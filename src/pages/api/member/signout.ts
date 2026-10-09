/**
 * POST /api/member/signout — expire Privy's session cookies on this site.
 *
 * Privy's `logout()` can throw, and when the SDK fails to start there is no
 * `logout()` at all. Either way the `privy-token` cookie would stay and the
 * server would still treat the browser as signed in. This route is the part
 * the server can always do.
 *
 * No token is required: an expired or broken session must still be able to
 * sign out. The same-origin check still applies, so another site cannot sign
 * a visitor out.
 *
 * Each cookie is expired host-only AND on the parent domain, because a custom
 * Privy auth domain sets them with `Domain=.withclaude.in`, and a host-only
 * expiry does not touch a domain cookie.
 */
import type { APIRoute } from 'astro';
import {
  ACCESS_TOKEN_COOKIE,
  IDENTITY_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  SESSION_COOKIE,
} from '@/server/auth/privy';
import { json } from '@/server/http/guard';
import { assertSameOrigin, fetchSiteAllows } from '@/server/http/origin';

export const prerender = false;

const COOKIES = [ACCESS_TOKEN_COOKIE, IDENTITY_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE, SESSION_COOKIE];

/**
 * The registrable parent of the host, as a cookie Domain, or null.
 *
 * Only withclaude.in has one among the hosts this site answers on: a
 * `*.vercel.app` host is its own registrable domain (vercel.app is a public
 * suffix), and localhost or an IP has none. A request from any other host
 * fails the origin check before it gets here.
 */
function parentCookieDomain(hostname: string): string | null {
  return hostname === 'withclaude.in' || hostname.endsWith('.withclaude.in')
    ? '.withclaude.in'
    : null;
}

function expiredCookies(url: URL): string[] {
  const attrs = `Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${url.protocol === 'https:' ? '; Secure' : ''}; SameSite=Lax`;
  const domain = parentCookieDomain(url.hostname);
  return COOKIES.flatMap((name) => [
    `${name}=; ${attrs}`,
    ...(domain ? [`${name}=; Domain=${domain}; ${attrs}`] : []),
  ]);
}

export const POST: APIRoute = ({ request }) => {
  if (!assertSameOrigin(request) || !fetchSiteAllows(request)) {
    return json({ error: 'That request did not come from this site.' }, 403);
  }
  const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
  for (const cookie of expiredCookies(new URL(request.url))) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 204, headers });
};

export const ALL: APIRoute = () =>
  json({ error: 'This endpoint only accepts POST.' }, 405, { Allow: 'POST' });
