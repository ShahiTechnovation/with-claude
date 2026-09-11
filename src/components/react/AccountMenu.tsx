/**
 * AccountMenu — the masthead's auth-aware slot.
 *
 * Mounted with `client:only="react"` so it does not participate in SSR.
 * Every public page is served from the CDN as an anonymous document; this
 * island upgrades the account control in the browser for the minority who
 * are signed in.
 *
 * The entire React + Privy SDK cost is paid only here. Nothing else on the
 * public site loads React unless it uses `client:*`.
 *
 * Keyboard behaviour:
 *  - Enter / Space opens/closes the dropdown
 *  - Escape closes the dropdown and returns focus to the trigger
 *  - Arrow keys (Down/Up) cycle through menu items
 *  - Tab leaves the menu, closing it
 */
import { PrivyProvider, usePrivy } from '@privy-io/react-auth';
import { useState, useRef, useEffect, useCallback } from 'react';

function Inner() {
  const { ready, authenticated, user, logout } = usePrivy();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  /** Close on outside click */
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, []);

  /** Escape closes and returns focus */
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

  /** Arrow-key navigation within the dropdown */
  const handleDropdownKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!dropdownRef.current) return;
    const items = Array.from(
      dropdownRef.current.querySelectorAll<HTMLElement>('a, button'),
    );
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

  /** Derive a display name: prefer username → email local-part → "Account" */
  const displayName = (() => {
    if (!user) return 'Account';
    // Privy user object: linked_accounts may include email, google, github etc.
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

  // While Privy is hydrating, render a stable placeholder that matches the
  // static "Join WITH CLAUDE" size to avoid layout shift.
  if (!ready) {
    return (
      <div className="account-slot" data-account-state="loading" aria-hidden="true">
        <span className="account-join account-placeholder">Join WITH CLAUDE</span>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="account-slot" data-account-state="anonymous">
        <a className="account-join" href="/join/">
          Join WITH CLAUDE
        </a>
      </div>
    );
  }

  return (
    <div
      className="account-slot"
      data-account-state="signed-in"
      ref={containerRef}
      style={{ position: 'relative' }}
    >
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
          <a href="/me/" role="menuitem">
            Profile
          </a>
          <a href="/me/projects/" role="menuitem">
            Projects
          </a>
          <a href="/me/settings/" role="menuitem">
            Settings
          </a>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void logout();
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

interface Props {
  appId: string;
  loginMethods?: string[];
}

export default function AccountMenu({ appId, loginMethods }: Props) {
  /**
   * NO EMBEDDED WALLETS — same reasoning as SignIn.tsx. A wallet is optional
   * future functionality; creating one on every login would provision a
   * financial instrument without explicit consent.
   */
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
