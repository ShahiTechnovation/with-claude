import { describe, expect, it, vi } from 'vitest';
import { onRequest } from '../src/middleware';

vi.mock('astro:middleware', () => ({ defineMiddleware: (handler: unknown) => handler }));

function context(headers: Record<string, string> = {}) {
  const url = new URL('https://www.withclaude.in/');
  return { url, request: new Request(url, { headers }), rewrite: vi.fn(), redirect: vi.fn() };
}

describe('the public middleware', () => {
  it('refuses the Vercel adapter path-override header', async () => {
    const next = vi.fn();
    const response = (await onRequest(
      context({ 'x-astro-path': '/not-found/' }) as never,
      next,
    )) as Response;
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(next).not.toHaveBeenCalled();
  });

  it('never reads request headers on a prerendered page (Astro warns on every one)', async () => {
    const ok = new Response('ok');
    const ctx = { ...context(), isPrerendered: true };
    Object.defineProperty(ctx.request, 'headers', {
      get: () => {
        throw new Error('headers read while prerendering');
      },
    });
    expect(
      await onRequest(
        ctx as never,
        vi.fn(async () => ok),
      ),
    ).toBe(ok);
  });

  it('passes an ordinary request through', async () => {
    const ok = new Response('ok');
    const next = vi.fn(async () => ok);
    expect(await onRequest(context() as never, next)).toBe(ok);
    expect(next).toHaveBeenCalledOnce();
  });
});
