/**
 * PrivyRoot — THE ONLY `PrivyProvider` ON THE PUBLIC SITE.
 *
 * Root cause of the "stuck on Checking…" regression: this site used to mount
 * `PrivyProvider` twice on pages like `/join` — once from the masthead's
 * account control (every page) and once from that page's own hero CTA
 * (`SignIn.tsx`). Two independent `PrivyProvider` instances each open their
 * own hidden iframe for Privy's session handshake, and the two instances
 * race over it: reproduced locally as a deterministic
 * `cannot dequeue privy:iframe:ready event: no event found for id id-N`
 * console error on every load of a dual-mount page, and zero such errors on
 * a single-mount page. On Preview's real network latency that race
 * sometimes never resolves, which is the stuck "Checking…" state.
 *
 * The fix is not a retry or a timeout — it is having exactly one provider.
 * This component is that provider, mounted once (from `AccountNav.astro`,
 * itself included once by `Masthead.astro`). Anything elsewhere on the page
 * that needs the login button or the account control is rendered here and
 * placed into that page's own DOM node with a portal, so every page still
 * gets its own visual CTA without a second Privy client.
 *
 * `client:only="react"` — mounted client-side only, same reasoning as the
 * components it replaces: Privy's provider reads browser storage on mount
 * and has no meaningful server render.
 */
import { PrivyProvider, usePrivy } from '@privy-io/react-auth';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** Trailing slash deliberate — see `src/data/forms.ts`. */
const BOOTSTRAP_ENDPOINT = '/api/member/bootstrap/';
const BOOTSTRAPPED_KEY = 'wc_bootstrapped';
const NEEDS_USERNAME_KEY = 'wc_needs_username';
const NUDGE_DISMISSED_KEY = 'wc_nudge_dismissed';
/**
 * The ambassador slug, cached per login alongside the other bootstrap facts.
 *
 * Cached for the same reason `needsUsername` is: the menu is rendered on every
 * page, and a member who has already been provisioned must not cause a POST
 * per navigation just so a menu item can be decided. §45, applied to a
 * five-item dropdown.
 */
const AMBASSADOR_KEY = 'wc_ambassador_slug';

type BootstrapState =
  | { status: 'idle' | 'running' }
  | {
      status: 'done';
      needsUsername: boolean;
      /** §43 — the slug when this member is a published ambassador, else null. */
      ambassadorSlug: string | null;
    }
  | { status: 'failed'; kind: 'server-unavailable' | 'auth-error' };

/**
 * Provision the member row exactly once per login, from exactly one place.
 *
 * A `useRef` guard (checked and set synchronously, before the `await`) is
 * what makes this exactly-once even when both portals below become
 * authenticated in the same render — a `sessionStorage` flag alone is not
 * enough, because it is only written after the fetch resolves, so two
 * effects racing in the same tick would both pass the check.
 */
function useBootstrapOnce(): BootstrapState {
  const { ready, authenticated, user, getAccessToken } = usePrivy();
  const [state, setState] = useState<BootstrapState>({ status: 'idle' });
  const started = useRef(false);

  useEffect(() => {
    if (!ready || !authenticated || started.current) return;

    const memberKey = `${BOOTSTRAPPED_KEY}:${user?.id ?? 'unknown'}`;
    const usernameKey = `${NEEDS_USERNAME_KEY}:${user?.id ?? 'unknown'}`;
    const ambassadorKey = `${AMBASSADOR_KEY}:${user?.id ?? 'unknown'}`;
    if (sessionStorage.getItem(memberKey)) {
      setState({
        status: 'done',
        needsUsername: sessionStorage.getItem(usernameKey) === '1',
        ambassadorSlug: sessionStorage.getItem(ambassadorKey) || null,
      });
      return;
    }

    started.current = true;
    setState({ status: 'running' });

    (async () => {
      try {
        const token = await getAccessToken();
        const response = await fetch(BOOTSTRAP_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          credentials: 'same-origin',
        });
        if (!response.ok) {
          // 503 means the server has no Privy credentials configured — not a
          // user error. Any other non-OK is a user-level auth failure.
          const kind = response.status === 503 ? 'server-unavailable' : 'auth-error';
          setState({ status: 'failed', kind });
          return;
        }
        const body = (await response.json()) as {
          profile?: { needsUsername?: boolean };
          ambassador?: { slug?: string } | null;
        };
        const needsUsername = Boolean(body.profile?.needsUsername);
        const ambassadorSlug = body.ambassador?.slug ?? null;
        sessionStorage.setItem(memberKey, '1');
        sessionStorage.setItem(usernameKey, needsUsername ? '1' : '0');
        // Written as the empty string for "not an ambassador", so the cached
        // read above can tell "we asked and the answer was no" from "we have
        // not asked" — `getItem` returns null for both otherwise.
        sessionStorage.setItem(ambassadorKey, ambassadorSlug ?? '');
        setState({ status: 'done', needsUsername, ambassadorSlug });
      } catch {
        setState({ status: 'failed', kind: 'auth-error' });
      }
    })();
  }, [ready, authenticated, user?.id, getAccessToken]);

  return state;
}


/** The masthead's auth-aware slot, portaled into `#account-slot-root`. */
function AccountSlot({ bootstrap }: { bootstrap: BootstrapState }) {
  const { ready, authenticated, user, login, logout } = usePrivy();
  const [open, setOpen] = useState(false);
  const [nudgeDismissed, setNudgeDismissed] = useState(
    () => sessionStorage.getItem(NUDGE_DISMISSED_KEY) === '1',
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
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
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const handleDropdownKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!dropdownRef.current) return;
    const items = Array.from(dropdownRef.current.querySelectorAll<HTMLElement>('a, button'));
    const idx = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(idx + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(idx - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  }, []);

  const dismissNudge = useCallback(() => {
    sessionStorage.setItem(NUDGE_DISMISSED_KEY, '1');
    setNudgeDismissed(true);
  }, []);

  const displayName = (() => {
    if (!user) return 'Account';
    const accounts = (user as { linked_accounts?: Array<{ type: string; username?: string; address?: string; email?: string }> }).linked_accounts ?? [];
    const github = accounts.find((a) => a.type === 'github_oauth');
    if (github?.username) return github.username;
    const google = accounts.find((a) => a.type === 'google_oauth');
    if (google?.email) return google.email.split('@')[0];
    const email = accounts.find((a) => a.type === 'email');
    if (email?.address) return email.address.split('@')[0];
    return 'Account';
  })();

  const initial = displayName[0]?.toUpperCase() ?? '•';

  /**
   * Null until the bootstrap call has answered, and null for nearly everyone
   * after it. Read off the discriminated state rather than kept in its own
   * `useState`, so the menu cannot show a stale ambassador link from a
   * previous login in the same tab.
   */
  const ambassadorSlug = bootstrap.status === 'done' ? bootstrap.ambassadorSlug : null;

  const target = document.getElementById('account-slot-root');
  if (!target) return null;

  let content: React.ReactNode;

  if (!ready) {
    content = (
      <div className="account-slot" data-account-state="loading" aria-hidden="true">
        <span className="account-join account-placeholder">Join WITH CLAUDE</span>
      </div>
    );
  } else if (!authenticated) {
    content = (
      <div className="account-slot" data-account-state="anonymous">
        <button type="button" className="account-join" onClick={() => login()}>
          Join WITH CLAUDE
        </button>
      </div>
    );
  } else {
    const needsUsername = bootstrap.status === 'done' && bootstrap.needsUsername && !nudgeDismissed;
    content = (
      <div
        className="account-slot"
        data-account-state="signed-in"
        ref={containerRef}
        style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
      >
        {needsUsername && (
          <div className="account-nudge">
            <a href="/me/profile/edit/" onClick={dismissNudge}>
              Complete profile
            </a>
            <button type="button" aria-label="Dismiss" onClick={dismissNudge}>
              ×
            </button>
          </div>
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
            {initial}
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
            <a href="/me/profile/" role="menuitem">
              Profile
            </a>
            <a href="/me/projects/" role="menuitem">
              Projects
            </a>
            {/*
              §43 — only when there is one. Ambassador status is a community
              identity, not an account tier, so the overwhelming majority of
              signed-in members never see this item and nothing on the menu
              hints that they are missing anything.
            */}
            {ambassadorSlug && (
              <a href={`/ambassadors/${ambassadorSlug}/`} role="menuitem">
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
                void logout().then(() => window.location.assign('/'));
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

function isValidNext(next: string) {
  if (!next.startsWith('/')) return false;
  if (next.startsWith('//')) return false;
  return true;
}

/**
 * A page's own hero sign-in CTA, portaled into that page's `#join-cta-root`.
 */
function JoinCta({ bootstrap }: { bootstrap: BootstrapState }) {
  const { ready, authenticated, login, logout } = usePrivy();
  const redirected = useRef(false);

  const target = document.getElementById('join-cta-root');
  const rawNext = target?.dataset.next ?? '/me/';
  const next = isValidNext(rawNext) ? rawNext : '/me/';

  useEffect(() => {
    if (!target || bootstrap.status !== 'done' || redirected.current) return;
    redirected.current = true;
    window.location.assign(bootstrap.needsUsername ? '/me/profile/edit/' : next);
  }, [target, bootstrap, next]);

  if (!target) return null;

  let content: React.ReactNode;

  if (!ready) {
    content = <p className="signin-status">Checking…</p>;
  } else if (!authenticated) {
    content = (
      <button type="button" className="signin-button" onClick={() => login()}>
        Continue with WITH CLAUDE
      </button>
    );
  } else if (bootstrap.status === 'failed') {
    if (bootstrap.kind === 'server-unavailable') {
      // Server credentials are missing — not the user's fault.
      // Don't show "Something went wrong signing you in." which implies a user error.
      content = (
        <p className="signin-status">Sign-in is temporarily unavailable. Please try again shortly.</p>
      );
    } else {
      content = (
        <div className="signin-failed">
          <p className="signin-status">Something went wrong signing you in.</p>
          <button type="button" className="signin-secondary" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      );
    }
  } else {
    content = <p className="signin-status">Setting up your account…</p>;
  }

  return createPortal(content, target);
}

/**
 * The settings page's "Sign out" button, portaled into `#signout-slot-root`.
 *
 * `/me/settings` used to mount its own separate `<SignOutButton
 * client:only="react" />` island for this — a second, independent React
 * root with no ancestor `<PrivyProvider>`, so `usePrivy().logout` there was
 * the SDK's default stub, which THROWS "You need to wrap your application
 * with the <PrivyProvider>…" the moment it is called. Nothing caught it, so
 * clicking the button did nothing visible; the actual sign-out never ran and
 * the session cookie was never cleared.
 *
 * The masthead's own Account dropdown (`AccountSlot` above) already has a
 * WORKING "Sign out" — it is rendered inside this same component, which is
 * the site's one real provider. This slot is that same working action,
 * placed on the settings page the same way `AccountSlot` and `JoinCta` place
 * theirs: one provider, another portaled visual slot. No second provider, no
 * new session mechanism — the exact pattern this file already documents.
 */
function SignOutSlot() {
  const { logout } = usePrivy();
  const target = document.getElementById('signout-slot-root');
  if (!target) return null;

  return createPortal(
    <button
      type="button"
      className="btn-secondary"
      onClick={() => void logout().then(() => window.location.assign('/'))}
    >
      Sign out
    </button>,
    target,
  );
}

function Inner() {
  /**
   * A portal target is a DOM node React never rendered, so React never
   * clears it on mount the way it would a container it owns — the static
   * SSR fallback (`js-hydrate-hide`) would otherwise sit next to the live
   * button forever. Removing it in a lazy `useState` initializer runs
   * during render, strictly before `AccountSlot`/`JoinCta` below commit
   * their own children into the same nodes, so there is no flash of both at
   * once and nothing here is a node React manages.
   */
  useState(() => {
    document.querySelectorAll('.js-hydrate-hide').forEach((el) => el.remove());
    return null;
  });

  const bootstrap = useBootstrapOnce();
  return (
    <>
      <AccountSlot bootstrap={bootstrap} />
      <JoinCta bootstrap={bootstrap} />
      <SignOutSlot />
    </>
  );
}

interface Props {
  appId: string;
  loginMethods?: string[];
}

export default function PrivyRoot({ appId, loginMethods }: Props) {
  return (
    <PrivyProvider
      appId={appId}
      config={{
        ...(loginMethods && loginMethods.length > 0
          ? { loginMethods: loginMethods as never }
          : {}),
        embeddedWallets: {
          ethereum: { createOnLogin: 'off' },
          solana: { createOnLogin: 'off' },
        },
        appearance: { theme: 'light' },
      }}
    >
      <Inner />
    </PrivyProvider>
  );
}
