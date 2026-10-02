/**
 * Request middleware — one job: serve the Project Directory at
 * projects.withclaude.in (see `src/lib/directory-host.ts`).
 *
 * Runs for server-rendered routes. Prerendered pages are files on the CDN and
 * never reach this; on the directory host they are redirected at the edge by
 * the matching rule in `vercel.json`. Every other host passes straight
 * through, untouched.
 */
import { defineMiddleware } from 'astro:middleware';
import { routeDirectoryHost } from './lib/directory-host';

export const onRequest = defineMiddleware(async (context, next) => {
  const route = routeDirectoryHost(context.url.hostname, context.url.pathname, context.url.search);
  if (route.kind === 'rewrite') return context.rewrite(route.to);
  if (route.kind === 'redirect') return context.redirect(route.to, 302);
  return next();
});
