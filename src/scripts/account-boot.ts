/**
 * LOAD THE SIGN-IN SDK ONLY WHEN IT IS NEEDED.
 *
 * `PrivyRoot` carries the Privy SDK — about 650 KB of gzipped JavaScript. It
 * used to be an Astro `client:only` island on every page, so every visitor
 * downloaded and ran it, including the ones who only came to read. Now:
 *
 *   load at once   on an account page (sign-in panel, an editor, sign-out),
 *                  or when this browser already holds a Privy session — a
 *                  signed-in member sees their account control as before
 *   load on click  for everyone else, when they press "Sign in"; the login
 *                  opens as soon as the SDK is ready
 *
 * With JavaScript off the static "Sign in" link still goes to `/me/`
 * (`signInHref`), the sign-in gate.
 * Session detection reads only whether Privy's own keys EXIST; it never reads
 * or copies a token.
 */
import { enabledLoginMethods } from '@/components/react/privy-methods';

const mount = document.getElementById('privy-root');

function hasPrivySession(): boolean {
  if (/(?:^|;\s*)privy-(?:token|session)=/.test(document.cookie)) return true;
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i) ?? '';
      if (key === 'privy:token' || (key.startsWith('privy:') && key.endsWith(':token')))
        return true;
    }
  } catch {
    // Storage blocked: fall back to loading on demand.
  }
  return false;
}

function needsAccountNow(): boolean {
  return Boolean(
    document.getElementById('join-cta-root') ||
    document.getElementById('signout-slot-root') ||
    document.querySelector('[data-account-island]'),
  );
}

let booted: Promise<void> | null = null;

function boot(openLogin: boolean): Promise<void> {
  if (booted || !mount) return booted ?? Promise.resolve();
  const appId = mount.dataset.appId ?? '';
  const loginMethods = (mount.dataset.loginMethods ?? '').split(',').filter(Boolean);
  if (import.meta.env.DEV) {
    // Dev only: Vite's React plugin adds fast-refresh hooks to every .tsx, and
    // Astro installs their globals only for its own islands. This tree is not
    // an island, so give it no-op hooks (no hot reload for it, nothing else).
    const w = window as unknown as Record<string, unknown>;
    w.$RefreshReg$ ??= () => {};
    w.$RefreshSig$ ??= () => (type: unknown) => type;
  }
  // Asked in parallel with the SDK download: drops methods the Privy app has off.
  // Its grace period starts once the SDK has loaded, so a slow link still filters.
  const methods = enabledLoginMethods(appId, loginMethods);
  booted = Promise.all([
    import('react'),
    import('react-dom/client'),
    import('@/components/react/PrivyRoot'),
  ]).then(async ([React, { createRoot }, { default: PrivyRoot }]) => {
    const enabled = await Promise.race([
      methods,
      new Promise<string[]>((resolve) => setTimeout(resolve, 1500, loginMethods)),
    ]);
    createRoot(mount).render(
      React.createElement(PrivyRoot, { appId, loginMethods: enabled, openLogin }),
    );
  });
  return booted;
}

if (mount?.dataset.appId) {
  if (needsAccountNow() || hasPrivySession()) {
    void boot(false);
  } else {
    // Capture-phase, so the static link never navigates once JS is running.
    document.addEventListener(
      'click',
      (event) => {
        const target = (event.target as Element | null)?.closest('[data-account-signin]');
        if (!target || booted) return;
        event.preventDefault();
        target.setAttribute('aria-busy', 'true');
        target.textContent = 'Opening sign-in…';
        void boot(true);
      },
      { capture: true },
    );
  }
}
