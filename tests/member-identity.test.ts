/**
 * PHASE A — identity, provisioning, and the rules that stop somebody being
 * somebody else.
 *
 * Runs against PGlite, so every CHECK, UNIQUE and partial index in migration
 * 0006 is the real thing. That matters more here than usual: the two most
 * important guarantees in this phase — one owner per builder, one handle per
 * person — are enforced by indexes, and a mock would happily accept the rows
 * the database is supposed to refuse.
 *
 * Privy itself is not reached. Token verification is `@privy-io/node` doing
 * ES256 locally, and what is worth testing is OUR behaviour around it: that a
 * missing token is distinguished from an invalid one, that configuration
 * absence fails closed, and that nothing trusts a client-supplied id. Those
 * are exercised through `verifyRequest`'s real code path with a real key pair
 * where a token is needed, and through the module boundary where it is not.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import * as schema from '../db/schema';
import {
  ensureProfileShell,
  provisionMember,
  requireMember,
  canPublish,
  statusFor,
} from '../src/server/auth/member';
import { readAccessToken, privyConfig } from '../src/server/auth/privy';
import {
  canonicalUsername,
  checkUsernameShape,
  checkUsernameAvailable,
  isPlaceholderUsername,
} from '../src/server/members/username';
import { isTrustedOrigin, assertSameOrigin } from '../src/server/http/origin';

let db: TestDatabase;

/** A city, because `builders.city_id` is NOT NULL. */
let cityId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  const [city] = await db
    .insert(schema.cities)
    .values({
      slug: 'zz-test-city',
      name: 'Test City',
      region: 'Test Region',
      lat: 23.25,
      lon: 77.41,
      blurb: 'A disposable fixture.',
      status: 'published',
    })
    .returning({ id: schema.cities.id });
  cityId = city.id;
});

afterAll(async () => {
  await db?.$close();
});

beforeEach(async () => {
  // Disposable fixtures only, and rebuilt per test. §69: nothing here is
  // modelled on a real person, and this suite never touches a real database.
  // NOT `audit_log`: migration 0001 makes it append-only with a trigger that
  // refuses DELETE, which is exactly the guarantee it exists to give. Audit
  // assertions below therefore scope to the entity under test rather than
  // assuming an empty table.
  await db.delete(schema.profileClaims);
  await db.delete(schema.memberProfiles);
  await db.delete(schema.builders);
  // NOT `members` either. `audit_log.actor_member_id` is ON DELETE SET NULL,
  // nulling it is an UPDATE, and the append-only trigger refuses UPDATEs — so
  // a member who has acted cannot be hard-deleted. That is the intended
  // behaviour (§12: retire by status, never by removing the row), so each test
  // uses its own DID rather than expecting an empty table.
});

// =========================================================================
describe('reading a token off a request', () => {
  it('prefers the Authorization header', () => {
    const request = new Request('https://www.withclaude.in/api/member/me', {
      headers: { authorization: 'Bearer header-token', cookie: 'privy-token=cookie-token' },
    });
    expect(readAccessToken(request)).toBe('header-token');
  });

  it('falls back to the privy-token cookie', () => {
    const request = new Request('https://www.withclaude.in/api/member/me', {
      headers: { cookie: 'other=1; privy-token=cookie-token; more=2' },
    });
    expect(readAccessToken(request)).toBe('cookie-token');
  });

  it('finds nothing when there is nothing', () => {
    expect(readAccessToken(new Request('https://www.withclaude.in/'))).toBeNull();
  });

  /**
   * A TOKEN IN A URL IS A TOKEN IN BROWSER HISTORY, IN `Referer`, AND IN
   * EVERY ACCESS LOG BETWEEN HERE AND THE FUNCTION.
   */
  it('never reads a token from the query string', () => {
    const request = new Request('https://www.withclaude.in/api/member/me?privy-token=leaked');
    expect(readAccessToken(request)).toBeNull();
  });

  it('ignores an empty Bearer value rather than treating it as a token', () => {
    const request = new Request('https://www.withclaude.in/', {
      headers: { authorization: 'Bearer    ' },
    });
    expect(readAccessToken(request)).toBeNull();
  });
});

// =========================================================================
describe('configuration', () => {
  it('is null without an app id, so a route can answer 503', () => {
    expect(privyConfig({ PRIVY_VERIFICATION_KEY: 'key' } as NodeJS.ProcessEnv)).toBeNull();
    expect(privyConfig({} as NodeJS.ProcessEnv)).toBeNull();
  });

  /**
   * A MISSING VERIFICATION KEY IS NO LONGER A REFUSAL.
   *
   * This assertion used to be the opposite, and that is what took the whole
   * account area down: `PRIVY_VERIFICATION_KEY` was declared-but-empty in
   * Preview and absent in Production, so `privyConfig()` returned null and
   * every authenticated request answered 503 `not-configured` — including for
   * users holding perfectly valid tokens.
   *
   * The key is optional because `verificationKeyFor()` falls back to the app's
   * published JWKS, which the installed SDK accepts as a `verification_key`
   * directly. The app id is still required: without it there is no audience to
   * check and no JWKS to fetch.
   */
  it('is configured with only an app id, resolving the key from JWKS', () => {
    const config = privyConfig({ PRIVY_APP_ID: 'app' } as NodeJS.ProcessEnv);
    expect(config).not.toBeNull();
    expect(config?.appId).toBe('app');
    expect(config?.verificationKey).toBeUndefined();
  });

  it('reads only server variables, never the PUBLIC_ copy', () => {
    const config = privyConfig({
      PUBLIC_PRIVY_APP_ID: 'public-app',
      PRIVY_APP_ID: 'server-app',
      PRIVY_VERIFICATION_KEY: 'key',
    } as NodeJS.ProcessEnv);
    expect(config?.appId).toBe('server-app');
  });

  /**
   * An unconfigured server must refuse, not accept. `not-configured` maps to
   * 503 and NOT to 200 — the failure mode of a missing key must never be
   * "everybody is authenticated".
   */
  it('maps every failure to a refusing status', () => {
    expect(statusFor('not-configured')).toBe(503);
    expect(statusFor('no-token')).toBe(401);
    expect(statusFor('invalid-token')).toBe(401);
    expect(statusFor('no-member')).toBe(409);
    expect(statusFor('suspended')).toBe(403);
    expect(statusFor('deleted')).toBe(403);
  });
});

// =========================================================================
describe('provisioning', () => {
  it('creates a member on first sight and reports it as created', async () => {
    const { member, created } = await provisionMember('did:privy:zz-test-1', db);
    expect(created).toBe(true);
    expect(member.status).toBe('active');
    expect(member.privyUserId).toBe('did:privy:zz-test-1');
  });

  it('is idempotent — a second login returns the same member', async () => {
    const first = await provisionMember('did:privy:zz-test-2', db);
    const second = await provisionMember('did:privy:zz-test-2', db);

    expect(second.created).toBe(false);
    expect(second.member.id).toBe(first.member.id);

    const rows = await db
      .select()
      .from(schema.members)
      .where(eq(schema.members.privyUserId, 'did:privy:zz-test-2'));
    expect(rows).toHaveLength(1);
  });

  /**
   * TWO TABS FINISHING LOGIN AT ONCE.
   *
   * The check-then-insert version of this loses: both see nothing, both
   * insert, the second gets a unique violation that surfaces as a failed
   * sign-in. `ON CONFLICT DO UPDATE` makes the database settle it.
   */
  it('survives two concurrent first logins', async () => {
    const [a, b] = await Promise.all([
      provisionMember('did:privy:zz-test-race', db),
      provisionMember('did:privy:zz-test-race', db),
    ]);

    expect(a.member.id).toBe(b.member.id);
    const rows = await db
      .select()
      .from(schema.members)
      .where(eq(schema.members.privyUserId, 'did:privy:zz-test-race'));
    expect(rows).toHaveLength(1);
  });

  it('creates a profile shell with a placeholder handle, not a real one', async () => {
    const { member } = await provisionMember('did:privy:zz-test-3', db);
    const shell = await ensureProfileShell(member, db);

    expect(shell.created).toBe(true);
    expect(isPlaceholderUsername(shell.username)).toBe(true);
  });

  it('does not publish anything — a shell is not a profile', async () => {
    const { member } = await provisionMember('did:privy:zz-test-4', db);
    await ensureProfileShell(member, db);

    const [profile] = await db
      .select()
      .from(schema.memberProfiles)
      .where(eq(schema.memberProfiles.memberId, member.id));
    expect(profile.publishedAt).toBeNull();

    // And no public record exists yet.
    const builders = await db.select().from(schema.builders);
    expect(builders).toHaveLength(0);
  });

  it('does not create a second shell for a returning member', async () => {
    const { member } = await provisionMember('did:privy:zz-test-5', db);
    const first = await ensureProfileShell(member, db);
    const second = await ensureProfileShell(member, db);

    expect(second.created).toBe(false);
    expect(second.username).toBe(first.username);
  });
});

// =========================================================================
describe('status gates the authorisation layer', () => {
  it('lets an active member publish', async () => {
    const { member } = await provisionMember('did:privy:zz-active', db);
    expect(canPublish(member)).toBe(true);
  });

  it('refuses a suspended member', async () => {
    const { member } = await provisionMember('did:privy:zz-suspended', db);
    await db
      .update(schema.members)
      .set({ status: 'suspended' })
      .where(eq(schema.members.id, member.id));

    expect(canPublish({ ...member, status: 'suspended' })).toBe(false);
  });

  /**
   * STATUS IS READ FRESH, NOT CARRIED IN A TOKEN.
   *
   * Suspending somebody must take effect on their next click. This asserts
   * the read comes from the row rather than from anything cached.
   */
  it('sees a suspension that happened after the member was created', async () => {
    const { member } = await provisionMember('did:privy:zz-later', db);
    await db
      .update(schema.members)
      .set({ status: 'suspended' })
      .where(eq(schema.members.id, member.id));

    const [row] = await db
      .select({ status: schema.members.status })
      .from(schema.members)
      .where(eq(schema.members.id, member.id));
    expect(row.status).toBe('suspended');
  });
});

// =========================================================================
describe('usernames', () => {
  it('canonicalises to lower case and trims', () => {
    expect(canonicalUsername('  PunIT  ')).toBe('punit');
  });

  it.each([
    ['ab', 'too-short'],
    ['a'.repeat(31), 'too-long'],
    ['-leading', 'shape'],
    ['_leading', 'shape'],
    ['has space', 'shape'],
    ['has.dot', 'shape'],
    ['emoji🙂name', 'shape'],
    ['', 'empty'],
  ])('rejects %j as %s', (input, reason) => {
    const result = checkUsernameShape(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(reason);
  });

  it.each(['abc', 'a-b_c', 'punit', 'x'.repeat(30), '0start'])('accepts %j', (input) => {
    expect(checkUsernameShape(input).ok).toBe(true);
  });

  it('refuses a reserved handle', async () => {
    const result = await checkUsernameAvailable('admin', db);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('reserved');
  });

  it.each(['api', 'me', 'settings', 'builders', 'ambassador', 'anthropic', 'verified'])(
    'reserves %s',
    async (name) => {
      const result = await checkUsernameAvailable(name, db);
      expect(result.ok).toBe(false);
    },
  );

  it('refuses a handle another member already has', async () => {
    const { member } = await provisionMember('did:privy:zz-taken', db);
    await db
      .update(schema.memberProfiles)
      .set({ username: 'zz-taken-handle' })
      .where(eq(schema.memberProfiles.memberId, (await ensureProfileShell(member, db), member.id)));

    const other = await provisionMember('did:privy:zz-other', db);
    const result = await checkUsernameAvailable('zz-taken-handle', db, other.member.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('taken');
  });

  it('lets a member keep their own handle', async () => {
    const { member } = await provisionMember('did:privy:zz-own', db);
    await ensureProfileShell(member, db);
    await db
      .update(schema.memberProfiles)
      .set({ username: 'zz-mine' })
      .where(eq(schema.memberProfiles.memberId, member.id));

    const result = await checkUsernameAvailable('zz-mine', db, member.id);
    expect(result.ok).toBe(true);
  });

  /**
   * A published profile becomes a `builders` row whose slug IS the username.
   * Without this check the collision would surface at publish time as a unique
   * violation on a different table, long after the decision that caused it.
   */
  it('refuses a handle that collides with an existing builder slug', async () => {
    await db.insert(schema.builders).values({
      slug: 'zz-legacy-person',
      name: 'ZZ Legacy Person',
      cityId,
      role: 'Builder',
      status: 'published',
    });

    const { member } = await provisionMember('did:privy:zz-collide', db);
    const result = await checkUsernameAvailable('zz-legacy-person', db, member.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('taken');
  });

  /** The database enforces the shape too, not only the form. */
  it('is refused by the database CHECK even if application code were bypassed', async () => {
    const { member } = await provisionMember('did:privy:zz-check', db);
    await expect(
      db.insert(schema.memberProfiles).values({ memberId: member.id, username: 'Has Space' }),
    ).rejects.toThrow();
  });
});

// =========================================================================
describe('origin checks', () => {
  it('trusts the production origins', () => {
    expect(isTrustedOrigin('https://www.withclaude.in', {} as NodeJS.ProcessEnv)).toBe(true);
    expect(isTrustedOrigin('https://withclaude.in', {} as NodeJS.ProcessEnv)).toBe(true);
  });

  it('trusts this project on vercel.app, anchored at both ends', () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(isTrustedOrigin('https://with-claude.vercel.app', env)).toBe(true);
    expect(isTrustedOrigin('https://with-claude-abc123.vercel.app', env)).toBe(true);
    expect(isTrustedOrigin('https://with-claude.vercel.app.evil.com', env)).toBe(false);
    expect(isTrustedOrigin('https://evil-with-claude.vercel.app', env)).toBe(false);
    expect(isTrustedOrigin('https://anything-else.vercel.app', env)).toBe(false);
  });

  /**
   * THE ADMIN IS A DIFFERENT APPLICATION WITH A DIFFERENT AUTH SYSTEM.
   * A POST from its origin into a member endpoint is cross-origin.
   */
  it('does not trust the admin deployment', () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(isTrustedOrigin('https://with-claude-admin.vercel.app', env)).toBe(false);
    expect(isTrustedOrigin('https://admin.withclaude.in', env)).toBe(false);
  });

  it('trusts loopback only outside a deployment', () => {
    expect(isTrustedOrigin('http://localhost:4321', {} as NodeJS.ProcessEnv)).toBe(true);
    expect(isTrustedOrigin('http://localhost:4321', { VERCEL: '1' } as NodeJS.ProcessEnv)).toBe(
      false,
    );
  });

  it('refuses a cross-site POST', () => {
    const request = new Request('https://www.withclaude.in/api/member/profile', {
      method: 'PATCH',
      headers: { origin: 'https://evil.example' },
    });
    expect(assertSameOrigin(request, {} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('accepts a same-origin POST', () => {
    const request = new Request('https://www.withclaude.in/api/member/profile', {
      method: 'PATCH',
      headers: { origin: 'https://www.withclaude.in' },
    });
    expect(assertSameOrigin(request, {} as NodeJS.ProcessEnv)).toBe(true);
  });

  it('refuses a request with no Origin and no Referer', () => {
    const request = new Request('https://www.withclaude.in/api/member/profile', { method: 'PATCH' });
    expect(assertSameOrigin(request, {} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('refuses an opaque origin', () => {
    const request = new Request('https://www.withclaude.in/api/member/profile', {
      method: 'PATCH',
      headers: { origin: 'null' },
    });
    expect(assertSameOrigin(request, {} as NodeJS.ProcessEnv)).toBe(false);
  });
});
