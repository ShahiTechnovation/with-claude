/**
 * projects.withclaude.in — the Project Directory on its own host.
 *
 * The subdomain is the SAME deployment as www.withclaude.in; nothing is
 * duplicated. On that host:
 *
 *   /                      the Project Directory (rendered as /projects/,
 *                          query string kept, so filters and pages work)
 *   /projects/…            served as-is (rows link here; the directory's own
 *                          form and script use these URLs)
 *   assets and the APIs a  served as-is (/_astro/, /_image, /_server-islands/,
 *   project page uses      /api/reports/, favicons, robots.txt)
 *   anything else          a temporary redirect to the same path on www —
 *                          events, builders, sign-in and the account area
 *                          live on the main site, where auth is configured
 *
 * Canonical URLs are always www (`Base.astro` builds them from `site.url`),
 * so the subdomain never competes with the main site in search results.
 */

export const DIRECTORY_HOST = 'projects.withclaude.in';
export const MAIN_ORIGIN = 'https://www.withclaude.in';

const SERVED_HERE = /^\/(projects\/|_astro\/|_image\/?|_server-islands\/|api\/reports\/|favicon[^/]*$|apple-touch-icon[^/]*$|robots\.txt$|site\.webmanifest$|fonts\/)/;

export type DirectoryHostRoute = { kind: 'pass' } | { kind: 'rewrite'; to: string } | { kind: 'redirect'; to: string };

/** What the directory host does with one request. Pure, so it is tested directly. */
export function routeDirectoryHost(hostname: string, pathname: string, search: string): DirectoryHostRoute {
  if (hostname.toLowerCase() !== DIRECTORY_HOST) return { kind: 'pass' };
  if (pathname === '/' || pathname === '') return { kind: 'rewrite', to: `/projects/${search}` };
  if (SERVED_HERE.test(pathname)) return { kind: 'pass' };
  return { kind: 'redirect', to: `${MAIN_ORIGIN}${pathname}${search}` };
}
