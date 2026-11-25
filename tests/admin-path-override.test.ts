/**
 * The admin middleware refuses the Vercel adapter's path override header (GHSA-mr6q-rp88-fx84).
 *
 * @astrojs/vercel before 10.0.2 let any caller pick which route rendered, with the
 * `x-astro-path` header or the `x_astro_path` query parameter. From 10.0.2 the adapter's own
 * entry applies either one only when it carries the per-build secret, so the adapter is now
 * the first line, and the last block here keeps it at or above that release. The middleware
 * still answers a forged header with 400, before it looks at the session: a second line, kept
 * on purpose.
 *
 * The gate also decides on the route that will run, not only on the path it is shown: under
 * Astro 7, `POST /api/claims/%252e%252e/login` reaches the middleware as `/api/login` (public)
 * while the router runs `/api/claims/[id]/[action]`. The contexts below carry the values
 * Astro 7.4.11 passed for these requests, read from the built admin function.
 */
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ resolveSession: vi.fn() }));
vi.mock('astro:middleware', () => ({ defineMiddleware: (handler: unknown) => handler }));
vi.mock('../admin/src/server/session', () => ({ resolveSession: session.resolveSession }));

import { onRequest } from '../admin/src/middleware';

type Handler = (context: unknown, next: () => Promise<Response>) => Promise<Response>;

/** `routePattern` defaults to the path, which is what a route without parameters matches as. */
function context(
  url: string,
  headers: Record<string, string> = {},
  routePattern = new URL(url).pathname,
) {
  return {
    url: new URL(url),
    routePattern,
    request: new Request(url, { headers }),
    locals: {} as Record<string, unknown>,
    redirect: (to: string, status: number) =>
      new Response(null, { status, headers: { Location: to } }),
  };
}

describe('the admin middleware', () => {
  beforeEach(() => {
    session.resolveSession.mockReset();
    session.resolveSession.mockResolvedValue({ authenticated: false, reason: 'no-session' });
  });

  it('refuses the x-astro-path header before it looks at the session', async () => {
    const next = vi.fn();
    const response = await (onRequest as unknown as Handler)(
      context('https://admin.withclaude.in/login', { 'x-astro-path': '/submissions' }),
      next,
    );
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(session.resolveSession).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('still gates an ordinary request on the session', async () => {
    const next = vi.fn();
    const response = await (onRequest as unknown as Handler)(
      context('https://admin.withclaude.in/submissions'),
      next,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/login?next=%2Fsubmissions');
    expect(next).not.toHaveBeenCalled();
  });
});

describe('the admin gate decides on the route that will run', () => {
  const ADMIN = 'https://admin.withclaude.in';
  const routeAnswer = () => Promise.resolve(new Response('the route'));

  beforeEach(() => {
    session.resolveSession.mockReset();
    session.resolveSession.mockResolvedValue({ authenticated: false, reason: 'no-session' });
  });

  async function gate(path: string, routePattern?: string) {
    const next = vi.fn(routeAnswer);
    const response = await (onRequest as unknown as Handler)(
      context(ADMIN + path, {}, routePattern),
      next,
    );
    return { response, next };
  }

  it.each([
    ['/api/claims/%252e%252e/login', '/api/claims/[id]/[action]'],
    [
      '/api/moderation/content/%252e%252e/%252e%252e/login',
      '/api/moderation/content/[type]/[id]/[action]',
    ],
  ])('answers %s, which it sees as /api/login, with its own 401', async (_sent, routePattern) => {
    const { response, next } = await gate('/api/login', routePattern);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Not authenticated.' });
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    ['/login', '/login'],
    ['/login/', '/login'],
    ['/login?next=%2Fsubmissions', '/login'],
    ['/api/auth', '/api/auth/[...all]'],
    ['/api/auth/', '/api/auth/[...all]'],
    ['/api/auth/get-session', '/api/auth/[...all]'],
    ['/api/auth/magic-link/verify?token=x', '/api/auth/[...all]'],
    ['/_image?href=x', '/_image'],
  ])('still lets %s through without a session', async (path, routePattern) => {
    const { response, next } = await gate(path, routePattern);
    expect(next).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe('the route');
  });

  it('gates a private path even when the route that matched is public, or under /_', async () => {
    // `/api/auth/%252e%252e/%252e%252e/submissions`: the path is private, the rest route public.
    const viaAuth = await gate('/submissions', '/api/auth/[...all]');
    expect(viaAuth.response.headers.get('location')).toBe('/login?next=%2Fsubmissions');
    // A `/_` path whose route is not a `/_` route is not an asset.
    const viaUnderscore = await gate('/_image', '/submissions/[id]');
    expect(viaUnderscore.response.status).toBe(302);
    expect(viaUnderscore.next).not.toHaveBeenCalled();
  });
});

describe('the Vercel adapter', () => {
  // The path override is refused by the adapter itself from 10.0.2 (GHSA-mr6q-rp88-fx84); the
  // site has no wrapper of its own any more, so a downgrade below that must fail here.
  it.each(['package.json', 'admin/package.json'])('resolves to 10.0.2 or later from %s', (from) => {
    const resolve = createRequire(new URL(`../${from}`, import.meta.url)).resolve;
    const { version } = createRequire(import.meta.url)(resolve('@astrojs/vercel/package.json'));
    const [major, minor, patch] = String(version).split('.').map(Number);
    expect(major > 10 || (major === 10 && (minor > 0 || patch >= 2)), version).toBe(true);
  });
});
