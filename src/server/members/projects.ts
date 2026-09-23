/**
 * A MEMBER'S PROJECTS. THE ONLY MODULE THAT ANSWERS THAT QUESTION.
 *
 * There were two. `src/server/me/queries.ts` had a `getMemberProjects` that
 * opened its own connection and took one argument; this file had a
 * `getMemberProjects` that took a connection and two. They returned different
 * columns and applied different authorisation — the first counted
 * collaborations, the second did not — so which projects a member could see
 * depended on which import a page happened to use. §61 forbids exactly that,
 * and the resolution is this file and the deletion of the other.
 *
 * ── WHY A CONNECTION IS PASSED IN ────────────────────────────────────────
 *
 * Because `tests/admin-isolation.test.ts` asserts that no module in the render
 * path names a database module, which is what keeps the static build static
 * and every credential out of the browser bundle. `src/server/http/page-guard.ts`
 * is the one place that opens a connection and it hands it down. A query
 * module that called `pooledDb()` itself would quietly re-import `db/pool`
 * into the render path — which is what the deleted module did.
 *
 * ── OWNERSHIP IS ONE COLUMN ──────────────────────────────────────────────
 *
 * `projects.owner_member_id`, and nothing else. `project_members` carries
 * collaborators only, and its enum is deliberately `collaborator |
 * contributor` with no `owner` — because an owner recorded in two places is
 * two places that can disagree about who owns a project. The create path used
 * to insert the owner into `project_members` as a `collaborator`, which made
 * every owner also appear as their own collaborator; it no longer does.
 */
import { and, desc, eq, or, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../../../db/schema';

type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

/** The columns the account area actually renders. Not `select *`. */
const projectColumns = {
  id: schema.projects.id,
  slug: schema.projects.slug,
  title: schema.projects.title,
  summary: schema.projects.summary,
  description: schema.projects.description,
  claudeUsage: schema.projects.claudeUsage,
  category: schema.projects.category,
  cityId: schema.projects.cityId,
  url: schema.projects.url,
  repoUrl: schema.projects.repoUrl,
  videoUrl: schema.projects.videoUrl,
  imagePath: schema.projects.imagePath,
  ownerMemberId: schema.projects.ownerMemberId,
  publicationStatus: schema.projects.publicationStatus,
  moderationState: schema.projects.moderationState,
  createdAt: schema.projects.createdAt,
  updatedAt: schema.projects.updatedAt,
} as const;

export type MemberProject = {
  [K in keyof typeof projectColumns]: (typeof projectColumns)[K]['_']['data'];
};

/**
 * Every project a member owns or collaborates on.
 *
 * `deleted` is excluded — a soft-deleted project is gone as far as its owner is
 * concerned, and §29 keeps the row only so a moderator can restore it.
 *
 * ONE QUERY, and the `leftJoin` + `DISTINCT` matter: joining `project_members`
 * multiplies a project by its collaborator count, so without the distinct a
 * project with three collaborators appears three times. The deleted module
 * de-duplicated in JavaScript after the fact, which works but pages the extra
 * rows over the wire.
 */
export async function getMemberProjects(
  memberId: string,
  db: AnyDatabase,
): Promise<MemberProject[]> {
  return (await db
    .selectDistinct(projectColumns)
    .from(schema.projects)
    .leftJoin(schema.projectMembers, eq(schema.projectMembers.projectId, schema.projects.id))
    .where(
      and(
        or(
          eq(schema.projects.ownerMemberId, memberId),
          eq(schema.projectMembers.memberId, memberId),
        ),
        sql`${schema.projects.publicationStatus} <> 'deleted'`,
      ),
    )
    .orderBy(desc(schema.projects.updatedAt))) as MemberProject[];
}

/**
 * One project, if this member may edit it.
 *
 * Returns null rather than throwing, and null means BOTH "no such project" and
 * "not yours" — deliberately indistinguishable, so this cannot be used to
 * enumerate which project ids exist.
 */
/**
 * `projects.id` is `uuid`. Postgres refuses to compare it against a string
 * that is not one — `invalid input syntax for type uuid`, thrown from the
 * database rather than caught here — which turns a malformed id into a 500
 * instead of the 403/404 every other "not yours" or "not found" path returns.
 *
 * Every route that reaches `getMemberProject` already validates its id with
 * `z.string().uuid()` before calling it (see `src/pages/api/media/upload.ts`
 * and the sibling project routes), so this can never fire in production. It
 * is here anyway because this function, not its callers, is what makes "not
 * a real id" and "not your project" the same answer — `null` — rather than a
 * third failure mode a caller has to remember to guard against separately.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getMemberProject(
  memberId: string,
  projectId: string,
  db: AnyDatabase,
): Promise<MemberProject | null> {
  if (!UUID_RE.test(projectId)) return null;

  const rows = (await db
    .selectDistinct(projectColumns)
    .from(schema.projects)
    .leftJoin(schema.projectMembers, eq(schema.projectMembers.projectId, schema.projects.id))
    .where(
      and(
        eq(schema.projects.id, projectId),
        or(
          eq(schema.projects.ownerMemberId, memberId),
          eq(schema.projectMembers.memberId, memberId),
        ),
        sql`${schema.projects.publicationStatus} <> 'deleted'`,
      ),
    )) as MemberProject[];
  return rows[0] ?? null;
}

/**
 * Whether this member may edit a project, without fetching it.
 *
 * Used by the mutation routes, which need the answer and not the row.
 */
export async function canEditProject(
  memberId: string,
  projectId: string,
  db: AnyDatabase,
): Promise<boolean> {
  return (await getMemberProject(memberId, projectId, db)) !== null;
}

/** What a project is missing before it can go public. */
export type PublishBlocker =
  | { field: 'title'; message: string }
  | { field: 'summary'; message: string }
  | { field: 'description'; message: string }
  | { field: 'claudeUsage'; message: string }
  | { field: 'category'; message: string }
  | { field: 'cityId'; message: string };

/**
 * THE PUBLISH GATE, AND THE INVARIANT IT KEEPS.
 *
 * Migration 0010 dropped NOT NULL from `projects.city_id` and
 * `projects.summary` so a draft could be saved incomplete — the previous
 * constraint meant every member project creation failed at the database.
 * Completeness did not stop being required; it moved here, to the boundary
 * where it actually matters.
 *
 * The five required fields for a published member project:
 *   title     — every page that renders this project prints the title
 *   summary   — the tagline shown on cards and in search
 *   description — what the project actually is and does
 *   claudeUsage — what Claude was used for (the interesting part)
 *   cityId    — required non-null by Project.citySlug in the type system
 *
 * All five are returned in one pass so the editor can highlight every missing
 * field simultaneously, rather than forcing the member to publish repeatedly
 * to discover them one by one.
 *
 * Legacy/curated projects already in the DB are not retroactively affected:
 * this gate runs only at the publish boundary, never as a migration.
 */
export function publishBlockers(project: {
  title?: string | null;
  summary?: string | null;
  description?: string | null;
  claudeUsage?: string | null;
  category?: string | null;
  cityId?: string | null;
}): PublishBlocker[] {
  const blockers: PublishBlocker[] = [];
  if (!project.title?.trim()) {
    blockers.push({ field: 'title', message: 'Give the project a name before publishing it.' });
  }
  if (!project.summary?.trim()) {
    blockers.push({
      field: 'summary',
      message: 'Add a short tagline before publishing it.',
    });
  }
  if (!project.description?.trim()) {
    blockers.push({
      field: 'description',
      message: 'Describe what the project does before publishing it.',
    });
  }
  if (!project.claudeUsage?.trim()) {
    blockers.push({
      field: 'claudeUsage',
      message: 'Explain how Claude was used before publishing it.',
    });
  }
  if (!project.cityId) {
    blockers.push({ field: 'cityId', message: 'Choose a city before publishing it.' });
  }
  if (!project.category) {
    blockers.push({ field: 'category', message: 'Choose a category before publishing it.' });
  }
  return blockers;
}

/**
 * A unique project slug, derived once.
 *
 * The slug is the public URL, so it is generated at creation and never
 * regenerated from an edited title — a project whose URL changed when its name
 * was tidied would break every link anybody had shared.
 */
export function slugifyTitle(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 72)
      .replace(/-+$/g, '') || 'project'
  );
}

/**
 * Claim a slug, atomically.
 *
 * ── WHY THIS IS NOT A LOOP OF SELECTS ────────────────────────────────────
 *
 * The previous implementation queried for a slug, incremented a counter and
 * queried again until it found a free one, then inserted. Two members creating
 * "My Agent" at the same moment both saw the same free slug and one insert
 * failed on the unique constraint with a raw 500.
 *
 * This asks the database for the answer in one statement instead: count the
 * rows whose slug is the base or `base-<n>`, and use that to pick the
 * candidate. It still races in principle, so the caller must treat a unique
 * violation as "try once more" — but the window is one statement wide rather
 * than the length of a loop, and §43 is satisfied by the constraint being
 * there at all rather than by this being clever.
 */
export async function nextAvailableSlug(title: string, db: AnyDatabase): Promise<string> {
  const base = slugifyTitle(title);
  const clashes = await db
    .select({ slug: schema.projects.slug })
    .from(schema.projects)
    .where(sql`${schema.projects.slug} = ${base} OR ${schema.projects.slug} LIKE ${`${base}-%`}`);

  if (!clashes.some((row) => row.slug === base)) return base;

  const taken = new Set(clashes.map((row) => row.slug));
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}
