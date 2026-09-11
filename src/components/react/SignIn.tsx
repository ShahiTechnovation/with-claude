/**
 * THE ONLY REACT ON THIS SITE.
 *
 * Privy's login UI is a React component, so signing in needs React. Nothing
 * else does, and that boundary is defended rather than assumed:
 *
 *   · this island is mounted with `client:only="react"` on `/join` and the
 *     `/me` pages, and on no other route
 *   · the account menu in the masthead is `src/scripts/account.ts`, plain
 *     TypeScript, about a kilobyte, because putting React in the masthead
 *     would put React on all 72 static pages to render an avatar
 *   · the `/me` pages read the `privy-token` cookie server-side, so editing a
 *     profile needs no client JavaScript at all
 *
 * The result is that the archive stays exactly as fast as it was, and the
 * ~150 KB of React and the Privy SDK are paid for only by the two or three
 * routes that genuinely need an authentication UI.
 *
 * ── WHAT THIS COMPONENT IS RESPONSIBLE FOR ───────────────────────────────
 *
 * Login, and one POST afterwards. It does NOT own the profile form, does not
 * hold application state, and does not decide anything about authorisation —
 * every question of that kind is answered by the server from the verified
 * token. If this file were replaced with a plain link to a hosted login page,
 * nothing about the security model would change.
 */
import { PrivyProvider, usePrivy } from '@privy-io/react-auth';
import { useCallback, useEffect, useState } from 'react';

/** Where to go once there is a member row. Passed in by the page. */
interface Props {
  appId: string;
  /** Login methods the Privy dashboard actually has configured. */
  loginMethods?: string[];
  next?: string;
}

type Phase = 'loading' | 'anonymous' | 'provisioning' | 'ready' | 'failed';

function Inner({ next = '/me/' }: { next?: string }) {
  const { ready, authenticated, login, logout, getAccessToken } = usePrivy();
  const [phase, setPhase] = useState<Phase>('loading');
  const [message, setMessage] = useState<string | null>(null);

  /**
   * Turn a Privy login into a member row, then leave.
   *
   * The access token is sent in an `Authorization` header rather than relied
   * on as a cookie, because this runs immediately after login and the cookie
   * may not have been written yet. The server accepts either.
   */
  const bootstrap = useCallback(async () => {
    setPhase('provisioning');
    setMessage(null);
    try {
      const token = await getAccessToken();
      const response = await fetch('/api/member/bootstrap', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        // Same-origin only. The server checks the origin too.
        credentials: 'same-origin',
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setMessage(body.error ?? 'Something went wrong signing you in.');
        setPhase('failed');
        return;
      }

      const body = (await response.json()) as { profile?: { needsUsername?: boolean } };
      setPhase('ready');
      // A brand-new member goes to the passport; a returning one to /me.
      window.location.assign(body.profile?.needsUsername ? '/me/profile/edit/' : next);
    } catch {
      // NO TOKEN IN THE MESSAGE, and nothing logged. See `server/auth/privy.ts`.
      setMessage('Could not reach the server. Try again.');
      setPhase('failed');
    }
  }, [getAccessToken, next]);

  useEffect(() => {
    if (!ready) return;
    if (!authenticated) {
      setPhase('anonymous');
      return;
    }
    if (phase === 'anonymous' || phase === 'loading') void bootstrap();
  }, [ready, authenticated, phase, bootstrap]);

  if (!ready || phase === 'loading') {
    return <p className="signin-status">Checking…</p>;
  }

  if (phase === 'provisioning') {
    return <p className="signin-status">Setting up your account…</p>;
  }

  if (phase === 'failed') {
    return (
      <div className="signin-failed">
        <p className="signin-status">{message}</p>
        <button type="button" className="signin-button" onClick={() => void bootstrap()}>
          Try again
        </button>
        <button type="button" className="signin-secondary" onClick={() => void logout()}>
          Sign out
        </button>
      </div>
    );
  }

  return (
    <button type="button" className="signin-button" onClick={() => login()}>
      Join WITH CLAUDE
    </button>
  );
}

export default function SignIn({ appId, loginMethods, next }: Props) {
  /**
   * NO EMBEDDED WALLETS.
   *
   * `createOnLogin: 'off'` is explicit rather than left to a default. §3 is
   * clear that a wallet is optional future functionality, and creating one for
   * every person who signs in with Google would be provisioning a financial
   * instrument on their behalf because they wanted a profile page.
   *
   * `loginMethods` is passed from the page and comes from configuration, so
   * this shows only what the dashboard actually has enabled. Listing a method
   * Privy is not configured for produces a button that fails when pressed.
   */
  return (
    <PrivyProvider
      appId={appId}
      config={{
        ...(loginMethods && loginMethods.length > 0
          ? { loginMethods: loginMethods as never }
          : {}),
        embeddedWallets: {
          // Per chain, which is the shape Privy 3.x takes. Both off, stated
          // explicitly rather than left to a default, so a future SDK version
          // changing that default cannot start provisioning wallets for people
          // who came here for a profile page.
          ethereum: { createOnLogin: 'off' },
          solana: { createOnLogin: 'off' },
        },
        appearance: { theme: 'light' },
      }}
    >
      <Inner next={next} />
    </PrivyProvider>
  );
}
