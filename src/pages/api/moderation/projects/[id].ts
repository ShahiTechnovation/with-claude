/**
 * MODERATE A PROJECT — hide, remove or restore. Moderators and owners only.
 *
 * Through `guardMutation()` like every other member mutation: same-origin,
 * JSON-only, bounded body, verified identity, strict schema. These routes used
 * to read the body without an origin check. Role comes from the database row
 * `requireMember()` returns, never from the request.
 *
 * The state change itself is `moderateProject()`, which only ever writes
 * `moderationState` — see `src/server/moderation.ts`.
 */
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { pooledDb } from '../../../../../db/pool';
import { guardMutation, json } from '@/server/http/guard';
import { moderateProject } from '@/server/moderation';

export const prerender = false;

const Payload = z.object({ action: z.enum(['hide', 'restore', 'remove']) }).strict();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PATCH: APIRoute = async ({ request, params }) => {
  const db = pooledDb();
  const guard = await guardMutation(request, db, { method: 'PATCH', schema: Payload });
  if (!guard.ok) return guard.response;

  const { member, body } = guard;
  if (member.role !== 'moderator' && member.role !== 'owner') {
    return json({ error: 'Only moderators can do that.' }, 403);
  }

  const id = params.id;
  if (!id || !UUID_RE.test(id)) return json({ error: 'Not found.' }, 404);

  try {
    const result = await moderateProject(id, body.action, member.id, db);
    if (!result.ok) return json({ error: result.error }, result.status);
    return json({ success: true, moderationState: result.to }, 200);
  } catch (error) {
    console.error('[moderation.projects] failed', error instanceof Error ? error.message : error);
    return json({ error: 'internal_error' }, 500);
  }
};

export const ALL: APIRoute = () => json({ error: 'Method not allowed' }, 405, { Allow: 'PATCH' });
