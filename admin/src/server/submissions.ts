/**
 * Reading the inbox.
 *
 * THE PRIVACY BOUNDARY IS IN THIS FILE, and it is enforced by what these
 * queries select rather than by what the templates remember to leave out.
 *
 * `select()` with an explicit column list means `submitter_email`, `ip_hash`
 * and `user_agent` are not merely unrendered on the queue — they are never
 * fetched, never in memory, and cannot leak into a page by somebody later
 * writing `JSON.stringify(row)` or adding a debug dump. The list view
 * literally cannot show what it does not have.
 *
 * The detail view is the one place an email is read, because a reviewer
 * sometimes has to write back to a person, and even there it is fetched by a
 * separate function with a name that says so out loud.
 */
import { and, asc, count, desc, eq, inArray } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../../../db/schema';
import { formById } from '../../../src/data/forms';
import { OPEN_STATUSES, type SubmissionStatus } from './transitions';

/**
 * Which public form produced each submission kind.
 *
 * The inverse of the map `/api/submit` uses to classify an incoming form.
 * Only used to order fields for reading — see `orderedPayload`.
 */
const FORM_BY_KIND: Record<string, ReturnType<typeof formById.get>> = {
  builder: formById.get('contribute'),
  project: formById.get('build'),
  'use-case': formById.get('practice'),
  'city-interest': formById.get('city'),
};

type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * One row in the queue.
 *
 * Note the absences: no email, no IP hash, no user agent, and no payload. A
 * queue answers "what is waiting and how long has it waited". Nothing else
 * belongs on it.
 */
export interface QueueRow {
  id: string;
  kind: string;
  submitterName: string | null;
  status: SubmissionStatus;
  createdAt: Date;
}

/** The exact columns the queue may see. Referenced by the privacy tests. */
export const QUEUE_COLUMNS = {
  id: schema.submissions.id,
  kind: schema.submissions.kind,
  submitterName: schema.submissions.submitterName,
  status: schema.submissions.status,
  createdAt: schema.submissions.createdAt,
} as const;

/** Columns that must never appear in a queue result. Asserted in tests. */
export const PRIVATE_COLUMNS = ['submitterEmail', 'ipHash', 'userAgent'] as const;

export interface QueueFilter {
  /** Which states to show. Defaults to everything still needing attention. */
  statuses?: readonly SubmissionStatus[];
  kind?: string;
  limit?: number;
  offset?: number;
}

/**
 * The queue.
 *
 * OLDEST FIRST, deliberately. A review queue sorted newest-first quietly
 * buries the thing that has been waiting longest, which is the one item the
 * queue exists to surface. Somebody who submitted twelve days ago should be at
 * the top of the screen, not four pages down it.
 */
export async function listSubmissions(
  db: AnyDatabase,
  filter: QueueFilter = {},
): Promise<QueueRow[]> {
  const statuses = filter.statuses ?? OPEN_STATUSES;

  const conditions = [inArray(schema.submissions.status, [...statuses])];
  if (filter.kind) {
    conditions.push(eq(schema.submissions.kind, filter.kind as never));
  }

  const rows = await db
    .select(QUEUE_COLUMNS)
    .from(schema.submissions)
    .where(and(...conditions))
    .orderBy(asc(schema.submissions.createdAt))
    .limit(Math.min(filter.limit ?? 100, 200))
    .offset(filter.offset ?? 0);

  return rows as QueueRow[];
}

/** How many submissions sit in each state. Drives the filter chips. */
export async function countByStatus(db: AnyDatabase): Promise<Record<SubmissionStatus, number>> {
  const rows = await db
    .select({ status: schema.submissions.status, n: count() })
    .from(schema.submissions)
    .groupBy(schema.submissions.status);

  const out = Object.fromEntries(schema.submissionStatus.enumValues.map((s) => [s, 0])) as Record<
    SubmissionStatus,
    number
  >;

  for (const row of rows) out[row.status] = Number(row.n);
  return out;
}

/**
 * One submission, in full, for an authenticated reviewer.
 *
 * This is the only query in the application that reads `submitter_email`, and
 * the only one that reads the raw payload. Both are deliberate: a reviewer
 * needs to see exactly what the person wrote, and sometimes needs to write
 * back to them.
 *
 * `ip_hash` and `user_agent` are still NOT selected. They exist for abuse
 * triage, which is a different job from editorial review, and a reviewer
 * deciding whether a project write-up is any good has no use for either.
 */
export interface SubmissionDetail {
  id: string;
  kind: string;
  /** Exactly what was submitted, untransformed. */
  payload: unknown;
  submitterName: string | null;
  /** Private. Rendered only on the authenticated detail page. */
  submitterEmail: string;
  status: SubmissionStatus;
  reviewerNote: string | null;
  reviewedAt: Date | null;
  reviewerEmail: string | null;
  reviewerName: string | null;
  createdAt: Date;
  /**
   * What this submission created, once an editor promoted it.
   *
   * Written by promotion and by nothing else. The pair IS the record of
   * whether this has been promoted — there is no separate flag that could
   * disagree with it — which is also what makes promotion idempotent.
   */
  entityType: string | null;
  entityId: string | null;
}

export async function getSubmission(
  db: AnyDatabase,
  id: string,
): Promise<SubmissionDetail | undefined> {
  const reviewer = schema.users;

  const [row] = await db
    .select({
      id: schema.submissions.id,
      kind: schema.submissions.kind,
      payload: schema.submissions.payload,
      submitterName: schema.submissions.submitterName,
      submitterEmail: schema.submissions.submitterEmail,
      status: schema.submissions.status,
      reviewerNote: schema.submissions.reviewerNote,
      reviewedAt: schema.submissions.reviewedAt,
      reviewerEmail: reviewer.email,
      reviewerName: reviewer.name,
      createdAt: schema.submissions.createdAt,
      entityType: schema.submissions.entityType,
      entityId: schema.submissions.entityId,
    })
    .from(schema.submissions)
    .leftJoin(reviewer, eq(schema.submissions.reviewerId, reviewer.id))
    .where(eq(schema.submissions.id, id));

  return row as SubmissionDetail | undefined;
}

/** Everything that has happened to one submission, newest first. */
export async function historyOf(db: AnyDatabase, submissionId: string) {
  return db
    .select({
      id: schema.auditLog.id,
      action: schema.auditLog.action,
      fromStatus: schema.auditLog.fromStatus,
      toStatus: schema.auditLog.toStatus,
      note: schema.auditLog.note,
      actorEmail: schema.auditLog.actorEmail,
      createdAt: schema.auditLog.createdAt,
    })
    .from(schema.auditLog)
    .where(
      and(eq(schema.auditLog.entityType, 'submission'), eq(schema.auditLog.entityId, submissionId)),
    )
    .orderBy(desc(schema.auditLog.createdAt));
}

/**
 * `2 hours`, `3 days`, `12 days` — how long this has been waiting.
 *
 * The number the queue is actually about. Rounded down and never dressed up:
 * something that has waited twelve days says twelve days, because the point of
 * putting it on the screen is to be uncomfortable about it.
 */
export function ageLabel(from: Date, now: Date = new Date()): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 1000));

  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;

  const days = Math.floor(hours / 24);
  if (days < 31) return `${days} ${days === 1 ? 'day' : 'days'}`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months} ${months === 1 ? 'month' : 'months'}`;

  const years = Math.floor(days / 365);
  return `${years} ${years === 1 ? 'year' : 'years'}`;
}

/**
 * The payload's fields, in the order the person met them on the form.
 *
 * PostgreSQL `jsonb` does not preserve key order — it stores keys sorted by
 * length and then alphabetically — so a submission read straight back out
 * arrives as `url, city, title, creator, summary…` regardless of how it was
 * filled in. For a screen whose entire job is "read exactly what this person
 * wrote", that is a small but real defect: the reviewer is reading a shuffled
 * form.
 *
 * So the fields are re-ordered to match the form definition. Note what this
 * does NOT do: it changes no key, no value, and drops nothing. Any key the
 * form does not know about — a renamed field, a payload from an older version
 * of a form — is appended rather than hidden, because the one thing this
 * screen must never do is quietly omit something somebody submitted.
 *
 * The form definitions are the public site's, imported as plain data. If a
 * field is ever renamed there, this degrades to storage order for that field
 * and loses nothing.
 */
export function orderedPayload(
  kind: string,
  payload: unknown,
): { field: string; value: unknown }[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];

  const entries = Object.entries(payload as Record<string, unknown>);
  const form = FORM_BY_KIND[kind];
  if (!form) return entries.map(([field, value]) => ({ field, value }));

  const order = new Map(form.fields.map((f, i) => [f.name, i]));

  const known = entries
    .filter(([field]) => order.has(field))
    .sort((a, b) => order.get(a[0])! - order.get(b[0])!);
  // Anything the form does not declare still gets shown, at the end.
  const unknown = entries.filter(([field]) => !order.has(field));

  return [...known, ...unknown].map(([field, value]) => ({ field, value }));
}

/** The audit trail, newest first. Read-only, for `/audit`. */
export async function recentAudit(db: AnyDatabase, limit = 100) {
  return db
    .select({
      id: schema.auditLog.id,
      createdAt: schema.auditLog.createdAt,
      actorEmail: schema.auditLog.actorEmail,
      actorName: schema.users.name,
      entityType: schema.auditLog.entityType,
      entityId: schema.auditLog.entityId,
      action: schema.auditLog.action,
      fromStatus: schema.auditLog.fromStatus,
      toStatus: schema.auditLog.toStatus,
      note: schema.auditLog.note,
    })
    .from(schema.auditLog)
    .leftJoin(schema.users, eq(schema.auditLog.actorId, schema.users.id))
    .orderBy(desc(schema.auditLog.createdAt))
    .limit(Math.min(limit, 500));
}

/** Kept for the queue header: how many are waiting, in total. */
export async function openCount(db: AnyDatabase): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(schema.submissions)
    .where(inArray(schema.submissions.status, [...OPEN_STATUSES]));
  return Number(row?.n ?? 0);
}
