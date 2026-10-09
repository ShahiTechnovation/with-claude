/**
 * THE SIGN-IN POPUP'S LOOK.
 *
 * Privy's popup used to be its default white box over the dark site. It now
 * follows the page's theme when Privy boots (dark ground on dark pages, light
 * on cream pages and the locked-light /me/ pages), takes the clay accent, the
 * site's logo and the owner-approved title. PrivyRoot passes on the login
 * methods account-boot gives it: the PUBLIC_PRIVY_LOGIN_METHODS ones the Privy
 * app has on (see privy-methods.ts).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

// The SDK is not needed to read the config, and does not belong in a node test.
vi.mock('@privy-io/react-auth', () => ({ PrivyProvider: () => null, usePrivy: () => ({}) }));

const { privyAppearance, serverSignOut, withUsernameSaved } =
  await import('../src/components/react/PrivyRoot');

const source = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const page = (theme?: string) => ({ dataset: theme ? { theme } : {} }) as unknown as HTMLElement;

describe('the Privy popup', () => {
  it('is dark on a dark page and light on a light or locked-light page', () => {
    expect(privyAppearance(page('dark'), 'https://www.withclaude.in').theme).toBe('#141413');
    // No data-theme yet means the dark default.
    expect(privyAppearance(page(), 'https://www.withclaude.in').theme).toBe('#141413');
    expect(privyAppearance(page('light'), 'https://www.withclaude.in').theme).toBe('light');
  });

  it('uses the small logo and the approved title in both themes', () => {
    for (const theme of ['dark', 'light']) {
      const look = privyAppearance(page(theme), 'http://localhost:4321');
      expect(look.logo).toBe('http://localhost:4321/logo-180.png');
      expect(look.landingHeader).toBe('Sign in to WITH CLAUDE');
    }
  });

  // Privy draws its Submit text in the accent on white: #D97757 is 3.07:1 there, --clay-deep 6.0:1.
  it('uses clay on the dark popup and --clay-deep on the light one', () => {
    expect(privyAppearance(page('dark'), 'https://www.withclaude.in').accentColor).toBe('#D97757');
    expect(privyAppearance(page(), 'https://www.withclaude.in').accentColor).toBe('#D97757');
    expect(privyAppearance(page('light'), 'https://www.withclaude.in').accentColor).toBe('#9e4526');
  });

  it('serves a logo sized for the popup (180px for a 90px slot, not the 487 KB original)', () => {
    const png = readFileSync('public/logo-180.png');
    expect(png.readUInt32BE(16)).toBe(180); // IHDR width
    expect(png.length).toBeLessThan(40_000);
  });

  it('reads the theme from <html> once, when Privy boots', () => {
    const root = source('src/components/react/PrivyRoot.tsx');
    expect(root).toContain('privyAppearance(document.documentElement, window.location.origin)');
    expect(root).toMatch(/config=\{\{[\s\S]*\n\s*appearance,\n/);
    expect(root).not.toContain("appearance: { theme: 'light' }");
  });

  it('passes on the login methods account-boot gives it, from the configured list', () => {
    const root = source('src/components/react/PrivyRoot.tsx');
    expect(root).toContain(
      '...(loginMethods && loginMethods.length > 0\n            ? { loginMethods: loginMethods as never }\n            : {}),',
    );
    const nav = source('src/components/AccountNav.astro');
    expect(nav).toContain('(import.meta.env.PUBLIC_PRIVY_LOGIN_METHODS as string | undefined)');
    expect(nav).toContain("data-login-methods={(loginMethods ?? []).join(',')}");
  });
});

describe('the account menu', () => {
  // Safari and Firefox blur on mousedown (relatedTarget null): closing then would
  // unmount the menu before a click on an item lands. Focus on the nudge must close
  // it, or the nudge's pill would sit hidden under the open menu.
  it('closes only when focus moves to something outside the trigger and the menu', () => {
    expect(source('src/components/react/PrivyRoot.tsx')).toContain(
      'if (to && to !== triggerRef.current && !dropdownRef.current?.contains(to)) setOpen(false);',
    );
  });
});

describe('the "Finish your profile" nudge', () => {
  const memory = () => {
    const data = new Map<string, string>();
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
      data,
    };
  };

  it('ends at once and stays gone on the next page once a username is saved', () => {
    const store = memory();
    vi.stubGlobal('window', { sessionStorage: store });
    try {
      // What bootstrap cached for this user, and another user's entry that must not change.
      store.setItem(
        'wc:u1:account',
        JSON.stringify({ needsUsername: true, ambassadorSlug: 'amb' }),
      );
      store.setItem('wc:u2:account', JSON.stringify({ needsUsername: true, ambassadorSlug: null }));
      const next = withUsernameSaved({
        status: 'signed-in',
        userKey: 'u1',
        needsUsername: true,
        ambassadorSlug: 'amb',
      });
      expect(next).toEqual({
        status: 'signed-in',
        userKey: 'u1',
        needsUsername: false,
        ambassadorSlug: 'amb',
      });
      expect(JSON.parse(store.getItem('wc:u1:account')!)).toEqual({
        needsUsername: false,
        ambassadorSlug: 'amb',
      });
      expect(JSON.parse(store.getItem('wc:u2:account')!).needsUsername).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('leaves any other state, and the cache, alone', () => {
    const store = memory();
    vi.stubGlobal('window', { sessionStorage: store });
    try {
      for (const state of [
        { status: 'bootstrapping' as const, userKey: 'u1' },
        { status: 'signed-in' as const, userKey: 'u1', needsUsername: false },
        { status: 'error' as const, errorKind: 'not-configured' as const },
      ]) {
        expect(withUsernameSaved(state)).toBe(state);
      }
      expect(store.data.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('is wired from the editor save to the provider', () => {
    const editor = source('src/components/react/ProfileEditor.tsx');
    // A placeholder-shaped handle (m-<12 hex>) still needs a username on the server.
    expect(editor).toContain(
      'if (body.username && !PLACEHOLDER_USERNAME.test(body.username as string)) {',
    );
    expect(editor).not.toContain('account.retry()');
    const root = source('src/components/react/PrivyRoot.tsx');
    expect(root).toContain('window.addEventListener(USERNAME_SAVED_EVENT, onSaved);');
    expect(root).toContain('usernameSaved.current = true;');
  });

  it('is not undone by a bootstrap answer that was already on its way', () => {
    const root = source('src/components/react/PrivyRoot.tsx');
    expect(root).toContain(
      'needsUsername: Boolean(body.profile?.needsUsername) && !usernameSaved.current,',
    );
    // A different person in the tab starts without the last one's save.
    expect(root).toMatch(/startedFor\.current = null;\s*usernameSaved\.current = false;/);
  });
});

describe('sign-out ends the server session', () => {
  const root = () => source('src/components/react/PrivyRoot.tsx');

  it('posts to the signout route same-origin with keepalive, and never throws', async () => {
    const calls: Array<[string, RequestInit]> = [];
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return Promise.reject(new Error('offline'));
    });
    try {
      await expect(serverSignOut()).resolves.toBeUndefined();
      expect(calls).toEqual([
        [
          '/api/member/signout/',
          expect.objectContaining({ method: 'POST', credentials: 'same-origin', keepalive: true }),
        ],
      ]);
      vi.stubGlobal('fetch', () => {
        throw new Error('no fetch');
      });
      await expect(serverSignOut()).resolves.toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('gives up waiting after the time limit, and aborts the late answer only when asked', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      signals.push(init.signal!);
      return new Promise(() => {});
    });
    try {
      const kept = serverSignOut();
      const dropped = serverSignOut(true);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(kept).resolves.toBeUndefined();
      await expect(dropped).resolves.toBeUndefined();
      expect(signals.map((s) => s.aborted)).toEqual([false, true]);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('runs in the normal signOut finally, before navigating, so a failed logout() still signs out', () => {
    // A late answer is dropped only once logout() has ended the session itself.
    expect(root()).toMatch(
      /await logout\(\);\s*loggedOut = true;\s*\} finally \{[^}]*await serverSignOut\(loggedOut\);\s*clearIdentityState\(\);\s*window\.location\.assign\(/,
    );
  });

  it('degraded mode renders the Sign out button, and its signOut calls the server', () => {
    const src = root();
    const degraded = src.slice(
      src.indexOf('function DegradedInner()'),
      src.indexOf('function DegradedSlot()'),
    );
    expect(degraded).toContain('<SignOutSlot />');
    expect(degraded).toMatch(
      /signOut: async \(to = '\/'\) => \{\s*clearPrivyStorage\(\);\s*clearIdentityState\(\);\s*await serverSignOut\(\);\s*window\.location\.assign\(isSafeNext\(to\) \? to : '\/'\);/,
    );
  });
});
