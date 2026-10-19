/**
 * A failed claim decision or sync run comes back as `?error=`, and a success as
 * `?note=`. The pages render `?error=` as a red `role="alert"` notice and
 * `?note=` as the info notice; this file checks the redirects, not the render.
 * A thrown error is logged with the action and comes back as `?error=` too.
 * Before, every outcome came back as `?note=`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../db/testing';

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('../db/pool', () => ({ pooledDb: () => state.db }));
// The routes import the admin's `@/server/session`; vitest's `@` is the public src.
vi.mock('@/server/session', () => ({ assertSameOrigin: () => true }));
vi.mock('@/server/moderation', () => import('../admin/src/server/moderation'));
// Spied, not replaced: each case that wants another outcome sets it once.
vi.mock('../src/server/projects/claims', async (orig) => {
  const real = await orig<typeof import('../src/server/projects/claims')>();
  return { ...real, resolveProjectClaim: vi.fn(real.resolveProjectClaim) };
});
vi.mock('../src/server/integrations/baserow/runtime', async (orig) => {
  const real = await orig<typeof import('../src/server/integrations/baserow/runtime')>();
  return { ...real, runSync: vi.fn(real.runSync) };
});

import { POST as claimPOST } from '../admin/src/pages/api/claims/[id]/[action]';
import { POST as syncPOST } from '../admin/src/pages/api/integrations/[action]';
import { resolveProjectClaim } from '../src/server/projects/claims';
import { runSync } from '../src/server/integrations/baserow/runtime';

type Handler = (ctx: unknown) => Promise<Response>;

function call(handler: unknown, params: Record<string, string>, form: Record<string, string> = {}) {
  return (handler as Handler)({
    request: new Request('https://admin.test/x', {
      method: 'POST',
      body: new URLSearchParams(form),
    }),
    params,
    locals: { user: { id: crypto.randomUUID(), email: 'notices@example.com', role: 'editor' } },
  });
}

/** The redirect's query, decoded: `{ error: '…' }` or `{ note: '…' }`. */
const query = (response: Response) =>
  Object.fromEntries(new URL(response.headers.get('Location')!, 'https://admin.test').searchParams);

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  state.db = db;
});

afterAll(async () => {
  await db?.$close();
});

describe('claim decisions', () => {
  it('sends an approval without a note back as an error', async () => {
    const response = await call(claimPOST, { id: crypto.randomUUID(), action: 'approve' });
    expect(response.status).toBe(303);
    expect(query(response)).toEqual({
      error: 'Approval needs a note saying how it was verified.',
    });
  });

  it('sends a claim that cannot be decided back as an error', async () => {
    const response = await call(claimPOST, { id: crypto.randomUUID(), action: 'reject' });
    expect(response.status).toBe(303);
    expect(query(response)).toEqual({ error: 'No such claim.' });
  });

  it('sends a decided claim back as a note, not an error', async () => {
    vi.mocked(resolveProjectClaim).mockResolvedValueOnce({ ok: true, status: 'approved' });
    const response = await call(
      claimPOST,
      { id: crypto.randomUUID(), action: 'approve' },
      { note: 'Checked the repo owner.' },
    );
    expect(response.status).toBe(303);
    expect(query(response)).toEqual({ note: 'Claim approved.' });
  });

  it('logs a decision that throws and says nothing was saved', async () => {
    const id = crypto.randomUUID();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(resolveProjectClaim).mockRejectedValueOnce(new Error('pool timeout'));
    try {
      const response = await call(claimPOST, { id, action: 'reject' });
      expect(response.status).toBe(303);
      expect(query(response)).toEqual({
        error: 'Could not reject this claim. The change was not saved.',
      });
      expect(log).toHaveBeenCalledWith(`claim reject on ${id} failed`, expect.any(Error));
    } finally {
      log.mockRestore();
    }
  });

  it('refuses an id that is not a UUID before it reaches the database', async () => {
    // 36 characters from the old pattern's alphabet, and not a UUID.
    const response = await call(claimPOST, { id: '-'.repeat(36), action: 'reject' });
    expect(response.status).toBe(400);
  });
});

describe('sync runs', () => {
  it('sends a run that did not happen back as an error', async () => {
    vi.stubEnv('BASEROW_SYNC_ENABLED', 'false');
    try {
      const response = await call(syncPOST, { action: 'process' });
      expect(response.status).toBe(303);
      expect(query(response)).toEqual({ error: 'Not run: disabled.' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('sends a run that finished back as a note', async () => {
    vi.mocked(runSync).mockResolvedValueOnce({ ran: true, started: true });
    const response = await call(syncPOST, { action: 'process' });
    expect(response.status).toBe(303);
    expect(query(response)).toEqual({ note: 'Run finished.' });
  });

  it('keeps the re-queued count on a retry that finished', async () => {
    vi.mocked(runSync).mockResolvedValueOnce({ ran: true, started: true });
    const response = await call(syncPOST, { action: 'retry' });
    expect(query(response)).toEqual({ note: '0 job(s) re-queued. Run finished.' });
  });

  it('points a run that started and failed at Recent runs, where its message is', async () => {
    // Keyed on `started`, not on the wording of `reason`.
    vi.mocked(runSync).mockResolvedValueOnce({ ran: false, started: true, reason: 'reworded' });
    const response = await call(syncPOST, { action: 'process' });
    expect(query(response)).toEqual({ error: 'The run failed. See Recent runs.' });
  });

  it('logs a sync that throws, and says where to look', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(runSync).mockRejectedValueOnce(new Error('pool timeout'));
    try {
      const response = await call(syncPOST, { action: 'reconcile' });
      expect(response.status).toBe(303);
      expect(query(response)).toEqual({ error: 'The sync failed. See the server log.' });
      expect(log).toHaveBeenCalledWith('sync reconcile failed', expect.any(Error));
    } finally {
      log.mockRestore();
    }
  });
});
