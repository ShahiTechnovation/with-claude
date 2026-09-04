/**
 * Who sent this, without keeping who sent this.
 *
 * Rate limiting needs to recognise a repeat caller. It does not need to know
 * their address, and storing one would make this database a log of who visited
 * a community website — which is a liability nobody asked for and a promise
 * the submission forms already make ("your email is used to reach you and is
 * never displayed").
 *
 * So the address is salted and hashed on the way in and the original is
 * discarded before anything is written. The salt matters: an unsalted SHA-256
 * of an IPv4 address is reversible in seconds, because there are only four
 * billion of them.
 */
import { createHash } from 'node:crypto';
import { ipSalt } from '../../../db/env';

/**
 * The caller's address, as the platform reports it.
 *
 * On Vercel the client address arrives in `x-forwarded-for`, left-most entry.
 * Anything downstream of the platform's own proxy cannot be trusted, so only
 * the first hop is read — and if it is absent, the caller is anonymous rather
 * than assumed.
 */
export function clientAddress(request: Request, fallback?: string): string | undefined {
  const forwarded = request.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first || request.headers.get('x-real-ip')?.trim() || fallback || undefined;
}

/**
 * A stable, salted, one-way identifier for an address.
 *
 * Truncated to 32 hex characters. That is 128 bits — far beyond collision
 * concerns at this volume — and shorter rows for a value that exists only to
 * be compared with itself.
 */
export function hashAddress(address: string): string {
  return createHash('sha256').update(`${ipSalt()}:${address}`).digest('hex').slice(0, 32);
}

/** The user agent, bounded. Kept for abuse triage, not for analytics. */
export function userAgent(request: Request): string | undefined {
  const value = request.headers.get('user-agent');
  return value ? value.slice(0, 512) : undefined;
}

/**
 * Normalise an email for rate-limiting comparisons.
 *
 * Lower-cased only. Deliberately does NOT strip dots or `+tags`: those are
 * provider-specific conventions, and treating `a.b@example.com` as the same
 * person as `ab@example.com` would be wrong on most of the internet.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}
