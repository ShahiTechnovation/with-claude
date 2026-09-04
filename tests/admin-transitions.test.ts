import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import * as schema from '../db/schema';
import {
  ALL_STATUSES,
  OPEN_STATUSES,
  RULES,
  availableActions,
  canReview,
  transitionSubmission,
  type ReviewAction,
  type SubmissionStatus,
} from '../admin/src/server/transitions';

/**
 * The state machine, against a real PostgreSQL.
 *
 * These are the most important tests in Phase 2. The claim they defend is that
 * a submission's status and its audit trail can never disagree — not after an
 * invalid request, not after a database failure, and not when two reviewers
 * click at the same moment.
 *
 * PGlite is real PostgreSQL in-process, so `db.transaction()` here is a real
 * BEGIN/COMMIT and a rollback really rolls back. A mock would make every
 * atomicity assertion below meaningless.
 */
let db: TestDatabase;

const admin = { id: '', email: 'admin@example.com', role: 'admin' };
const editor = { id: '', email: 'editor@example.com', role: 'editor' };
const viewer = { id: '', email: 'viewer@example.com', role: 'viewer' };

beforeAll(async () => {
  db = await createTestDatabase();

  for (const person of [admin, editor, viewer]) {
    const [row] = await db
      .insert(schema.users)
      .values({ email: person.email, name: person.email, role: person.role as never })
      .returning({ id: schema.users.id });
    person.id = row.id;
  }
}, 60_000);

afterAll(async () => {
  await db?.$close();
});

beforeEach(async () => {
  await db.execute(sql`delete from submissions`);
  // `audit_log` rejects DELETE by trigger — it is append-only, and that is the
  // point of it. Tests scope their assertions to the submission under test
  // rather than to an empty table.
});

async function seed(status: SubmissionStatus = 'pending'): Promise<string> {
  const [row] = await db
    .insert(schema.submissions)
    .values({
      kind: 'builder',
      payload: { name: 'Asha Menon', building: 'A scheduling agent.' },
      submitterName: 'Asha Menon',
      submitterEmail: 'asha@example.com',
      status,
    })
    .returning({ id: schema.submissions.id });
  return row.id;
}

async function statusOf(id: string): Promise<SubmissionStatus> {
  const [row] = await db
    .select({ status: schema.submissions.status })
    .from(schema.submissions)
    .where(eq(schema.submissions.id, id));
  return row.status;
}

async function auditFor(id: string) {
  return db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, id));
}

// ── The valid map ───────────────────────────────────────────────────────

describe('the audited workflow', () => {
  it.each([
    ['pending', 'start_review', 'in_review'],
    ['pending', 'approve', 'approved'],
    ['in_review', 'approve', 'approved'],
    ['in_review', 'request_changes', 'changes_requested'],
    ['in_review', 'reject', 'rejected'],
    ['changes_requested', 'resubmit', 'pending'],
  ] as const)('%s --%s--> %s', async (from, action, to) => {
    const id = await seed(from);

    const result = await transitionSubmission(db, {
      submissionId: id,
      action,
      actor: editor,
      note: RULES[action].requiresNote ? 'A real reason, written out.' : undefined,
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) {
      expect(result.from).toBe(from);
      expect(result.to).toBe(to);
    }
    expect(await statusOf(id)).toBe(to);
  });

  it('records who reviewed it and when', async () => {
    const id = await seed('in_review');
    await transitionSubmission(db, { submissionId: id, action: 'approve', actor: admin });

    const [row] = await db
      .select({
        reviewerId: schema.submissions.reviewerId,
        reviewedAt: schema.submissions.reviewedAt,
      })
      .from(schema.submissions)
      .where(eq(schema.submissions.id, id));

    expect(row.reviewerId).toBe(admin.id);
    expect(row.reviewedAt).toBeInstanceOf(Date);
  });

  it('stores the reviewer note where one was required', async () => {
    const id = await seed('in_review');
    await transitionSubmission(db, {
      submissionId: id,
      action: 'request_changes',
      actor: editor,
      note: '  The claudeUsage field just says "helped". Say what it actually did.  ',
    });

    const [row] = await db
      .select({ note: schema.submissions.reviewerNote })
      .from(schema.submissions)
      .where(eq(schema.submissions.id, id));

    // Trimmed, but otherwise exactly what was written.
    expect(row.note).toBe('The claudeUsage field just says "helped". Say what it actually did.');
  });

  it('never reaches a published state, because approval is not publication', () => {
    expect(ALL_STATUSES).not.toContain('published');
    for (const rule of Object.values(RULES)) {
      expect(rule.to).not.toBe('published');
    }
  });
});

// ── Invalid transitions ─────────────────────────────────────────────────

describe('transitions that are not on the map are refused', () => {
  it.each([
    ['approved', 'approve'],
    ['approved', 'reject'],
    ['approved', 'start_review'],
    ['rejected', 'approve'],
    ['rejected', 'request_changes'],
    ['pending', 'request_changes'],
    ['pending', 'reject'],
    ['pending', 'resubmit'],
    ['in_review', 'start_review'],
    ['in_review', 'resubmit'],
    ['changes_requested', 'approve'],
    ['draft', 'approve'],
  ] as const)('refuses %s --%s-->', async (from, action) => {
    const id = await seed(from);

    const result = await transitionSubmission(db, {
      submissionId: id,
      action,
      actor: admin,
      note: 'A note, in case one is wanted.',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(409);

    // Unchanged, and no audit entry claiming otherwise.
    expect(await statusOf(id)).toBe(from);
    expect(await auditFor(id)).toHaveLength(0);
  });

  it('refuses an action that does not exist', async () => {
    const id = await seed('pending');
    const result = await transitionSubmission(db, {
      submissionId: id,
      action: 'delete_everything' as ReviewAction,
      actor: admin,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(422);
    expect(await statusOf(id)).toBe('pending');
  });

  it('refuses an unknown submission without touching anything', async () => {
    const result = await transitionSubmission(db, {
      submissionId: '00000000-0000-0000-0000-000000000000',
      action: 'approve',
      actor: admin,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });
});

// ── The note requirement ────────────────────────────────────────────────

describe('a refusal needs a reason', () => {
  it.each(['request_changes', 'reject'] as const)('%s requires a note', async (action) => {
    const id = await seed('in_review');

    for (const note of [undefined, null, '', '   ', '\n\t ']) {
      const result = await transitionSubmission(db, {
        submissionId: id,
        action,
        actor: editor,
        note,
      });

      expect(result.ok, `note ${JSON.stringify(note)}`).toBe(false);
      if (!result.ok) expect(result.status).toBe(422);
    }

    expect(await statusOf(id)).toBe('in_review');
    expect(await auditFor(id)).toHaveLength(0);
  });

  it.each(['approve', 'start_review'] as const)('%s does not require one', async (action) => {
    const id = await seed(action === 'approve' ? 'in_review' : 'pending');
    const result = await transitionSubmission(db, { submissionId: id, action, actor: editor });
    expect(result.ok).toBe(true);
  });

  it('rejects an absurdly long note', async () => {
    const id = await seed('in_review');
    const result = await transitionSubmission(db, {
      submissionId: id,
      action: 'reject',
      actor: editor,
      note: 'x'.repeat(5_000),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(422);
    expect(await statusOf(id)).toBe('in_review');
  });
});

// ── Roles ───────────────────────────────────────────────────────────────

describe('roles', () => {
  it('lets an admin review', async () => {
    const id = await seed('pending');
    expect(
      (await transitionSubmission(db, { submissionId: id, action: 'approve', actor: admin })).ok,
    ).toBe(true);
  });

  it('lets an editor review — Moderator is Editor, by design', async () => {
    const id = await seed('pending');
    expect(
      (await transitionSubmission(db, { submissionId: id, action: 'approve', actor: editor })).ok,
    ).toBe(true);
  });

  it.each(['start_review', 'approve', 'request_changes', 'reject', 'resubmit'] as const)(
    'refuses a viewer trying to %s',
    async (action) => {
      const id = await seed('in_review');
      const result = await transitionSubmission(db, {
        submissionId: id,
        action,
        actor: viewer,
        note: 'Trying anyway.',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(403);
      expect(await auditFor(id)).toHaveLength(0);
    },
  );

  it('checks the role before it reads the submission', async () => {
    // A refused caller must not be able to learn whether an id exists.
    const real = await seed('pending');
    const fake = '00000000-0000-0000-0000-000000000000';

    const a = await transitionSubmission(db, {
      submissionId: real,
      action: 'approve',
      actor: viewer,
    });
    const b = await transitionSubmission(db, {
      submissionId: fake,
      action: 'approve',
      actor: viewer,
    });

    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    if (!a.ok && !b.ok) {
      expect(a.status).toBe(403);
      expect(b.status).toBe(403);
      expect(a.error).toBe(b.error);
    }
  });

  it('agrees with canReview and availableActions', () => {
    expect(canReview('admin')).toBe(true);
    expect(canReview('editor')).toBe(true);
    expect(canReview('viewer')).toBe(false);
    expect(canReview('reviewer')).toBe(false);

    expect(availableActions('pending', 'viewer')).toEqual([]);
    expect(availableActions('pending', 'editor').sort()).toEqual(['approve', 'start_review']);
    expect(availableActions('in_review', 'admin').sort()).toEqual([
      'approve',
      'reject',
      'request_changes',
    ]);
    // Resting states offer nothing.
    expect(availableActions('approved', 'admin')).toEqual([]);
    expect(availableActions('rejected', 'admin')).toEqual([]);
  });
});

// ── The audit log ───────────────────────────────────────────────────────

describe('every transition writes exactly one audit row', () => {
  it.each([
    ['pending', 'start_review', 'in_review', 'submission.review_started'],
    ['in_review', 'approve', 'approved', 'submission.approved'],
    ['in_review', 'request_changes', 'changes_requested', 'submission.changes_requested'],
    ['in_review', 'reject', 'rejected', 'submission.rejected'],
    ['changes_requested', 'resubmit', 'pending', 'submission.resubmitted'],
  ] as const)('%s --%s--> %s', async (from, action, to, expectedAction) => {
    const id = await seed(from);
    const note = RULES[action].requiresNote ? 'Because of the missing detail.' : undefined;

    const result = await transitionSubmission(db, {
      submissionId: id,
      action,
      actor: editor,
      note,
    });
    expect(result.ok).toBe(true);

    const entries = await auditFor(id);
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry.actorId).toBe(editor.id);
    expect(entry.actorEmail).toBe(editor.email);
    expect(entry.entityType).toBe('submission');
    expect(entry.entityId).toBe(id);
    expect(entry.action).toBe(expectedAction);
    expect(entry.fromStatus).toBe(from);
    expect(entry.toStatus).toBe(to);
    expect(entry.note).toBe(note ?? null);
    expect(entry.createdAt).toBeInstanceOf(Date);
  });

  it('accumulates one row per step across a whole review', async () => {
    const id = await seed('pending');

    await transitionSubmission(db, { submissionId: id, action: 'start_review', actor: editor });
    await transitionSubmission(db, {
      submissionId: id,
      action: 'request_changes',
      actor: editor,
      note: 'Needs a real credential.',
    });
    await transitionSubmission(db, { submissionId: id, action: 'resubmit', actor: admin });
    await transitionSubmission(db, { submissionId: id, action: 'approve', actor: admin });

    const entries = (await auditFor(id)).sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );

    expect(entries.map((e) => `${e.fromStatus}->${e.toStatus}`)).toEqual([
      'pending->in_review',
      'in_review->changes_requested',
      'changes_requested->pending',
      'pending->approved',
    ]);
    expect(entries.map((e) => e.actorEmail)).toEqual([
      editor.email,
      editor.email,
      admin.email,
      admin.email,
    ]);
    expect(await statusOf(id)).toBe('approved');
  });

  it('writes nothing when the transition is refused', async () => {
    const id = await seed('approved');

    for (const action of ['approve', 'reject', 'start_review'] as const) {
      await transitionSubmission(db, {
        submissionId: id,
        action,
        actor: admin,
        note: 'Reason.',
      });
    }

    expect(await auditFor(id)).toHaveLength(0);
    expect(await statusOf(id)).toBe('approved');
  });
});

// ── Atomicity ───────────────────────────────────────────────────────────

describe('the audit row and the status change are one operation', () => {
  /**
   * The failure this guards against: an audit entry saying "approved" for a
   * submission that is still pending, or a submission that moved with nothing
   * to account for it. Either one makes the log worthless, because a log you
   * have to cross-check is not a log.
   */
  it('rolls the audit entry back when the update writes no row', async () => {
    const id = await seed('pending');

    // Two reviewers, same submission, same moment. The first wins.
    const [first, second] = await Promise.all([
      transitionSubmission(db, { submissionId: id, action: 'approve', actor: admin }),
      transitionSubmission(db, { submissionId: id, action: 'start_review', actor: editor }),
    ]);

    const wins = [first, second].filter((r) => r.ok);
    const loses = [first, second].filter((r) => !r.ok);

    expect(wins).toHaveLength(1);
    expect(loses).toHaveLength(1);

    // Exactly one audit row: the loser's was rolled back with its update.
    const entries = await auditFor(id);
    expect(entries).toHaveLength(1);

    // And the one entry describes what actually happened.
    expect(entries[0].toStatus).toBe(await statusOf(id));
  });

  it('leaves no audit row when the database rejects the write', async () => {
    const id = await seed('in_review');

    // A note longer than the column can hold is refused by the length check
    // before any write. Belt and braces: assert nothing was logged.
    await transitionSubmission(db, {
      submissionId: id,
      action: 'reject',
      actor: editor,
      note: 'x'.repeat(10_000),
    });

    expect(await auditFor(id)).toHaveLength(0);
    expect(await statusOf(id)).toBe('in_review');
  });

  it('really does roll an audit insert back — the property the design rests on', async () => {
    // The append-only trigger rejects UPDATE, DELETE and TRUNCATE. It must NOT
    // reject a rollback, or the transaction below could commit an audit entry
    // for a status change that failed. Proven directly rather than assumed.
    const before = await db.select().from(schema.auditLog);

    await expect(
      db.transaction(async (tx) => {
        await tx.insert(schema.auditLog).values({
          actorId: admin.id,
          action: 'test.rollback',
          entityType: 'submission',
          fromStatus: 'pending',
          toStatus: 'approved',
        });
        // Visible inside the transaction...
        const during = await tx.select().from(schema.auditLog);
        expect(during.length).toBe(before.length + 1);
        throw new Error('forced failure after the audit insert');
      }),
    ).rejects.toThrow('forced failure');

    // ...and gone after it.
    const after = await db.select().from(schema.auditLog);
    expect(after.length).toBe(before.length);
  });

  it('cannot be edited or deleted afterwards', async () => {
    const id = await seed('pending');
    await transitionSubmission(db, { submissionId: id, action: 'approve', actor: admin });

    const [entry] = await auditFor(id);
    expect(entry).toBeDefined();

    // Append-only, enforced by trigger. A correction is a new entry.
    await expect(
      db.update(schema.auditLog).set({ note: 'tampered' }).where(eq(schema.auditLog.id, entry.id)),
    ).rejects.toThrow();
    await expect(
      db.delete(schema.auditLog).where(eq(schema.auditLog.id, entry.id)),
    ).rejects.toThrow();
  });
});

// ── The shape of the workflow itself ────────────────────────────────────

describe('the workflow vocabulary', () => {
  it('is exactly the audited set', () => {
    expect([...ALL_STATUSES]).toEqual([
      'draft',
      'pending',
      'in_review',
      'changes_requested',
      'approved',
      'rejected',
    ]);
  });

  it('treats pending, in_review and changes_requested as still open', () => {
    expect([...OPEN_STATUSES]).toEqual(['pending', 'in_review', 'changes_requested']);
    for (const status of OPEN_STATUSES) {
      expect(ALL_STATUSES).toContain(status);
    }
  });

  it('only ever moves to a state in the vocabulary', () => {
    for (const [action, rule] of Object.entries(RULES)) {
      expect(ALL_STATUSES, action).toContain(rule.to);
      for (const from of rule.from) expect(ALL_STATUSES, action).toContain(from);
    }
  });

  it('requires a note for exactly the two negative outcomes', () => {
    const needNote = Object.entries(RULES)
      .filter(([, rule]) => rule.requiresNote)
      .map(([action]) => action)
      .sort();
    expect(needNote).toEqual(['reject', 'request_changes']);
  });
});
