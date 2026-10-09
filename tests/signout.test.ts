/**
 * POST /api/member/signout — ends the server session even when Privy's own
 * logout() cannot run (degraded mode) or throws.
 */
import { describe, expect, it } from 'vitest';
import { ALL, POST } from '../src/pages/api/member/signout';

const call = (handler: typeof POST, url: string, init: RequestInit = {}) =>
  handler({ request: new Request(url, init) } as never) as Promise<Response>;

const post = (url: string, headers: Record<string, string> = {}) =>
  call(POST, url, { method: 'POST', headers: { origin: new URL(url).origin, ...headers } });

const NAMES = ['privy-token', 'privy-id-token', 'privy-refresh-token', 'privy-session'];
const EXPIRED = 'Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT';

describe('POST /api/member/signout', () => {
  it('refuses any other method with 405', async () => {
    const res = await call(ALL, 'https://www.withclaude.in/api/member/signout/');
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('refuses a cross-origin POST with 403 and sets no cookie', async () => {
    const res = await post('https://www.withclaude.in/api/member/signout/', {
      origin: 'https://evil.example',
    });
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual([]);
    const crossSite = await post('https://www.withclaude.in/api/member/signout/', {
      'sec-fetch-site': 'cross-site',
    });
    expect(crossSite.status).toBe(403);
  });

  it('signs out with no token and with an invalid one', async () => {
    for (const headers of <Record<string, string>[]>[
      {},
      { cookie: 'privy-token=not-a-jwt' },
      { authorization: 'Bearer not-a-jwt' },
    ]) {
      const res = await post('https://www.withclaude.in/api/member/signout/', headers);
      expect(res.status).toBe(204);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('expires every Privy cookie host-only and on .withclaude.in, Secure on https', async () => {
    const expected = NAMES.flatMap((name) => [
      `${name}=; ${EXPIRED}; Secure; SameSite=Lax`,
      `${name}=; Domain=.withclaude.in; ${EXPIRED}; Secure; SameSite=Lax`,
    ]);
    for (const host of ['https://withclaude.in', 'https://www.withclaude.in']) {
      const res = await post(`${host}/api/member/signout/`);
      expect(res.headers.getSetCookie()).toEqual(expected);
    }
  });

  it('expires them host-only, without Secure, on http localhost', async () => {
    for (const host of ['http://localhost:4321', 'http://127.0.0.1:4322']) {
      const res = await post(`${host}/api/member/signout/`);
      expect(res.status).toBe(204);
      expect(res.headers.getSetCookie()).toEqual(
        NAMES.map((name) => `${name}=; ${EXPIRED}; SameSite=Lax`),
      );
    }
  });

  it('expires them host-only on a vercel.app preview (a public suffix)', async () => {
    const res = await post('https://with-claude-git-x.vercel.app/api/member/signout/');
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie().some((c) => c.includes('Domain='))).toBe(false);
  });
});
