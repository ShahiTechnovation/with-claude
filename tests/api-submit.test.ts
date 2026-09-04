import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import * as schema from '../db/schema';
import { handleSubmission } from '../src/server/submissions/handle';
import { LIMITS, RESERVED_FIELDS, validateSubmission } from '../src/server/submissions/validate';
import { RATE_LIMITS } from '../src/server/submissions/rate-limit';
import { hashAddress, normaliseEmail } from '../src/server/submissions/identity';
import { forms } from '../src/data/forms';

/**
 * `/api/submit`, end to end, against a real PostgreSQL.
 *
 * The handler takes its database and mailer as arguments, so these exercise
 * the actual pipeline — validation, rate limiting, the insert, the
 * acknowledgement — rather than a re-implementation of it. Nothing is stubbed
 * except the mail send, which is recorded so the tests can assert what would
 * have gone out without anything leaving the machine.
 */
let db: TestDatabase;

/** Every acknowledgement the handler asked for, in order. */
let sent: { to: string; kind: string; name?: string }[];

beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await db?.$close();
});

beforeEach(async () => {
  sent = [];
  // Each test starts from an empty inbox so the rate-limit counters, which
  // read this table, do not leak between cases.
  await db.execute(sql`delete from city_interest`);
  await db.execute(sql`delete from submissions`);
});

/** A distinct caller per test, so one test's ceiling is not another's. */
let addressCounter = 0;

function post(
  body: unknown,
  { address, headers }: { address?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const request = new Request('https://www.withclaude.in/api/submit/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': address ?? `203.0.113.${(addressCounter += 1) % 250}`,
      'user-agent': 'vitest',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  return handleSubmission(request, {
    database: () => db,
    // Behaves like the real hasher — salted, one-way, opaque — so the privacy
    // assertions below mean something rather than testing a stub's format.
    hashAddress: (value) =>
      createHash('sha256').update(`test-salt:${value}`).digest('hex').slice(0, 32),
    sendAcknowledgement: async (message) => {
      sent.push({ to: message.to, kind: message.kind, name: message.name });
      return { delivered: true };
    },
  });
}

// ── Valid submissions, one per form the site renders ───────────────────

/** Enough time on the form to look like a person typed it. */
const TYPED = RATE_LIMITS.minimumElapsedMs + 500;

const VALID: Record<string, Record<string, unknown>> = {
  contribute: {
    form: 'contribute',
    name: 'Asha Menon',
    email: 'asha@example.com',
    city: 'Bhopal',
    role: 'Backend engineer',
    building: 'A scheduling agent for a clinic.',
    claudeTools: 'Claude Code, the API',
    elapsed_ms: TYPED,
  },
  build: {
    form: 'build',
    title: 'Queueless',
    creator: 'Asha Menon',
    email: 'asha@example.com',
    city: 'Bhopal',
    category: 'Product',
    summary: 'Removes the queue at the municipal office.',
    claudeUsage: 'Drafted the state machine and caught two race conditions.',
    url: 'https://queueless.example.com',
    elapsed_ms: TYPED,
  },
  practice: {
    form: 'practice',
    title: 'How I use Claude Code to review migrations',
    name: 'Asha Menon',
    credential: 'Ran the Claude Code workshop in Bhopal, vol. 09',
    email: 'asha@example.com',
    city: 'Bhopal',
    category: 'Claude Code',
    problem: 'Migrations were landing without anyone reading them.',
    workflow: 'Diff, then explain, then challenge.',
    claudeDid: 'Explained each statement and flagged the destructive ones.',
    humanDid: 'Rejected two suggestions that would have dropped a column.',
    result: 'Two bad migrations caught. It still misses lock contention.',
    elapsed_ms: TYPED,
  },
  city: {
    form: 'city',
    city: 'Nagpur',
    email: 'asha@example.com',
    doing: 'A logistics tool for a family business.',
    helping: 'I would help organise',
    elapsed_ms: TYPED,
  },
};

describe('every form the site renders is accepted', () => {
  it.each([
    ['builder', 'contribute'],
    ['project', 'build'],
    ['use-case', 'practice'],
    ['city-interest', 'city'],
  ])('a valid %s submission returns 202', async (kind, formId) => {
    const response = await post(VALID[formId]);

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.received).toBe(true);

    const rows = await db.select().from(schema.submissions);
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe(kind);
    // Straight into the review queue. Nothing arriving from the public
    // endpoint is a draft — the person has finished and is waiting.
    expect(rows[0].status).toBe('pending');
  });

  it('covers every form defined in forms.ts', () => {
    // If a fifth form is added, this test fails until it has a case above —
    // an unvalidated form is a hole in the endpoint, not an omission in a test.
    expect(new Set(Object.keys(VALID))).toEqual(new Set(forms.map((f) => f.id)));
  });

  it('retains the raw submitted payload', async () => {
    await post(VALID.contribute);
    const [row] = await db.select().from(schema.submissions);

    expect(row.payload).toMatchObject({
      name: 'Asha Menon',
      role: 'Backend engineer',
      building: 'A scheduling agent for a clinic.',
    });
  });

  it('sends exactly one acknowledgement', async () => {
    await post(VALID.contribute);
    expect(sent).toEqual([{ to: 'asha@example.com', kind: 'builder', name: 'Asha Menon' }]);
  });
});

// ── Rejections ──────────────────────────────────────────────────────────

describe('malformed input is rejected', () => {
  it('rejects a body that is not JSON', async () => {
    const response = await post('not json at all');
    expect(response.status).toBe(400);
  });

  it('rejects a body that is not an object', async () => {
    const response = await post([1, 2, 3]);
    expect(response.status).toBe(400);
  });

  it('rejects a missing form id', async () => {
    const { form, ...rest } = VALID.contribute;
    void form;
    const response = await post(rest);
    expect(response.status).toBe(400);
  });

  it('rejects an unknown form id', async () => {
    const response = await post({ ...VALID.contribute, form: 'not-a-form' });
    expect(response.status).toBe(404);
  });

  it('rejects an unknown field rather than stripping it', async () => {
    const response = await post({ ...VALID.contribute, favouriteColour: 'orange' });

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(JSON.stringify(body)).toMatch(/favouriteColour/);

    // And nothing was written.
    const rows = await db.select().from(schema.submissions);
    expect(rows.length).toBe(0);
  });

  it('rejects a missing email', async () => {
    const { email, ...rest } = VALID.contribute;
    void email;
    const response = await post(rest);

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(JSON.stringify(body.issues)).toMatch(/email/);
  });

  it('rejects a malformed email', async () => {
    const response = await post({ ...VALID.contribute, email: 'asha at example dot com' });
    expect(response.status).toBe(422);
  });

  it('rejects a missing required field', async () => {
    const { building, ...rest } = VALID.contribute;
    void building;
    expect((await post(rest)).status).toBe(422);
  });

  it('rejects a select value the site never offered', async () => {
    const response = await post({ ...VALID.build, category: 'Something Else Entirely' });
    expect(response.status).toBe(422);
  });

  it('rejects a value that is not text', async () => {
    const response = await post({ ...VALID.contribute, name: { first: 'Asha' } });
    expect(response.status).toBe(400);
  });
});

describe('URLs must be HTTPS', () => {
  it.each([
    ['plain http', 'http://queueless.example.com'],
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,<script>alert(1)</script>'],
    ['not a URL at all', 'queueless.example.com'],
  ])('rejects %s', async (_label, url) => {
    const response = await post({ ...VALID.build, url });
    expect(response.status).toBe(422);
  });

  it('accepts https', async () => {
    const response = await post({ ...VALID.build, url: 'https://queueless.example.com/x' });
    expect(response.status).toBe(202);
  });
});

describe('a submission cannot set its own state', () => {
  /**
   * The load-bearing test for the whole design. A submission is an inbox item:
   * it publishes nothing, creates nothing, and cannot name the record it would
   * like to become. Every field below is refused by name.
   */
  it.each([
    ['status', { status: 'published' }],
    ['id', { id: '00000000-0000-0000-0000-000000000000' }],
    ['slug', { slug: 'asha-menon' }],
    ['entity_type', { entity_type: 'builder' }],
    ['entityId', { entityId: '00000000-0000-0000-0000-000000000000' }],
    ['reviewer_id', { reviewer_id: '00000000-0000-0000-0000-000000000000' }],
    ['reviewed_at', { reviewed_at: '2026-09-04T00:00:00Z' }],
    ['approved', { approved: 'true' }],
    ['published', { published: 'true' }],
    ['featured', { featured: 'true' }],
    ['kind', { kind: 'builder' }],
    ['roles', { roles: 'ambassador' }],
    ['verifiedVia', { verifiedVia: 'I said so' }],
    ['ip_hash', { ip_hash: 'something' }],
  ])('rejects an attempted %s', async (field, extra) => {
    const response = await post({ ...VALID.contribute, ...extra });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(new RegExp(field));

    const rows = await db.select().from(schema.submissions);
    expect(rows.length, 'nothing may be written').toBe(0);
  });

  it('names every reserved field in the rejection list', () => {
    // A field that is reserved but not listed would fail as merely "unknown",
    // which is a worse error and a weaker guarantee.
    for (const field of ['id', 'slug', 'status', 'entity_type', 'reviewer_id']) {
      expect(RESERVED_FIELDS).toContain(field);
    }
  });

  it('creates no builder, project, use case or city record', async () => {
    for (const formId of Object.keys(VALID)) {
      await post(VALID[formId], { address: `198.51.100.${Object.keys(VALID).indexOf(formId)}` });
    }

    for (const table of ['builders', 'projects', 'use_cases', 'stories', 'guides', 'cities']) {
      const result = await db.execute(sql.raw(`select count(*)::int as n from ${table}`));
      expect((result.rows as { n: number }[])[0].n, `${table} must stay empty`).toBe(0);
    }
  });
});

describe('size limits', () => {
  it('rejects an oversized body', async () => {
    const response = await post({
      ...VALID.contribute,
      building: 'x'.repeat(LIMITS.bodyBytes + 100),
    });
    expect(response.status).toBe(413);
  });

  it('rejects an over-long field', async () => {
    const response = await post({ ...VALID.contribute, role: 'x'.repeat(LIMITS.text + 1) });
    expect(response.status).toBe(422);
  });

  it('rejects a declared content-length over the ceiling', async () => {
    const response = await post(VALID.contribute, {
      headers: { 'content-length': String(LIMITS.bodyBytes + 1) },
    });
    expect(response.status).toBe(413);
  });
});

describe('anti-abuse', () => {
  it('rejects a filled-in honeypot', async () => {
    const response = await post({ ...VALID.contribute, website: 'https://spam.example.com' });

    expect(response.status).toBe(422);
    expect(await db.select().from(schema.submissions)).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('accepts an empty honeypot, which is what a person sends', async () => {
    const response = await post({ ...VALID.contribute, website: '' });
    expect(response.status).toBe(202);
  });

  it('rejects a submission filled in faster than a person could type it', async () => {
    const response = await post({ ...VALID.contribute, elapsed_ms: 40 });

    expect(response.status).toBe(422);
    expect(await db.select().from(schema.submissions)).toHaveLength(0);
  });

  it('does not punish a client that never reported a timing', async () => {
    const { elapsed_ms, ...rest } = VALID.contribute;
    void elapsed_ms;
    expect((await post(rest)).status).toBe(202);
  });

  it('stops one address after its hourly ceiling', async () => {
    const address = '192.0.2.99';

    for (let i = 0; i < RATE_LIMITS.perAddressPerHour; i += 1) {
      const response = await post(
        { ...VALID.contribute, email: `person${i}@example.com` },
        { address },
      );
      expect(response.status, `submission ${i + 1}`).toBe(202);
    }

    const blocked = await post(
      { ...VALID.contribute, email: 'one-too-many@example.com' },
      { address },
    );
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
  });

  it('stops one email address across different networks', async () => {
    for (let i = 0; i < RATE_LIMITS.perEmailPerDay; i += 1) {
      const response = await post(VALID.contribute, { address: `192.0.2.${10 + i}` });
      expect(response.status, `submission ${i + 1}`).toBe(202);
    }

    const blocked = await post(VALID.contribute, { address: '192.0.2.200' });
    expect(blocked.status).toBe(429);
  });

  it('treats a shifted capital as the same email address', async () => {
    await post(VALID.contribute, { address: '192.0.2.30' });
    const [row] = await db.select().from(schema.submissions);
    expect(row.submitterEmail).toBe('asha@example.com');

    await post({ ...VALID.contribute, email: 'ASHA@Example.com' }, { address: '192.0.2.31' });
    const rows = await db.select().from(schema.submissions);
    expect(rows.map((r) => r.submitterEmail)).toEqual(['asha@example.com', 'asha@example.com']);
  });
});

describe('privacy', () => {
  it('stores a hash of the address, never the address', async () => {
    await post(VALID.contribute, { address: '203.0.113.77' });
    const [row] = await db.select().from(schema.submissions);

    expect(row.ipHash).toBeTruthy();
    expect(row.ipHash).not.toContain('203.0.113.77');
    expect(row.ipHash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('uses a salted one-way hash in production, not a reversible one', () => {
    // The real hasher, exercised directly. Without a salt a hashed IPv4
    // address is reversible in seconds, so its absence must be a hard failure
    // rather than a fallback to something weaker.
    const previous = process.env.SUBMISSION_IP_SALT;
    try {
      delete process.env.SUBMISSION_IP_SALT;
      expect(() => hashAddress('203.0.113.77')).toThrow(/SUBMISSION_IP_SALT/);

      process.env.SUBMISSION_IP_SALT = 'salt-one';
      const withOne = hashAddress('203.0.113.77');
      expect(withOne).not.toContain('203.0.113.77');
      expect(withOne).toMatch(/^[0-9a-f]{32}$/);
      // Same input, same output — otherwise it could not count anything.
      expect(hashAddress('203.0.113.77')).toBe(withOne);
      // Different address, different hash.
      expect(hashAddress('203.0.113.78')).not.toBe(withOne);

      // And the salt is actually mixed in: an unsalted digest of the address
      // is exactly what this must not produce.
      const unsalted = createHash('sha256').update('203.0.113.77').digest('hex').slice(0, 32);
      expect(withOne).not.toBe(unsalted);

      process.env.SUBMISSION_IP_SALT = 'salt-two';
      expect(hashAddress('203.0.113.77')).not.toBe(withOne);
    } finally {
      if (previous === undefined) delete process.env.SUBMISSION_IP_SALT;
      else process.env.SUBMISSION_IP_SALT = previous;
    }
  });

  it('refuses to start if a credential has been exposed as PUBLIC_', () => {
    process.env.PUBLIC_DATABASE_URL = 'postgresql://someone@example/db';
    try {
      expect(() => hashAddress('203.0.113.1')).toThrow(/PUBLIC_DATABASE_URL/);
    } finally {
      delete process.env.PUBLIC_DATABASE_URL;
    }
  });

  it('normalises an email without mangling provider conventions', () => {
    expect(normaliseEmail('  ASHA@Example.com ')).toBe('asha@example.com');
    // Dots and +tags are provider-specific and are NOT the same address
    // everywhere, so they are left alone.
    expect(normaliseEmail('a.b@example.com')).toBe('a.b@example.com');
    expect(normaliseEmail('asha+events@example.com')).toBe('asha+events@example.com');
  });

  it('returns nothing private in the response', async () => {
    const response = await post(VALID.contribute, { address: '203.0.113.78' });
    const text = await response.text();

    expect(text).not.toContain('asha@example.com');
    expect(text).not.toContain('203.0.113.78');
    expect(text).not.toContain('vitest');
    expect(text).not.toMatch(/ip_?[Hh]ash/);
    // Not even the submission's own id.
    const [row] = await db.select().from(schema.submissions);
    expect(text).not.toContain(row.id);
  });

  it('is never cacheable', async () => {
    const response = await post(VALID.contribute);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('city interest', () => {
  it('records the signal alongside the inbox item, unverified', async () => {
    await post(VALID.city);

    const [submission] = await db.select().from(schema.submissions);
    const [interest] = await db.select().from(schema.cityInterest);

    expect(interest.cityName).toBe('Nagpur');
    expect(interest.submissionId).toBe(submission.id);
    // The whole point: it counts for nothing until a person confirms it.
    expect(interest.verifiedAt).toBeNull();
    expect(interest.verifiedBy).toBeNull();
    // And it does not attach itself to a city on the atlas by name-matching.
    expect(interest.cityId).toBeNull();
  });

  it('does not inflate the count when the same person sends it twice', async () => {
    await post(VALID.city, { address: '198.51.100.50' });
    await post({ ...VALID.city, doing: 'Something else now.' }, { address: '198.51.100.51' });

    const rows = await db.select().from(schema.cityInterest);
    expect(rows).toHaveLength(1);
    expect(rows[0].doing).toBe('Something else now.');
  });

  it('changes nothing about any city on the atlas', async () => {
    await post(VALID.city);
    const result = await db.execute(sql`select count(*)::int as n from cities`);
    expect((result.rows as { n: number }[])[0].n).toBe(0);
  });
});

describe('the acknowledgement is honest', () => {
  it('reports a skipped send rather than claiming one', async () => {
    const request = new Request('https://www.withclaude.in/api/submit/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.200' },
      body: JSON.stringify(VALID.contribute),
    });

    const response = await handleSubmission(request, {
      database: () => db,
      hashAddress: (value) =>
        createHash('sha256').update(`test-salt:${value}`).digest('hex').slice(0, 32),
      // What happens in development, where there are no Resend credentials.
      sendAcknowledgement: async () => ({
        delivered: false,
        skipped: true,
        reason: 'RESEND_API_KEY not set',
      }),
    });

    expect(response.status).toBe(202);
    expect((await response.json()).acknowledgementSent).toBe(false);

    // The submission is still captured. That is the point of not throwing.
    expect(await db.select().from(schema.submissions)).toHaveLength(1);
  });
});

// ── The validator on its own ────────────────────────────────────────────

describe('validation is pure and testable without a database', () => {
  it('trims whitespace rather than storing it', () => {
    const result = validateSubmission({ ...VALID.contribute, name: '   Asha Menon   ' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.name).toBe('Asha Menon');
  });

  it('drops an optional field that arrived empty', () => {
    const result = validateSubmission({ ...VALID.contribute, links: '' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.links).toBeUndefined();
  });

  it('never lets a control field into the stored payload', () => {
    const result = validateSubmission({ ...VALID.contribute, website: '' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.website).toBeUndefined();
      expect(result.payload.elapsed_ms).toBeUndefined();
      expect(result.payload.form).toBeUndefined();
    }
  });
});
