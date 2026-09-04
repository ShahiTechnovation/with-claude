/**
 * POST /api/content/:type/:id/transition
 *
 * The only route that can put a record on the website or take one off it.
 *
 * It decides nothing: it authenticates, checks the origin, and hands the
 * request to `transitionContent()`, where the whole map lives — which
 * transitions exist, who may make them, which need a written reason, and what
 * gets audited. There is one place to read to know what can happen to a
 * record, and this is not it.
 *
 * ── WHY THE DEPLOY OUTCOME IS REPORTED SEPARATELY ────────────────────────
 *
 * A successful response means the DATABASE changed, because the database is
 * the source of truth. Whether Vercel accepted a deploy hook is a second,
 * independent fact, and it is reported as one — the editor is told both what
 * was saved and whether a rebuild is running.
 *
 * The alternative — failing the request when the hook fails — would mean an
 * outage at a third party could block a takedown. That is unacceptable for a
 * correction path, so it is not how this works.
 */
import type { APIRoute } from 'astro';
import { pooledDb } from '@db/pool';
import { assertSameOrigin } from '@/server/session';
import {
  PUBLISH_RULES,
  deployMessage,
  isEntityType,
  transitionContent,
  type PublishAction,
} from '@/server/publishing';

export const prerender = false;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function back(to: string, params: Record<string, string>): Response {
  const query = new URLSearchParams(params).toString();
  return new Response(null, {
    status: 303,
    headers: { Location: `${to}${query ? `?${query}` : ''}`, 'Cache-Control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request, params, locals }) => {
  const user = locals.user;
  if (!user) return json({ error: 'Not authenticated.' }, 401);

  if (!assertSameOrigin(request)) {
    return json({ error: 'Cross-origin request refused.' }, 403);
  }

  const { type, id } = params;
  if (!type || !id) return new Response('No record named.', { status: 400 });
  if (!isEntityType(type)) return new Response('Not a publishable type.', { status: 400 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return back('/publish', { error: 'Could not read that form.' });
  }

  const action = String(form.get('action') ?? '') as PublishAction;
  if (!(action in PUBLISH_RULES)) {
    return back('/publish', { error: 'Unknown action.' });
  }

  // Where to send the editor back to. Defaults to the publish queue, but the
  // same action is offered from a submission's detail page.
  const origin = String(form.get('return') ?? '/publish');
  const destination = origin.startsWith('/') ? origin : '/publish';

  const note = form.get('note');

  const result = await transitionContent(pooledDb(), {
    entityType: type,
    entityId: id,
    action,
    actor: { id: user.id, email: user.email, role: user.role },
    note: typeof note === 'string' ? note : null,
  });

  if (!result.ok) {
    return back(destination, { error: result.error });
  }

  // Both facts: what the database did, and what the deploy hook did.
  return back(destination, {
    done: `${PUBLISH_RULES[action].label} — now ${result.to}. ${deployMessage(result.deploy)}`,
  });
};

export const ALL: APIRoute = () =>
  new Response('This endpoint only accepts POST.', { status: 405, headers: { Allow: 'POST' } });
