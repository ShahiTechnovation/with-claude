/**
 * Authentication for `admin.withclaude.in`.
 *
 * ── WHY better-auth ──────────────────────────────────────────────────────
 *
 * It has a first-party Drizzle adapter, so the sessions live in the same
 * database and the same schema file as everything else rather than in a second
 * store with its own migrations. Its handler is a plain
 * `(Request) => Promise<Response>`, which drops straight into an Astro
 * endpoint with no framework shim — Auth.js's Astro support is a
 * community-maintained package, and an auth layer is the last place to accept
 * an extra hop of indirection. Cookies are HttpOnly, Secure and SameSite=Lax
 * by default, and the magic-link plugin is first-party rather than assembled
 * out of a token table and hope.
 *
 * ── THE ONLY WAY IN ──────────────────────────────────────────────────────
 *
 * One email, one link, five minutes. No passwords: there is nothing to
 * phish, nothing to reuse from another site, and nothing to hash badly.
 *
 * `disableSignUp: true` means opening a link for an address with no row in
 * `users` mints no account and no session. The allowlist is checked a second
 * time, before anything is sent, in `requestMagicLink()` below — because the
 * plugin's own check happens at verification, which would mean posting an
 * unknown address still sends it an email. This site does not send email to
 * people who did not ask for it.
 *
 * `storeToken: 'hashed'` means the database holds a hash of each pending link.
 * A leaked dump is then a list of expiry times rather than a set of working
 * front doors.
 *
 * ── WHAT THIS FILE DELIBERATELY DOES NOT DO ──────────────────────────────
 *
 * It does not decide what anybody is allowed to do. It answers "who is this",
 * and stops. Authorisation reads `users.role` and `users.active` from the
 * database on every request — see `session.ts` — so removing somebody's access
 * takes effect on their next click rather than whenever their session happens
 * to expire.
 */
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { magicLink } from 'better-auth/plugins/magic-link';
import { eq } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { pooledDb } from '../../../db/pool';
import * as schema from '../../../db/schema';
import { sendMagicLinkEmail } from './email';

type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

/** Roles allowed to sign in at all. Everything else is not an admin account. */
export const ADMIN_ROLES = ['admin', 'editor'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

/** How long a magic link is good for. Long enough to switch to a mail app. */
const LINK_TTL_SECONDS = 10 * 60;

/** How long a sign-in lasts. A working day and a bit, not a fortnight. */
const SESSION_TTL_SECONDS = 12 * 60 * 60;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. The admin cannot run without it — see admin/.env.example.`,
    );
  }
  return value;
}

let cached: ReturnType<typeof build> | undefined;

function build() {
  return betterAuth({
    /** Signs session cookies. Rotating it signs everybody out, which is the point. */
    secret: required('BETTER_AUTH_SECRET'),
    /** The admin origin. Magic-link URLs are built from this. */
    baseURL: required('BETTER_AUTH_URL'),

    database: drizzleAdapter(pooledDb(), {
      provider: 'pg',
      // Our tables are `users` / `sessions` / `accounts` / `verifications`.
      usePlural: true,
      schema: {
        users: schema.users,
        sessions: schema.sessions,
        accounts: schema.accounts,
        verifications: schema.verifications,
      },
    }),

    /** There is no password anywhere in this system. */
    emailAndPassword: { enabled: false },

    session: {
      expiresIn: SESSION_TTL_SECONDS,
      // Re-issued once a session is more than an hour old, so an active
      // reviewer is not logged out mid-review.
      updateAge: 60 * 60,
    },

    advanced: {
      /**
       * Cookies belong to the admin origin and nowhere else.
       *
       * No `domain` is set, deliberately. Setting `.withclaude.in` would send
       * the admin session cookie to the public site on every page view of a
       * static marketing page, which is exactly the sharing this architecture
       * exists to prevent. A host-only cookie on `admin.withclaude.in` is
       * never sent to `withclaude.in`.
       */
      useSecureCookies: process.env.NODE_ENV === 'production',
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
      },
    },

    /**
     * Origins allowed to make state-changing requests. better-auth rejects a
     * mismatched Origin header, which is the CSRF defence for its endpoints;
     * our own POST routes check the same thing in `assertSameOrigin()`.
     */
    trustedOrigins: [required('BETTER_AUTH_URL')],

    plugins: [
      magicLink({
        expiresIn: LINK_TTL_SECONDS,
        // Opening a link for an unknown address creates nothing.
        disableSignUp: true,
        // The database stores a hash, never the live token.
        storeToken: 'hashed',
        sendMagicLink: async ({ email, url }) => {
          await sendMagicLinkEmail({ to: email, url, expiresInMinutes: LINK_TTL_SECONDS / 60 });
        },
      }),
    ],
  });
}

/** The auth instance. Built on first use so importing this file is free. */
export function auth(): ReturnType<typeof build> {
  if (!cached) cached = build();
  return cached;
}

/** An allowlisted account, as the admin understands it. */
export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  role: AdminRole;
}

export type LookupResult =
  { allowed: true; user: AdminUser } | { allowed: false; reason: 'unknown' | 'inactive' | 'role' };

/**
 * Is this address allowed to sign in?
 *
 * Separated from everything that sends or renders, so the rule is one function
 * a test can call directly against a real database. The three refusals are
 * distinguished for the server log only — the caller must never be able to
 * tell them apart, which is what `requestMagicLink` guarantees.
 *
 * The connection is a parameter with a default rather than a hard import, for
 * the same reason the Phase 1 submission pipeline takes one: a rule this
 * important should be testable without a network.
 */
export async function lookupAdminUser(
  email: string,
  db: AnyDatabase = pooledDb(),
): Promise<LookupResult> {
  const [row] = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      role: schema.users.role,
      active: schema.users.active,
    })
    .from(schema.users)
    .where(eq(schema.users.email, email.trim().toLowerCase()));

  if (!row) return { allowed: false, reason: 'unknown' };
  if (!row.active) return { allowed: false, reason: 'inactive' };
  if (!(ADMIN_ROLES as readonly string[]).includes(row.role)) {
    return { allowed: false, reason: 'role' };
  }

  return {
    allowed: true,
    user: { id: row.id, email: row.email, name: row.name, role: row.role as AdminRole },
  };
}
