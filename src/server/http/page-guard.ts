/**
 * The `/me/*` pages' front door.
 *
 * ── WHY THESE PAGES NEED NO CLIENT JAVASCRIPT ────────────────────────────
 *
 * Because Privy's cookie session means the `privy-token` cookie arrives with
 * an ordinary page request, and the server can verify it before rendering a
 * byte. So the account area is plain server-rendered HTML with plain forms —
 * no React, no client-side auth check, no flash of the wrong state.
 *
 * That is also the security property. A client-side guard hides a page from
 * somebody who has already been sent it; the data is in the response either
 * way. Here the data is never put in the response at all unless the token
 * verified.
 *
 * ── THE FIVE ANSWERS ─────────────────────────────────────────────────────
 *
 * unauthenticated        → render the in-place Privy gate (no token / bad token)
 * server-not-configured  → server credentials missing; 503-class, not the user's fault
 * no-member              → Privy verified but bootstrap has not run yet
 * member-unavailable     → suspended or deleted account
 * authenticated          → render the requested page
 *
 * A redirect rather than a 401 page, because these are navigations by a person
 * rather than calls by a program, and "you need to sign in" is better
 * expressed by showing them the place to do it.
 *
 * ── WHY REASONS ARE SEPARATE ─────────────────────────────────────────────
 *
 * Collapsing every failure into 'authentication-required' caused the real
 * symptom: a verified client showing a sign-in CTA because the server had no
 * Privy credentials. Each reason below maps to a distinct UI state in
 * AuthRequired — user-facing text is safe and generic; the reason code stays
 * server-side for logging.
 */
import type { AstroGlobal } from 'astro';
import { pooledDb } from '../../../db/pool';
import { requireMember, type Member } from '../auth/member';
import { readProfile, type ProfileRow } from '../members/profile';

/**
 * The guard hands back the CONNECTION as well as the member.
 *
 * Not a convenience. `tests/admin-isolation.test.ts` asserts that no file in
 * the render path names a database module, because that is what keeps a static
 * build static and every credential out of the bundle. An authenticated page
 * that imported `db/pool` itself would break that guard for a good reason,
 * which is the worst kind of reason to break a guard — the next page to do it
 * for a bad reason would look identical.
 *
 * So exactly one module under `src/server/http/` opens the connection, and the
 * pages receive it. They import nothing from `db/`.
 */
export type PageGuardFailureReason =
  /** No token presented, or token did not verify. User should sign in. */
  | 'unauthenticated'
  /**
   * Server-side Privy credentials (PRIVY_APP_ID / PRIVY_VERIFICATION_KEY) are
   * absent or empty. This is a deployment configuration error, not the user's
   * fault. Returns 503-class semantics; must never show a sign-in CTA.
   */
  | 'server-not-configured'
  /**
   * Privy identity verified, but no member row exists yet.
   * Bootstrap (`POST /api/member/bootstrap`) has not run for this user.
   */
  | 'no-member'
  /** Member row exists but is suspended or deleted. */
  | 'member-unavailable'
  /**
   * Member exists but has no profile shell.
   * Normally created by bootstrap; can occur if bootstrap partially failed.
   */
  | 'profile-required';

export type PageGuard =
  | { ok: true; member: Member; profile: ProfileRow; db: ReturnType<typeof pooledDb> }
  | { ok: false; reason: PageGuardFailureReason };

/**
 * Resolve the signed-in member for a page, or explain which step failed.
 *
 * A missing identity is deliberately not an HTTP redirect. The page renders a
 * tiny client-side Privy gate at the requested URL instead, so login can open
 * in place and return the visitor to the exact account page they asked for.
 * That keeps `/join` out of the authenticated routing path entirely.
 *
 * Each failure reason maps to a distinct UI state in `<AuthRequired />`:
 *
 *   unauthenticated       → "Sign in to continue" + Privy CTA
 *   server-not-configured → "Sign-in temporarily unavailable" (no CTA)
 *   no-member             → "Setting up your account…"
 *   member-unavailable    → "This account is not available."
 *   profile-required      → "Finishing account setup…"
 */
export async function guardPage(
  astro: AstroGlobal,
  _options: { allowMissingProfile?: boolean } = {},
): Promise<PageGuard> {
  /**
   * PRIVATE HEADERS FIRST, ON EVERY OUTCOME — INCLUDING THE FAILURES.
   *
   * Each of the seven `/me/*` pages called `privateHeaders()` inside its own
   * `if (guard.ok)` branch, so an authenticated response was correctly
   * `private, no-store` and every UNAUTHENTICATED one came back
   * `public, max-age=0, must-revalidate`. Verified on production before this
   * changed.
   *
   * That is the wrong way round for a URL whose response depends on who is
   * asking. `/me/profile` returns a sign-in gate to one visitor and a person's
   * name, city and email preference to the next, and a shared cache is not
   * required to know the difference — `public` is an invitation to store the
   * response and serve it to somebody else.
   *
   * Setting them here rather than in the pages makes it structural: a page
   * cannot forget, and the eighth account page inherits it. The pages keep
   * their own calls, which are now redundant and idempotent; this is the
   * guarantee.
   */
  privateHeaders(astro);

  const db = pooledDb();
  const identity = await requireMember(astro.request, db);

  if (!identity.ok) {
    // Map each auth failure reason to the appropriate page-guard reason,
    // keeping 'not-configured' separate so the UI never asks an authenticated
    // user to sign in when the server is simply misconfigured.
    switch (identity.reason) {
      case 'not-configured':
        return { ok: false, reason: 'server-not-configured' };
      case 'no-token':
      case 'invalid-token':
        return { ok: false, reason: 'unauthenticated' };
      case 'no-member':
        return { ok: false, reason: 'no-member' };
      case 'suspended':
      case 'deleted':
        return { ok: false, reason: 'member-unavailable' };
    }
  }

  const profile = await readProfile(identity.member.id, db);

  if (!profile) return { ok: false, reason: 'profile-required' };

  return { ok: true, member: identity.member, profile, db };
}

/**
 * Headers every authenticated page must carry.
 *
 * `private, no-store` because a page naming the person reading it must never
 * enter a shared cache — that is how one visitor gets served another's
 * profile. `noindex` because none of this belongs in a search engine.
 */
export function privateHeaders(astro: AstroGlobal): void {
  astro.response.headers.set('Cache-Control', 'private, no-store');
  astro.response.headers.set('X-Robots-Tag', 'noindex, nofollow');
}
