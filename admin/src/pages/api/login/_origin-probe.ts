/**
 * TEMPORARY diagnostic for Phase 3 Step 8. Delete after use.
 *
 * Reports how Astro resolved the request URL on Vercel, so the
 * `security.checkOrigin` 403 can be diagnosed from real data rather than
 * inference. Reveals no secrets: only request headers this caller already sent.
 */
import type { APIRoute } from 'astro';

export const prerender = false;

export const ALL: APIRoute = ({ request, url }) => {
  const h = request.headers;
  return new Response(
    JSON.stringify(
      {
        method: request.method,
        'astro_url.origin': url.origin,
        'astro_url.href': url.href,
        request_url: request.url,
        origin_header: h.get('origin'),
        host: h.get('host'),
        'x-forwarded-host': h.get('x-forwarded-host'),
        'x-forwarded-proto': h.get('x-forwarded-proto'),
        'x-forwarded-port': h.get('x-forwarded-port'),
        'content-type': h.get('content-type'),
        origin_matches_url_origin: h.get('origin') === url.origin,
      },
      null,
      2,
    ),
    { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
  );
};
