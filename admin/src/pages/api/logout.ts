/**
 * Sign out.
 *
 * POST only. A sign-out on GET can be fired by anything that renders a URL —
 * a link prefetcher, an image tag in an email, a chat client unfurling a
 * preview — which turns "someone pasted a link" into "you are logged out".
 */
import type { APIRoute } from 'astro';
import { auth } from '@/server/auth';
import { assertSameOrigin } from '@/server/session';

export const prerender = false;

export const POST: APIRoute = async ({ request, redirect }) => {
  if (!assertSameOrigin(request)) {
    return new Response('Cross-origin request refused.', { status: 403 });
  }

  // Revokes the session server-side and clears the cookie. Returning the
  // library's own response keeps the Set-Cookie header intact.
  const response = await auth().api.signOut({ headers: request.headers, asResponse: true });

  const out = redirect('/login', 302);
  const cookie = response.headers.get('set-cookie');
  if (cookie) out.headers.set('set-cookie', cookie);
  return out;
};

/** Anything else is refused rather than quietly doing nothing. */
export const ALL: APIRoute = () =>
  new Response('This endpoint only accepts POST.', { status: 405, headers: { Allow: 'POST' } });
