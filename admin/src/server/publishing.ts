/**
 * THE content state machine — publishing and takedown.
 *
 * The sibling of `transitions.ts`, which owns the submission inbox. This one
 * owns the lifecycle of the REAL records: builders, projects, use cases,
 * events, cities, stories, guides, ambassadors.
 *
 * ── WHY THE TWO ARE SEPARATE ─────────────────────────────────────────────
 *
 * Because they answer different questions about different things, and merging
 * them is the mistake this whole design exists to avoid.
 *
 *     submission.status    what happened to the MESSAGE somebody sent
 *     <entity>.status      whether the RECORD is on the website
 *
 * A submission reaching `approved` says an editor read it and it belongs in
 * the record. It does not put anything on the site — publishing is a separate
 * act, taken deliberately, and tied to a build. That is why there is no
 * `published` in `submission_status` and why adding one would be wrong: it
 * would let approving something publish it, and a review queue would quietly
 * become a publishing pipeline.
 *
 * ── THE MAP ──────────────────────────────────────────────────────────────
 *
 *     draft ─→ pending ─→ in_review ─┬→ changes_requested ─→ pending
 *                                    ├→ rejected
 *                                    └→ approved ─→ published ⇄ archived
 *
 * Phase 3 implements the last link and the takedown that follows it. What it
 * deliberately does NOT implement is a way around them: `pending → published`
 * is not on the map, so nothing can reach the website without an editor having
 * approved it first. There is no self-publication and no bypass.
 *
 * ── THE TRANSACTION IS THE POINT ─────────────────────────────────────────
 *
 * Audit row and status change, in one BEGIN/COMMIT, or neither. Same rule as
 * the submission machine, for the same reason: a log with a gap in it is not a
 * log, and a status change nobody can account for is what the log exists to
 * make impossible.
 *
 * The deploy hook is explicitly OUTSIDE that transaction — see
 * `publishEntity()`. The database is the source of truth; a deploy is how the
 * truth reaches a CDN, and Vercel being down is not a reason to un-publish
 * something an editor decided to publish.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../../../db/schema';
import type { Actor } from './transitions';

type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

/** The audited content lifecycle. All eight, from Phase 1. */
export type ContentStatus = (typeof schema.contentStatus.enumValues)[number];

/**
 * The record types an editor can publish.
 *
 * Keyed by the name used in URLs, in the audit log and on the publish queue,
 * so those three can never disagree about what a thing is called.
 */
export const PUBLISHABLE = {
  builder: { table: schema.builders, label: 'Builder', title: schema.builders.name },
  project: { table: schema.projects, label: 'Project', title: schema.projects.title },
  use_case: { table: schema.useCases, label: 'Use case', title: schema.useCases.title },
  event: { table: schema.events, label: 'Event', title: schema.events.title },
  city: { table: schema.cities, label: 'City', title: schema.cities.name },
  story: { table: schema.stories, label: 'Story', title: schema.stories.title },
  guide: { table: schema.guides, label: 'Guide', title: schema.guides.title },
  ambassador: { table: schema.ambassadors, label: 'Ambassador', title: schema.ambassadors.name },
} as const;

export type EntityType = keyof typeof PUBLISHABLE;

export const ENTITY_TYPES = Object.keys(PUBLISHABLE) as EntityType[];

export function isEntityType(value: string): value is EntityType {
  return value in PUBLISHABLE;
}

/** Publishing is an Editor/Admin act. A reviewer reviews; they do not ship. */
const PUBLISH_ROLES = ['admin', 'editor'] as const;

export type PublishAction = 'publish' | 'archive' | 'restore';

interface Rule {
  from: readonly ContentStatus[];
  to: ContentStatus;
  requiresNote: boolean;
  roles: readonly string[];
  auditAction: string;
  label: string;
}

/**
 * The whole map. If a transition is not here, it cannot happen.
 *
 * `publish` is reachable ONLY from `approved`. That single line is the
 * governance rule: a record gets onto the website because a person approved it
 * and then a person published it, and there is no third way in.
 */
export const PUBLISH_RULES: Record<PublishAction, Rule> = {
  publish: {
    from: ['approved'],
    to: 'published',
    requiresNote: false,
    roles: PUBLISH_ROLES,
    auditAction: 'published',
    label: 'Publish',
  },
  archive: {
    /**
     * THE TAKEDOWN PATH.
     *
     * One action, from published to gone-on-the-next-build. It deletes
     * nothing: the row stays, the audit trail stays, and the public reader
     * simply stops selecting it. That is what makes it safe to use quickly,
     * which is the entire point of a correction policy — somebody reporting a
     * problem with a record should not have to wait for a careful decision
     * about whether to keep the data.
     */
    from: ['published'],
    to: 'archived',
    requiresNote: true,
    roles: PUBLISH_ROLES,
    auditAction: 'archived',
    label: 'Archive',
  },
  restore: {
    /**
     * Back to `approved`, NOT to `published`.
     *
     * Undoing a takedown returns the record to the queue, where publishing it
     * again is a deliberate second act. A one-click round trip from archived
     * straight back onto the website would make the takedown reversible by
     * accident, which is exactly what it must not be.
     */
    from: ['archived'],
    to: 'approved',
    requiresNote: true,
    roles: PUBLISH_ROLES,
    auditAction: 'restored',
    label: 'Restore to queue',
  },
};

export const NOTE_MAX = 2_000;

export type PublishFailure =
  | { ok: false; status: 403; error: string }
  | { ok: false; status: 404; error: string }
  | { ok: false; status: 409; error: string }
  | { ok: false; status: 422; error: string };

export type PublishResult =
  | {
      ok: true;
      entityType: EntityType;
      entityId: string;
      from: ContentStatus;
      to: ContentStatus;
      auditId: string;
      /** What happened when the deploy hook was called. Never affects `ok`. */
      deploy: DeployOutcome;
    }
  | PublishFailure;

/**
 * What became of the deploy hook.
 *
 * Reported alongside a successful mutation rather than folded into it. The
 * editorial decision succeeded or it did not; whether a CDN has caught up yet
 * is a different fact, and the UI says both.
 */
export type DeployOutcome =
  | { triggered: true }
  | { triggered: false; reason: 'not-configured' | 'refused' | 'unreachable'; detail?: string };

export interface PublishInput {
  entityType: EntityType;
  entityId: string;
  action: PublishAction;
  actor: Actor;
  note?: string | null;
  /** Injected by the tests. Production uses the real hook. */
  deploy?: () => Promise<DeployOutcome>;
}

/** Which actions this actor could take on a record in this state. */
export function availablePublishActions(status: ContentStatus, role: string): PublishAction[] {
  return (Object.keys(PUBLISH_RULES) as PublishAction[]).filter((action) => {
    const rule = PUBLISH_RULES[action];
    return rule.roles.includes(role) && rule.from.includes(status);
  });
}

export function canPublish(role: string): boolean {
  return (PUBLISH_ROLES as readonly string[]).includes(role);
}

/**
 * Move one record along its lifecycle.
 *
 * Mirrors `transitionSubmission()` deliberately, including the order of the
 * checks: role, then request shape, then the record, then the transition. An
 * unauthorised caller learns nothing about whether the record exists.
 */
export async function transitionContent(
  db: AnyDatabase,
  { entityType, entityId, action, actor, note, deploy = triggerDeploy }: PublishInput,
): Promise<PublishResult> {
  const rule = PUBLISH_RULES[action];
  if (!rule) {
    return { ok: false, status: 422, error: `Unknown action "${String(action)}".` };
  }
  if (!isEntityType(entityType)) {
    return { ok: false, status: 422, error: `"${String(entityType)}" is not a publishable type.` };
  }

  // 1. Role, before anything is read.
  if (!rule.roles.includes(actor.role)) {
    return {
      ok: false,
      status: 403,
      error: `Your role (${actor.role}) cannot ${rule.label.toLowerCase()} a record.`,
    };
  }

  // 2. The note requirement — a property of the request, not of the record.
  const trimmed = typeof note === 'string' ? note.trim() : '';
  if (rule.requiresNote && trimmed.length === 0) {
    return {
      ok: false,
      status: 422,
      error:
        `"${rule.label}" needs a note saying why. Taking something down is a decision ` +
        `somebody will ask about later.`,
    };
  }
  if (trimmed.length > NOTE_MAX) {
    return { ok: false, status: 422, error: `The note must be under ${NOTE_MAX} characters.` };
  }

  const { table } = PUBLISHABLE[entityType];

  // 3. The record.
  const [current] = await db
    .select({ id: table.id, slug: table.slug, status: table.status })
    .from(table)
    .where(eq(table.id, entityId));

  if (!current) {
    return { ok: false, status: 404, error: `No ${entityType} with that id.` };
  }

  // 4. The transition.
  if (!rule.from.includes(current.status)) {
    return {
      ok: false,
      status: 409,
      error:
        `Cannot ${rule.label.toLowerCase()} a ${entityType} that is "${current.status}". ` +
        `That action applies to: ${rule.from.join(', ')}.`,
    };
  }

  const from = current.status;
  const to = rule.to;

  // 5. Both halves, or neither.
  let auditId: string;
  try {
    auditId = await db.transaction(async (tx) => {
      const [entry] = await tx
        .insert(schema.auditLog)
        .values({
          actorId: actor.id,
          actorEmail: actor.email,
          action: `${entityType}.${rule.auditAction}`,
          entityType,
          entityId,
          fromStatus: from,
          toStatus: to,
          note: trimmed.length > 0 ? trimmed : null,
        })
        .returning({ id: schema.auditLog.id });

      const updated = await tx
        .update(table)
        .set({ status: to, updatedAt: new Date() })
        .where(
          // The status is re-asserted so two editors clicking at the same
          // moment cannot both win. The loser updates zero rows and rolls back
          // with its audit entry.
          and(eq(table.id, entityId), eq(table.status, from)),
        )
        .returning({ id: table.id });

      if (updated.length !== 1) throw new ConcurrentTransition();
      return entry.id;
    });
  } catch (error) {
    if (error instanceof ConcurrentTransition) {
      return {
        ok: false,
        status: 409,
        error: 'Somebody else changed this record a moment ago. Reload and look again.',
      };
    }
    console.error('[publishing] failed:', error);
    throw error;
  }

  /**
   * THE DEPLOY HOOK IS OUTSIDE THE TRANSACTION, AND AFTER IT.
   *
   * The database has already committed by the time this runs, and its outcome
   * cannot roll anything back. That is deliberate and is the rule in §13: the
   * database is the source of truth and the deploy is a delivery mechanism.
   *
   * If Vercel is unreachable, the record is still published — it is simply not
   * on the CDN yet, and the nightly rebuild will carry it there. Rolling back
   * an editorial decision because a third party had an outage would be the
   * worse failure by a wide margin, and for a takedown it would be dangerous:
   * "we could not reach Vercel so we put it back up" is not acceptable
   * behaviour for a correction path.
   */
  const deployOutcome = await deploy();

  return { ok: true, entityType, entityId, from, to, auditId, deploy: deployOutcome };
}

/** Signals a lost race, so the catch above can tell it from a real fault. */
class ConcurrentTransition extends Error {
  constructor() {
    super('Record changed concurrently.');
    this.name = 'ConcurrentTransition';
  }
}

/**
 * Ask Vercel for a fresh production build.
 *
 * The same hook the nightly cron calls — one deploy path, not two. Every
 * failure is reported rather than thrown: the caller has already committed an
 * editorial decision and must not be handed an exception for something that
 * did not affect it.
 */
export async function triggerDeploy(): Promise<DeployOutcome> {
  const hook = process.env.VERCEL_DEPLOY_HOOK_URL;
  if (!hook) {
    return { triggered: false, reason: 'not-configured' };
  }

  try {
    const response = await fetch(hook, { method: 'POST' });
    if (!response.ok) {
      return { triggered: false, reason: 'refused', detail: `HTTP ${response.status}` };
    }
    return { triggered: true };
  } catch (error) {
    return {
      triggered: false,
      reason: 'unreachable',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** A sentence for the editor, saying what the deploy did or did not do. */
export function deployMessage(outcome: DeployOutcome): string {
  if (outcome.triggered) return 'A rebuild is running. The site updates when it finishes.';
  switch (outcome.reason) {
    case 'not-configured':
      return 'Saved. No deploy hook is configured, so the site updates on the next build.';
    case 'refused':
      return `Saved. The deploy hook refused (${outcome.detail ?? 'no detail'}), so the site updates on the nightly rebuild.`;
    case 'unreachable':
      return 'Saved. The deploy hook could not be reached, so the site updates on the nightly rebuild.';
  }
}

// =========================================================================
// THE PUBLISH QUEUE
// =========================================================================

/** One record waiting to go live. */
export interface PublishableRow {
  entityType: EntityType;
  id: string;
  slug: string;
  title: string;
  status: ContentStatus;
  updatedAt: Date | null;
  /** Who approved it, and when, read from the audit log. */
  approvedAt: Date | null;
  approvedBy: string | null;
  /** The submission this came from, when it came from one. */
  submissionId: string | null;
  submitterName: string | null;
}

/**
 * Everything approved and not yet published, plus anything archived.
 *
 * Reads every publishable table and merges. That is eight queries rather than
 * one, because the tables genuinely are different shapes; it happens once per
 * page load on a screen an editor opens a few times a day.
 */
export async function listPublishable(
  db: AnyDatabase,
  statuses: readonly ContentStatus[] = ['approved'],
): Promise<PublishableRow[]> {
  const rows: PublishableRow[] = [];

  for (const entityType of ENTITY_TYPES) {
    const { table, title } = PUBLISHABLE[entityType];

    const found = await db
      .select({
        id: table.id,
        slug: table.slug,
        title: sql<string>`${title}`,
        status: table.status,
        updatedAt: table.updatedAt,
      })
      .from(table)
      .where(inArray(table.status, [...statuses]));

    for (const row of found) {
      rows.push({
        entityType,
        id: row.id,
        slug: row.slug,
        title: row.title,
        status: row.status,
        updatedAt: row.updatedAt,
        approvedAt: null,
        approvedBy: null,
        submissionId: null,
        submitterName: null,
      });
    }
  }

  if (rows.length === 0) return rows;

  /**
   * Who approved each one, from the audit log.
   *
   * The log is the record of what happened, so the approval is read from it
   * rather than from a column somebody would have to remember to write. One
   * query for all of them, keyed by entity id.
   */
  const ids = rows.map((row) => row.id);
  const approvals = await db
    .select({
      entityId: schema.auditLog.entityId,
      actorEmail: schema.auditLog.actorEmail,
      createdAt: schema.auditLog.createdAt,
    })
    .from(schema.auditLog)
    .where(and(inArray(schema.auditLog.entityId, ids), eq(schema.auditLog.toStatus, 'approved')));

  const latest = new Map<string, { email: string | null; at: Date }>();
  for (const row of approvals) {
    if (!row.entityId) continue;
    const existing = latest.get(row.entityId);
    if (!existing || row.createdAt > existing.at) {
      latest.set(row.entityId, { email: row.actorEmail, at: row.createdAt });
    }
  }

  /** And which submission each came from, so the queue can credit a person. */
  const promoted = await db
    .select({
      id: schema.submissions.id,
      entityId: schema.submissions.entityId,
      submitterName: schema.submissions.submitterName,
    })
    .from(schema.submissions)
    .where(inArray(schema.submissions.entityId, ids));

  const bySource = new Map(promoted.map((row) => [row.entityId!, row]));

  for (const row of rows) {
    const approval = latest.get(row.id);
    if (approval) {
      row.approvedAt = approval.at;
      row.approvedBy = approval.email;
    }
    const source = bySource.get(row.id);
    if (source) {
      row.submissionId = source.id;
      row.submitterName = source.submitterName;
    }
  }

  // Oldest approval first — the same principle as the review queue. Something
  // approved two weeks ago and never shipped is the item worth surfacing.
  return rows.sort((a, b) => (a.approvedAt?.getTime() ?? 0) - (b.approvedAt?.getTime() ?? 0));
}

/** How many records sit in each publishable state. Drives the header counts. */
export async function countPublishable(
  db: AnyDatabase,
): Promise<{ approved: number; published: number; archived: number }> {
  const out = { approved: 0, published: 0, archived: 0 };

  for (const entityType of ENTITY_TYPES) {
    const { table } = PUBLISHABLE[entityType];
    const found = await db
      .select({ status: table.status, n: sql<number>`count(*)::int` })
      .from(table)
      .groupBy(table.status);

    for (const row of found) {
      if (row.status === 'approved') out.approved += Number(row.n);
      else if (row.status === 'published') out.published += Number(row.n);
      else if (row.status === 'archived') out.archived += Number(row.n);
    }
  }

  return out;
}
