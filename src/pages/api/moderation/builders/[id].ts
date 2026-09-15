import type { APIRoute } from 'astro';
import { requireMember, statusFor } from '@/server/auth/member';
import { hideBuilder, restoreBuilder, removeBuilder } from '@/server/moderation';
import { pooledDb } from '../../../../../db/pool';
import { z } from 'zod';

export const prerender = false;

const Payload = z.object({
  action: z.enum(['hide', 'restore', 'remove']),
});

export const PATCH: APIRoute = async ({ request, params }) => {
  const db = pooledDb();
  const auth = await requireMember(request, db);

  if (!auth.ok) {
    return new Response(JSON.stringify({ error: auth.reason }), {
      status: statusFor(auth.reason),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { member } = auth;
  if (member.role !== 'moderator' && member.role !== 'owner') {
    return new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { id } = params;
  if (!id) {
    return new Response(JSON.stringify({ error: 'missing_id' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let action: 'hide' | 'restore' | 'remove';
  try {
    const json = await request.json();
    const parsed = Payload.parse(json);
    action = parsed.action;
  } catch (error) {
    return new Response(JSON.stringify({ error: 'bad_request' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    if (action === 'hide') {
      await hideBuilder(id, member.id);
    } else if (action === 'remove') {
      await removeBuilder(id, member.id);
    } else {
      await restoreBuilder(id, member.id);
    }
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: 'internal_error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
