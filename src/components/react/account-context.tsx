/**
 * THE ACCOUNT STATE, SHARED BY EVERYTHING UNDER THE ONE `PrivyProvider`.
 *
 * `PrivyRoot.tsx` owns the provider and the state machine; this module is the
 * contract the account islands it mounts (ProfileEditor, ProjectEditor) read.
 * They used to be independent Astro islands calling `usePrivy()` with no
 * provider ancestor — which returns the SDK's default context, whose
 * `getAccessToken()` throws — and only worked because `accountFetch()` swallowed
 * that throw and fell back to the cookie. They are now rendered BENEATH the
 * provider, so the hook is real, and they get the state below instead of
 * guessing it.
 *
 * Nothing here holds a token. `fetch` asks Privy for a fresh access token per
 * request (which also refreshes the `privy-token` cookie) and sends it as a
 * bearer header; the token never touches the DOM, storage or a global.
 */
import { createContext, useContext } from 'react';

/**
 * Explicit states, so no screen ever sits on an unexplained "Checking…".
 *
 *   initialising   Privy has not reported `ready` yet
 *   slow           …and it has been long enough to say so and offer a retry
 *   signed-out     ready, no session
 *   bootstrapping  signed in with Privy; provisioning the member row
 *   signed-in      member row confirmed by the server
 *   error          a specific, recoverable failure (see `kind`)
 */
export type AccountStatus =
  'initialising' | 'slow' | 'signed-out' | 'bootstrapping' | 'signed-in' | 'error';

export type AccountErrorKind =
  /** 503 — the deployment has no server-side Privy configuration. */
  | 'not-configured'
  /** 401 — Privy says signed in, the server could not verify the token. */
  | 'session-rejected'
  /** 403 — the member row exists and is suspended or closed. */
  | 'account-unavailable'
  /** The server signed us in, but this page still cannot see the session. */
  | 'session-not-visible'
  /** The request never got an answer. */
  | 'network'
  /** Anything else the server said. */
  | 'unknown';

export interface AccountState {
  status: AccountStatus;
  errorKind?: AccountErrorKind;
  /** Privy's user id, for identity-scoped state. Never sent anywhere. */
  userKey?: string;
  needsUsername?: boolean;
  ambassadorSlug?: string | null;
}

export interface AccountApi {
  state: AccountState;
  /** Open Privy's login. */
  signIn: () => void;
  /** Log out of Privy, clear identity-scoped state, then navigate. */
  signOut: (to?: string) => Promise<void>;
  /** Re-run provisioning after a failure. */
  retry: () => void;
  /**
   * Same-origin fetch with a fresh bearer token when one is available. The
   * cookie is sent too; the server checks the header first.
   */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Headers for third-party clients that make their own request (Blob upload). */
  authHeaders: () => Promise<Record<string, string>>;
}

/**
 * Fired on `window` by an editor once the server has saved a username. PrivyRoot
 * drops the "Finish your profile" nudge and its cached flag for the tab.
 */
export const USERNAME_SAVED_EVENT = 'wc:username-saved';

const AccountContext = createContext<AccountApi | null>(null);

export const AccountContextProvider = AccountContext.Provider;

/**
 * The account API. Throws if used outside `PrivyRoot`, deliberately: a
 * silent default is exactly how the previous islands failed.
 */
export function useAccount(): AccountApi {
  const value = useContext(AccountContext);
  if (!value) {
    throw new Error('useAccount() must be rendered inside PrivyRoot.');
  }
  return value;
}

/** Plain-language text for each failure, shared by every surface. */
export function describeAccountProblem(kind: AccountErrorKind | undefined): string {
  switch (kind) {
    case 'not-configured':
      return 'Sign-in is not available on this deployment right now. Nothing is wrong with your account.';
    case 'session-rejected':
      return 'Your sign-in could not be verified. Sign out and sign in again.';
    case 'account-unavailable':
      return 'This account is not available. Contact the organisers if you think that is a mistake.';
    case 'session-not-visible':
      return 'You are signed in, but this site could not read your session. Try again; if it keeps happening, sign out and back in.';
    case 'network':
      return 'We could not reach the server. Check your connection and try again.';
    default:
      return 'Something went wrong while signing you in. Try again.';
  }
}
