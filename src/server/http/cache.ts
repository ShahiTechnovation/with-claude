/**
 * CACHE POLICY FOR SERVER-RENDERED PAGES. One place, two answers.
 *
 * PUBLIC — the same bytes for every visitor. Cached at Vercel's CDN for 30 s,
 * then served stale for at most 30 s more while one request revalidates. The
 * worst case between a moderator restricting a project and the last public
 * copy being served is therefore ~60 s (30 s fresh + 30 s stale), plus the
 * render time of the revalidating request. Browsers do not cache (`max-age=0`)
 * so a visitor who reloads after the window gets the new answer.
 *
 * This replaced `s-maxage=60, stale-while-revalidate=86400`: a restricted
 * project could be served from the CDN for up to a day after the takedown.
 *
 * PRIVATE — anything that depends on who is asking: a moderator's view with
 * controls or a banner, an authenticated preview, a non-public record shown to
 * its moderator. Never stored by a shared cache. The CDN does not vary on
 * cookies, so a response that differs by viewer MUST be private or the first
 * viewer's version is served to everyone.
 *
 * See docs/caching.md for the invalidation story and how this was verified.
 */
import type { AstroGlobal } from 'astro';

export const PUBLIC_CDN_SECONDS = 30;
export const PUBLIC_STALE_SECONDS = 30;

export const PUBLIC_CACHE_CONTROL = `public, max-age=0, s-maxage=${PUBLIC_CDN_SECONDS}, stale-while-revalidate=${PUBLIC_STALE_SECONDS}`;
export const PRIVATE_CACHE_CONTROL = 'private, no-store';

export function publicCache(astro: Pick<AstroGlobal, 'response'>): void {
  astro.response.headers.set('Cache-Control', PUBLIC_CACHE_CONTROL);
}

export function privateCache(astro: Pick<AstroGlobal, 'response'>, noindex = true): void {
  astro.response.headers.set('Cache-Control', PRIVATE_CACHE_CONTROL);
  if (noindex) astro.response.headers.set('X-Robots-Tag', 'noindex, nofollow');
}
