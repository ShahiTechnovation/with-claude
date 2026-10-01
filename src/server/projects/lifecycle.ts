/**
 * PROJECTS: WHO MAY DO WHAT, WHAT IS PUBLIC, AND HOW STATE MOVES.
 *
 * One module answers three questions that used to be answered separately by
 * every route that needed them — and answered differently:
 *
 *   1. PERMISSION. `can(role, action)` over a fixed matrix. The archive and
 *      restore routes used to let any `project_members` row through, so a
 *      `contributor` (credit only) could archive the owner's project.
 *
 *   2. PUBLIC ELIGIBILITY. `publicProjectWhere()` / `isPublicProject()`. The
 *      detail page admitted `moderationState = 'reported'` while the listing
 *      required `clean`, so a project could be reachable by URL and absent
 *      from every list. There is one predicate now.
 *
 *   3. LIFECYCLE. `transitionProject()`. `publicationStatus` is canonical;
 *      the legacy `status` column (the admin's editorial vocabulary) is kept in
 *      step through `legacyStatusFor()` so the two can no longer disagree about
 *      a row that is on the website. `moderationState` is independent and
 *      `featured` is orthogonal — neither is touched here.
 *
 * Every transition writes its audit row in the same transaction as the state
 * change, with the before/after state, and re-asserts the from-state in the
 * WHERE clause so two concurrent clicks cannot both win.
 */
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../../../db/schema';

type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

export type PublicationStatus = (typeof schema.publicationStatus.enumValues)[number];
export type ModerationState = (typeof schema.moderationState.enumValues)[number];
export type LegacyStatus = (typeof schema.contentStatus.enumValues)[number];

// =========================================================================
// 1. PERMISSIONS
// =========================================================================

/**
 * A member's relationship to one project.
 *
 * `owner` is `projects.owner_member_id` and nothing else. The other two are
 * `project_members.role`, whose enum deliberately has no `owner`.
 */
export type ProjectRole = 'owner' | 'collaborator' | 'contributor';

export type ProjectAction =
  | 'read'
  | 'edit'
  | 'upload_media'
  | 'publish'
  | 'archive'
  | 'restore'
  | 'manage_collaborators';

/**
 * THE MATRIX. Owner does everything; a collaborator edits content and may
 * attach media to it; a contributor is credited and may read their own
 * project in the account area, nothing more.
 *
 * Publishing, archiving and restoring are owner-only because each one changes
 * what the public sees under the owner's name. Moderators are not in this
 * table at all: moderation is a separate set of actions in
 * `src/server/moderation.ts`, and a moderator never acts AS an owner.
 */
const MATRIX: Record<ProjectRole, ReadonlySet<ProjectAction>> = {
  owner: new Set<ProjectAction>([
    'read',
    'edit',
    'upload_media',
    'publish',
    'archive',
    'restore',
    'manage_collaborators',
  ]),
  collaborator: new Set<ProjectAction>(['read', 'edit', 'upload_media']),
  contributor: new Set<ProjectAction>(['read']),
};

export function can(role: ProjectRole | null | undefined, action: ProjectAction): boolean {
  return role ? MATRIX[role].has(action) : false;
}

/** For the account UI: which actions to offer. Never trusted server-side. */
export function allowedActions(role: ProjectRole | null): ProjectAction[] {
  return role ? [...MATRIX[role]] : [];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProjectAccess {
  role: ProjectRole;
  project: {
    id: string;
    slug: string;
    ownerMemberId: string | null;
    publicationStatus: PublicationStatus;
    moderationState: ModerationState;
    status: LegacyStatus;
    imageId: string | null;
    contentAuthority: ContentAuthority;
    publishedAt: Date | null;
  };
}

export type ContentAuthority = (typeof schema.contentAuthority.enumValues)[number];

/**
 * Resolve the caller's role on a project, from the database.
 *
 * Null means "no such project", "deleted", "malformed id" AND "not yours" —
 * deliberately indistinguishable, so a route cannot be used to enumerate ids.
 */
export async function projectAccess(
  memberId: string,
  projectId: string,
  db: AnyDatabase,
): Promise<ProjectAccess | null> {
  if (!UUID_RE.test(projectId)) return null;

  const [row] = await db
    .select({
      id: schema.projects.id,
      slug: schema.projects.slug,
      ownerMemberId: schema.projects.ownerMemberId,
      publicationStatus: schema.projects.publicationStatus,
      moderationState: schema.projects.moderationState,
      status: schema.projects.status,
      imageId: schema.projects.imageId,
      contentAuthority: schema.projects.contentAuthority,
      publishedAt: schema.projects.publishedAt,
      memberRole: schema.projectMembers.role,
    })
    .from(schema.projects)
    .leftJoin(
      schema.projectMembers,
      and(
        eq(schema.projectMembers.projectId, schema.projects.id),
        eq(schema.projectMembers.memberId, memberId),
      ),
    )
    .where(and(eq(schema.projects.id, projectId), sql`${schema.projects.publicationStatus} <> 'deleted'`));

  if (!row) return null;

  const role: ProjectRole | null =
    row.ownerMemberId === memberId ? 'owner' : (row.memberRole ?? null);
  if (!role) return null;

  const { memberRole: _ignored, ...project } = row;
  return { role, project };
}

/**
 * Convenience for routes that only need a yes/no.
 *
 * Every action except `read` also requires the project's content to be the
 * website's to write (`contentAuthority = 'member'`). A credited member on an
 * imported, unclaimed project can see it in their account; they cannot change
 * what the organisers' source owns.
 */
export async function memberCan(
  memberId: string,
  projectId: string,
  action: ProjectAction,
  db: AnyDatabase,
): Promise<ProjectAccess | null> {
  const access = await projectAccess(memberId, projectId, db);
  if (!access || !can(access.role, action)) return null;
  if (action !== 'read' && access.project.contentAuthority !== 'member') return null;
  return access;
}

// =========================================================================
// 2. PUBLIC ELIGIBILITY
// =========================================================================

/**
 * THE public-project predicate, as SQL. Every public surface — detail, list,
 * event page, builder page, related projects, homepage, search, sitemap —
 * must build its WHERE from this.
 *
 *   published   the owner (or an editor) put it on the website
 *   clean       no moderation state is in effect. `reported` is NOT public:
 *               it is a moderator-applied hold, and nothing else writes it.
 *   not deleted the soft-delete timestamp is unset
 */
export function publicProjectWhere(): SQL {
  return and(
    eq(schema.projects.publicationStatus, 'published'),
    eq(schema.projects.moderationState, 'clean'),
    isNull(schema.projects.deletedAt),
  )!;
}

export function isPublicProject(row: {
  publicationStatus: string;
  moderationState: string;
  deletedAt?: Date | string | null;
}): boolean {
  return (
    row.publicationStatus === 'published' && row.moderationState === 'clean' && !row.deletedAt
  );
}

/** Moderation states that stop an owner publishing. */
export const MODERATION_HOLDS: readonly ModerationState[] = ['restricted', 'removed', 'archived'];

// =========================================================================
// 3. LIFECYCLE
// =========================================================================

/**
 * `publicationStatus` → the legacy editorial `status`.
 *
 * The compatibility mapping. The admin's lists and the curated archive still
 * read `status`; leaving it at `draft` on a live project made the admin
 * describe a public project as unwritten, and leaving it `published` on an
 * archived one did the reverse.
 */
export function legacyStatusFor(publication: PublicationStatus): LegacyStatus {
  switch (publication) {
    case 'draft':
      return 'draft';
    case 'published':
      return 'published';
    case 'archived':
    case 'deleted':
      return 'archived';
  }
}

/**
 * The reverse mapping, for the admin's editorial transitions on a project.
 *
 * `approved` is "an editor said yes, not yet on the website" — a draft from
 * the public site's point of view. Statuses before approval are drafts too.
 */
export function publicationStatusForLegacy(status: LegacyStatus): PublicationStatus {
  switch (status) {
    case 'published':
      return 'published';
    case 'archived':
    case 'rejected':
      return 'archived';
    default:
      return 'draft';
  }
}

export type LifecycleAction = 'publish' | 'archive' | 'restore';

interface LifecycleRule {
  from: readonly PublicationStatus[];
  to: PublicationStatus;
  permission: ProjectAction;
  audit: string;
}

/**
 * The owner's lifecycle. Restore goes back to DRAFT, never straight to
 * published: un-archiving is a deliberate two-step, like the admin's
 * `restore → approved`.
 */
export const LIFECYCLE: Record<LifecycleAction, LifecycleRule> = {
  publish: { from: ['draft'], to: 'published', permission: 'publish', audit: 'project.published' },
  archive: {
    from: ['draft', 'published'],
    to: 'archived',
    permission: 'archive',
    audit: 'project.archived',
  },
  restore: { from: ['archived'], to: 'draft', permission: 'restore', audit: 'project.restored' },
};

export type TransitionResult =
  | {
      ok: true;
      from: PublicationStatus;
      to: PublicationStatus;
      slug: string;
      auditId: string;
    }
  | { ok: false; status: 403 | 404 | 409 | 422; error: string; blockers?: unknown };

export interface TransitionOptions {
  /**
   * Extra work inside the same transaction, after the state change and
   * before commit — publish uses it for attribution and cover media.
   */
  within?: (tx: AnyDatabase, access: ProjectAccess) => Promise<void>;
  /** Refuse with this result before writing, e.g. publish blockers. */
  precheck?: (access: ProjectAccess) => Promise<TransitionResult | null>;
}

/**
 * Move a member's project along its lifecycle. The one writer of
 * `publicationStatus` for member actions.
 */
export async function transitionProject(
  db: AnyDatabase,
  memberId: string,
  projectId: string,
  action: LifecycleAction,
  options: TransitionOptions = {},
): Promise<TransitionResult> {
  const rule = LIFECYCLE[action];
  const access = await projectAccess(memberId, projectId, db);
  // Not yours and not there are the same answer.
  if (!access) return { ok: false, status: 404, error: 'Project not found.' };
  if (!can(access.role, rule.permission)) {
    return {
      ok: false,
      status: 403,
      error:
        access.role === 'contributor'
          ? 'Contributors are credited on a project but cannot change it.'
          : 'Only the project owner can do that.',
    };
  }

  const { project } = access;

  if (project.contentAuthority !== 'member') {
    return {
      ok: false,
      status: 409,
      error: 'This project is managed by the organisers until it is claimed.',
    };
  }

  if (action === 'publish' && MODERATION_HOLDS.includes(project.moderationState)) {
    // §29: publishing is not a way out of moderation.
    return { ok: false, status: 403, error: 'That project is under moderation review.' };
  }

  if (!rule.from.includes(project.publicationStatus)) {
    if (project.publicationStatus === rule.to) {
      return { ok: false, status: 409, error: `That project is already ${rule.to}.` };
    }
    return {
      ok: false,
      status: 409,
      error: `Cannot ${action} a project that is ${project.publicationStatus}.`,
    };
  }

  if (options.precheck) {
    const refused = await options.precheck(access);
    if (refused) return refused;
  }

  const from = project.publicationStatus;
  const to = rule.to;
  const now = new Date();

  try {
    const auditId = await db.transaction(async (tx) => {
      const updated = await tx
        .update(schema.projects)
        .set({
          publicationStatus: to,
          status: legacyStatusFor(to),
          updatedAt: now,
          // First publication only. A re-publish after archive keeps the
          // original date, so "newest" does not reward churn.
          ...(to === 'published' && !project.publishedAt ? { publishedAt: now } : {}),
        })
        .where(and(eq(schema.projects.id, projectId), eq(schema.projects.publicationStatus, from)))
        .returning({ id: schema.projects.id });
      if (updated.length !== 1) throw new ConcurrentTransition();

      if (options.within) await options.within(tx as unknown as AnyDatabase, access);

      const [entry] = await tx
        .insert(schema.auditLog)
        .values({
          actorMemberId: memberId,
          action: rule.audit,
          entityType: 'project',
          entityId: projectId,
          fromStatus: from,
          toStatus: to,
          before: {
            publicationStatus: from,
            status: project.status,
            moderationState: project.moderationState,
          },
          after: {
            publicationStatus: to,
            status: legacyStatusFor(to),
            moderationState: project.moderationState,
          },
          note: project.slug,
        })
        .returning({ id: schema.auditLog.id });
      return entry.id;
    });

    return { ok: true, from, to, slug: project.slug, auditId };
  } catch (error) {
    if (error instanceof ConcurrentTransition) {
      return {
        ok: false,
        status: 409,
        error: 'This project changed a moment ago. Reload and try again.',
      };
    }
    throw error;
  }
}

class ConcurrentTransition extends Error {
  constructor() {
    super('Project changed concurrently.');
    this.name = 'ConcurrentTransition';
  }
}
