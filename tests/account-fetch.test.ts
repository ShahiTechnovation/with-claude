/**
 * `accountFetch` / `describeAccountError` — the fix for the profile-save
 * regression, tested as running code rather than only as source text.
 *
 * `ProfileEditor`, `ProjectEditor` and `ReportModal` are mounted as
 * standalone islands outside the site's one `PrivyProvider` (see
 * `src/lib/account-fetch.ts` for the full explanation), so `getAccessToken()`
 * inside them always throws. These tests assert the two properties that
 * actually mattered in production: the throw must never reach the caller,
 * and the request must still go out.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountFetch, describeAccountError } from '../src/lib/account-fetch';

const NOT_WRAPPED = () =>
  Promise.reject(
    new Error('You need to wrap your application with the <PrivyProvider> initialized with your app id.'),
  );

describe('accountFetch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * THE EXACT PRODUCTION BUG.
   *
   * `getAccessToken` throwing must not propagate out of `accountFetch` — that
   * throw, reaching `ProfileEditor.save()`'s try/catch, is precisely what
   * turned every save into "Network error while saving." before a single
   * byte reached the network.
   */
  it('does not throw when getAccessToken rejects — it still issues the request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    const response = await accountFetch('/api/member/profile/', { method: 'PATCH' }, NOT_WRAPPED);

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('sends the request without an Authorization header when no token is available', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    await accountFetch('/api/member/profile/', { method: 'PATCH' }, NOT_WRAPPED);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.has('Authorization')).toBe(false);
    /**
     * `credentials: 'same-origin'` is what carries the `privy-token` cookie
     * — the ENTIRE reason omitting the header is safe. Without this, the
     * fix would be "send an unauthenticated request and hope", not "send
     * the request the server can actually authenticate".
     */
    expect(init.credentials).toBe('same-origin');
  });

  it('adds a Bearer header when a token IS available', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    await accountFetch('/api/member/profile/', { method: 'PATCH' }, async () => 'a-real-token');

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer a-real-token');
  });

  it('preserves headers already set on the request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    await accountFetch(
      '/api/member/profile/',
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' } },
      NOT_WRAPPED,
    );

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  /**
   * A REAL network failure must still surface. This is what stays "Network
   * error while saving." after the fix — the difference is that it now only
   * happens when a request genuinely could not be sent.
   */
  it('still rejects when the network call itself fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(accountFetch('/api/member/profile/', { method: 'PATCH' }, NOT_WRAPPED)).rejects.toThrow(
      'Failed to fetch',
    );
  });
});

describe('describeAccountError', () => {
  const withStatus = (status: number, body: unknown = {}) =>
    new Response(JSON.stringify(body), { status });

  it('maps 401 to a session-expired message, not a generic failure', async () => {
    expect(await describeAccountError(withStatus(401))).toBe('Your session has expired. Sign in again.');
  });

  it('maps 403 to a permission message', async () => {
    expect(await describeAccountError(withStatus(403))).toBe('You do not have permission to do that.');
  });

  it('surfaces the server-provided message on a 409 conflict', async () => {
    expect(await describeAccountError(withStatus(409, { error: 'That username is taken.' }))).toBe(
      'That username is taken.',
    );
  });

  it('falls back to a generic conflict message if the body has none', async () => {
    expect(await describeAccountError(withStatus(409, {}))).toBe('That value is already in use.');
  });

  it('surfaces the server-provided message on a 422 validation failure', async () => {
    expect(await describeAccountError(withStatus(422, { error: 'That is not a city on the atlas.' }))).toBe(
      'That is not a city on the atlas.',
    );
  });

  it('falls back to a generic validation message if the body is not JSON', async () => {
    const response = new Response('not json', { status: 400 });
    expect(await describeAccountError(response)).toBe('Please check the highlighted fields.');
  });

  it('gives a generic message for an unexpected status, and never throws', async () => {
    expect(await describeAccountError(withStatus(500))).toBe("Couldn't save your changes. Please try again.");
  });
});
