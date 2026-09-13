/**
 * POST /api/events/:id/host — correct a host attribution. §37.
 *
 * Writes through `correctEventHost()`, which writes through the public site's
 * `setPrimaryHost()`, which is the only function in the system allowed to move
 * `events.ambassador_id`. Three layers sounds like too many until you consider
 * the alternative: an admin UPDATE that set the column directly would leave the
 * canonical `event_hosts` row behind and the leaderboard would credit somebody
 * the event page does not.
 *
 * Nothing here touches `event_source_records`. §37 requires correction without
 * destroying the source value, and the way that is achieved is by never
 * editing the staged row at all — it keeps saying what the feed said, forever,
 * and the correction lives in the canonical table beside it.
 */
import type { APIRoute } from 'astro';
import { assertSameOrigin } from '@/server/session';
import { correctEventHost } from '@/server/ambassadors';
import type { EventHostRole } from '../../../../../../src/server/events/hosts';

export const prerender = false;

const ROLES: EventHostRole[] = ['primary_host', 'co_host', 'organizer', 'partner', 'speaker'];

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

  const eventId = params.id;
  if (!eventId) return new Response('Missing event id.', { status: 400 });

  const form = await request.formData();
  const role = String(form.get('role') ?? 'primary_host') as EventHostRole;
  if (!ROLES.includes(role)) {
    return new Response('Unknown role.', { status: 400 });
  }

  const rawAmbassador = String(form.get('ambassadorId') ?? '').trim();
  const result = await correctEventHost(
    eventId,
    { ambassadorId: rawAmbassador.length > 0 ? rawAmbassador : null, role },
    { id: user.id, email: user.email },
  );

  // Back to the queue the correction was made from.
  return new Response(null, {
    status: 303,
    headers: {
      Location: result.ok
        ? '/attribution?saved=1'
        : `/attribution?error=${encodeURIComponent(result.error)}`,
      'Cache-Control': 'no-store',
    },
  });
};

export const ALL: APIRoute = () =>
  new Response(JSON.stringify({ error: 'This endpoint only accepts POST.' }), {
    status: 405,
    headers: { Allow: 'POST' },
  });
