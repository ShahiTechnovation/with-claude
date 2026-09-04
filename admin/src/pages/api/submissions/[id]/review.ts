/**
 * POST /api/submissions/:id/review
 *
 * The only route that can move a submission, and it does none of the deciding
 * itself: it parses a form, hands the request to `transitionSubmission()`, and
 * turns the answer into a redirect. Every rule about who may do what, from
 * which state, with what note, and what gets written to the audit log lives in
 * the state machine — so there is exactly one place to read to know what can
 * happen to a submission.
 *
 * POST because it changes state, from an ordinary `<form>` because the whole
 * admin works without JavaScript. Redirect-after-post so a reload does not
 * re-fire a review.
 */
import type { APIRoute } from 'astro';
import { pooledDb } from '@db/pool';
import { assertSameOrigin } from '@/server/session';
import { RULES, transitionSubmission, type ReviewAction } from '@/server/transitions';

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

export const POST: APIRoute = async ({ request, params, locals }) => {
  // The middleware has already refused an unauthenticated request; this is the
  // route's own check, because a route that relies on middleware it cannot see
  // is one refactor away from being open.
  const user = locals.user;
  if (!user) {
    return new Response(JSON.stringify({ error: 'Not authenticated.' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  if (!assertSameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'Cross-origin request refused.' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const id = params.id;
  if (!id) return new Response('No submission id.', { status: 400 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return back(id, { error: 'Could not read that form.' });
  }

  const action = String(form.get('action') ?? '') as ReviewAction;
  if (!(action in RULES)) {
    return back(id, { error: 'Unknown review action.' });
  }

  const note = form.get('note');

  const result = await transitionSubmission(pooledDb(), {
    submissionId: id,
    action,
    actor: { id: user.id, email: user.email, role: user.role },
    note: typeof note === 'string' ? note : null,
  });

  if (!result.ok) {
    // The state machine's messages are written for the person reading them —
    // they say what state the submission is in and what the action applies to,
    // rather than leaking a constraint name.
    return back(id, { error: result.error });
  }

  return back(id, {
    done: `${RULES[action].label} — now ${result.to.replace(/_/g, ' ')}.`,
  });
};

export const ALL: APIRoute = () =>
  new Response('This endpoint only accepts POST.', { status: 405, headers: { Allow: 'POST' } });
