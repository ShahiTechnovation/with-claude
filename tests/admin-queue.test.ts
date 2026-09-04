import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import * as schema from '../db/schema';
import {
  PRIVATE_COLUMNS,
  QUEUE_COLUMNS,
  ageLabel,
  countByStatus,
  getSubmission,
  historyOf,
  listSubmissions,
  openCount,
  orderedPayload,
  recentAudit,
} from '../admin/src/server/submissions';
import { OPEN_STATUSES, transitionSubmission } from '../admin/src/server/transitions';

/**
 * The queue, the detail view, and the privacy line between them.
 *
 * The assertion that matters most: `submitter_email`, `ip_hash` and
 * `user_agent` are not merely unrendered on the queue — they are never
 * selected, so they are never in memory and cannot leak through a template
 * change, a debug dump or a `JSON.stringify`. These tests check the returned
 * objects for those keys directly.
 */
let db: TestDatabase;
let editorId: string;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

beforeAll(async () => {
  db = await createTestDatabase();
  const [row] = await db
    .insert(schema.users)
    .values({ email: 'editor@example.com', name: 'An Editor', role: 'editor' })
    .returning({ id: schema.users.id });
  editorId = row.id;
}, 60_000);

afterAll(async () => {
  await db?.$close();
});

beforeEach(async () => {
  await db.execute(sql`delete from submissions`);
});

interface SeedOptions {
  kind?: 'builder' | 'project' | 'use-case' | 'city-interest';
  status?: (typeof schema.submissionStatus.enumValues)[number];
  agoMs?: number;
  name?: string;
  email?: string;
  payload?: Record<string, unknown>;
}

async function seed({
  kind = 'builder',
  status = 'pending',
  agoMs = HOUR,
  name = 'Asha Menon',
  email = 'asha@example.com',
  payload = { name: 'Asha Menon', building: 'A scheduling agent for a clinic.' },
}: SeedOptions = {}): Promise<string> {
  const [row] = await db
    .insert(schema.submissions)
    .values({
      kind,
      payload,
      submitterName: name,
      submitterEmail: email,
      status,
      // Private, and deliberately populated so its absence downstream means
      // something. A test against a null column proves nothing.
      ipHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      userAgent: 'Mozilla/5.0 (test)',
      createdAt: new Date(Date.now() - agoMs),
    })
    .returning({ id: schema.submissions.id });
  return row.id;
}

// ── Privacy on the queue ────────────────────────────────────────────────

describe('the queue cannot show what it never fetched', () => {
  it('selects exactly five columns, and no private one', () => {
    expect(Object.keys(QUEUE_COLUMNS).sort()).toEqual([
      'createdAt',
      'id',
      'kind',
      'status',
      'submitterName',
    ]);

    for (const forbidden of PRIVATE_COLUMNS) {
      expect(Object.keys(QUEUE_COLUMNS)).not.toContain(forbidden);
    }
  });

  it('returns no email, IP hash or user agent on any row', async () => {
    await seed();
    await seed({ status: 'in_review', email: 'other@example.com' });

    const rows = await listSubmissions(db, { statuses: OPEN_STATUSES });
    expect(rows.length).toBe(2);

    for (const row of rows) {
      const keys = Object.keys(row);
      for (const forbidden of PRIVATE_COLUMNS) {
        expect(keys, `row keys include ${forbidden}`).not.toContain(forbidden);
      }
      // Belt and braces: the serialised row contains no address at all.
      const json = JSON.stringify(row);
      expect(json).not.toMatch(/@example\.com/);
      expect(json).not.toContain('a1b2c3d4e5f60718293a4b5c6d7e8f90');
      expect(json).not.toContain('Mozilla');
    }
  });

  it('does not fetch the payload either — a queue is not a reading list', async () => {
    await seed({ payload: { secret: 'should-not-be-on-the-queue' } });
    const rows = await listSubmissions(db);

    expect(Object.keys(rows[0])).not.toContain('payload');
    expect(JSON.stringify(rows)).not.toContain('should-not-be-on-the-queue');
  });
});

// ── Ordering ────────────────────────────────────────────────────────────

describe('oldest first', () => {
  it('puts the longest wait at the top', async () => {
    const twelveDays = await seed({ agoMs: 12 * DAY, name: 'Waited longest' });
    const twoHours = await seed({ agoMs: 2 * HOUR, name: 'Waited least' });
    const threeDays = await seed({ agoMs: 3 * DAY, name: 'Waited a while' });

    const rows = await listSubmissions(db);
    expect(rows.map((r) => r.id)).toEqual([twelveDays, threeDays, twoHours]);
    expect(rows[0].submitterName).toBe('Waited longest');
  });

  it('keeps the order stable across kinds and statuses', async () => {
    const a = await seed({ agoMs: 5 * DAY, kind: 'project', status: 'in_review' });
    const b = await seed({ agoMs: 4 * DAY, kind: 'city-interest', status: 'changes_requested' });
    const c = await seed({ agoMs: 1 * DAY, kind: 'use-case', status: 'pending' });

    const rows = await listSubmissions(db);
    expect(rows.map((r) => r.id)).toEqual([a, b, c]);
  });
});

// ── Filters ─────────────────────────────────────────────────────────────

describe('filters', () => {
  it('defaults to the three states that still need somebody', async () => {
    await seed({ status: 'pending' });
    await seed({ status: 'in_review' });
    await seed({ status: 'changes_requested' });
    await seed({ status: 'approved' });
    await seed({ status: 'rejected' });
    await seed({ status: 'draft' });

    const rows = await listSubmissions(db);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.status))).toEqual(
      new Set(['pending', 'in_review', 'changes_requested']),
    );
  });

  it('filters to one status', async () => {
    await seed({ status: 'pending' });
    await seed({ status: 'approved' });
    await seed({ status: 'approved' });

    const rows = await listSubmissions(db, { statuses: ['approved'] });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'approved')).toBe(true);
  });

  it('filters by kind', async () => {
    await seed({ kind: 'builder' });
    await seed({ kind: 'project' });
    await seed({ kind: 'project' });

    const rows = await listSubmissions(db, { kind: 'project' });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === 'project')).toBe(true);
  });

  it('combines status and kind', async () => {
    await seed({ kind: 'project', status: 'pending' });
    await seed({ kind: 'project', status: 'approved' });
    await seed({ kind: 'builder', status: 'pending' });

    const rows = await listSubmissions(db, { statuses: ['pending'], kind: 'project' });
    expect(rows).toHaveLength(1);
  });

  it('shows everything when asked for every status', async () => {
    await seed({ status: 'pending' });
    await seed({ status: 'approved' });
    await seed({ status: 'rejected' });

    const rows = await listSubmissions(db, {
      statuses: schema.submissionStatus.enumValues,
    });
    expect(rows).toHaveLength(3);
  });

  it('caps the page size so one query cannot pull the whole table', async () => {
    for (let i = 0; i < 5; i += 1) await seed({ agoMs: (i + 1) * HOUR });

    expect(await listSubmissions(db, { limit: 2 })).toHaveLength(2);
    // A request for more than the ceiling is clamped, not honoured.
    expect((await listSubmissions(db, { limit: 10_000 })).length).toBeLessThanOrEqual(200);
  });

  it('counts each state for the filter chips', async () => {
    await seed({ status: 'pending' });
    await seed({ status: 'pending' });
    await seed({ status: 'approved' });

    const counts = await countByStatus(db);
    expect(counts.pending).toBe(2);
    expect(counts.approved).toBe(1);
    expect(counts.rejected).toBe(0);
    // Every state is present as a key, so a chip never renders `undefined`.
    for (const status of schema.submissionStatus.enumValues) {
      expect(typeof counts[status]).toBe('number');
    }
  });

  it('counts what is open', async () => {
    await seed({ status: 'pending' });
    await seed({ status: 'in_review' });
    await seed({ status: 'approved' });
    expect(await openCount(db)).toBe(2);
  });
});

// ── The detail view ─────────────────────────────────────────────────────

describe('the submission detail', () => {
  it('returns the raw payload exactly as stored', async () => {
    const payload = {
      title: '  Queueless  ',
      claudeUsage: 'Drafted the state machine.\n\nAnd caught two race conditions.',
      tags: ['civic', 'agent'],
      count: 3,
      empty: '',
    };
    const id = await seed({ payload });

    const detail = await getSubmission(db, id);
    expect(detail).toBeDefined();
    // Untransformed: whitespace, newlines, arrays and numbers all survive.
    expect(detail!.payload).toEqual(payload);
  });

  it('shows the submitter email, because a reviewer has to be able to reply', async () => {
    const id = await seed({ email: 'asha@example.com' });
    const detail = await getSubmission(db, id);
    expect(detail!.submitterEmail).toBe('asha@example.com');
  });

  it('still does not fetch the IP hash or user agent', async () => {
    const id = await seed();
    const detail = await getSubmission(db, id);

    const keys = Object.keys(detail!);
    expect(keys).not.toContain('ipHash');
    expect(keys).not.toContain('userAgent');

    const json = JSON.stringify(detail);
    expect(json).not.toContain('a1b2c3d4e5f60718293a4b5c6d7e8f90');
    expect(json).not.toContain('Mozilla');
  });

  it('returns undefined for an id that is not there', async () => {
    expect(await getSubmission(db, '00000000-0000-0000-0000-000000000000')).toBeUndefined();
  });

  it('names the reviewer once somebody has reviewed it', async () => {
    const id = await seed({ status: 'in_review' });
    await transitionSubmission(db, {
      submissionId: id,
      action: 'approve',
      actor: { id: editorId, email: 'editor@example.com', role: 'editor' },
    });

    const detail = await getSubmission(db, id);
    expect(detail!.status).toBe('approved');
    expect(detail!.reviewerEmail).toBe('editor@example.com');
    expect(detail!.reviewerName).toBe('An Editor');
    expect(detail!.reviewedAt).toBeInstanceOf(Date);
  });

  it('carries the whole history of one submission, newest first', async () => {
    const id = await seed({ status: 'pending' });
    const actor = { id: editorId, email: 'editor@example.com', role: 'editor' };

    await transitionSubmission(db, { submissionId: id, action: 'start_review', actor });
    await transitionSubmission(db, {
      submissionId: id,
      action: 'reject',
      actor,
      note: 'Not verifiable.',
    });

    const history = await historyOf(db, id);
    expect(history).toHaveLength(2);
    expect(history[0].toStatus).toBe('rejected');
    expect(history[0].note).toBe('Not verifiable.');
    expect(history[1].toStatus).toBe('in_review');

    // The history of one submission never mentions another's private data.
    expect(JSON.stringify(history)).not.toMatch(/asha@example\.com/);
  });
});

describe('the payload reads in the order it was filled in', () => {
  /**
   * `jsonb` stores keys sorted by length then alphabetically, so a submission
   * read straight back arrives shuffled. On a screen whose whole job is "read
   * exactly what this person wrote", that is a real defect — so the fields are
   * put back into form order. Nothing is renamed, changed or dropped.
   */
  it('restores the form order for each kind', async () => {
    const id = await seed({
      kind: 'project',
      payload: {
        // Deliberately scrambled, and stored via jsonb which scrambles further.
        url: 'https://queueless.example.com',
        claudeUsage: 'Drafted the state machine.',
        title: 'Queueless',
        summary: 'Removes the queue.',
        city: 'Indore',
        creator: 'Ravi Iyer',
        category: 'Product',
      },
    });

    const detail = await getSubmission(db, id);
    const fields = orderedPayload('project', detail!.payload).map((p) => p.field);

    expect(fields).toEqual([
      'title',
      'creator',
      'city',
      'category',
      'summary',
      'claudeUsage',
      'url',
    ]);
  });

  it('changes no key and no value', async () => {
    const payload = {
      name: '  Asha Menon  ',
      building: 'Line one.\n\nLine two.',
      claudeTools: 'Claude Code, the API',
    };
    const id = await seed({ kind: 'builder', payload });
    const detail = await getSubmission(db, id);

    const rebuilt = Object.fromEntries(
      orderedPayload('builder', detail!.payload).map((p) => [p.field, p.value]),
    );
    expect(rebuilt).toEqual(payload);
  });

  it('appends a key the form does not know rather than hiding it', () => {
    const ordered = orderedPayload('builder', {
      surpriseField: 'from an older form version',
      name: 'Asha',
      email: 'asha@example.com',
    });

    const fields = ordered.map((p) => p.field);
    expect(fields).toContain('surpriseField');
    // Known fields first, in form order; the stranger last.
    expect(fields[fields.length - 1]).toBe('surpriseField');
    expect(fields.slice(0, 2)).toEqual(['name', 'email']);
  });

  it('falls back to storage order for an unrecognised kind', () => {
    const ordered = orderedPayload('something-else', { b: 2, a: 1 });
    expect(ordered.map((p) => p.field)).toEqual(['b', 'a']);
  });

  it('handles an empty or non-object payload without throwing', () => {
    expect(orderedPayload('builder', {})).toEqual([]);
    expect(orderedPayload('builder', null)).toEqual([]);
    expect(orderedPayload('builder', 'a string')).toEqual([]);
    expect(orderedPayload('builder', [1, 2])).toEqual([]);
  });
});

// ── The audit page ──────────────────────────────────────────────────────

describe('the audit feed', () => {
  it('reads newest first and names the actor', async () => {
    const id = await seed({ status: 'pending' });
    const actor = { id: editorId, email: 'editor@example.com', role: 'editor' };

    await transitionSubmission(db, { submissionId: id, action: 'start_review', actor });
    await transitionSubmission(db, { submissionId: id, action: 'approve', actor });

    const rows = await recentAudit(db, 10);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0].toStatus).toBe('approved');
    expect(rows[0].actorEmail).toBe('editor@example.com');
    expect(rows[0].actorName).toBe('An Editor');
    expect(rows[0].fromStatus).toBe('in_review');
  });

  it('exposes no submitter data — it is a log of actions, not of people', async () => {
    const id = await seed({ status: 'pending', email: 'private@example.com' });
    await transitionSubmission(db, {
      submissionId: id,
      action: 'approve',
      actor: { id: editorId, email: 'editor@example.com', role: 'editor' },
    });

    const rows = await recentAudit(db, 10);
    expect(JSON.stringify(rows)).not.toContain('private@example.com');
    expect(JSON.stringify(rows)).not.toContain('Mozilla');
  });
});

// ── The age label ───────────────────────────────────────────────────────

describe('the age label', () => {
  const now = new Date('2026-09-04T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it.each([
    [0, 'just now'],
    [30_000, 'just now'],
    [60_000, '1 minute'],
    [5 * 60_000, '5 minutes'],
    [HOUR, '1 hour'],
    [2 * HOUR, '2 hours'],
    [23 * HOUR, '23 hours'],
    [DAY, '1 day'],
    [3 * DAY, '3 days'],
    [12 * DAY, '12 days'],
    [45 * DAY, '1 month'],
    [200 * DAY, '6 months'],
    [400 * DAY, '1 year'],
  ])('renders %i ms as %s', (elapsed, expected) => {
    expect(ageLabel(ago(elapsed), now)).toBe(expected);
  });

  it('never shows a negative age for a clock skew', () => {
    expect(ageLabel(new Date(now.getTime() + 60_000), now)).toBe('just now');
  });

  it('rounds down, so nothing looks fresher than it is', () => {
    // 47 hours is one day and 23 hours. It says one day, not two.
    expect(ageLabel(ago(47 * HOUR), now)).toBe('1 day');
  });
});
