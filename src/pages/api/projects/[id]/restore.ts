/**
 * RESTORE AN ARCHIVED PROJECT — back to draft, never straight to published.
 *
 * Owner-only, through `transitionProject()` — the one writer of
 * `publicationStatus` for member actions. It used to let any `project_members`
 * row through, so a contributor (credit only) could restore the owner's
 * project, and it moved `publicationStatus` without the legacy `status` or an
 * audit entry.
 */
import type { APIRoute } from 'astro';
import { pooledDb } from '../../../../../db/pool';
import { guardMutation, json } from '@/server/http/guard';
import { transitionProject } from '@/server/projects/lifecycle';

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  const db = pooledDb();
  const guard = await guardMutation(request, db);
  if (!guard.ok) return guard.response;

  const projectId = params.id;
  if (!projectId) return json({ error: 'Missing project id.' }, 400);

  const result = await transitionProject(db, guard.member.id, projectId, 'restore');
  if (!result.ok) return json({ error: result.error }, result.status);
  return json({ ok: true, status: result.to }, 200);
};

export const ALL: APIRoute = () => json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
