/**
 * Anti-abuse for a public endpoint on a low-volume community site.
 *
 * NO REDIS, AND NO CAPTCHA.
 *
 * The counter lives in the `submissions` table, because the table is already
 * the record of who submitted what and when — a separate always-on store would
 * be a second piece of infrastructure to pay for and page on, to protect a
 * form that receives single-digit submissions a week. Two indexed counts
 * against a table this size cost less than the round trip to Redis would.
 *
 * A CAPTCHA is not here on purpose. It taxes every honest person on the site,
 * hands a third party a record of them, and is beaten by the automation it
 * claims to stop. The four checks below — a hidden field, a minimum time on
 * the form, a per-address ceiling and a per-address-per-email ceiling — stop
 * the traffic this endpoint will actually see, which is opportunistic form
 * spam rather than a targeted attack.
 *
 * The failure mode is deliberate too: if the ceiling is hit, the caller is
 * told to try later. Nothing is silently swallowed.
 */
import { and, count, eq, gte, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../../../db/schema';

type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

export const RATE_LIMITS = {
  /** Submissions from one address in an hour. */
  perAddressPerHour: 5,
  /** Submissions from one address in a day. */
  perAddressPerDay: 12,
  /** Submissions from one email address in a day, across all forms. */
  perEmailPerDay: 6,
  /**
   * A person cannot read a form, think, type an answer and submit in under
   * three seconds. A script can do it in none.
   */
  minimumElapsedMs: 3_000,
} as const;

export type RateLimitVerdict =
  | { allowed: true }
  | { allowed: false; status: 429 | 422; reason: string; retryAfterSeconds?: number };

/** Too fast to have been typed. */
export function checkElapsed(elapsedMs: number | undefined): RateLimitVerdict {
  // An absent value is not treated as a failure: a person with JavaScript
  // disabled, or a browser that never ran the timer, is not a bot. The other
  // three checks still apply to them.
  if (elapsedMs === undefined) return { allowed: true };

  if (elapsedMs < RATE_LIMITS.minimumElapsedMs) {
    return {
      allowed: false,
      status: 422,
      reason: 'That was submitted faster than a form can be filled in.',
    };
  }
  return { allowed: true };
}

function since(ms: number): Date {
  return new Date(Date.now() - ms);
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Count what this caller has already sent, and decide.
 *
 * Runs before the insert, so a rejected submission is never written — the
 * table stays a record of accepted submissions rather than of attempts.
 */
export async function checkRateLimit(
  db: AnyDatabase,
  { ipHash, email }: { ipHash?: string; email: string },
): Promise<RateLimitVerdict> {
  if (ipHash) {
    const [hourly] = await db
      .select({ n: count() })
      .from(schema.submissions)
      .where(
        and(eq(schema.submissions.ipHash, ipHash), gte(schema.submissions.createdAt, since(HOUR))),
      );

    if ((hourly?.n ?? 0) >= RATE_LIMITS.perAddressPerHour) {
      return {
        allowed: false,
        status: 429,
        reason: 'That is a lot of submissions in one hour. Try again a bit later.',
        retryAfterSeconds: 3_600,
      };
    }

    const [daily] = await db
      .select({ n: count() })
      .from(schema.submissions)
      .where(
        and(eq(schema.submissions.ipHash, ipHash), gte(schema.submissions.createdAt, since(DAY))),
      );

    if ((daily?.n ?? 0) >= RATE_LIMITS.perAddressPerDay) {
      return {
        allowed: false,
        status: 429,
        reason: 'That is a lot of submissions today. Try again tomorrow.',
        retryAfterSeconds: 24 * 3_600,
      };
    }
  }

  const [byEmail] = await db
    .select({ n: count() })
    .from(schema.submissions)
    .where(
      and(
        // Case-insensitive: the same person with a shifted capital is still
        // the same person.
        sql`lower(${schema.submissions.submitterEmail}) = ${email}`,
        gte(schema.submissions.createdAt, since(DAY)),
      ),
    );

  if ((byEmail?.n ?? 0) >= RATE_LIMITS.perEmailPerDay) {
    return {
      allowed: false,
      status: 429,
      reason: 'This address has sent several submissions today. Try again tomorrow.',
      retryAfterSeconds: 24 * 3_600,
    };
  }

  return { allowed: true };
}
