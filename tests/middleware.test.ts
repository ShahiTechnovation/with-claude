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

  it('passes an ordinary request through', async () => {
    const ok = new Response('ok');
    const next = vi.fn(async () => ok);
    expect(await onRequest(context() as never, next)).toBe(ok);
    expect(next).toHaveBeenCalledOnce();
  });
});
