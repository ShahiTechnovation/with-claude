/**
 * PrivyRoot — THE ONLY `PrivyProvider` ON THE PUBLIC SITE.
 *
 * Two provider instances on one page race over Privy's hidden iframe
 * handshake (reproduced as `cannot dequeue privy:iframe:ready event`), which
 * is what produced the stuck "Checking…" state this file was created to fix.
 * So there is exactly one, mounted from `AccountNav.astro`, and every piece of
 * auth-aware UI on a page is rendered HERE and placed into the page's own DOM
 * node with a portal:
 *
 *   #account-slot-root        the masthead control (every page)
 *   #join-cta-root            an account page's sign-in / recovery panel
 *   #signout-slot-root        the settings page's sign-out button
 *   [data-account-island]     route-specific editors (profile, project),
 *                             lazy-loaded, with typed props from a JSON script
 *
 * A portal keeps React context, so the editors are genuinely beneath the
 * provider and `useAccount()` / `usePrivy()` are real for them. They used to
 * be separate Astro islands with no provider ancestor at all.
 *
 * ── THE STATE MACHINE ────────────────────────────────────────────────────
 *
 * `useAccountMachine()` turns Privy's flags plus one bootstrap POST into the
 * explicit states in `account-context.tsx`. Rules it keeps:
 *
 *   · bootstrap runs once per (user, attempt); `retry()` makes a new attempt
 *   · the sessionStorage cache only saves the masthead a POST per navigation;
 *     an account page that the SERVER could not authorise always re-runs the
 *     bootstrap instead of trusting it
 *   · every cached key is scoped to the Privy user id and is cleared on logout
 *     and when a different user signs in in the same tab
 *   · an account page redirects back to itself after sign-in at most once a
 *     minute; if the server still cannot see the session, the visitor gets an
 *     explanation and a retry, not a reload loop
 *   · Privy not becoming ready is reported after 8 s, not shown as a spinner
 *     forever
 */
import { PrivyProvider, usePrivy, type PrivyClientConfig } from '@privy-io/react-auth';
import {
  Component,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  AccountContextProvider,
  describeAccountProblem,
  useAccount,
  USERNAME_SAVED_EVENT,
  type AccountApi,
  type AccountErrorKind,
  type AccountState,
} from './account-context';

/** Trailing slash deliberate — see `src/data/forms.ts`. */
const BOOTSTRAP_ENDPOINT = '/api/member/bootstrap/';
const SIGNOUT_ENDPOINT = '/api/member/signout/';
/** Sign-out waits this long for the server at most, then navigates anyway. */
const SIGNOUT_WAIT_MS = 2_000;
/** Every key this file writes starts with this, so logout can clear them all. */
const PREFIX = 'wc:';
/** Pre-namespacing keys from the previous version, cleared on sight. */
const LEGACY_PREFIX = 'wc_';
const SLOW_AFTER_MS = 8_000;
const RETURN_GUARD_MS = 60_000;

// ── identity-scoped storage ──────────────────────────────────────────────

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

const accountKey = (userKey: string) => `${PREFIX}${userKey}:account`;
const returnKey = (path: string) => `${PREFIX}return:${path}`;

function readCache(userKey: string): Pick<AccountState, 'needsUsername' | 'ambassadorSlug'> | null {
  try {
    const raw = storage()?.getItem(accountKey(userKey));
    return raw ? (JSON.parse(raw) as Pick<AccountState, 'needsUsername' | 'ambassadorSlug'>) : null;
  } catch {
    return null;
  }
}

function writeCache(
  userKey: string,
  value: Pick<AccountState, 'needsUsername' | 'ambassadorSlug'>,
) {
  storage()?.setItem(accountKey(userKey), JSON.stringify(value));
}

/**
 * A saved username ends the nudge: in this state now, and in the tab's cache so
 * the next page does not bring it back from the bootstrap answer.
 */
export function withUsernameSaved(state: AccountState): AccountState {
  if (state.status !== 'signed-in' || !state.needsUsername || !state.userKey) return state;
  const facts = { needsUsername: false, ambassadorSlug: state.ambassadorSlug ?? null };
  writeCache(state.userKey, facts);
  return { ...state, ...facts };
}

/** Remove every key this file owns — or only one user's, on an account switch. */
function clearIdentityState(userKey?: string) {
  const store = storage();
  if (!store) return;
  for (const key of Object.keys(store)) {
    const ours = key.startsWith(PREFIX) || key.startsWith(LEGACY_PREFIX);
    if (!ours) continue;
    if (userKey && !key.startsWith(`${PREFIX}${userKey}:`)) continue;
    store.removeItem(key);
  }
}

/**
 * Ask the server to expire Privy's session cookies. Never throws, and never
 * holds up the navigation longer than SIGNOUT_WAIT_MS. With `dropLate`, an
 * answer that misses the wait is aborted: a caller whose own logout already
 * ended the session passes it, so a slow answer cannot land after the next
 * sign-in and expire that session's cookies.
 */
export async function serverSignOut(dropLate = false): Promise<void> {
  const late = new AbortController();
  let request: Promise<unknown>;
  try {
    request = fetch(SIGNOUT_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      signal: late.signal,
    }).catch(() => undefined);
  } catch {
    return;
  }
  await Promise.race([request, new Promise((resolve) => setTimeout(resolve, SIGNOUT_WAIT_MS))]);
  if (dropLate) late.abort(); // A no-op once the answer is in.
}

/** Privy's own localStorage keys (tokens included), for when its logout() cannot run. */
function clearPrivyStorage() {
  try {
    const store = window.localStorage;
    for (const key of Object.keys(store)) if (key.startsWith('privy:')) store.removeItem(key);
  } catch {
    // Storage blocked: nothing of Privy's can be in it either.
  }
}

function kindForStatus(status: number): AccountErrorKind {
  if (status === 503) return 'not-configured';
  if (status === 401) return 'session-rejected';
  if (status === 403) return 'account-unavailable';
  return 'unknown';
}

/** A same-origin path, and not one that could become an open redirect. */
export function isSafeNext(next: string): boolean {
  return (
    next.startsWith('/') &&
    !next.startsWith('//') &&
    !next.startsWith('/\\') &&
    !next.startsWith('/api/') &&
    !/[\r\n]/.test(next)
  );
}

// ── the machine ──────────────────────────────────────────────────────────

function useAccountMachine(): AccountApi {
  const { ready, authenticated, user, getAccessToken, login, logout } = usePrivy();
  const [state, setState] = useState<AccountState>({ status: 'initialising' });
  const [attempt, setAttempt] = useState(0);
  const startedFor = useRef<string | null>(null);
  const previousUser = useRef<string | null>(null);
  // A save can land while bootstrap is still in flight; its older answer must not undo it.
  const usernameSaved = useRef(false);

  // Privy that never becomes ready is a state, not a spinner.
  useEffect(() => {
    if (ready) return;
    const timer = window.setTimeout(() => {
      setState((s) => (s.status === 'initialising' ? { status: 'slow' } : s));
    }, SLOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [ready]);

  // A different person in the same tab must not inherit the last one's state.
  const currentUser = ready && authenticated ? (user?.id ?? null) : null;
  useEffect(() => {
    if (previousUser.current && previousUser.current !== currentUser) {
      clearIdentityState(previousUser.current);
      startedFor.current = null;
      usernameSaved.current = false;
    }
    previousUser.current = currentUser;
  }, [currentUser]);

  useEffect(() => {
    if (!ready) return;
    if (!authenticated || !user) {
      startedFor.current = null;
      setState({ status: 'signed-out' });
      return;
    }

    const userKey = user.id;
    // The server could not authorise this page: never trust the cache here.
    const serverNeedsProof = Boolean(document.getElementById('join-cta-root'));
    const cached = serverNeedsProof ? null : readCache(userKey);
    if (cached) {
      setState({ status: 'signed-in', userKey, ...cached });
      return;
    }

    const run = `${userKey}:${attempt}`;
    if (startedFor.current === run) return;
    startedFor.current = run;
    setState({ status: 'bootstrapping', userKey });

    let cancelled = false;
    (async () => {
      let token: string | null = null;
      try {
        token = await getAccessToken();
      } catch {
        // Fall through: the cookie still goes with a same-origin request.
      }
      let response: Response;
      try {
        response = await fetch(BOOTSTRAP_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          credentials: 'same-origin',
          body: '{}',
        });
      } catch {
        if (!cancelled) setState({ status: 'error', errorKind: 'network', userKey });
        return;
      }
      if (cancelled) return;
      if (!response.ok) {
        setState({ status: 'error', errorKind: kindForStatus(response.status), userKey });
        return;
      }
      const body = (await response.json().catch(() => ({}))) as {
        profile?: { needsUsername?: boolean };
        ambassador?: { slug?: string } | null;
      };
      const facts = {
        needsUsername: Boolean(body.profile?.needsUsername) && !usernameSaved.current,
        ambassadorSlug: body.ambassador?.slug ?? null,
      };
      writeCache(userKey, facts);
      if (!cancelled) setState({ status: 'signed-in', userKey, ...facts });
    })();

    return () => {
      cancelled = true;
      // Let the same run start again if this effect is re-entered.
      if (startedFor.current === run) startedFor.current = null;
    };
  }, [ready, authenticated, user?.id, attempt]);

  useEffect(() => {
    const onSaved = () => {
      usernameSaved.current = true;
      setState(withUsernameSaved);
    };
    window.addEventListener(USERNAME_SAVED_EVENT, onSaved);
    return () => window.removeEventListener(USERNAME_SAVED_EVENT, onSaved);
  }, []);

  const signIn = useCallback(() => login(), [login]);

  const signOut = useCallback(
    async (to = '/') => {
      let loggedOut = false;
      try {
        await logout();
        loggedOut = true;
      } finally {
        // Even when logout() threw, the server session still ends.
        await serverSignOut(loggedOut);
        clearIdentityState();
        window.location.assign(isSafeNext(to) ? to : '/');
      }
    },
    [logout],
  );

  const retry = useCallback(() => {
    if (state.userKey) clearIdentityState(state.userKey);
    setAttempt((n) => n + 1);
  }, [state.userKey]);

  const authHeaders = useCallback(async (): Promise<Record<string, string>> => {
    if (!authenticated) return {};
    try {
      const token = await getAccessToken();
      return token ? { Authorization: `Bearer ${token}` } : {};
    } catch {
      return {};
    }
  }, [authenticated, getAccessToken]);

  const accountFetch = useCallback(
    async (url: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      for (const [k, v] of Object.entries(await authHeaders())) headers.set(k, v);
      return fetch(url, { ...init, headers, credentials: 'same-origin' });
    },
    [authHeaders],
  );

  return useMemo(
    () => ({ state, signIn, signOut, retry, fetch: accountFetch, authHeaders }),
    [state, signIn, signOut, retry, accountFetch, authHeaders],
  );
}

// ── the masthead control ─────────────────────────────────────────────────

function displayNameOf(user: unknown): string {
  const accounts =
    (
      user as {
        linked_accounts?: Array<{
          type: string;
          username?: string;
          address?: string;
          email?: string;
        }>;
      } | null
    )?.linked_accounts ?? [];
  const github = accounts.find((a) => a.type === 'github_oauth');
  if (github?.username) return github.username;
  const google = accounts.find((a) => a.type === 'google_oauth');
  if (google?.email) return google.email.split('@')[0];
  const email = accounts.find((a) => a.type === 'email');
  if (email?.address) return email.address.split('@')[0];
  return 'Account';
}

function AccountSlot() {
  const { user } = usePrivy();
  const { state, signIn, signOut, retry } = useAccount();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const target = document.getElementById('account-slot-root');

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    // Focus the first item when the menu opens, for keyboard users.
    dropdownRef.current?.querySelector<HTMLElement>('a, button')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const handleDropdownKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!dropdownRef.current) return;
    const items = Array.from(dropdownRef.current.querySelectorAll<HTMLElement>('a, button'));
    const idx = items.indexOf(document.activeElement as HTMLElement);
    const next = {
      ArrowDown: (idx + 1) % items.length,
      ArrowUp: (idx - 1 + items.length) % items.length,
      Home: 0,
      End: items.length - 1,
    }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    items[next]?.focus();
  }, []);

  // Tab moves through the items like any links; the menu closes once focus moves to
  // anything but the trigger or the menu (the nudge too, or its pill would sit under
  // the menu). A null relatedTarget is ignored: Safari and Firefox clear focus on
  // mousedown, and the pointerdown listener already closes on outside presses.
  const handleBlur = useCallback((e: React.FocusEvent<HTMLDivElement>) => {
    const to = e.relatedTarget as Node | null;
    if (to && to !== triggerRef.current && !dropdownRef.current?.contains(to)) setOpen(false);
  }, []);

  if (!target) return null;

  let content: React.ReactNode;
  if (state.status === 'initialising' || state.status === 'slow') {
    content = (
      <div className="account-slot" data-account-state="loading" aria-hidden="true">
        <span className="account-join account-placeholder">Sign in</span>
      </div>
    );
  } else if (state.status === 'signed-out') {
    content = (
      <div className="account-slot" data-account-state="anonymous">
        <button type="button" className="account-join" onClick={signIn}>
          Sign in
        </button>
      </div>
    );
  } else {
    const displayName = displayNameOf(user);
    const needsUsername = state.status === 'signed-in' && state.needsUsername;
    content = (
      <div
        className="account-slot"
        data-account-state={state.status}
        ref={containerRef}
        onBlur={handleBlur}
      >
        {needsUsername && (
          <a className="account-nudge" href="/me/profile/edit/">
            Finish your profile
          </a>
        )}
        <button
          ref={triggerRef}
          className="account-link"
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={`Account menu for ${displayName}`}
          aria-expanded={open}
          aria-haspopup="menu"
        >
          <span className="account-badge" aria-hidden="true">
            {displayName[0]?.toUpperCase() ?? '•'}
          </span>
          <span className="account-name">{displayName}</span>
        </button>

        {open && (
          <div
            ref={dropdownRef}
            className="account-menu-dropdown"
            role="menu"
            aria-label="Account"
            onKeyDown={handleDropdownKeyDown}
          >
            {state.status === 'error' && (
              <button type="button" role="menuitem" onClick={retry}>
                Sign-in problem — retry
              </button>
            )}
            <a href="/me/" role="menuitem">
              Dashboard
            </a>
            <a href="/me/profile/" role="menuitem">
              Profile
            </a>
            <a href="/me/projects/" role="menuitem">
              My projects
            </a>
            {state.status === 'signed-in' && state.ambassadorSlug && (
              <a href={`/ambassadors/${state.ambassadorSlug}/`} role="menuitem">
                Ambassador profile
              </a>
            )}
            <a href="/me/settings/" role="menuitem">
              Settings
            </a>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void signOut('/');
              }}
            >
              Sign out
            </button>
          </div>
        )}
      </div>
    );
  }

  return createPortal(content, target);
}

// ── an account page's sign-in / recovery panel ───────────────────────────

function JoinCta() {
  const { state, signIn, signOut, retry } = useAccount();
  const target = document.getElementById('join-cta-root');
  const rawNext = target?.dataset.next ?? '/me/';
  const next = isSafeNext(rawNext) ? rawNext : '/me/';
  const [blocked, setBlocked] = useState(false);
  const redirected = useRef(false);

  useEffect(() => {
    if (!target || state.status !== 'signed-in' || redirected.current) return;
    const store = storage();
    const guard = returnKey(next);
    const last = Number(store?.getItem(guard) ?? 0);
    if (last && Date.now() - last < RETURN_GUARD_MS) {
      // We already came back here signed in and the server still could not
      // see the session. Reloading again would be a loop.
      setBlocked(true);
      return;
    }
    redirected.current = true;
    store?.setItem(guard, String(Date.now()));
    const destination = state.needsUsername && next === '/me/' ? '/me/profile/edit/' : next;
    window.location.assign(destination);
  }, [target, state, next]);

  if (!target) return null;

  let content: React.ReactNode;
  if (blocked) {
    content = (
      <div className="signin-failed" role="alert">
        <p className="signin-status">{describeAccountProblem('session-not-visible')}</p>
        <div className="signin-actions">
          <button
            type="button"
            className="signin-button"
            onClick={() => {
              storage()?.removeItem(returnKey(next));
              window.location.reload();
            }}
          >
            Try again
          </button>
          <button type="button" className="signin-secondary" onClick={() => void signOut(next)}>
            Sign out
          </button>
        </div>
      </div>
    );
  } else if (state.status === 'initialising') {
    content = <p className="signin-status">Preparing secure sign-in…</p>;
  } else if (state.status === 'slow') {
    content = (
      <div className="signin-failed" role="alert">
        <p className="signin-status">Sign-in is taking longer than usual to load.</p>
        <button type="button" className="signin-button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  } else if (state.status === 'signed-out') {
    content = (
      <button type="button" className="signin-button" onClick={signIn}>
        Sign in to continue
      </button>
    );
  } else if (state.status === 'bootstrapping') {
    content = <p className="signin-status">Setting up your account…</p>;
  } else if (state.status === 'error') {
    content = (
      <div className="signin-failed" role="alert">
        <p className="signin-status">{describeAccountProblem(state.errorKind)}</p>
        <div className="signin-actions">
          {state.errorKind !== 'not-configured' && state.errorKind !== 'account-unavailable' && (
            <button type="button" className="signin-button" onClick={retry}>
              Try again
            </button>
          )}
          <button type="button" className="signin-secondary" onClick={() => void signOut(next)}>
            Sign out
          </button>
        </div>
      </div>
    );
  } else {
    content = <p className="signin-status">Signed in — opening your account…</p>;
  }

  return createPortal(<div aria-live="polite">{content}</div>, target);
}

/** The settings page's sign-out button, portaled into `#signout-slot-root`. */
function SignOutSlot() {
  const { signOut } = useAccount();
  const target = document.getElementById('signout-slot-root');
  if (!target) return null;
  return createPortal(
    <button type="button" className="btn-secondary" onClick={() => void signOut('/')}>
      Sign out
    </button>,
    target,
  );
}

// ── route-specific account islands ───────────────────────────────────────

/**
 * Lazily loaded, so the editors' code is fetched only on the pages that have
 * a mount point for them. The names are the only values a page can put in
 * `data-account-island`; anything else is ignored.
 */
const ISLANDS: Record<string, ComponentType<Record<string, unknown>>> = {
  'profile-editor': lazy(() => import('./ProfileEditor')) as never,
  'project-editor': lazy(() => import('./ProjectEditor')) as never,
};

interface IslandMount {
  node: HTMLElement;
  name: string;
  props: Record<string, unknown>;
}

function readIslandMounts(): IslandMount[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-account-island]')).flatMap(
    (node) => {
      const name = node.dataset.accountIsland ?? '';
      if (!ISLANDS[name]) return [];
      const script = node.querySelector('script[type="application/json"]');
      try {
        const props = script?.textContent
          ? (JSON.parse(script.textContent) as Record<string, unknown>)
          : {};
        return [{ node, name, props }];
      } catch {
        return [];
      }
    },
  );
}

function AccountIslands() {
  const [mounts] = useState(readIslandMounts);
  return (
    <>
      {mounts.map(({ node, name, props }, index) => {
        const Island = ISLANDS[name];
        return createPortal(
          <Suspense fallback={<p className="island-loading">Loading…</p>}>
            <Island {...props} />
          </Suspense>,
          node,
          `${name}-${index}`,
        );
      })}
    </>
  );
}

function Inner({ openLogin = false }: { openLogin?: boolean }) {
  /**
   * Portal targets are DOM nodes React never rendered, so React never clears
   * their server fallback. Removing `.js-hydrate-hide` in a lazy initializer
   * runs during render, before the portals commit, so there is no flash of
   * both. A successful server-authorised account page (no `#join-cta-root`)
   * also clears the sign-in return guard.
   */
  useState(() => {
    document.querySelectorAll('.js-hydrate-hide').forEach((el) => el.remove());
    if (!document.getElementById('join-cta-root')) {
      const store = storage();
      if (store) {
        for (const key of Object.keys(store)) {
          if (key.startsWith(`${PREFIX}return:`)) store.removeItem(key);
        }
      }
    }
    return null;
  });

  const account = useAccountMachine();
  // The SDK was loaded because somebody pressed "Sign in": finish the gesture.
  const opened = useRef(false);
  useEffect(() => {
    if (!openLogin || opened.current || account.state.status !== 'signed-out') return;
    opened.current = true;
    account.signIn();
  }, [openLogin, account]);
  return (
    <AccountContextProvider value={account}>
      <AccountSlot />
      <JoinCta />
      <SignOutSlot />
      <AccountIslands />
    </AccountContextProvider>
  );
}

/**
 * WHEN THE PROVIDER ITSELF FAILS.
 *
 * `PrivyProvider` throws during render for a malformed app id, and can fail
 * on initialisation in other ways. Without a boundary that took down the
 * whole root — the masthead control, the sign-in panel AND the editors, which
 * then sat on "Loading the editor…" forever. Now a failure drops to a
 * degraded root: the state is an explicit, honest "sign-in unavailable", and
 * requests go with the cookie alone. A page the SERVER already authorised
 * keeps working; nothing is pretended.
 */
class ProviderBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // A fixed code only; SDK errors are not echoed.
    console.warn(
      '[account] sign-in provider failed to start',
      error instanceof Error ? error.name : 'unknown',
    );
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function DegradedInner() {
  useState(() => {
    document.querySelectorAll('.js-hydrate-hide').forEach((el) => el.remove());
    return null;
  });
  const account = useMemo<AccountApi>(
    () => ({
      state: { status: 'error', errorKind: 'not-configured' },
      // The sign-in gate is /me/; already there, a reload would only loop.
      signIn: () => {
        if (!window.location.pathname.startsWith('/me/')) window.location.assign('/me/');
      },
      // Clear the local session first: if the tab closes during the server
      // call, Privy's refresh token must not be left on the device.
      signOut: async (to = '/') => {
        clearPrivyStorage();
        clearIdentityState();
        await serverSignOut();
        window.location.assign(isSafeNext(to) ? to : '/');
      },
      retry: () => window.location.reload(),
      fetch: (url, init = {}) => fetch(url, { ...init, credentials: 'same-origin' }),
      authHeaders: async () => ({}),
    }),
    [],
  );
  return (
    <AccountContextProvider value={account}>
      <DegradedSlot />
      <JoinCta />
      <SignOutSlot />
      <AccountIslands />
    </AccountContextProvider>
  );
}

/** The masthead when the provider could not start: a plain link, no menu. */
function DegradedSlot() {
  const target = document.getElementById('account-slot-root');
  if (!target) return null;
  return createPortal(
    <div className="account-slot" data-account-state="unavailable">
      <a className="account-join" href="/me/">
        Account
      </a>
    </div>,
    target,
  );
}

// ── the login popup's look ───────────────────────────────────────────────

/** The site's clay (`--clay`): Privy's buttons, links and active borders on the dark popup. */
const PRIVY_ACCENT = '#D97757';
/** `--clay-deep` on light: Privy draws text in the accent on white, and #D97757 is 3.07:1 there. */
const PRIVY_ACCENT_LIGHT = '#9e4526';
/** The dark ground (`--paper`): Privy derives the rest of its dark palette from it. */
const PRIVY_DARK_GROUND = '#141413';
/** The popup's heading. Approved by the owner. */
const PRIVY_TITLE = 'Sign in to WITH CLAUDE';

/**
 * Privy's look, read once when it boots: the page's theme (`<html data-theme>`,
 * which is locked light on /me/), the clay accent and the 180px logo from `public/`.
 * Privy loads the logo itself, so it needs an absolute URL.
 */
export function privyAppearance(
  root: HTMLElement,
  origin: string,
): NonNullable<PrivyClientConfig['appearance']> {
  const light = root.dataset.theme === 'light';
  return {
    theme: light ? 'light' : PRIVY_DARK_GROUND,
    accentColor: light ? PRIVY_ACCENT_LIGHT : PRIVY_ACCENT,
    logo: `${origin}/logo-180.png`,
    landingHeader: PRIVY_TITLE,
  };
}

interface Props {
  appId: string;
  loginMethods?: string[];
  /** Open Privy's login once it is ready — the visitor clicked "Sign in". */
  openLogin?: boolean;
}

export default function PrivyRoot({ appId, loginMethods, openLogin = false }: Props) {
  const [appearance] = useState(() =>
    privyAppearance(document.documentElement, window.location.origin),
  );
  return (
    <ProviderBoundary fallback={<DegradedInner />}>
      <PrivyProvider
        appId={appId}
        config={{
          ...(loginMethods && loginMethods.length > 0
            ? { loginMethods: loginMethods as never }
            : {}),
          // The SDK shows "I have a passkey" whenever the dashboard has passkeys on,
          // whatever loginMethods says. This flag (internal, missing from the
          // 3.41 types) hides it unless we configured passkey ourselves.
          ...(loginMethods && loginMethods.length > 0 && !loginMethods.includes('passkey')
            ? ({ globalDisablePasskeys: true } as object)
            : {}),
          embeddedWallets: {
            ethereum: { createOnLogin: 'off' },
            solana: { createOnLogin: 'off' },
          },
          appearance,
        }}
      >
        <Inner openLogin={openLogin} />
      </PrivyProvider>
    </ProviderBoundary>
  );
}
