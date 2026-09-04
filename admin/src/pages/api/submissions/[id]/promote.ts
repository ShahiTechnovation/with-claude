/**
 * POST /api/submissions/:id/promote
 *
 * Turns an approved submission into a real record. Like the review route, it
 * decides nothing itself: it authenticates, checks the origin, and hands the
 * request to `promoteSubmission()`, where every rule about who may promote
 * what, from which state, and what gets written lives.
 *
 * POST from an ordinary `<form>`, redirect-after-post — so the admin still
 * works with JavaScript off, and so a reload cannot fire a second promotion.
 * (It could not create a second record anyway; promotion is idempotent. But a
 * reload that silently re-POSTs is a bad habit for a screen to teach.)
 */
import type { APIRoute } from 'astro';
import { pooledDb } from '@db/pool';
import { assertSameOrigin } from '@/server/session';
import { promoteSubmission } from '@/server/promotion';

export const prerender = false;

function back(id: string, params: Record<string, string>): Response {
  const query = new URLSearchParams(params).toString();
  return new Response(null, {
    status: 303,
    headers: {
      Location: `/submissions/${id}${query ? `?${query}` : ''}`,
      'Cache-Control': 'no-store',
    },
  });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request, params, locals }) => {
  // The middleware has already refused an unauthenticated request; this is the
  // route's own check, because a route that relies on middleware it cannot see
  // is one refactor away from being open.
  const user = locals.user;
  if (!user) return json({ error: 'Not authenticated.' }, 401);

  if (!assertSameOrigin(request)) {
    return json({ error: 'Cross-origin request refused.' }, 403);
  }

  const id = params.id;
  if (!id) return new Response('No submission id.', { status: 400 });

  const result = await promoteSubmission(pooledDb(), {
    submissionId: id,
    actor: { id: user.id, email: user.email, role: user.role },
  });

  if (!result.ok) {
    // The promoter's messages name the missing field and say what to do about
    // it, rather than leaking a constraint name.
    return back(id, { error: result.error });
  }

  const label = result.entityType.replace(/_/g, ' ');
  return back(id, {
    done: result.created
      ? `Created a ${label}. It is approved, not published — publish it when you are ready.`
      : `Already promoted. This submission created a ${label} earlier.`,
  });
};

export const ALL: APIRoute = () =>
  new Response('This endpoint only accepts POST.', { status: 405, headers: { Allow: 'POST' } });
