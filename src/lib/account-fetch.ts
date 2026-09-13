/**
 * MUTATING THE ACCOUNT AREA FROM A STANDALONE ISLAND.
 *
 * `PrivyRoot.tsx` is the ONLY `PrivyProvider` on the public site, mounted
 * once from the masthead — its own file header explains why: two provider
 * instances race over Privy's iframe handshake and that race is what caused
 * the "stuck on Checking…" regression this codebase already fixed once.
 *
 * `ProfileEditor`, `ProjectEditor` and `ReportModal` are all mounted as their
 * OWN independent islands (`client:only="react"` / `client:load`), each its
 * own React root, none of them descendants of that provider. A fourth,
 * `SignOutButton`, used to be mounted the same broken way on `/me/settings`;
 * it no longer exists as a separate island — `PrivyRoot.tsx`'s `SignOutSlot`
 * now portals a working "Sign out" from inside the real provider instead,
 * the same way `AccountSlot` and `JoinCta` already did for their own slots.
 * Calling `usePrivy()` inside one of the three that remain does not throw — it
 * returns the SDK's DEFAULT context value, because `useContext()` returns the
 * default when there is no ancestor `<Context.Provider>` in THAT tree, and a
 * portal (which is how `PrivyRoot` places its own UI on the page) moves
 * rendered DOM output, not React context. The default value's
 * `getAccessToken` is `() => { throw Error("You need to wrap your
 * application with the <PrivyProvider>…") }` — verified by reading
 * `@privy-io/react-auth`'s own context module.
 *
 * That throw is what actually broke `/me/profile/edit`. `ProfileEditor.save()`
 * called `await getAccessToken()` inside a try/catch whose catch block set
 * the message "Network error while saving." — so every save failed with that
 * message before a single byte reached the network, on every account in
 * production, regardless of whether the person was actually signed in.
 *
 * ── WHY THE FIX IS NOT A SECOND PROVIDER ─────────────────────────────────
 *
 * Wrapping each of these four islands in its own `<PrivyProvider>` would
 * reintroduce exactly the bug `PrivyRoot.tsx` exists to prevent. The fix
 * instead relies on a mechanism the server already implements for a related
 * reason: `readAccessToken()` in `src/server/auth/privy.ts` checks the
 * `Authorization` header FIRST and falls back to the `privy-token` COOKIE.
 * Privy's SDK writes that cookie to this origin by default (confirmed by
 * reading `@privy-io/js-sdk-core`'s `shouldWriteCookies()` — it is disabled
 * only inside a browser extension, never on an ordinary page), and it is
 * that same cookie which lets every `/me/*` page's `guardPage()` identify the
 * signed-in member SERVER-SIDE, before any client JavaScript has run.
 * `PrivyRoot`'s own instance, mounted on every page via the masthead, keeps
 * that cookie fresh in the background for as long as the session is valid.
 *
 * So a same-origin `fetch()` from one of these islands already carries a
 * working credential with NO Authorization header at all. This helper still
 * ATTEMPTS `getAccessToken()` as a courtesy — an explicit bearer token is
 * what the server checks first, so if it ever becomes available (e.g. a
 * future island that does live inside the provider), it is used — but a
 * failure to obtain one is not treated as a reason to refuse the request.
 */

/**
 * `fetch()`, with a best-effort bearer token that never blocks the request.
 *
 * `getAccessToken` is passed in rather than imported, because importing
 * `usePrivy` here would not help: the hook still has to be CALLED inside a
 * component that is (or is not) inside the provider. This function only
 * decides what to do with whatever the caller already has.
 */
export async function accountFetch(
  url: string,
  init: RequestInit,
  getAccessToken: () => Promise<string | null>,
): Promise<Response> {
  let token: string | null = null;
  try {
    token = await getAccessToken();
  } catch {
    // No `PrivyProvider` ancestor in this island's tree — see the file
    // header. Fall through; the `privy-token` cookie is sent automatically
    // with this same-origin request either way.
  }

  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);

  return fetch(url, { ...init, headers, credentials: 'same-origin' });
}

/**
 * A safe, specific message for a failed mutation — never "Network error"
 * when the request actually reached the server and the server said no.
 *
 * Reads the response body defensively: a 500 is not guaranteed to be JSON,
 * and this must never throw while trying to explain a different failure.
 */
export async function describeAccountError(response: Response): Promise<string> {
  if (response.status === 401) return 'Your session has expired. Sign in again.';
  if (response.status === 403) return 'You do not have permission to do that.';

  if (response.status === 409) {
    const body = await response.json().catch(() => null);
    return typeof body?.error === 'string' ? body.error : 'That value is already in use.';
  }

  if (response.status === 400 || response.status === 422) {
    const body = await response.json().catch(() => null);
    return typeof body?.error === 'string' ? body.error : 'Please check the highlighted fields.';
  }

  return "Couldn't save your changes. Please try again.";
}
