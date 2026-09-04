/**
 * Asking for a sign-in link.
 *
 * ── THE ONE RULE THIS FILE EXISTS FOR ────────────────────────────────────
 *
 * The response is identical whether or not the address has an account.
 *
 * A login form that says "no such user" is a membership oracle: anybody can
 * discover who has editorial access to this project by typing addresses into
 * it, which is the first step of every targeted phishing attempt that follows.
 * So an unknown address, a deactivated account and a real editor all get the
 * same screen and the same wording. Only the server log knows the difference.
 *
 * The cost of that is a real one — somebody who typos their address gets no
 * feedback and waits for an email that is not coming. It is still the right
 * trade for a four-person allowlist, and the copy says plainly that a link
 * arrives *if* the address has an account, rather than promising one.
 *
 * Kept out of the route file so the decision is a function a test can call.
 */
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type * as schema from '../../../db/schema';
import { auth, lookupAdminUser } from './auth';

type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

/** Where a successful sign-in lands. */
export const AFTER_LOGIN = '/submissions';

export type LoginOutcome =
  | { ok: true; sent: boolean; reason?: string }
  | { ok: false; status: 400 | 429 | 500; error: string };

/** Deliberately vague, and the same for every outcome. */
export const GENERIC_CONFIRMATION =
  'If that address has an account, a sign-in link is on its way. It expires in ten minutes.';

/** Bounded, and enough to reject obvious nonsense before touching the database. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const EMAIL_MAX = 254;

/**
 * A small in-memory throttle.
 *
 * The magic-link endpoint sends email, so an unthrottled login form is a way to
 * make this project's mail domain send spam on request. This holds attempts in
 * the process, which is imperfect on serverless — a cold start forgets — but it
 * costs nothing, needs no Redis, and closes the loop that matters: somebody
 * hammering one address in one burst. Resend's own limits are the backstop.
 */
const attempts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_WINDOW = 5;

function throttled(key: string, now = Date.now()): boolean {
  const entry = attempts.get(key);

  if (!entry || now > entry.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_PER_WINDOW;
}

/** Test seam — the throttle is process state, and a test should start clean. */
export function resetLoginThrottle(): void {
  attempts.clear();
}

export interface LoginRequest {
  email: unknown;
  /** Hashed caller identity, for throttling. Optional. */
  callerKey?: string;
  /** Where to land after the link is opened. Validated as a local path. */
  next?: string | null;
}

/**
 * The two things this function touches, injectable.
 *
 * The database so the allowlist rule can be tested against a real one, and the
 * send so a test can assert that NOTHING was sent for an address that is not
 * on it — which is the whole point of the function and is not observable any
 * other way.
 */
export interface LoginDependencies {
  db?: AnyDatabase;
  sendLink?: (input: { email: string; next: string }) => Promise<void>;
}

/**
 * Only a path on this origin. A `callbackURL` taken from the query string and
 * used unchecked is an open redirect, and an open redirect on the page that
 * mints sessions is worth being careful about.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next) return AFTER_LOGIN;
  if (!next.startsWith('/') || next.startsWith('//')) return AFTER_LOGIN;
  return next;
}

export async function requestMagicLink(
  { email, callerKey, next }: LoginRequest,
  deps: LoginDependencies = {},
): Promise<LoginOutcome> {
  if (typeof email !== 'string') {
    return { ok: false, status: 400, error: 'Enter an email address.' };
  }

  const address = email.trim().toLowerCase();
  if (address.length === 0 || address.length > EMAIL_MAX || !EMAIL_PATTERN.test(address)) {
    // A malformed address is a typo, not an enumeration attempt, so this one
    // is worth saying out loud.
    return { ok: false, status: 400, error: 'That does not look like an email address.' };
  }

  if (throttled(callerKey ?? address)) {
    return {
      ok: false,
      status: 429,
      error: 'Too many sign-in attempts. Wait a few minutes and try again.',
    };
  }

  const lookup = await lookupAdminUser(address, deps.db);

  if (!lookup.allowed) {
    // Nothing is sent, and the caller is told nothing. The log is where the
    // difference lives, because an operator debugging "why did my link not
    // arrive" needs it and a stranger must not have it.
    console.warn(`[login] refused (${lookup.reason}) for ${address}`);
    return { ok: true, sent: false, reason: lookup.reason };
  }

  const send =
    deps.sendLink ??
    (async ({ email: to, next: callbackURL }) => {
      await auth().api.signInMagicLink({
        body: { email: to, callbackURL },
        headers: new Headers({ 'x-forwarded-for': callerKey ?? '' }),
      });
    });

  try {
    await send({ email: lookup.user.email, next: safeNext(next) });
    return { ok: true, sent: true };
  } catch (error) {
    // The mail layer throws rather than pretending, so a failure here means
    // the link genuinely did not go out. Saying "check your inbox" would leave
    // somebody waiting for nothing.
    console.error('[login] could not send the sign-in link:', error);
    return {
      ok: false,
      status: 500,
      error: 'The sign-in link could not be sent. Tell an administrator.',
    };
  }
}
