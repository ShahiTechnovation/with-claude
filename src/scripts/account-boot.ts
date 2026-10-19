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
 *                  opens as soon as the SDK is ready. The download starts
 *                  a little earlier, when they point at, focus or touch it
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

const appId = mount?.dataset.appId ?? '';
const loginMethods = (mount?.dataset.loginMethods ?? '').split(',').filter(Boolean);

type Loaded = [
  typeof import('react'),
  typeof import('react-dom/client'),
  typeof import('@/components/react/PrivyRoot'),
];
let warmed: { sdk: Promise<Loaded>; methods: Promise<string[]> } | null = null;

/** Start the downloads without rendering: on intent (hover, focus, touch) and on boot. */
function warm(): NonNullable<typeof warmed> {
  if (warmed) return warmed;
  if (import.meta.env.DEV) {
    // Dev only: Vite's React plugin adds fast-refresh hooks to every .tsx, and
    // Astro installs their globals only for its own islands. This tree is not
    // an island, so give it no-op hooks (no hot reload for it, nothing else).
    const w = window as unknown as Record<string, unknown>;
    w.$RefreshReg$ ??= () => {};
    w.$RefreshSig$ ??= () => (type: unknown) => type;
  }
  // Asked in parallel with the SDK download: drops methods the Privy app has off.
  warmed = {
    methods: enabledLoginMethods(appId, loginMethods),
    sdk: Promise.all([
      import('react'),
      import('react-dom/client'),
      import('@/components/react/PrivyRoot'),
    ]),
  };
  // A failed download is not kept: the next hover or click starts it again.
  warmed.sdk.catch(() => {
    warmed = null;
  });
  return warmed;
}

let booted: Promise<void> | null = null;

function boot(openLogin: boolean): Promise<void> {
  if (booted || !mount) return booted ?? Promise.resolve();
  const { sdk, methods } = warm();
  booted = sdk
    .then(async ([React, { createRoot }, { default: PrivyRoot }]) => {
      // Its grace period starts once the SDK has loaded, so a slow link still filters.
      const enabled = await Promise.race([
        methods,
        new Promise<string[]>((resolve) => setTimeout(resolve, 1500, loginMethods)),
      ]);
      createRoot(mount).render(
        React.createElement(PrivyRoot, { appId, loginMethods: enabled, openLogin }),
      );
    })
    .catch((error: unknown) => {
      // The download failed (a deploy replaced the file, the connection dropped, a blocker).
      // PrivyRoot never mounted, so its own slow state cannot show: undo the click's label,
      // let the next click try again, and give the gate PrivyRoot's slow-start line.
      console.error('[account] sign-in failed to load', error);
      booted = null;
      for (const link of document.querySelectorAll('[data-account-signin][aria-busy]')) {
        link.removeAttribute('aria-busy');
        link.textContent = 'Sign in';
      }
      const gate = document.getElementById('join-cta-root');
      if (gate) {
        // Fixed markup, the same as PrivyRoot's slow state; nothing from the error goes in.
        gate.innerHTML =
          '<div class="signin-failed" role="alert">' +
          '<p class="signin-status">Sign-in is taking longer than usual to load.</p>' +
          '<button type="button" class="signin-button">Reload</button></div>';
        gate.querySelector('button')?.addEventListener('click', () => window.location.reload());
      }
    });
  return booted;
}

if (appId) {
  if (needsAccountNow() || hasPrivySession()) {
    void boot(false);
  } else {
    // A pointer resting on, a focus on or a finger touching "Sign in" usually
    // comes a few hundred ms before the click: start the download then.
    const onIntent = (event: Event) => {
      if ((event.target as Element | null)?.closest?.('[data-account-signin]')) warm();
    };
    for (const type of ['pointerover', 'focusin', 'touchstart'])
      document.addEventListener(type, onIntent, { passive: true });
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
