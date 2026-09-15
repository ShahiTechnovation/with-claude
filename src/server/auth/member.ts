/**
 * WHO IS ASKING, AND MAY THEY.
 *
 * The public counterpart of `admin/src/server/session.ts`, and deliberately
 * built on the same two rules that file argues for at length:
 *
 *  1. EVERY authenticated surface resolves its caller here, on the server,
 *     before it reads anything. There is no client-side guard, because a
 *     client-side guard hides a page from somebody who has already been sent
 *     it.
 *
 *  2. STATUS COMES FROM THE DATABASE, NOT THE TOKEN. A Privy token proves
 *     identity and nothing else. `members.status` is read fresh on every
 *     request, so suspending an account takes effect on that person's next
 *     click rather than whenever their token happens to expire.
 *
 * ── ONE DOOR ─────────────────────────────────────────────────────────────
 *
 * `requireMember()` is the only way to obtain a member. Everything else takes
 * the member it returns as an argument. That is what makes "the server derives
 * identity from the verified credential" checkable rather than aspirational —
 * a route that wanted to trust a client-supplied id would have to not call
 * this, which is visible in review.
 *
 * ── PROVISIONING IS SEPARATE FROM AUTHORISATION ──────────────────────────
 *
 * `requireMember()` never creates anything. A first-time caller gets
 * `no-member`, and creating the row is `provisionMember()`'s job, reached only
 * through `POST /api/member/bootstrap`. Folding the two together would mean
 * every GET on every authenticated page could write to the database, which
 * turns a read path into a write path and makes rate limiting meaningless.
 */
import { eq, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../../../db/schema';
import { authTrace, verifyRequest, type AuthFailure } from './privy';

type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

export type MemberStatus = (typeof schema.memberStatus.enumValues)[number];
export type MemberRole = (typeof schema.memberRole.enumValues)[number];

/**
 * An authenticated public member.
 *
 * Note what is absent: no role, no permissions, no `verified`. A member has a
 * status and an id. Every authorisation question in Phase A is answered by
 * ownership — does this member own this row — rather than by a capability
 * carried around on the identity.
 */
export interface Member {
  id: string;
  privyUserId: string;
  status: MemberStatus;
  role: MemberRole;
}

export type MemberFailure =
  | AuthFailure
  /** Verified by Privy, but no member row yet. Bootstrap has not run. */
  | 'no-member'
  /** A member row exists and is not allowed to act. */
  | 'suspended'
  | 'deleted';

export type MemberResult = { ok: true; member: Member } | { ok: false; reason: MemberFailure };

/** HTTP status for each failure. `not-configured` is ours, not the caller's. */
export function statusFor(reason: MemberFailure): 401 | 403 | 409 | 503 {
  switch (reason) {
    case 'not-configured':
      return 503;
    case 'no-token':
    case 'invalid-token':
      return 401;
    case 'no-member':
      return 409;
    case 'suspended':
    case 'deleted':
      return 403;
  }
}

/**
 * Resolve the caller to an active member, or explain why not.
 *
 * Never throws for an anonymous request: not being signed in is an ordinary
 * case, and the caller decides whether that means a redirect or a 401.
 */
export async function requireMember(request: Request, db: AnyDatabase): Promise<MemberResult> {
  const identity = await verifyRequest(request);
  if (!identity.ok) {
    authTrace('member', { result: 'not-reached' });
    return { ok: false, reason: identity.reason };
  }

  const [row] = await db
    .select({
      id: schema.members.id,
      privyUserId: schema.members.privyUserId,
      status: schema.members.status,
      role: schema.members.role,
    })
    .from(schema.members)
    .where(eq(schema.members.privyUserId, identity.privyUserId));

  authTrace('member', { result: row ? 'found' : 'missing' });
  if (!row) return { ok: false, reason: 'no-member' };
  if (row.status === 'suspended') return { ok: false, reason: 'suspended' };
  if (row.status === 'deleted') return { ok: false, reason: 'deleted' };

  return { ok: true, member: { id: row.id, privyUserId: row.privyUserId, status: row.status, role: row.role } };
}

/**
 * Find or create the member behind a verified Privy identity.
 *
 * IDEMPOTENT BY CONSTRAINT, NOT BY CHECK-THEN-INSERT.
 *
 * The obvious implementation is SELECT, and INSERT if nothing came back. It is
 * wrong: two tabs finishing login at the same moment both see nothing and both
 * insert, and the second gets a unique violation that surfaces to a person as
 * a failed sign-in. `ON CONFLICT DO UPDATE` on `privy_user_id` makes the
 * database resolve the race — the second writer updates the row the first one
 * committed, and both callers get the same member back.
 *
 * `last_seen_at` is advanced here because bootstrap is the one authenticated
 * write that happens on every sign-in anyway. It is not touched on reads: a
 * timestamp per page view would turn every GET into a write.
 */
export async function provisionMember(
  privyUserId: string,
  db: AnyDatabase,
): Promise<{ member: Member; created: boolean }> {
  const before = await db
    .select({ id: schema.members.id })
    .from(schema.members)
    .where(eq(schema.members.privyUserId, privyUserId));

  const [row] = await db
    .insert(schema.members)
    .values({ privyUserId, lastSeenAt: new Date() })
    .onConflictDoUpdate({
      target: schema.members.privyUserId,
      set: { lastSeenAt: new Date(), updatedAt: new Date() },
    })
    .returning({
      id: schema.members.id,
      privyUserId: schema.members.privyUserId,
      status: schema.members.status,
      role: schema.members.role,
    });

  return {
    member: { id: row.id, privyUserId: row.privyUserId, status: row.status, role: row.role },
    created: before.length === 0,
  };
}

/**
 * Create the empty profile a passport is filled into, if there is not one.
 *
 * A SHELL IS NOT A PUBLICATION. `published_at` stays null and no `builders`
 * row is created, so nothing is public and nothing appears in the record until
 * the member explicitly publishes. What this buys is somewhere for the
 * passport form to save a half-finished answer.
 *
 * The username is a placeholder derived from the member id, not from anything
 * the person typed or from anything in the token. It satisfies the shape CHECK
 * and the UNIQUE index without silently claiming a handle somebody might
 * want — `m-3f2a…` is obviously provisional, and choosing a real one is step
 * two of the passport.
 */
export async function ensureProfileShell(
  member: Member,
  db: AnyDatabase,
): Promise<{ created: boolean; username: string }> {
  const existing = await db
    .select({ username: schema.memberProfiles.username })
    .from(schema.memberProfiles)
    .where(eq(schema.memberProfiles.memberId, member.id));

  if (existing.length > 0) return { created: false, username: existing[0].username };

  const placeholder = `m-${member.id.replace(/-/g, '').slice(0, 12)}`;

  const [row] = await db
    .insert(schema.memberProfiles)
    .values({ memberId: member.id, username: placeholder })
    .onConflictDoNothing({ target: schema.memberProfiles.memberId })
    .returning({ username: schema.memberProfiles.username });

  // `onConflictDoNothing` returns nothing when another writer got there first.
  if (!row) {
    const [now] = await db
      .select({ username: schema.memberProfiles.username })
      .from(schema.memberProfiles)
      .where(eq(schema.memberProfiles.memberId, member.id));
    return { created: false, username: now.username };
  }

  return { created: true, username: row.username };
}

/**
 * Whether this member may change public content right now.
 *
 * Phase A's whole authorisation model, in one function. §18 asks only that the
 * layer be aware of member status; the broad moderation design is Phase C, and
 * anticipating it here would be building a permission system against
 * requirements that do not exist yet.
 */
export function canPublish(member: Member): boolean {
  return member.status === 'active';
}

/** Touch `last_seen_at` without making a read path into a write path. */
export async function noteSeen(member: Member, db: AnyDatabase): Promise<void> {
  await db
    .update(schema.members)
    .set({ lastSeenAt: sql`now()` })
    .where(eq(schema.members.id, member.id));
}
