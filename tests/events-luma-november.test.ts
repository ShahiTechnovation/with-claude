/**
 * MIGRATION 0019, ON A REAL DATABASE (PGlite, all migrations).
 *
 * The record is imported, then the nine new events are deleted, so the
 * database is as it was before 0019. Then 0019's statements run twice. After
 * the first run the database has to read back exactly as `src/data/events.ts`
 * says; the second run has to change nothing.
 *
 * The production cases seed the sync's own rows for some of these events, as
 * production had them on 29 October: they end up archived as an editor's
 * takedown, and a later sync neither revives them nor adds a copy. The guard
 * cases check both stops.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, inArray, isNotNull, like, sql } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import { importRecords, repositoryRecords } from '../db/import';
import * as schema from '../db/schema';
import { loadRecordSet } from '../src/data/source-db';
import { tsRecordSet } from '../src/data/source-ts';
import type { CommunityEvent } from '../src/data/types';
import { ManualEventSource } from '../src/server/events/registry';
import { syncSource } from '../src/server/events/sync';

/** The nine events: slug → Luma link. */
const NEW: Record<string, string> = {
  'claude-code-meetup-23-october': 'claude-qax4',
  'claude-for-founders-meetup-25-october': 'claude-s0yt',
  'claude-code-workshop-1-november': 'claude-8ej2',
  'claude-code-meetup-workshop-3-november': 'claude-0yz1',
  'claude-code-workshop-7-november': 'claude-4nyy',
  'claude-code-workshop-14-november': 'claude-vtm6',
  'claude-meetup-18-november': 'claude-a33d',
  'claude-code-workshop-19-november': 'claude-b4mc',
  'claude-build-day-22-november': 'claude-89py',
};
const SLUGS = Object.keys(NEW);
const FEED_KEY = 'luma:claudecommunity';
/** A published feed row for another event, which 0019 must leave alone. */
const UNRELATED = 'stray-unrelated-feed';

function statements(): string[] {
  return readFileSync(join(process.cwd(), 'db/migrations/0019_events_luma_november.sql'), 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function run0019() {
  for (const s of statements()) await db.execute(sql.raw(s));
}

/** Runs 0019 and returns the database's error, or '' if every statement ran. */
async function run0019Error(): Promise<string> {
  try {
    await run0019();
    return '';
  } catch (error) {
    // Drizzle wraps it: the message is the failed SQL, the cause is Postgres's error.
    return ((error as Error).cause as Error | undefined)?.message ?? String(error);
  }
}

/** Before 0019: the nine absent, and no feed, feed rows or strays. */
async function resetToBefore() {
  await db.delete(schema.events).where(inArray(schema.events.slug, SLUGS));
  await db.delete(schema.events).where(isNotNull(schema.events.sourceId));
  await db.delete(schema.events).where(like(schema.events.slug, 'stray-%'));
  // Cascades to their staging rows.
  await db.delete(schema.eventSources);
}

/** What a page reads: every field but ids, timestamps and derived lists. And photos. */
const visible = ({ id, createdAt, updatedAt, projectSlugs, photos, ...rest }: CommunityEvent) =>
  rest;
const bySlug = (a: { slug: string }, b: { slug: string }) => a.slug.localeCompare(b.slug);

/** The Luma link a URL points at, in any spelling: lu.ma or luma.com, www., a query. */
const lumaLink = (url: string | null) =>
  url?.match(/^https?:\/\/(?:www\.)?(?:lu\.ma|luma\.com)\/([^/?#]+)/i)?.[1]?.toLowerCase();

const eventsTable = () => db.select().from(schema.events).orderBy(schema.events.slug);

async function snapshot() {
  return {
    events: await eventsTable(),
    hosts: await db
      .select()
      .from(schema.eventHosts)
      .orderBy(schema.eventHosts.eventId, schema.eventHosts.role),
    records: await db
      .select()
      .from(schema.eventSourceRecords)
      .orderBy(schema.eventSourceRecords.externalId),
  };
}

let db: TestDatabase;
let bhopalId: string;
let mumbaiId: string;
let aniketId: string;

const row = async (slug: string) =>
  (await db.select().from(schema.events).where(eq(schema.events.slug, slug)))[0];

/** The required fields of an event 0019 did not write, in Bhopal. */
function strayEvent(slug: string) {
  return {
    slug,
    title: 'Stray',
    format: 'meetup' as const,
    cityId: bhopalId,
    date: '2026-11-18',
    startTime: '17:30',
    venueName: 'Bhopal',
    summary: 'Already here.',
    status: 'published' as const,
  };
}

async function feedSource() {
  const [source] = await db
    .insert(schema.eventSources)
    .values({ key: FEED_KEY, provider: 'luma', label: 'Feed', syncMode: 'ics' })
    .onConflictDoUpdate({ target: schema.eventSources.key, set: { label: 'Feed' } })
    .returning();
  return source!.id;
}

/**
 * Production as a session read it on 29 October, plus an editor's takedown:
 *  #2 promoted, then withdrawn by the sync (archived, `canceled_at` set);
 *  #3 promoted and published on its announced 31 October, 17:30;
 *  #4 promoted and published, with an ingest host and a lu.ma link;
 *  #6 promoted, then archived by an editor;
 *  #8 promoted, its link in Luma's `/event/evt-…` form, so only its id matches;
 *  #1, #5 and #7 in staging only.
 * And one published feed row for another event, its link one character off, that 0019 must not touch.
 */
async function seedProduction() {
  const sourceId = await feedSource();
  const feedRow = (values: Partial<typeof schema.events.$inferInsert>) => ({
    ...strayEvent('unused'),
    title: 'From the feed',
    venuePrivate: true,
    summary: 'From the feed.',
    sourceId,
    ...values,
  });
  const inserted = await db
    .insert(schema.events)
    .values([
      feedRow({
        slug: 'bhopal-claude-for-founders-meetup',
        externalId: 'evt-Vpm9XpMA9kiNnax',
        date: '2026-10-25',
        registrationUrl: 'https://luma.com/claude-s0yt',
        status: 'archived',
        canceledAt: new Date('2026-10-28T21:45:00Z'),
      }),
      feedRow({
        slug: 'bhopal-claude-code-workshop',
        externalId: 'evt-2nvTaWT6ZK53QzK',
        format: 'workshop',
        date: '2026-10-31',
        registrationUrl: 'https://luma.com/claude-8ej2',
      }),
      feedRow({
        slug: 'mumbai-claude-code-meetup-workshop',
        externalId: 'evt-lEdV5rOtFA9Zysr',
        format: 'workshop',
        cityId: mumbaiId,
        ambassadorId: aniketId,
        date: '2026-11-03',
        startTime: '18:30',
        registrationUrl: 'https://lu.ma/claude-0yz1?utm_source=x',
      }),
      feedRow({
        slug: 'bhopal-claude-code-workshop-k8hvfyek',
        externalId: 'evt-K8HvFYekuXrG6DW',
        format: 'workshop',
        date: '2026-11-14',
        registrationUrl: 'https://luma.com/claude-vtm6',
        status: 'archived',
      }),
      feedRow({
        slug: 'bhopal-claude-code-workshop-8cvlkgog',
        externalId: 'evt-8CVlKGOGLHQNv1T',
        format: 'workshop',
        date: '2026-11-19',
        registrationUrl: 'https://luma.com/event/evt-8CVlKGOGLHQNv1T',
      }),
    ])
    .returning();
  const [unrelated] = await db
    .insert(schema.events)
    .values(
      feedRow({
        slug: UNRELATED,
        externalId: 'evt-unrelated',
        registrationUrl: 'https://luma.com/claude-qax4x',
      }),
    )
    .returning();
  const id = (slug: string) => inserted.find((e) => e.slug === slug)!.id;
  await db.insert(schema.eventHosts).values({
    eventId: id('mumbai-claude-code-meetup-workshop'),
    ambassadorId: aniketId,
    role: 'primary_host',
    source: 'ingest',
    confidence: '1.00',
  });

  const staging = (
    externalId: string,
    link: string,
    startsAt: string,
    state: 'promoted' | 'review' | 'withdrawn',
    stateReason: string | null,
    eventId: string | null = null,
  ) => ({
    sourceId,
    externalId,
    title: 'From the feed',
    startsAt: new Date(startsAt),
    registrationUrl: `https://luma.com/${link}`,
    state,
    stateReason,
    eventId,
    rawHash: 'seed',
  });
  await db
    .insert(schema.eventSourceRecords)
    .values([
      staging(
        'evt-4CHDcOU7oEqR3gK',
        'claude-qax4',
        '2026-10-23T12:00:00Z',
        'withdrawn',
        'absent-from-feed',
      ),
      staging(
        'evt-Vpm9XpMA9kiNnax',
        'claude-s0yt',
        '2026-10-25T12:00:00Z',
        'withdrawn',
        'absent-from-feed',
        id('bhopal-claude-for-founders-meetup'),
      ),
      staging(
        'evt-2nvTaWT6ZK53QzK',
        'claude-8ej2',
        '2026-10-31T12:00:00Z',
        'promoted',
        null,
        id('bhopal-claude-code-workshop'),
      ),
      staging(
        'evt-lEdV5rOtFA9Zysr',
        'claude-0yz1',
        '2026-11-03T13:00:00Z',
        'promoted',
        null,
        id('mumbai-claude-code-meetup-workshop'),
      ),
      staging(
        'evt-A313V0jzFkmmvub',
        'claude-4nyy',
        '2026-11-07T12:00:00Z',
        'review',
        'no-location-signal',
      ),
      staging(
        'evt-K8HvFYekuXrG6DW',
        'claude-vtm6',
        '2026-11-14T12:00:00Z',
        'promoted',
        null,
        id('bhopal-claude-code-workshop-k8hvfyek'),
      ),
      staging(
        'evt-ste1FXlgIXRMxj4',
        'claude-a33d',
        '2026-11-18T12:00:00Z',
        'review',
        'no-location-signal',
      ),
    ]);
  return { feed: inserted, unrelated: unrelated! };
}

beforeAll(async () => {
  db = await createTestDatabase();
  await importRecords(db as never, repositoryRecords);
  const city = async (slug: string) =>
    (await db.select().from(schema.cities).where(eq(schema.cities.slug, slug)))[0]!.id;
  bhopalId = await city('bhopal');
  mumbaiId = await city('mumbai');
  aniketId = (
    await db.select().from(schema.ambassadors).where(eq(schema.ambassadors.slug, 'aniket-sahu'))
  )[0]!.id;
}, 180_000);

afterAll(async () => {
  await db?.$close();
});

/** DB equals TS, leaving out the feed row for another event, which is not in the record. */
async function expectDbEqualsTs() {
  const fromDb = (await loadRecordSet(db as never)).events
    .filter((e) => e.slug !== UNRELATED)
    .map(visible)
    .sort(bySlug);
  const fromTs = tsRecordSet().events.map(visible).sort(bySlug);
  expect(fromDb).toEqual(fromTs);
  return fromDb;
}

describe('migration 0019: nine Luma events as curated rows', () => {
  it('adds the nine from nothing, and is a no-op the second time', async () => {
    await resetToBefore();

    await run0019();
    const once = await snapshot();
    await run0019();
    expect(await snapshot()).toEqual(once);

    const fromDb = await expectDbEqualsTs();
    for (const slug of SLUGS) {
      expect(fromDb.find((e) => e.slug === slug)?.host.credits, slug).toEqual([
        { ambassadorSlug: 'aniket-sahu', role: 'primary_host', source: 'curated', confidence: 1 },
      ]);
    }
  });

  it('archives the sync’s own rows as a takedown, and leaves one published row per link', async () => {
    await resetToBefore();
    const { feed, unrelated } = await seedProduction();
    const records = () =>
      db.select().from(schema.eventSourceRecords).orderBy(schema.eventSourceRecords.externalId);
    const stagingBefore = await records();

    await run0019();
    const once = await snapshot();
    await run0019();
    expect(await snapshot()).toEqual(once);

    for (const before of feed) {
      expect(await row(before.slug), before.slug).toMatchObject({
        id: before.id,
        slug: before.slug,
        sourceId: before.sourceId,
        externalId: before.externalId,
        status: 'archived',
        canceledAt: null,
      });
    }
    expect(await records()).toEqual(stagingBefore);
    expect(await row(UNRELATED)).toEqual(unrelated);

    const published = (await eventsTable()).filter((e) => e.status === 'published');
    for (const [slug, link] of Object.entries(NEW)) {
      const holders = published.filter((e) => lumaLink(e.registrationUrl) === link);
      expect(
        holders.map((e) => e.slug),
        link,
      ).toEqual([slug]);
    }
    await expectDbEqualsTs();
  });

  it('a sync afterwards links the event once it has a location, and writes no event', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-12T06:30:00Z'), toFake: ['Date'] });
    try {
      await resetToBefore();
      await seedProduction();
      await run0019();
      const before = await eventsTable();

      const feedEvent = (
        externalId: string,
        title: string,
        link: string,
        startsAt: string,
        location?: string,
      ) => ({
        externalId,
        title,
        startsAt: new Date(startsAt),
        location,
        organizer: 'Aniket Sahu',
        registrationUrl: `https://luma.com/${link}`,
      });
      const summary = await syncSource(
        new ManualEventSource(
          [
            // No venue on Luma yet: no location signal at all.
            feedEvent(
              'evt-K8HvFYekuXrG6DW',
              'Bhopal | Claude Code Workshop',
              'claude-vtm6',
              '2026-11-14T12:00:00Z',
            ),
            // The host has added the venue since.
            feedEvent(
              'evt-ste1FXlgIXRMxj4',
              'Bhopal | Claude Meetup',
              'claude-a33d',
              '2026-11-18T12:00:00Z',
              'Bhopal, Madhya Pradesh, India',
            ),
          ],
          { key: FEED_KEY, complete: true },
        ),
        db,
      );
      expect(summary).toMatchObject({ ok: true, matchedCurated: 1 });

      const record = async (externalId: string) =>
        (
          await db
            .select()
            .from(schema.eventSourceRecords)
            .where(eq(schema.eventSourceRecords.externalId, externalId))
        )[0];
      expect(await record('evt-K8HvFYekuXrG6DW')).toMatchObject({
        state: 'review',
        stateReason: 'no-location-signal',
      });
      expect(await record('evt-ste1FXlgIXRMxj4')).toMatchObject({
        state: 'promoted',
        stateReason: 'matched-curated-event',
        eventId: (await row('claude-meetup-18-november'))!.id,
      });
      expect(await eventsTable()).toEqual(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['a curated row elsewhere', 'https://www.luma.com/claude-vtm6/', 'curated', false],
    ['a Baserow row', 'https://lu.ma/claude-a33d?utm_source=luma', 'baserow', true],
    ['a Baserow row, by its Luma id', null, 'baserow', true],
  ] as const)('stops before any change when %s holds one (%s)', async (_, url, authority, feed) => {
    await resetToBefore();
    const sourceId = feed ? await feedSource() : null;
    await db.insert(schema.events).values({
      ...strayEvent('stray-holder'),
      registrationUrl: url,
      contentAuthority: authority,
      sourceId,
      externalId: feed ? 'evt-ste1FXlgIXRMxj4' : null,
    });
    const before = await snapshot();

    expect(await run0019Error()).toMatch(/0019 stopped before any change: stray-holder \(/);
    expect(await snapshot()).toEqual(before);
  });

  it('stops after its changes when a stray row holds one of the slugs', async () => {
    await resetToBefore();
    const [stray] = await db
      .insert(schema.events)
      .values({ ...strayEvent('claude-meetup-18-november'), registrationUrl: null })
      .returning();

    expect(await run0019Error()).toMatch(
      /0019 stopped after its changes.*claude-meetup-18-november is missing/,
    );

    expect(await row('claude-meetup-18-november')).toMatchObject({
      id: stray!.id,
      title: 'Stray',
      registrationUrl: null,
    });
    const strayHosts = await db
      .select()
      .from(schema.eventHosts)
      .where(eq(schema.eventHosts.eventId, stray!.id));
    expect(strayHosts).toEqual([]);
    // The other eight still went in.
    for (const slug of SLUGS.filter((s) => s !== 'claude-meetup-18-november')) {
      expect((await row(slug))?.registrationUrl, slug).toBe(`https://luma.com/${NEW[slug]}`);
    }
  });
});
