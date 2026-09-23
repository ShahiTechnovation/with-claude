/**
 * SELF-PUBLICATION.
 *
 * The change this whole phase exists for. Until now a public record reached
 * the website because an editor approved it and then published it —
 * `admin/src/server/publishing.ts` enforces that, and its rule map
 * deliberately makes `published` reachable only from `approved`.
 *
 * That rule is still correct for the curated archive and is untouched. This is
 * a second, narrower path that applies to member-owned rows only.
 *
 * ── WHY NOT REUSE `transitionContent()` ──────────────────────────────────
 *
 * Because its map is a governance statement, not an implementation detail:
 * "a record gets onto the website because a person approved it and then a
 * person published it, and there is no third way in". Making member profiles
 * flow through it would require adding `draft → published`, which would also
 * open that door for all 72 legacy builders and every project, story and
 * event. One shortcut for one entity type would become a shortcut for
 * everything.
 *
 * So there are two publish paths, and the thing that keeps them apart is a
 * column: this one refuses any row that is not `owner_member_id = <caller>`.
 * A member cannot reach a legacy record and an editor's queue does not fill up
 * with member profiles.
 *
 * ── THE TRANSACTION IS THE POINT ─────────────────────────────────────────
 *
 * Audit row and content change together, or neither — the same rule both
 * existing state machines follow, for the same reason. A profile that went
 * public with nothing accounting for it is exactly what the log exists to make
 * impossible.
 *
 * ── WHEN IT ACTUALLY BECOMES VISIBLE ─────────────────────────────────────
 *
 * `/builders/[slug]` and `/builders/` are both SSR (`prerender = false`) and
 * query Neon directly. A published profile is immediately visible at
 * `/builders/[slug]` — no rebuild needed, no CDN purge delay. The deploy hook
 * is still called so other static pages that include the builder (sitemap,
 * /discover search index) are updated on the next Vercel deployment, but the
 * profile page itself is live the moment the transaction commits.
 *
 * The authenticated `/me` view reads Neon directly and is always immediate.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../../../db/schema';
import type { Member } from '../auth/member';
import { canPublish } from '../auth/member';
import { isPlaceholderUsername } from './username';
import { projectToBuilder, type ProfileRow } from './profile';

type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

export type PublishFailure =
  | { ok: false; status: 403; error: string }
  | { ok: false; status: 409; error: string }
  | { ok: false; status: 422; error: string; field?: string };

export type PublishResult =
  | { ok: true; slug: string; builderId: string; created: boolean; auditId: string }
  | PublishFailure;

/**
 * What a profile needs before it can be public.
 *
 * Deliberately short. A thin profile is honest — the existing builder page
 * already says plainly what a record is missing rather than padding it — so
 * this asks only for the things a page cannot render without: a handle that
 * somebody chose, a name to print, and a city, because `builders.city_id` is
 * NOT NULL and the atlas is what the site is organised around.
 */
export function missingForPublish(profile: ProfileRow): string[] {
  const name =
    profile.displayName?.trim() ||
    [profile.firstName, profile.lastName].filter(Boolean).join(' ').trim();

  return [
    isPlaceholderUsername(profile.username) && 'a username',
    !name && 'a name',
    !profile.cityId && 'a city',
    !profile.primaryRole && 'a role',
  ].filter(Boolean) as string[];
}

/**
 * Publish, or update, the caller's own public profile.
 *
 * Three cases, and the difference between them is the safety property:
 *
 *   1. the member owns a builder row already (they claimed one, or published
 *      before) — the projection updates the fields it is allowed to
 *   2. no row, and the username is free — a new `source = 'user'` row
 *   3. anything else — refused
 *
 * Case 1 is where claiming pays off: the row keeps its verified name, its
 * roles, its ambassador link and its event credits, because
 * `projectToBuilder()` does not return those keys for a legacy row.
 */
export async function publishProfile(
  member: Member,
  db: AnyDatabase,
  deploy: () => Promise<void> = triggerDeploy,
): Promise<PublishResult> {
  if (!canPublish(member)) {
    return { ok: false, status: 403, error: 'This account cannot publish right now.' };
  }

  const [profile] = (await db
    .select()
    .from(schema.memberProfiles)
    .where(eq(schema.memberProfiles.memberId, member.id))) as ProfileRow[];

  if (!profile) return { ok: false, status: 409, error: 'There is no profile to publish.' };

  const missing = missingForPublish(profile);
  if (missing.length > 0) {
    return {
      ok: false,
      status: 422,
      error: `Your passport still needs ${missing.join(', ')}.`,
    };
  }

  const [owned] = await db
    .select({ id: schema.builders.id, slug: schema.builders.slug, source: schema.builders.source })
    .from(schema.builders)
    .where(eq(schema.builders.ownerMemberId, member.id));

  const result = await db.transaction(async (tx) => {
    let finalBuilderId: string;
    let finalSlug: string;
    let finalCreated: boolean;
    let finalAuditId: string;

    if (owned) {
      // ── Case 1: a row this member already owns ──────────────────────
      const patch = projectToBuilder(profile, owned.source);

      const [audit] = await tx
        .insert(schema.auditLog)
        .values({
          actorMemberId: member.id,
          action: 'member.profile.published',
          entityType: 'builder',
          entityId: owned.id,
          fromStatus: 'published',
          toStatus: 'published',
          after: patch as Record<string, unknown>,
          note: `Profile update published by its owner (source=${owned.source}).`,
        })
        .returning({ id: schema.auditLog.id });

      await tx
        .update(schema.builders)
        .set({ ...patch, status: 'published' })
        .where(
          // OWNERSHIP IN THE WHERE CLAUSE, not only in the check above. Even
          // if something upstream were wrong, this statement cannot touch a
          // row belonging to somebody else.
          and(eq(schema.builders.id, owned.id), eq(schema.builders.ownerMemberId, member.id)),
        );

      finalBuilderId = owned.id;
      finalSlug = owned.slug;
      finalCreated = false;
      finalAuditId = audit.id;
    } else {
      // ── Case 2: a new row, named by the username ────────────────────────
      const name =
        profile.displayName?.trim() ||
        [profile.firstName, profile.lastName].filter(Boolean).join(' ').trim();

      const [created] = await tx
        .insert(schema.builders)
        .values({
          /**
           * SLUG INVARIANT (Phase I): the slug is set from username at first
           * publication and is NEVER updated on re-publish. This is intentional:
           * /builders/{slug} is the member's permanent public URL, and public
           * URLs must not break when a member changes their username. The
           * username is their login handle; the builder slug is their public
           * identity. See projectToBuilder() — it deliberately omits 'slug'
           * from its update projection so re-publishes cannot change the URL.
           */
          slug: profile.username,
          name,
          cityId: profile.cityId!,
          role: profile.primaryRole ?? 'Builder',
          // NO ROLES ARE ASSIGNED HERE. `roles` stays empty for the same reason
          // the promotion path leaves it empty: it is curated, and the database
          // would refuse `ambassador` outright. Nobody arrives at standing
          // through a form.
          bio: profile.bio ?? null,
          status: 'published',
          source: 'user',
          ownerMemberId: member.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning({ id: schema.builders.id, slug: schema.builders.slug });

      const [audit] = await tx
        .insert(schema.auditLog)
        .values({
          actorMemberId: member.id,
          action: 'member.profile.published',
          entityType: 'builder',
          entityId: created.id,
          fromStatus: null,
          toStatus: 'published',
          note: 'Builder Passport published by its owner. Self-service, no editorial review.',
        })
        .returning({ id: schema.auditLog.id });

      finalBuilderId = created.id;
      finalSlug = created.slug;
      finalCreated = true;
      finalAuditId = audit.id;
    }

    // ── Update publication timestamp atomically ──────────────────────────
    await tx
      .update(schema.memberProfiles)
      .set({ publishedAt: sql`now()`, updatedAt: new Date() })
      .where(eq(schema.memberProfiles.memberId, member.id));

    // ── Backfill project attribution ──────────────────────────────────────
    // The member might have published projects before they published their
    // Builder Passport. Now that they have one, they should get credit.
    const uncreditedProjects = await tx
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.ownerMemberId, member.id),
          eq(schema.projects.publicationStatus, 'published')
        )
      );

    if (uncreditedProjects.length > 0) {
      await tx
        .insert(schema.projectBuilders)
        .values(
          uncreditedProjects.map((p) => ({
            projectId: p.id,
            builderId: finalBuilderId,
            position: 0,
          }))
        )
        .onConflictDoNothing();
    }

    return { slug: finalSlug, builderId: finalBuilderId, created: finalCreated, auditId: finalAuditId };
  });

  // Outside the transaction, and its failure is not this call's failure.
  try {
    await deploy();
  } catch (error) {
    console.error('[publish] the deploy hook could not be called:', error);
  }

  return { ok: true, ...result };
}

/**
 * Ask Vercel to rebuild.
 *
 * The same hook the admin uses. Absent configuration is not an error — it
 * means the profile is in the database and will appear on the next build,
 * which for a local development database is exactly right.
 */
export async function triggerDeploy(): Promise<void> {
  const hook = process.env.VERCEL_DEPLOY_HOOK_URL;
  if (!hook) return;
  await fetch(hook, { method: 'POST' });
}

/**
 * Unlist a published profile.
 *
 * NOT a delete, and not `archived` either — archiving is a moderator's
 * takedown and it would be wrong for a member's own choice to write the same
 * state a moderation action writes, because the audit trail would then
 * conflate the two. The row stays `published` and `visibility` decides whether
 * it is promoted or indexed.
 */
export async function setVisibility(
  member: Member,
  visibility: (typeof schema.profileVisibility.enumValues)[number],
  db: AnyDatabase,
): Promise<void> {
  await db
    .update(schema.memberProfiles)
    .set({ visibility, updatedAt: new Date() })
    .where(eq(schema.memberProfiles.memberId, member.id));
}

/** The builder row this member owns, if any. */
export async function ownedBuilder(
  member: Member,
  db: AnyDatabase,
): Promise<{ id: string; slug: string; name: string; source: string } | null> {
  const [row] = await db
    .select({
      id: schema.builders.id,
      slug: schema.builders.slug,
      name: schema.builders.name,
      source: schema.builders.source,
    })
    .from(schema.builders)
    .where(eq(schema.builders.ownerMemberId, member.id));
  return row ?? null;
}

/** Unclaimed builder rows, for the claim UI. Never used to infer ownership. */
export async function isClaimable(builderId: string, db: AnyDatabase): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.builders.id })
    .from(schema.builders)
    .where(and(eq(schema.builders.id, builderId), isNull(schema.builders.ownerMemberId)));
  return Boolean(row);
}
