/**
 * The admin middleware refuses the Vercel adapter's path override header (GHSA-mr6q-rp88-fx84).
 *
 * @astrojs/vercel before 10.0.2 let any caller pick which route rendered, with the
 * `x-astro-path` header or the `x_astro_path` query parameter. From 10.0.2 the adapter's own
 * entry applies either one only when it carries the per-build secret, so the adapter is now
 * the first line. The middleware still answers a forged header with 400, before it looks at
 * the session: a second line, kept on purpose.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ resolveSession: vi.fn() }));
vi.mock('astro:middleware', () => ({ defineMiddleware: (handler: unknown) => handler }));
vi.mock('../admin/src/server/session', () => ({ resolveSession: session.resolveSession }));

import { onRequest } from '../admin/src/middleware';

type Handler = (context: unknown, next: () => Promise<Response>) => Promise<Response>;

function context(url: string, headers: Record<string, string> = {}) {
  return {
    url: new URL(url),
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
