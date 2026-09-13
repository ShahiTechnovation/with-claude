/**
 * POST /api/ambassadors — create an ambassador. §36.
 *
 * A plain form post with a 303 back to the register, matching the rest of this
 * application: the admin has no client-side framework and a moderator with
 * scripts blocked can still do their job.
 */
import type { APIRoute } from 'astro';
import { assertSameOrigin } from '@/server/session';
import { createAmbassador } from '@/server/ambassadors';

export const prerender = false;

const back = (query: string) =>
  new Response(null, {
    status: 303,
    headers: { Location: `/ambassadors${query}`, 'Cache-Control': 'no-store' },
  });

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  /**
   * `editor` and `admin`, not `admin` alone.
   *
   * §62 asks that moderators be able to create and link ambassadors, and §36
   * puts ambassador management among the moderator's ordinary duties. A
   * `reviewer` cannot — creating a public profile is not reviewing one.
   */
  if (!user || (user.role !== 'admin' && user.role !== 'editor')) {
    return new Response(JSON.stringify({ error: 'Not authorised.' }), { status: 401 });
  }

  if (!assertSameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'Cross-origin request refused.' }), {
      status: 403,
    });
  }

  const form = await request.formData();
  const result = await createAmbassador(form, { id: user.id, email: user.email });

  if (!result.ok) return back(`?error=${encodeURIComponent(result.error)}`);
  return back(`?created=1#${result.id}`);
};

export const ALL: APIRoute = () =>
  new Response(JSON.stringify({ error: 'This endpoint only accepts POST.' }), {
    status: 405,
    headers: { Allow: 'POST' },
  });
