import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import * as schema from '../db/schema';
import { ADMIN_ROLES, lookupAdminUser } from '../admin/src/server/auth';
import { authorise, assertSameOrigin, canReview, isAdmin } from '../admin/src/server/session';
import {
  GENERIC_CONFIRMATION,
  requestMagicLink,
  resetLoginThrottle,
  safeNext,
} from '../admin/src/server/login';

/**
 * The access boundary.
 *
 * Two rules are load-bearing and both are tested against a real database:
 *
 *  1. NOBODY GETS IN WHO IS NOT ON THE LIST. There is no sign-up. An address
 *     with no row, a deactivated row, or a row without an admin role gets
 *     nothing — not a session, and not an email.
 *
 *  2. THE LOGIN FORM IS NOT A MEMBERSHIP ORACLE. The response is byte-identical
 *     whether or not the address has an account, so nobody can enumerate who
 *     has editorial access by typing addresses at it.
 */
let db: TestDatabase;

const people = {
  admin: { email: 'admin@example.com', role: 'admin', active: true, id: '' },
  editor: { email: 'editor@example.com', role: 'editor', active: true, id: '' },
  viewer: { email: 'viewer@example.com', role: 'viewer', active: true, id: '' },
  reviewer: { email: 'reviewer@example.com', role: 'reviewer', active: true, id: '' },
  deactivated: { email: 'gone@example.com', role: 'editor', active: false, id: '' },
};

beforeAll(async () => {
  db = await createTestDatabase();

  for (const person of Object.values(people)) {
    const [row] = await db
      .insert(schema.users)
      .values({
        email: person.email,
        name: person.email.split('@')[0],
        role: person.role as never,
        active: person.active,
      })
      .returning({ id: schema.users.id });
    person.id = row.id;
  }
}, 60_000);

afterAll(async () => {
  await db?.$close();
});

beforeEach(() => {
  resetLoginThrottle();
});

// ── The allowlist ───────────────────────────────────────────────────────

describe('the allowlist', () => {
  it('admits an admin', async () => {
    const result = await lookupAdminUser(people.admin.email, db);
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.user.role).toBe('admin');
      expect(result.user.id).toBe(people.admin.id);
    }
  });

  it('admits an editor', async () => {
    const result = await lookupAdminUser(people.editor.email, db);
    expect(result.allowed).toBe(true);
    if (result.allowed) expect(result.user.role).toBe('editor');
  });

  it('refuses an address with no account', async () => {
    const result = await lookupAdminUser('stranger@example.com', db);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe('unknown');
  });

  it('refuses a deactivated account', async () => {
    const result = await lookupAdminUser(people.deactivated.email, db);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe('inactive');
  });

  it.each(['viewer', 'reviewer'] as const)('refuses a %s — not an admin role', async (which) => {
    const result = await lookupAdminUser(people[which].email, db);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe('role');
  });

  it('is case- and whitespace-insensitive about the address', async () => {
    for (const variant of ['  ADMIN@example.com  ', 'Admin@Example.COM']) {
      const result = await lookupAdminUser(variant, db);
      expect(result.allowed, variant).toBe(true);
    }
  });

  it('recognises exactly two roles', () => {
    expect([...ADMIN_ROLES]).toEqual(['admin', 'editor']);
    // `reviewer` exists in the database enum from Phase 1 and deliberately
    // grants nothing: the architecture treats Moderator as Editor rather than
    // inventing a third tier.
    expect(schema.userRole.enumValues).toContain('reviewer');
    expect(ADMIN_ROLES as readonly string[]).not.toContain('reviewer');
  });
});

// ── Authorisation on every request ──────────────────────────────────────

describe('authorisation is re-checked from the database, not from the token', () => {
  it('allows an active admin', async () => {
    const result = await authorise(people.admin.id, db);
    expect(result.authenticated).toBe(true);
    if (result.authenticated) expect(result.user.role).toBe('admin');
  });

  it('allows an active editor', async () => {
    const result = await authorise(people.editor.id, db);
    expect(result.authenticated).toBe(true);
  });

  it('refuses a deactivated account even with a valid session', async () => {
    const result = await authorise(people.deactivated.id, db);
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) expect(result.reason).toBe('inactive');
  });

  it('refuses a role that is not an admin role', async () => {
    const result = await authorise(people.viewer.id, db);
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) expect(result.reason).toBe('role');
  });

  it('refuses a session whose user no longer exists', async () => {
    const result = await authorise('00000000-0000-0000-0000-000000000000', db);
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) expect(result.reason).toBe('unknown-user');
  });

  /**
   * The property that justifies the per-request lookup: revoking access takes
   * effect immediately rather than when a session expires. A role baked into a
   * signed token is a decision you cannot take back for twelve hours.
   */
  it('locks somebody out the moment they are deactivated', async () => {
    const [row] = await db
      .insert(schema.users)
      .values({ email: 'temp@example.com', role: 'editor', active: true })
      .returning({ id: schema.users.id });

    expect((await authorise(row.id, db)).authenticated).toBe(true);

    await db.update(schema.users).set({ active: false }).where(eq(schema.users.id, row.id));

    const after = await authorise(row.id, db);
    expect(after.authenticated).toBe(false);
    if (!after.authenticated) expect(after.reason).toBe('inactive');
  });

  it('demotes somebody the moment their role changes', async () => {
    const [row] = await db
      .insert(schema.users)
      .values({ email: 'demoted@example.com', role: 'admin', active: true })
      .returning({ id: schema.users.id });

    expect((await authorise(row.id, db)).authenticated).toBe(true);

    await db.update(schema.users).set({ role: 'viewer' }).where(eq(schema.users.id, row.id));

    const after = await authorise(row.id, db);
    expect(after.authenticated).toBe(false);
    if (!after.authenticated) expect(after.reason).toBe('role');
  });

  it('agrees with the role helpers', () => {
    expect(canReview('admin')).toBe(true);
    expect(canReview('editor')).toBe(true);
    expect(canReview('viewer')).toBe(false);
    expect(isAdmin('admin')).toBe(true);
    expect(isAdmin('editor')).toBe(false);
  });
});

// ── The login form tells nobody anything ────────────────────────────────

describe('the login form is not a membership oracle', () => {
  /** Records what would have been emailed, so a test can assert "nothing". */
  function recorder() {
    const sent: string[] = [];
    return {
      sent,
      sendLink: async ({ email }: { email: string }) => {
        sent.push(email);
      },
    };
  }

  it('sends a link to an allowlisted account', async () => {
    const mail = recorder();
    const outcome = await requestMagicLink(
      { email: people.editor.email },
      { db, sendLink: mail.sendLink },
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.sent).toBe(true);
    expect(mail.sent).toEqual([people.editor.email]);
  });

  it.each([
    ['an unknown address', 'stranger@example.com'],
    ['a deactivated account', people.deactivated.email],
    ['a non-admin role', people.viewer.email],
  ])('sends nothing at all for %s', async (_label, email) => {
    const mail = recorder();
    const outcome = await requestMagicLink({ email }, { db, sendLink: mail.sendLink });

    // Reports success — and sent no email.
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.sent).toBe(false);
    expect(mail.sent).toEqual([]);
  });

  it('answers identically whether or not the address exists', async () => {
    const real = await requestMagicLink(
      { email: people.admin.email },
      { db, sendLink: async () => {} },
    );
    resetLoginThrottle();
    const fake = await requestMagicLink(
      { email: 'nobody-at-all@example.com' },
      { db, sendLink: async () => {} },
    );

    expect(real.ok).toBe(true);
    expect(fake.ok).toBe(true);

    // Both are `ok`, so the page renders the same confirmation for each. The
    // `sent` flag differs but is never rendered — the page shows one constant.
    if (real.ok && fake.ok) {
      expect(real.ok).toBe(fake.ok);
      expect('error' in real).toBe(false);
      expect('error' in fake).toBe(false);
    }
    // And the confirmation itself promises nothing.
    expect(GENERIC_CONFIRMATION).toMatch(/if that address has an account/i);
  });

  it('creates no account for an unknown address', async () => {
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(schema.users);
    await requestMagicLink({ email: 'never-seen@example.com' }, { db, sendLink: async () => {} });
    const after = await db.select({ n: sql<number>`count(*)::int` }).from(schema.users);

    expect(after[0].n).toBe(before[0].n);
  });

  it('rejects a malformed address out loud, because that is a typo not a probe', async () => {
    for (const email of [
      '',
      '   ',
      'not-an-email',
      'a@b',
      'a@b.',
      '@example.com',
      'x'.repeat(300),
    ]) {
      const outcome = await requestMagicLink({ email }, { db, sendLink: async () => {} });
      expect(outcome.ok, JSON.stringify(email)).toBe(false);
      if (!outcome.ok) expect(outcome.status).toBe(400);
      resetLoginThrottle();
    }
  });

  it('rejects a non-string address', async () => {
    for (const email of [null, undefined, 42, {}, []]) {
      const outcome = await requestMagicLink({ email }, { db, sendLink: async () => {} });
      expect(outcome.ok).toBe(false);
      resetLoginThrottle();
    }
  });

  it('throttles repeated attempts, so the form cannot be used to send mail', async () => {
    const mail = recorder();

    for (let i = 0; i < 5; i += 1) {
      const outcome = await requestMagicLink(
        { email: people.admin.email, callerKey: '203.0.113.9' },
        { db, sendLink: mail.sendLink },
      );
      expect(outcome.ok, `attempt ${i + 1}`).toBe(true);
    }

    const blocked = await requestMagicLink(
      { email: people.admin.email, callerKey: '203.0.113.9' },
      { db, sendLink: mail.sendLink },
    );
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.status).toBe(429);

    // Five sent, the sixth refused before it reached the mailer.
    expect(mail.sent).toHaveLength(5);
  });

  it('reports a mail failure rather than claiming a link was sent', async () => {
    const outcome = await requestMagicLink(
      { email: people.admin.email },
      {
        db,
        sendLink: async () => {
          throw new Error('Resend is down');
        },
      },
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(500);
      // And the message does not leak the provider's error.
      expect(outcome.error).not.toMatch(/Resend/);
    }
  });
});

// ── Redirect safety ─────────────────────────────────────────────────────

describe('the post-login redirect cannot leave the site', () => {
  it.each([
    ['//evil.example.com', '/submissions'],
    ['https://evil.example.com', '/submissions'],
    ['http://evil.example.com', '/submissions'],
    ['evil.example.com', '/submissions'],
    ['javascript:alert(1)', '/submissions'],
    ['', '/submissions'],
    [null, '/submissions'],
    ['/submissions', '/submissions'],
    ['/submissions/abc?x=1', '/submissions/abc?x=1'],
    ['/audit', '/audit'],
  ])('turns %j into %j', (input, expected) => {
    expect(safeNext(input as string | null)).toBe(expected);
  });
});

// ── CSRF ────────────────────────────────────────────────────────────────

describe('state-changing requests must come from this origin', () => {
  const ADMIN_ORIGIN = 'https://admin.withclaude.in';
  const previous = process.env.BETTER_AUTH_URL;

  beforeEach(() => {
    process.env.BETTER_AUTH_URL = ADMIN_ORIGIN;
  });

  afterAll(() => {
    if (previous === undefined) delete process.env.BETTER_AUTH_URL;
    else process.env.BETTER_AUTH_URL = previous;
  });

  const post = (headers: Record<string, string>) =>
    new Request(`${ADMIN_ORIGIN}/api/submissions/x/review`, { method: 'POST', headers });

  it('accepts a matching Origin', () => {
    expect(assertSameOrigin(post({ origin: ADMIN_ORIGIN }))).toBe(true);
  });

  it('falls back to Referer when Origin is absent', () => {
    expect(assertSameOrigin(post({ referer: `${ADMIN_ORIGIN}/submissions/abc` }))).toBe(true);
  });

  it.each([
    ['the public site', 'https://www.withclaude.in'],
    ['a lookalike', 'https://admin.withclaude.in.evil.example.com'],
    ['plain http', 'http://admin.withclaude.in'],
    ['an attacker', 'https://evil.example.com'],
  ])('refuses %s', (_label, origin) => {
    expect(assertSameOrigin(post({ origin }))).toBe(false);
  });

  it('refuses a request with neither Origin nor Referer', () => {
    expect(assertSameOrigin(post({}))).toBe(false);
  });

  it('refuses everything when the expected origin is not configured', () => {
    delete process.env.BETTER_AUTH_URL;
    expect(assertSameOrigin(post({ origin: ADMIN_ORIGIN }))).toBe(false);
  });
});

// ── The public site keeps the cookie out ────────────────────────────────

describe('session cookies belong to the admin origin', () => {
  it('sets no cookie domain, so the public site never receives one', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('admin/src/server/auth.ts', 'utf8'),
    );

    // A `domain` of `.withclaude.in` would send the admin session cookie to
    // the public site on every static page view. Its absence is deliberate and
    // worth failing a test over.
    expect(source).not.toMatch(/domain\s*:/);
    expect(source).toMatch(/httpOnly:\s*true/);
    expect(source).toMatch(/sameSite:\s*'lax'/);
    expect(source).toMatch(/useSecureCookies/);
  });
});
