/**
 * THE HANDLE.
 *
 * A username is not just a display preference here — it becomes the public URL
 * (`/builders/<username>`) and it becomes the `builders.slug` of the published
 * record. So it has to satisfy three separate things at once, and each one is
 * checked in a different place on purpose:
 *
 *   SHAPE          this file, and a CHECK on `member_profiles.username`
 *   NOT RESERVED   the `reserved_usernames` table
 *   NOT TAKEN      UNIQUE on `member_profiles.username`, UNIQUE on `builders.slug`
 *
 * The database owns the last two because they are questions about the state of
 * the whole table, and any answer this process computes is already stale by
 * the time it acts on it. What this file owns is the shape, and telling a
 * person clearly which rule they broke.
 */
import { eq, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../../../db/schema';

type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;

/**
 * Lower-case, starts with a letter or digit, then letters, digits, `_` or `-`.
 *
 * Kept character-for-character identical to the CHECK in migration 0006. If
 * the two ever disagree, the database wins and a person gets an unexplained
 * failure instead of a sentence telling them what to fix — so they are written
 * to be compared side by side.
 */
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]{2,29}$/;

export type UsernameProblem =
  | { ok: false; reason: 'empty'; message: string }
  | { ok: false; reason: 'too-short' | 'too-long'; message: string }
  | { ok: false; reason: 'shape'; message: string }
  | { ok: false; reason: 'reserved'; message: string }
  | { ok: false; reason: 'taken'; message: string };

export type UsernameCheck = { ok: true; username: string } | UsernameProblem;

/**
 * Canonical form.
 *
 * Lower-cased and trimmed, so `Punit` and `punit` cannot both exist and a
 * trailing space pasted from somewhere does not create a handle nobody can
 * type. Deliberately NOT doing anything cleverer — no stripping of separators,
 * no unicode folding — because a normaliser that silently changes what
 * somebody typed hands them a different handle from the one they asked for.
 */
export function canonicalUsername(input: string): string {
  return input.trim().toLowerCase();
}

/** Shape only. No database, so it is usable in a form validator. */
export function checkUsernameShape(input: string): UsernameCheck {
  const username = canonicalUsername(input);

  if (!username) {
    return { ok: false, reason: 'empty', message: 'Choose a username.' };
  }
  if (username.length < USERNAME_MIN) {
    return {
      ok: false,
      reason: 'too-short',
      message: `Usernames are at least ${USERNAME_MIN} characters.`,
    };
  }
  if (username.length > USERNAME_MAX) {
    return {
      ok: false,
      reason: 'too-long',
      message: `Usernames are at most ${USERNAME_MAX} characters.`,
    };
  }
  if (!USERNAME_PATTERN.test(username)) {
    return {
      ok: false,
      reason: 'shape',
      message:
        'Usernames use lowercase letters, numbers, hyphens and underscores, and start with a letter or number.',
    };
  }

  return { ok: true, username };
}

/**
 * Shape, then reserved, then taken.
 *
 * ── WHY `builders.slug` IS CHECKED TOO ───────────────────────────────────
 *
 * Because a published profile becomes a `builders` row whose slug is the
 * username, and there are already 72 slugs in that table. Without this check a
 * member could take `punit` as a username, get it accepted, and then fail at
 * publish time with a unique violation on a completely different table — which
 * is a confusing failure arriving long after the decision that caused it.
 *
 * The check excludes the member's OWN builder row, so somebody who has claimed
 * `aniket-sahu` and wants that as their username is not told it is taken by
 * themselves.
 */
export async function checkUsernameAvailable(
  input: string,
  db: AnyDatabase,
  memberId?: string,
): Promise<UsernameCheck> {
  const shape = checkUsernameShape(input);
  if (!shape.ok) return shape;
  const { username } = shape;

  const reserved = await db
    .select({ username: schema.reservedUsernames.username })
    .from(schema.reservedUsernames)
    .where(eq(schema.reservedUsernames.username, username));

  if (reserved.length > 0) {
    return { ok: false, reason: 'reserved', message: 'That username is not available.' };
  }

  const takenByProfile = await db
    .select({ memberId: schema.memberProfiles.memberId })
    .from(schema.memberProfiles)
    .where(eq(schema.memberProfiles.username, username));

  if (takenByProfile.length > 0 && takenByProfile[0].memberId !== memberId) {
    return { ok: false, reason: 'taken', message: 'That username is already taken.' };
  }

  const takenBySlug = await db
    .select({ id: schema.builders.id, ownerMemberId: schema.builders.ownerMemberId })
    .from(schema.builders)
    .where(eq(schema.builders.slug, username));

  if (takenBySlug.length > 0 && takenBySlug[0].ownerMemberId !== memberId) {
    return { ok: false, reason: 'taken', message: 'That username is already taken.' };
  }

  return { ok: true, username };
}

/**
 * Whether a username is only a provisional shell handle.
 *
 * `ensureProfileShell()` assigns `m-<hex>` on first login so the passport has
 * somewhere to save to. A profile still wearing one has not chosen a handle,
 * which is what `/me` uses to decide whether to send somebody to step two.
 */
export function isPlaceholderUsername(username: string): boolean {
  return /^m-[0-9a-f]{12}$/.test(username);
}

/** Every reserved handle, for the tests and for a form's own hint text. */
export async function reservedUsernames(db: AnyDatabase): Promise<string[]> {
  const rows = await db
    .select({ username: schema.reservedUsernames.username })
    .from(schema.reservedUsernames)
    .orderBy(sql`username`);
  return rows.map((r) => r.username);
}
