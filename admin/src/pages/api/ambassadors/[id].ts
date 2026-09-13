/**
 * POST /api/ambassadors/:id — edit, link, publish, disable, rebuild. §36.
 *
 * One route with an `intent` field rather than five routes, because every one
 * of these is "a moderator changed this ambassador" and they share the same
 * authorisation, the same origin check and the same redirect target. The
 * intents are an explicit allowlist; an unrecognised one is refused rather
 * than ignored, so a typo in a form is a visible error instead of a button
 * that silently does nothing.
 */
import type { APIRoute } from 'astro';
import { assertSameOrigin } from '@/server/session';
import {
  linkMember,
  requestLeaderboardRebuild,
  setAmbassadorStatus,
  updateAmbassador,
} from '@/server/ambassadors';

export const prerender = false;

export const POST: APIRoute = async ({ request, params, locals }) => {
  const user = locals.user;
  if (!user || (user.role !== 'admin' && user.role !== 'editor')) {
    return new Response(JSON.stringify({ error: 'Not authorised.' }), { status: 401 });
  }

  if (!assertSameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'Cross-origin request refused.' }), {
      status: 403,
    });
  }

  const id = params.id;
  if (!id) return new Response('Missing id.', { status: 400 });

  const back = (query: string) =>
    new Response(null, {
      status: 303,
      headers: { Location: `/ambassadors/${id}${query}`, 'Cache-Control': 'no-store' },
    });

  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');
  const actor = { id: user.id, email: user.email };

  if (intent === 'update') {
    const result = await updateAmbassador(id, form, actor);
    return back(result.ok ? '?saved=1' : `?error=${encodeURIComponent(result.error)}`);
  }

  if (intent === 'link-member') {
    const raw = String(form.get('username') ?? '').trim();
    const result = await linkMember(id, raw.length > 0 ? raw : null, actor);
    return back(result.ok ? '?saved=1' : `?error=${encodeURIComponent(result.error)}`);
  }

  if (intent === 'publish' || intent === 'disable') {
    const result = await setAmbassadorStatus(
      id,
      intent === 'publish' ? 'published' : 'archived',
      actor,
    );
    return back(result.ok ? '?saved=1' : `?error=${encodeURIComponent(result.error)}`);
  }

  if (intent === 'rebuild') {
    const result = await requestLeaderboardRebuild(actor);
    return back(`?rebuild=${encodeURIComponent(result.message)}`);
  }

  return back(`?error=${encodeURIComponent('Unrecognised action.')}`);
};

export const ALL: APIRoute = () =>
  new Response(JSON.stringify({ error: 'This endpoint only accepts POST.' }), {
    status: 405,
    headers: { Allow: 'POST' },
  });
