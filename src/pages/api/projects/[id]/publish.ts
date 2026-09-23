/**
 * PUBLISH. INSTANTLY, AND WITHOUT AN EDITOR.
 *
 * §13: publishing is immediate for a normal user. There is no approval queue
 * for member-owned projects, and admin is reactive — it restricts what has
 * been reported, it does not gate what has been written.
 *
 * ── WHAT THIS STILL REFUSES ──────────────────────────────────────────────
 *
 * 1. A project that is not yours.
 * 2. A project that has been restricted or removed by a moderator. Publishing
 *    is not a way out of moderation (§29), so a restricted project cannot be
 *    re-published by its owner.
 * 3. A project that is not COMPLETE. `publishBlockers()` enforces five
 *    required fields (title, summary, description, claudeUsage, cityId) and
 *    returns all of them at once so the editor can highlight every gap
 *    simultaneously.
 *
 * ── OWNER ATTRIBUTION ────────────────────────────────────────────────────
 *
 * After publication, the owner's Builder record (builders.ownerMemberId =
 * projects.ownerMemberId) is inserted into project_builders. This is what
 * makes the "Made by" sidebar link and the builder profile project list work
 * without a Git commit or nightly rebuild.
 *
 * The attribution uses ON CONFLICT DO NOTHING, so re-publishing or
 * concurrent publishes do not duplicate rows. If the member has not yet
 * published a Builder Passport (no row in builders for their memberId), the
 * project still publishes — attribution is best-effort rather than a
 * prerequisite. The member's builder row is inserted by the profile publish
 * path, not here.
 *
 * The whole operation is transactional: if the project update, the builder
 * attribution, or the audit log fails, none of the three commits.
 */
import type { APIRoute } from 'astro';
import { and, eq } from 'drizzle-orm';
import { pooledDb } from '../../../../../db/pool';
import * as schema from '../../../../../db/schema';
import { guardMutation, json } from '@/server/http/guard';
import { publishBlockers } from '@/server/members/projects';

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  const db = pooledDb();
  // No body: publishing is an act, not a payload.
  const guard = await guardMutation(request, db);
  if (!guard.ok) return guard.response;

  const { member } = guard;
  const projectId = params.id;
  if (!projectId) return json({ error: 'Missing project id.' }, 400);

  const [project] = await db
    .select({
      id: schema.projects.id,
      slug: schema.projects.slug,
      title: schema.projects.title,
      summary: schema.projects.summary,
      description: schema.projects.description,
      claudeUsage: schema.projects.claudeUsage,
      cityId: schema.projects.cityId,
      ownerMemberId: schema.projects.ownerMemberId,
      publicationStatus: schema.projects.publicationStatus,
      moderationState: schema.projects.moderationState,
    })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId));

  // 404 for both "no such project" and "not yours", so this cannot be used to
  // discover which ids exist.
  if (!project) return json({ error: 'Project not found.' }, 404);

  if (project.ownerMemberId !== member.id) {
    const [collaborator] = await db
      .select({ memberId: schema.projectMembers.memberId })
      .from(schema.projectMembers)
      .where(
        and(
          eq(schema.projectMembers.projectId, projectId),
          eq(schema.projectMembers.memberId, member.id),
        ),
      );
    if (!collaborator) return json({ error: 'Project not found.' }, 404);
  }

  if (project.publicationStatus === 'deleted') {
    return json({ error: 'That project has been deleted.' }, 409);
  }

  /**
   * Moderation outranks the owner. §29: publishing is instant, but a
   * moderator's restriction is not something an owner can undo by pressing
   * publish again.
   */
  if (
    project.moderationState === 'restricted' ||
    project.moderationState === 'removed' ||
    project.moderationState === 'archived'
  ) {
    return json({ error: 'That project is under moderation review.' }, 403);
  }

  const blockers = publishBlockers(project);
  if (blockers.length > 0) {
    return json(
      {
        error: blockers[0].message,
        field: blockers[0].field,
        // All of them, so the editor can mark up every missing field at once
        // rather than making the member publish repeatedly to find them.
        blockers,
      },
      422,
    );
  }

  const now = new Date();

  // ── TRANSACTIONAL PUBLISH ───────────────────────────────────────────────
  //
  // Three writes, one transaction:
  //   1. Set publicationStatus = published on the project
  //   2. Insert owner → project_builders attribution (idempotent)
  //   3. Write audit log entry
  //
  // If any step fails, none commit — no partial-published state.
  try {
    await db.transaction(async (tx) => {
      // 1. Publish the project.
      await tx
        .update(schema.projects)
        .set({
          publicationStatus: 'published',
          /**
           * The curated archive's editorial status moves too, so the two
           * vocabularies agree about a row that is on the website. It is NOT
           * how visibility is decided — `src/data/source-db.ts` filters on
           * `publicationStatus` and `moderationState` — but leaving it at
           * `draft` would make the admin's own listings describe a live
           * project as unwritten.
           */
          status: 'published',
          updatedAt: now,
        })
        .where(eq(schema.projects.id, projectId));

      // 2. Owner attribution: find the Builder record owned by this member and
      //    link it to the project. ON CONFLICT DO NOTHING makes this safe for
      //    re-publishes and concurrent requests.
      //
      //    If the member has no Builder Passport yet, the SELECT returns no row
      //    and we simply skip the insert — the project still publishes. The
      //    attribution appears automatically when they later publish their
      //    profile (the profile publish path does NOT undo this: once the
      //    Builder row exists, ON CONFLICT DO NOTHING is a no-op on the next
      //    project publish).
      if (project.ownerMemberId) {
        const [ownerBuilder] = await tx
          .select({ id: schema.builders.id })
          .from(schema.builders)
          .where(eq(schema.builders.ownerMemberId, project.ownerMemberId));

        if (ownerBuilder) {
          await tx
            .insert(schema.projectBuilders)
            .values({
              projectId,
              builderId: ownerBuilder.id,
              position: 0,
            })
            .onConflictDoNothing();
        }
      }

      // 3. Audit log.
      await tx.insert(schema.auditLog).values({
        actorMemberId: member.id,
        action: 'project.published',
        entityType: 'project',
        entityId: projectId,
        fromStatus: project.publicationStatus,
        toStatus: 'published',
        note: project.slug,
      });
    });
  } catch (err) {
    console.error('[project.publish] transaction failed', err);
    return json({ error: 'Could not publish the project. Please try again.' }, 500);
  }

  /**
   * WHEN IT ACTUALLY APPEARS, STATED HONESTLY.
   *
   * `/projects/[slug]` is server-rendered, so the detail page is live the
   * moment this returns — §14's requirement that a new project not need a Git
   * push to exist. The listing page (`/projects/`) is also SSR (prerender =
   * false) and queries Neon live, so it appears there immediately too. Search
   * (`/discover`) likewise queries live. No rebuild is required for any of
   * the primary surfaces.
   */
  return json(
    {
      ok: true,
      slug: project.slug,
      url: `/projects/${project.slug}/`,
      detailLive: true,
      listingLive: true,
    },
    200,
  );
};

export const ALL: APIRoute = () => json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
