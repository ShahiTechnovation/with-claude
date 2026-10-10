/**
 * THE SIGN-IN POPUP OFFERS ONLY THE METHODS THE PRIVY APP HAS SWITCHED ON.
 *
 * A configured method that is off in the Privy dashboard drew a button whose
 * click failed with 403 `disallowed_login_method`.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enabledLoginMethods, filterLoginMethods } from '../src/components/react/privy-methods';

const configured = ['email', 'google', 'github'];

describe('filterLoginMethods', () => {
  it('drops google when google_oauth is false and keeps it when true', () => {
    expect(
      filterLoginMethods(configured, {
        email_auth: true,
        google_oauth: false,
        github_oauth: false,
      }),
    ).toEqual(['email']);
    expect(
      filterLoginMethods(configured, { email_auth: true, google_oauth: true, github_oauth: false }),
    ).toEqual(['email', 'google']);
  });

  it('keeps an unknown name and a method whose flag is missing', () => {
    expect(filterLoginMethods(['email', 'newthing', 'apple'], { email_auth: true })).toEqual([
      'email',
      'newthing',
      'apple',
    ]);
  });

  it('falls back to the configured list for a missing config or an empty result', () => {
    expect(filterLoginMethods(configured, null)).toEqual(configured);
    expect(filterLoginMethods(configured, 'oops')).toEqual(configured);
    expect(
      filterLoginMethods(configured, {
        email_auth: false,
        google_oauth: false,
        github_oauth: false,
      }),
    ).toEqual(configured);
  });

  it('keeps a method that is on through either of its flags, as the SDK reads them', () => {
    expect(
      filterLoginMethods(['email', 'wallet'], {
        email_auth: true,
        wallet_auth: false,
        solana_wallet_auth: true,
      }),
    ).toEqual(['email', 'wallet']);
    expect(
      filterLoginMethods(['email', 'telegram'], {
        email_auth: true,
        telegram_auth: false,
        telegram_oauth: true,
      }),
    ).toEqual(['email', 'telegram']);
    expect(
      filterLoginMethods(['email', 'wallet'], {
        email_auth: true,
        wallet_auth: false,
        solana_wallet_auth: false,
      }),
    ).toEqual(['email']);
  });

  it('never adds a method the app enables but we did not configure', () => {
    expect(
      filterLoginMethods(['email'], {
        email_auth: true,
        wallet_auth: true,
        passkey_auth: true,
        google_oauth: true,
      }),
    ).toEqual(['email']);
  });
});

describe('enabledLoginMethods', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks Privy on every boot, so a dashboard change is not pinned for the tab', async () => {
    // The browser caches the answer for Privy's max-age=300; no copy of our own outlives it.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ email_auth: true, google_oauth: false, github_oauth: false }),
      )
      .mockResolvedValueOnce(Response.json({ email_auth: true, google_oauth: true }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await enabledLoginMethods('app1', configured)).toEqual(['email']);
    expect(await enabledLoginMethods('app1', configured)).toEqual(['email', 'google', 'github']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]).toEqual([
      'https://auth.privy.io/api/v1/apps/app1',
      expect.objectContaining({ headers: { 'privy-app-id': 'app1' } }),
    ]);
  });

  it('falls back to the configured list when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network');
      }),
    );
    expect(await enabledLoginMethods('app1', configured)).toEqual(configured);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('no', { status: 500 })),
    );
    expect(await enabledLoginMethods('app1', configured)).toEqual(configured);
  });

  it('gives up on a hung request and falls back to the configured list', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const c = new AbortController();
      setTimeout(() => c.abort(new DOMException('timed out', 'TimeoutError')), 5);
      return c.signal;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) =>
            init.signal!.addEventListener('abort', () => reject(init.signal!.reason)),
          ),
      ),
    );
    try {
      expect(await enabledLoginMethods('app1', configured)).toEqual(configured);
      expect(timeout).toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
    }
  });
});

describe('the wiring', () => {
  it('asks in parallel with loading PrivyRoot, waits briefly after it, and passes the result', () => {
    const boot = readFileSync('src/scripts/account-boot.ts', 'utf8');
    expect(boot).toContain(
      "import { enabledLoginMethods } from '@/components/react/privy-methods';",
    );
    // The request starts before the SDK imports...
    expect(boot).toMatch(
      /methods: enabledLoginMethods\(appId, loginMethods\),\s*sdk: Promise\.all\(\[[^\]]*import\('@\/components\/react\/PrivyRoot'\),\s*\]\)/,
    );
    // Pointing at, focusing or touching "Sign in" starts both downloads before the click.
    expect(boot).toMatch(/closest\?\.\('\[data-account-signin\]'\)\) warm\(\);/);
    expect(boot).toMatch(/\['pointerover', 'focusin', 'touchstart'\]/);
    // ...and its grace period only starts once they have loaded.
    expect(boot).toMatch(
      /await Promise\.race\(\[\s*methods,\s*new Promise<string\[\]>\(\(resolve\) => setTimeout\(resolve, 1500, loginMethods\)\),\s*\]\)/,
    );
    expect(boot).toContain(
      'React.createElement(PrivyRoot, { appId, loginMethods: enabled, openLogin })',
    );
  });

  it('hides the passkey button unless passkey is a configured method', () => {
    // The SDK draws "I have a passkey" from the dashboard flag alone; loginMethods
    // cannot remove it, so PrivyRoot sets globalDisablePasskeys instead.
    const root = readFileSync('src/components/react/PrivyRoot.tsx', 'utf8');
    expect(root).toMatch(
      /loginMethods && loginMethods\.length > 0 && !loginMethods\.includes\('passkey'\)\s*\? \(\{ globalDisablePasskeys: true \} as object\)/,
    );
  });
});
