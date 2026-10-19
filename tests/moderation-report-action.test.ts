/**
 * A moderator's report action moves the report and writes one audit entry with
 * a fixed past-tense note per action ("Report dismissed by moderator"), not the
 * old note built from the verb plus "d" ("dismissd"). Also: who may act, what a
 * second action on the same report logs, and what a bad id or a failed write
 * answers.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import * as schema from '../db/schema';

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('../db/pool', () => ({ pooledDb: () => state.db }));
// The route imports the admin's `@/server/session`; vitest's `@` is the public src.
vi.mock('@/server/session', () => ({ assertSameOrigin: () => true }));
vi.mock('@/server/moderation', () => import('../admin/src/server/moderation'));

import { POST } from '../admin/src/pages/api/moderation/reports/[id]/[action]';
import { POST as contentPOST } from '../admin/src/pages/api/moderation/content/[type]/[id]/[action]';

const EMAIL = 'mod-report-action@example.com';
type Handler = (ctx: unknown) => Promise<Response>;

function call(handler: unknown, params: Record<string, string>, role = 'admin') {
  return (handler as Handler)({
    request: new Request('https://admin.test/x', { method: 'POST' }),
    params,
    locals: { user: { id: adminId, email: EMAIL, role } },
  });
}

let db: TestDatabase;
let adminId: string;
let memberId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  state.db = db;
  [{ id: adminId }] = await db
    .insert(schema.users)
    .values({ email: EMAIL, role: 'admin' })
    .returning({ id: schema.users.id });
  [{ id: memberId }] = await db
    .insert(schema.members)
    .values({ privyUserId: 'did:privy:report-action' })
    .returning({ id: schema.members.id });
});

afterAll(async () => {
  await db?.$close();
});

async function act(action: string, role = 'admin') {
  const [report] = await db
    .insert(schema.reports)
    .values({
      reporterMemberId: memberId,
      entityType: 'project',
      entityId: crypto.randomUUID(),
      reason: 'spam',
    })
    .returning({ id: schema.reports.id });
  const response = await call(POST, { id: report.id, action }, role);
  const [row] = await db.select().from(schema.reports).where(eq(schema.reports.id, report.id));
  const audit = await db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.entityId, report.id));
  return { response, row, audit };
}

describe('POST /api/moderation/reports/[id]/[action]', () => {
  it.each([
    ['dismiss', 'dismissed', true, 'Report dismissed by moderator'],
    ['triage', 'triaged', false, 'Report triaged by moderator'],
    ['investigate', 'investigating', false, 'Report investigated by moderator'],
    ['resolve', 'resolved', true, 'Report resolved by moderator'],
  ])('%s moves the report to %s and logs it by that name', async (action, status, closes, note) => {
    const { response, row, audit } = await act(action);
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe(`/reports/${row.id}`);
    expect(row.status).toBe(status);
    expect(row.resolvedAt !== null).toBe(closes);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: `report.${status}`,
      fromStatus: 'open',
      toStatus: status,
      actorId: adminId,
      actorEmail: EMAIL,
      note,
    });
  });

  it.each([
    ['an editor', 'dismiss', 'editor', 401],
    ['an unknown action', 'delete', 'admin', 400],
    // On every object's prototype, so an `in` check would let it through.
    ['toString as an action', 'toString', 'admin', 400],
  ])('refuses %s without writing', async (_label, action, role, status) => {
    const { response, row, audit } = await act(action, role);
    expect(response.status).toBe(status);
    expect(row.status).toBe('open');
    expect(audit).toHaveLength(0);
  });

  it('answers 400 for an id that is not a UUID, before it reaches the uuid column', async () => {
    const response = await call(POST, { id: 'abc', action: 'dismiss' });
    expect(response.status).toBe(400);
  });

  it('answers 404 for a report that does not exist', async () => {
    const response = await call(POST, { id: crypto.randomUUID(), action: 'dismiss' });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('No report with that id.');
  });

  it('logs a failed write with the action and id, and says nothing was saved', async () => {
    const id = crypto.randomUUID();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    state.db = { transaction: () => Promise.reject(new Error('pool timeout')) };
    try {
      const response = await call(POST, { id, action: 'resolve' });
      expect(response.status).toBe(500);
      expect(await response.text()).toBe(
        'Could not resolve this report. The change was not saved.',
      );
      expect(log).toHaveBeenCalledWith(`report resolve on ${id} failed`, expect.any(Error));
    } finally {
      state.db = db;
      log.mockRestore();
    }
  });
});

describe('a second action on the same report', () => {
  const open = async () =>
    (
      await db
        .insert(schema.reports)
        .values({
          reporterMemberId: memberId,
          entityType: 'project',
          entityId: crypto.randomUUID(),
          reason: 'spam',
        })
        .returning({ id: schema.reports.id })
    )[0]!.id;
  const auditFor = (id: string) =>
    db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, id));

  it('the same action again writes no second audit row (the double-click)', async () => {
    const id = await open();
    expect((await call(POST, { id, action: 'dismiss' })).status).toBe(303);
    expect((await call(POST, { id, action: 'dismiss' })).status).toBe(303);
    expect(await auditFor(id)).toHaveLength(1);
  });

  it('a later action logs the status it moved from, not "open"', async () => {
    const id = await open();
    await call(POST, { id, action: 'triage' });
    await call(POST, { id, action: 'resolve' });
    const moves = (await auditFor(id)).map((a) => `${a.fromStatus}>${a.toStatus}`);
    expect(moves).toHaveLength(2);
    expect(new Set(moves)).toEqual(new Set(['open>triaged', 'triaged>resolved']));
  });
});

describe('POST /api/moderation/content/[type]/[id]/[action]', () => {
  it('refuses an editor', async () => {
    // Without the role check the random id would reach the database and answer 404.
    const response = await call(
      contentPOST,
      { type: 'project', id: crypto.randomUUID(), action: 'delete' },
      'editor',
    );
    expect(response.status).toBe(401);
  });
});
