/**
 * Who is asking, and may they.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────
 *
 * Every admin route resolves its user through this file, on the server, before
 * it reads anything. There is no client-side guard anywhere in this
 * application, because a client-side guard hides a page from somebody who has
 * already been sent it — the data is in the response either way, and that is
 * not a security control, it is a curtain.
 *
 * ── ROLE COMES FROM THE DATABASE, NOT THE SESSION ────────────────────────
 *
 * The session cookie proves identity and nothing else. `role` and `active` are
 * read fresh from `users` on every single request. That costs one indexed
 * lookup and buys the property that matters: deactivating an account or
 * demoting a role takes effect on that person's next click, rather than
 * whenever their session happens to expire. A role baked into a token is a
 * decision you cannot take back for twelve hours.
 */
import { eq } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { pooledDb } from '../../../db/pool';
import * as schema from '../../../db/schema';
import { ADMIN_ROLES, auth, type AdminRole, type AdminUser } from './auth';

type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

export type SessionResult =
  | { authenticated: true; user: AdminUser }
  | { authenticated: false; reason: 'no-session' | 'unknown-user' | 'inactive' | 'role' };

/**
 * Resolve the caller.
 *
 * Never throws for an anonymous request — an unauthenticated visitor is an
 * ordinary case, not an error, and the caller decides whether to redirect or
 * to answer 401.
 */
export async function resolveSession(
  request: Request,
  db: AnyDatabase = pooledDb(),
): Promise<SessionResult> {
  const session = await auth().api.getSession({ headers: request.headers });
  if (!session?.user?.id) {
    return { authenticated: false, reason: 'no-session' };
  }

  return authorise(session.user.id, db);
}

/**
 * The authorisation half, split out from the session lookup.
 *
 * Given a user id that a session vouches for, decide whether that account may
 * use the admin right now. Separate because it is the part with the rules in
 * it, and because a test should be able to exercise those rules without
 * minting a real session cookie first.
 */
export async function authorise(
  userId: string,
  db: AnyDatabase = pooledDb(),
): Promise<SessionResult> {
  const [row] = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      role: schema.users.role,
      active: schema.users.active,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId));

  // A session whose user has since been deleted. Cascade should prevent it;
  // handled anyway, because "should" is not a guarantee.
  if (!row) return { authenticated: false, reason: 'unknown-user' };
  if (!row.active) return { authenticated: false, reason: 'inactive' };
  if (!(ADMIN_ROLES as readonly string[]).includes(row.role)) {
    return { authenticated: false, reason: 'role' };
  }

  return {
    authenticated: true,
    user: { id: row.id, email: row.email, name: row.name, role: row.role as AdminRole },
  };
}

/** True when this role may do editorial review. Both admin roles may. */
export function canReview(role: string): boolean {
  return (ADMIN_ROLES as readonly string[]).includes(role);
}

/** True when this role may do administrator-only things. Phase 2 has none yet. */
export function isAdmin(role: string): boolean {
  return role === 'admin';
}

/**
 * Same-origin check for state-changing requests.
 *
 * Cookies are SameSite=Lax, which already stops a cross-site form POST from
 * carrying one. This is the second lock: a POST whose `Origin` is not the
 * admin's own is refused before it reaches any handler, so a CSRF defence does
 * not rest on one browser behaviour being implemented the way we expect.
 */
export function assertSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');

  // Some clients omit Origin on same-origin form posts; fall back to Referer.
  const candidate = origin ?? request.headers.get('referer');
  if (!candidate) return false;

  const expected = process.env.BETTER_AUTH_URL;
  if (!expected) return false;

  try {
    return new URL(candidate).origin === new URL(expected).origin;
  } catch {
    return false;
  }
}
