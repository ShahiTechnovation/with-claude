/**
 * POST /api/claims/<id>/<approve|reject> — resolve a project claim.
 *
 * Approval is the ONLY way an imported project gets an owner. It transfers
 * content authority to the website atomically; see
 * `src/server/projects/claims.ts`.
 */
import type { APIRoute } from 'astro';
import { pooledDb } from '@db/pool';
import { assertSameOrigin } from '@/server/session';
import { resolveProjectClaim } from '../../../../../../src/server/projects/claims';

export const prerender = false;

export const POST: APIRoute = async ({ request, params, locals }) => {
  const user = locals.user;
  if (!user || (user.role !== 'admin' && user.role !== 'editor')) {
    return new Response('Editors only.', { status: 403 });
  }
  if (!assertSameOrigin(request)) return new Response('Cross-origin request refused.', { status: 403 });
  const { id, action } = params;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id) || (action !== 'approve' && action !== 'reject')) {
    return new Response('Bad request.', { status: 400 });
  }
  const form = await request.formData().catch(() => null);
  const note = String(form?.get('note') ?? '').trim().slice(0, 1_000) || null;
  if (action === 'approve' && !note) {
    return new Response(null, { status: 303, headers: { Location: '/claims?note=' + encodeURIComponent('Approval needs a note saying how it was verified.') } });
  }
  const result = await resolveProjectClaim(pooledDb(), id, action, { id: user.id, email: user.email }, note);
  const message = result.ok ? `Claim ${result.status}.` : result.error;
  return new Response(null, { status: 303, headers: { Location: `/claims?note=${encodeURIComponent(message)}`, 'Cache-Control': 'no-store' } });
};
