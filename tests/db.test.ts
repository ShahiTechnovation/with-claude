import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import * as schema from '../db/schema';

/**
 * The schema, tested as a schema.
 *
 * These run against PGlite — real PostgreSQL, compiled to WebAssembly, in
 * process. That is the whole point: most of this schema's governance lives in
 * CHECK constraints and triggers, and a mock would happily accept every row
 * the database is supposed to refuse.
 *
 * Every test below starts from an empty database with the committed migrations
 * applied, so "the migrations build the schema from nothing" is not a separate
 * assertion — it is the precondition of all of them.
 */
let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await db?.$close();
});

/** A city to hang foreign keys off. Returns its id. */
async function seedCity(slug = 'test-city'): Promise<string> {
  const [row] = await db
    .insert(schema.cities)
    .values({
      slug,
      name: 'Test City',
      region: 'Test State',
      lat: 23.2,
      lon: 77.4,
      blurb: 'Somewhere.',
    })
    .returning({ id: schema.cities.id });
  return row.id;
}

describe('migrations', () => {
  it('build the whole schema from an empty database', async () => {
    const result = await db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const tables = new Set((result.rows as { table_name: string }[]).map((r) => r.table_name));

    for (const expected of [
      'organizations',
      'cities',
      'builders',
      'ambassadors',
      'events',
      'projects',
      'stories',
      'use_cases',
      'guides',
      'media',
      'submissions',
      'city_interest',
      'audit_log',
      'users',
    ]) {
      expect(tables, `table ${expected}`).toContain(expected);
    }
  });

  it('record the audited moderation vocabulary and nothing else', async () => {
    const result = await db.execute(
      sql`select unnest(enum_range(null::content_status))::text as value`,
    );
    expect((result.rows as { value: string }[]).map((r) => r.value)).toEqual([
      'draft',
      'pending',
      'in_review',
      'changes_requested',
      'approved',
      'published',
      'rejected',
      'archived',
    ]);
  });
});

describe('governance: a city has no editable state', () => {
  /**
   * The single most important assertion in this file. A city becomes
   * ambassador-led because a verified ambassador row points at it, and no
   * other way — so there must be no column an editor can set to fake one.
   */
  it('has no lifecycle column on cities', async () => {
    const result = await db.execute(
      sql`select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'cities'`,
    );
    const columns = (result.rows as { column_name: string }[]).map((r) => r.column_name);

    for (const forbidden of ['city_state', 'state', 'chapter', 'tier', 'active', 'is_active']) {
      expect(columns, `cities.${forbidden} must not exist`).not.toContain(forbidden);
    }
    // Geography is kept, under a name that cannot be confused for a lifecycle.
    expect(columns).toContain('region');
  });
});

describe('governance: an event has no stored lifecycle', () => {
  it('has no upcoming/today/live/past column', async () => {
    const result = await db.execute(
      sql`select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'events'`,
    );
    const columns = (result.rows as { column_name: string }[]).map((r) => r.column_name);

    for (const forbidden of ['lifecycle', 'is_past', 'is_live', 'is_upcoming', 'event_state']) {
      expect(columns, `events.${forbidden} must not exist`).not.toContain(forbidden);
    }
    expect(columns).toContain('status_override');
  });

  it('accepts only authored door states in status_override', async () => {
    const result = await db.execute(
      sql`select unnest(enum_range(null::event_status_override))::text as value`,
    );
    expect((result.rows as { value: string }[]).map((r) => r.value)).toEqual([
      'sold-out',
      'registration-closed',
      'cancelled',
    ]);
  });
});

describe('governance: ambassador status is not self-assignable', () => {
  it('rejects a builder claiming the ambassador role', async () => {
    const cityId = await seedCity('roles-city');

    await expect(
      db.insert(schema.builders).values({
        slug: 'self-appointed',
        name: 'Self Appointed',
        cityId,
        role: 'Wishful thinker',
        roles: ['builder', 'ambassador'],
      }),
    ).rejects.toThrow();
  });

  it('accepts every other role', async () => {
    const cityId = await seedCity('roles-ok-city');

    await expect(
      db.insert(schema.builders).values({
        slug: 'legitimate',
        name: 'Legitimate Builder',
        cityId,
        role: 'Backend engineer',
        roles: ['builder', 'host', 'speaker', 'contributor', 'volunteer'],
      }),
    ).resolves.toBeDefined();
  });

  it('requires verification provenance on an ambassador', async () => {
    const cityId = await seedCity('amb-city');

    // Empty provenance is the same as none.
    await expect(
      db.insert(schema.ambassadors).values({
        slug: 'unverified',
        name: 'Unverified Person',
        cityId,
        verifiedVia: '   ',
      }),
    ).rejects.toThrow();

    await expect(
      db.insert(schema.ambassadors).values({
        slug: 'verified',
        name: 'Verified Person',
        cityId,
        verifiedVia: 'Confirmed by the organisers, September 2026',
      }),
    ).resolves.toBeDefined();
  });

  it('refuses to paraphrase the programme title', async () => {
    const cityId = await seedCity('title-city');

    await expect(
      db.insert(schema.ambassadors).values({
        slug: 'paraphrased',
        name: 'Paraphrased Title',
        cityId,
        title: 'Claude Ambassador',
        verifiedVia: 'Confirmed by the organisers',
      }),
    ).rejects.toThrow();
  });
});

describe('governance: authorship and attribution', () => {
  it('will not store a use case without a credential', async () => {
    await expect(
      db.execute(sql`
        insert into use_cases (slug, title, summary, category, author_name, author_credential,
                               date, problem, context, claude_did, human_did, result)
        values ('no-credential', 'T', 'S', 'product', 'Someone', NULL,
                '2026-09-01', 'P', 'C', ARRAY['a'], ARRAY['b'], 'R')`),
    ).rejects.toThrow();
  });

  it('will not store a use case with an empty credential', async () => {
    await expect(
      db.insert(schema.useCases).values({
        slug: 'blank-credential',
        title: 'T',
        summary: 'S',
        category: 'product',
        authorName: 'Someone',
        authorCredential: '  ',
        date: '2026-09-01',
        problem: 'P',
        context: 'C',
        claudeDid: ['a'],
        humanDid: ['b'],
        result: 'R',
      }),
    ).rejects.toThrow();
  });

  it('requires both halves of the human/Claude split', async () => {
    await expect(
      db.insert(schema.useCases).values({
        slug: 'one-sided',
        title: 'T',
        summary: 'S',
        category: 'product',
        authorName: 'Someone',
        authorCredential: 'Ran the workshop, vol. 09',
        date: '2026-09-01',
        problem: 'P',
        context: 'C',
        claudeDid: ['Claude did everything'],
        humanDid: [],
        result: 'R',
      }),
    ).rejects.toThrow();
  });

  it('will not store media without alt text', async () => {
    await expect(
      db.execute(sql`insert into media (path, alt) values ('events/undescribed.jpg', NULL)`),
    ).rejects.toThrow();

    await expect(
      db.insert(schema.media).values({
        path: 'events/described.jpg',
        alt: 'Six people beside the Claude standee at the meetup.',
      }),
    ).resolves.toBeDefined();
  });
});

describe('governance: a reported number must have a source', () => {
  it('rejects reported figures with no attribution', async () => {
    await expect(
      db.insert(schema.cities).values({
        slug: 'unsourced',
        name: 'Unsourced',
        region: 'Nowhere',
        lat: 20,
        lon: 77,
        blurb: 'A place.',
        reportedMembers: 900,
      }),
    ).rejects.toThrow();
  });

  it('rejects an interest count with no source', async () => {
    await expect(
      db.insert(schema.cities).values({
        slug: 'unsourced-interest',
        name: 'Unsourced Interest',
        region: 'Nowhere',
        lat: 20,
        lon: 77,
        blurb: 'A place.',
        interestCount: 40,
      }),
    ).rejects.toThrow();
  });

  it('accepts them together', async () => {
    await expect(
      db.insert(schema.cities).values({
        slug: 'sourced',
        name: 'Sourced',
        region: 'Somewhere',
        lat: 20,
        lon: 77,
        blurb: 'A place.',
        reportedMembers: 420,
        reportedSource: 'Reported by the organisers, September 2026',
      }),
    ).resolves.toBeDefined();
  });
});

describe('uniqueness', () => {
  it.each([
    [
      'cities',
      () =>
        db.insert(schema.cities).values({
          slug: 'dupe',
          name: 'Dupe',
          region: 'R',
          lat: 1,
          lon: 1,
          blurb: 'b',
        }),
    ],
  ])('rejects a duplicate slug in %s', async (_table, insert) => {
    await expect(insert()).resolves.toBeDefined();
    await expect(insert()).rejects.toThrow();
  });

  it('rejects duplicate slugs on builders, events and projects', async () => {
    const cityId = await seedCity('dupe-city');

    const builder = () =>
      db.insert(schema.builders).values({
        slug: 'dupe-builder',
        name: 'Dupe',
        cityId,
        role: 'Builder',
      });
    await expect(builder()).resolves.toBeDefined();
    await expect(builder()).rejects.toThrow();

    const event = () =>
      db.insert(schema.events).values({
        slug: 'dupe-event',
        title: 'Dupe',
        format: 'meetup',
        cityId,
        date: '2026-09-01',
        startTime: '18:00',
        venueName: 'Somewhere',
        summary: 'A room.',
      });
    await expect(event()).resolves.toBeDefined();
    await expect(event()).rejects.toThrow();

    const project = () =>
      db.insert(schema.projects).values({
        slug: 'dupe-project',
        title: 'Dupe',
        cityId,
        summary: 'A thing.',
        category: 'experiment',
      });
    await expect(project()).resolves.toBeDefined();
    await expect(project()).rejects.toThrow();
  });

  it('rejects a duplicate organisation name', async () => {
    await expect(
      db.insert(schema.organizations).values({ slug: 'a-guild', name: 'A Guild' }),
    ).resolves.toBeDefined();
    await expect(
      db.insert(schema.organizations).values({ slug: 'a-guild-2', name: 'A Guild' }),
    ).rejects.toThrow();
  });
});

describe('referential integrity', () => {
  it('refuses an event pointing at a city that does not exist', async () => {
    await expect(
      db.execute(sql`
        insert into events (slug, title, format, city_id, date, start_time, venue_name, summary)
        values ('orphan', 'Orphan', 'meetup', '00000000-0000-0000-0000-000000000000',
                '2026-09-01', '18:00', 'Somewhere', 'A room.')`),
    ).rejects.toThrow();
  });

  it('refuses to delete a city that still has events', async () => {
    const cityId = await seedCity('protected-city');
    await db.insert(schema.events).values({
      slug: 'protected-event',
      title: 'Protected',
      format: 'meetup',
      cityId,
      date: '2026-09-01',
      startTime: '18:00',
      venueName: 'Somewhere',
      summary: 'A room.',
    });

    await expect(db.execute(sql`delete from cities where id = ${cityId}`)).rejects.toThrow();
  });
});

describe('submissions', () => {
  it('arrives pending, with no reviewer and no entity', async () => {
    const [row] = await db
      .insert(schema.submissions)
      .values({
        kind: 'builder',
        payload: { name: 'Someone', email: 'someone@example.com' },
        submitterEmail: 'someone@example.com',
      })
      .returning();

    // The first state of the audited workflow. A person has finished writing
    // this and is waiting on somebody — which is what `pending` means, and
    // what the queue sorts by.
    expect(row.status).toBe('pending');
    expect(row.entityType).toBeNull();
    expect(row.entityId).toBeNull();
    expect(row.reviewerId).toBeNull();
    expect(row.reviewedAt).toBeNull();
  });

  it('will not record a review without a reviewer', async () => {
    await expect(
      db.insert(schema.submissions).values({
        kind: 'builder',
        payload: {},
        submitterEmail: 'x@example.com',
        reviewedAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('will not link half an entity reference', async () => {
    await expect(
      db.insert(schema.submissions).values({
        kind: 'builder',
        payload: {},
        submitterEmail: 'y@example.com',
        entityType: 'builder',
      }),
    ).rejects.toThrow();
  });
});

describe('city interest', () => {
  it('arrives unverified', async () => {
    const [row] = await db
      .insert(schema.cityInterest)
      .values({ cityName: 'Nagpur', email: 'someone@example.com' })
      .returning();

    expect(row.verifiedAt).toBeNull();
    expect(row.verifiedBy).toBeNull();
  });

  it('cannot be marked verified without saying who verified it', async () => {
    await expect(
      db.insert(schema.cityInterest).values({
        cityName: 'Surat',
        email: 'other@example.com',
        verifiedAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('keeps one signal per person per city', async () => {
    const values = { cityName: 'Kochi', email: 'repeat@example.com' };
    await expect(db.insert(schema.cityInterest).values(values)).resolves.toBeDefined();
    await expect(db.insert(schema.cityInterest).values(values)).rejects.toThrow();
  });
});

describe('the audit log is append-only', () => {
  it('accepts an entry', async () => {
    await expect(
      db.insert(schema.auditLog).values({
        action: 'submission.accepted',
        entityType: 'submission',
        note: 'Looks real.',
      }),
    ).resolves.toBeDefined();
  });

  it('refuses UPDATE, DELETE and TRUNCATE', async () => {
    await db.insert(schema.auditLog).values({ action: 'test.written', entityType: 'test' });

    await expect(db.update(schema.auditLog).set({ note: 'tampered' })).rejects.toThrow();
    await expect(db.delete(schema.auditLog)).rejects.toThrow();
    await expect(db.execute(sql`truncate table audit_log`)).rejects.toThrow();

    // And the entries are still there.
    const result = await db.execute(sql`select count(*)::int as n from audit_log`);
    expect((result.rows as { n: number }[])[0].n).toBeGreaterThan(0);
  });
});
