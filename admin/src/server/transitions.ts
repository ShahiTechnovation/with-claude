/**
 * THE submission state machine.
 *
 * Every change to `submissions.status` goes through `transitionSubmission()`.
 * No route writes that column directly, and none should: the moment two places
 * can move a submission, the audit log stops being a complete account of what
 * happened to it, and an audit log with a gap is not an audit log.
 *
 * WHAT THIS FUNCTION IS RESPONSIBLE FOR, IN ORDER
 *
 *   1. the actor's role                — may this person review at all?
 *   2. the submission exists           — 404 rather than a silent no-op
 *   3. the transition is on the map    — no arbitrary status writes
 *   4. the note requirement            — a refusal without a reason is not one
 *   5. audit entry AND status change   — in one transaction, or neither
 *
 * THE TRANSACTION IS THE POINT. The audit row is written first and the status
 * second, inside a single BEGIN/COMMIT. If the update fails, the audit row
 * rolls back with it, so the log never claims a change that did not happen. If
 * the audit insert fails, the status never moves, so a change never happens
 * unaccounted for. Both halves or neither.
 *
 * APPROVED IS NOT PUBLISHED. `approved` is the end of the line here. It means
 * a person read this and it belongs in the record; it does not put anything on
 * the website. Publication is tied to a build and is Phase 3's problem, which
 * is exactly why the two are different words.
 */
import { and, eq } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../../../db/schema';

type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

/** The audited submission lifecycle. */
export type SubmissionStatus = (typeof schema.submissionStatus.enumValues)[number];

/** What a reviewer can do. Named for the act, not for the resulting state. */
export type ReviewAction = 'start_review' | 'approve' | 'request_changes' | 'reject' | 'resubmit';

export interface Actor {
  id: string;
  email: string;
  role: string;
}

interface Rule {
  /** States this action may be taken from. Anything else is refused. */
  from: readonly SubmissionStatus[];
  to: SubmissionStatus;
  /** True when the action is meaningless without a written reason. */
  requiresNote: boolean;
  /** Roles permitted to take it. */
  roles: readonly string[];
  /** Written to `audit_log.action`. */
  auditAction: string;
  /** Shown in the UI. */
  label: string;
}

/**
 * The whole map. If a transition is not on it, it cannot happen.
 *
 *     draft ─┐
 *            ├→ pending ─┬→ in_review ─┬→ changes_requested ─→ pending
 *            │           │             ├→ approved
 *            │           └→ approved   └→ rejected
 *
 * `pending → approved` is here because a small queue does not need a
 * ceremonial "claim it first" step for something obviously fine, and forcing
 * one would only teach reviewers to click through it. `in_review` stays
 * available for anything that warrants a second look, and is required before
 * the two decisions that need a reason.
 */
const REVIEW_ROLES = ['admin', 'editor'] as const;

export const RULES: Record<ReviewAction, Rule> = {
  start_review: {
    from: ['pending'],
    to: 'in_review',
    requiresNote: false,
    roles: REVIEW_ROLES,
    auditAction: 'submission.review_started',
    label: 'Start review',
  },
  approve: {
    from: ['pending', 'in_review'],
    to: 'approved',
    requiresNote: false,
    roles: REVIEW_ROLES,
    auditAction: 'submission.approved',
    label: 'Approve',
  },
  request_changes: {
    // Only from `in_review`: asking somebody to change something you have not
    // said you are reading is not a review step, it is a guess.
    from: ['in_review'],
    to: 'changes_requested',
    requiresNote: true,
    roles: REVIEW_ROLES,
    auditAction: 'submission.changes_requested',
    label: 'Request changes',
  },
  reject: {
    from: ['in_review'],
    to: 'rejected',
    requiresNote: true,
    roles: REVIEW_ROLES,
    auditAction: 'submission.rejected',
    label: 'Reject',
  },
  resubmit: {
    from: ['changes_requested'],
    to: 'pending',
    requiresNote: false,
    roles: REVIEW_ROLES,
    auditAction: 'submission.resubmitted',
    label: 'Return to queue',
  },
};

/** Every state a submission can be in, in the order the workflow runs. */
export const ALL_STATUSES: readonly SubmissionStatus[] = schema.submissionStatus.enumValues;

/** The states that still need somebody to do something. */
export const OPEN_STATUSES: readonly SubmissionStatus[] = [
  'pending',
  'in_review',
  'changes_requested',
];

export type TransitionFailure =
  | { ok: false; status: 403; error: string }
  | { ok: false; status: 404; error: string }
  | { ok: false; status: 409; error: string }
  | { ok: false; status: 422; error: string };

export type TransitionResult =
  | {
      ok: true;
      submissionId: string;
      from: SubmissionStatus;
      to: SubmissionStatus;
      auditId: string;
    }
  | TransitionFailure;

/** Note length ceiling. Long enough for a real explanation, bounded anyway. */
export const NOTE_MAX = 2_000;

export interface TransitionInput {
  submissionId: string;
  action: ReviewAction;
  actor: Actor;
  note?: string | null;
}

/**
 * Which actions this actor could take on a submission in this state.
 *
 * Used to render the buttons, so the UI can never offer a move the state
 * machine would refuse. It is a convenience, not a control: the same rules are
 * re-checked on the POST, because a button is a suggestion and a request is
 * what actually arrives.
 */
export function availableActions(status: SubmissionStatus, role: string): ReviewAction[] {
  return (Object.keys(RULES) as ReviewAction[]).filter((action) => {
    const rule = RULES[action];
    return rule.roles.includes(role) && rule.from.includes(status);
  });
}

export function canReview(role: string): boolean {
  return (REVIEW_ROLES as readonly string[]).includes(role);
}

export async function transitionSubmission(
  db: AnyDatabase,
  { submissionId, action, actor, note }: TransitionInput,
): Promise<TransitionResult> {
  const rule = RULES[action];
  if (!rule) {
    return { ok: false, status: 422, error: `Unknown action "${String(action)}".` };
  }

  // 1. Role. Checked before anything is read, so an unauthorised caller learns
  //    nothing about whether the submission exists.
  if (!rule.roles.includes(actor.role)) {
    return {
      ok: false,
      status: 403,
      error: `Your role (${actor.role}) cannot ${rule.label.toLowerCase()}.`,
    };
  }

  // 4a. The note requirement is checked before the read too, because it is a
  //     property of the request rather than of the record.
  const trimmed = typeof note === 'string' ? note.trim() : '';
  if (rule.requiresNote && trimmed.length === 0) {
    return {
      ok: false,
      status: 422,
      error: `"${rule.label}" needs a note saying why. The submitter is a person who spent time on this.`,
    };
  }
  if (trimmed.length > NOTE_MAX) {
    return { ok: false, status: 422, error: `The note must be under ${NOTE_MAX} characters.` };
  }

  // 2. The submission.
  const [current] = await db
    .select({ id: schema.submissions.id, status: schema.submissions.status })
    .from(schema.submissions)
    .where(eq(schema.submissions.id, submissionId));

  if (!current) {
    return { ok: false, status: 404, error: 'No submission with that id.' };
  }

  // 3. The transition.
  if (!rule.from.includes(current.status)) {
    return {
      ok: false,
      status: 409,
      error:
        `Cannot ${rule.label.toLowerCase()} a submission that is "${current.status}". ` +
        `That action applies to: ${rule.from.join(', ')}.`,
    };
  }

  const from = current.status;
  const to = rule.to;
  const reviewedAt = new Date();

  // 5. Both halves, or neither.
  try {
    return await db.transaction(async (tx) => {
      const [entry] = await tx
        .insert(schema.auditLog)
        .values({
          actorId: actor.id,
          // Kept alongside the id so the entry still reads correctly after an
          // account is removed.
          actorEmail: actor.email,
          action: rule.auditAction,
          entityType: 'submission',
          entityId: submissionId,
          fromStatus: from,
          toStatus: to,
          note: trimmed.length > 0 ? trimmed : null,
        })
        .returning({ id: schema.auditLog.id });

      const updated = await tx
        .update(schema.submissions)
        .set({
          status: to,
          reviewerId: actor.id,
          reviewerNote: trimmed.length > 0 ? trimmed : null,
          reviewedAt,
        })
        .where(
          // The status is re-asserted in the WHERE clause so two reviewers
          // clicking at the same moment cannot both win. The second one
          // updates zero rows and is rolled back below with its audit entry.
          and(eq(schema.submissions.id, submissionId), eq(schema.submissions.status, from)),
        )
        .returning({ id: schema.submissions.id });

      if (updated.length !== 1) {
        // Rolls back the audit entry too. The log must never record a move
        // that did not happen.
        throw new ConcurrentTransition();
      }

      return {
        ok: true as const,
        submissionId,
        from,
        to,
        auditId: entry.id,
      };
    });
  } catch (error) {
    if (error instanceof ConcurrentTransition) {
      return {
        ok: false,
        status: 409,
        error: 'Somebody else changed this submission a moment ago. Reload and look again.',
      };
    }
    // A real database failure. The transaction rolled back, so there is no
    // audit row and no status change — the two are still consistent with each
    // other, which is the property worth protecting.
    console.error('[transition] failed:', error);
    throw error;
  }
}

/** Signals a lost race, so the catch above can tell it from a real fault. */
class ConcurrentTransition extends Error {
  constructor() {
    super('Submission changed concurrently.');
    this.name = 'ConcurrentTransition';
  }
}
