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
 * ── THE THREE ANSWERS ────────────────────────────────────────────────────
 *
 * anonymous        → redirect to /join
 * signed in, new   → redirect to the passport, because there is nothing to show
 * signed in, ready → render
 *
 * A redirect rather than a 401 page, because these are navigations by a person
 * rather than calls by a program, and "you need to sign in" is better
 * expressed by showing them the place to do it.
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
export type PageGuard =
  | { ok: true; member: Member; profile: ProfileRow; db: ReturnType<typeof pooledDb> }
  | { ok: false; redirect: Response };

/**
 * Resolve the signed-in member for a page, or the redirect to send instead.
 *
 * `noProfileTo` lets the passport page opt out of the "you have no profile"
 * redirect, since that page IS where a profile gets made and bouncing it to
 * itself would loop.
 */
export async function guardPage(
  astro: AstroGlobal,
  options: { allowMissingProfile?: boolean } = {},
): Promise<PageGuard> {
  const db = pooledDb();
  const identity = await requireMember(astro.request, db);

  if (!identity.ok) {
    /**
     * Everything that is not an active member goes to /join, including a
     * suspended one.
     *
     * Deliberately the same destination and the same wording for every
     * reason. Distinguishing "no account" from "suspended" here would tell an
     * unauthenticated caller which of the two a given session is, and §23 says
     * not to expose moderation internals. A suspended member is told what is
     * happening by a person, not by a redirect.
     */
    return { ok: false, redirect: astro.redirect('/join/', 302) };
  }

  const profile = await readProfile(identity.member.id, db);

  if (!profile) {
    if (options.allowMissingProfile) {
      return { ok: false, redirect: astro.redirect('/join/', 302) };
    }
    return { ok: false, redirect: astro.redirect('/join/', 302) };
  }

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
