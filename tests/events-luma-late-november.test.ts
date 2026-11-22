/**
 * MIGRATION 0020, ON A REAL DATABASE (PGlite, all migrations).
 *
 * The record is imported, then put back as 0019 left it: the three new events
 * deleted, the 18 and 22 November rows at 0019's values, and Agrati Tech Labs
 * gone. Then 0020's statements run twice. After the first run the database has
 * to read back exactly as `src/data/events.ts` says; the second run has to
 * change nothing. The other cases check the archive and both stops.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, inArray, isNotNull, like, sql } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import { importRecords, repositoryRecords } from '../db/import';
import * as schema from '../db/schema';
import { loadRecordSet } from '../src/data/source-db';
import { tsRecordSet } from '../src/data/source-ts';
import type { CommunityEvent } from '../src/data/types';

type EventRow = Partial<typeof schema.events.$inferInsert>;

/** The three new events: slug → Luma link. */
const NEW: Record<string, string> = {
  'claude-for-working-professionals-26-november': 'claude-r38s',
  'claude-code-workshop-for-government-officials-29-november': 'claude-4xxl',
  'claude-for-chartered-accountants-meetup-6-december': 'claude-m3ex',
};

/** The two corrected rows, as 0019 wrote them. */
const OLD: Record<string, EventRow> = {
  'claude-meetup-18-november': {
    title: 'Claude Meetup',
    endTime: '20:00',
    venueName: 'Bhopal',
    venueAddress: null,
    venuePrivate: true,
    summary:
      'Claude at Work, a midweek meetup by Claude Community Bhopal about the everyday side of Claude: how students, developers, founders, marketers, teachers and professionals in our city use it to write, research, plan, analyze and get real work done.',
  },
  'claude-build-day-22-november': {
    title: 'Claude Build Day',
    startTime: '17:30',
    endTime: '20:00',
  },
};

const FIVE = [...Object.keys(OLD), ...Object.keys(NEW)];
const AGRATI = 'agrati-tech-labs';

function statements(): string[] {
  return readFileSync(
    join(process.cwd(), 'db/migrations/0020_events_luma_late_november.sql'),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function run0020() {
  for (const s of statements()) await db.execute(sql.raw(s));
}

/** Runs 0020 and returns the database's error, or '' if every statement ran. */
async function run0020Error(): Promise<string> {
  try {
    await run0020();
    return '';
  } catch (error) {
    // Drizzle wraps it: the message is the failed SQL, the cause is Postgres's error.
    return ((error as Error).cause as Error | undefined)?.message ?? String(error);
  }
}

/** After 0019: the three absent, the two at 0019's values, no Agrati, no feed rows or strays. */
async function resetToAfter0019() {
  await db.delete(schema.events).where(inArray(schema.events.slug, Object.keys(NEW)));
  await db.delete(schema.events).where(isNotNull(schema.events.sourceId));
  await db.delete(schema.events).where(like(schema.events.slug, 'stray-%'));
  // Cascades to their staging rows.
  await db.delete(schema.eventSources);
  for (const [slug, old] of Object.entries(OLD)) {
    await db
      .update(schema.events)
      .set({ ...old, contentAuthority: 'curated' })
      .where(eq(schema.events.slug, slug));
  }
  const agrati = await db
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, AGRATI));
  for (const org of agrati) {
    await db
      .delete(schema.eventOrganizations)
      .where(eq(schema.eventOrganizations.organizationId, org.id));
    await db.delete(schema.organizations).where(eq(schema.organizations.id, org.id));
  }
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
    organizations: await db.select().from(schema.organizations).orderBy(schema.organizations.slug),
    eventOrganizations: await db
      .select()
      .from(schema.eventOrganizations)
      .orderBy(schema.eventOrganizations.eventId, schema.eventOrganizations.organizationId),
  };
}

let db: TestDatabase;
let bhopalId: string;

const row = async (slug: string) =>
  (await db.select().from(schema.events).where(eq(schema.events.slug, slug)))[0];

/** The required fields of an event 0020 did not write, in Bhopal. */
function strayEvent(slug: string) {
  return {
    slug,
    title: 'Stray',
    format: 'meetup' as const,
    cityId: bhopalId,
    date: '2026-11-26',
    startTime: '17:00',
    venueName: 'Bhopal',
    summary: 'Already here.',
    status: 'published' as const,
  };
}

beforeAll(async () => {
  db = await createTestDatabase();
  await importRecords(db as never, repositoryRecords);
  bhopalId = (await db.select().from(schema.cities).where(eq(schema.cities.slug, 'bhopal')))[0]!.id;
}, 180_000);

afterAll(async () => {
  await db?.$close();
});

async function expectDbEqualsTs() {
  const fromDb = (await loadRecordSet(db as never)).events.map(visible).sort(bySlug);
  const fromTs = tsRecordSet().events.map(visible).sort(bySlug);
  expect(fromDb).toEqual(fromTs);
  return fromDb;
}

describe('migration 0020: three new Bhopal events and two Luma corrections', () => {
  it('brings the two rows to Luma, adds the three, and is a no-op the second time', async () => {
    await resetToAfter0019();

    await run0020();
    const once = await snapshot();
    await run0020();
    expect(await snapshot()).toEqual(once);

    const fromDb = await expectDbEqualsTs();
    for (const slug of FIVE) {
      expect(fromDb.find((e) => e.slug === slug)?.host.credits, slug).toEqual([
        { ambassadorSlug: 'aniket-sahu', role: 'primary_host', source: 'curated', confidence: 1 },
      ]);
    }
    expect(fromDb.find((e) => e.slug === 'claude-meetup-18-november')).toMatchObject({
      title: 'Claude Community x Agrati Tech Meetup',
      endTime: '19:30',
      venue: { name: 'Poppin’ Deli', address: 'Bhopal' },
      host: { organisations: ['Agrati Tech Labs'] },
    });
    expect(fromDb.find((e) => e.slug === 'claude-build-day-22-november')).toMatchObject({
      title: 'Claude Code Build Day - Fable 5.2',
      startTime: '14:00',
      endTime: '19:00',
      venue: { name: 'Bhopal', private: true },
    });
  });

  it('archives the sync’s own rows for the new events as a takedown', async () => {
    await resetToAfter0019();
    const [source] = await db
      .insert(schema.eventSources)
      .values({ key: 'luma:claudecommunity', provider: 'luma', label: 'Feed', syncMode: 'ics' })
      .returning();
    const feed = await db
      .insert(schema.events)
      .values([
        {
          ...strayEvent('bhopal-claude-for-working-professionals'),
          title: 'From the feed',
          venuePrivate: true,
          sourceId: source!.id,
          externalId: 'evt-7668zjjRwZFuijG',
          registrationUrl: 'https://lu.ma/claude-r38s?utm_source=feed',
        },
        // Withdrawn by the sync: still archived, but as a takedown it never revives.
        {
          ...strayEvent('bhopal-claude-code-workshop-s7cycouc'),
          title: 'From the feed',
          format: 'workshop' as const,
          date: '2026-11-29',
          venuePrivate: true,
          sourceId: source!.id,
          externalId: 'evt-S7CYCOUCLbCohb8',
          registrationUrl: 'https://luma.com/event/evt-S7CYCOUCLbCohb8',
          status: 'archived' as const,
          canceledAt: new Date('2026-11-21T21:45:00Z'),
        },
      ])
      .returning();

    await run0020();
    const once = await snapshot();
    await run0020();
    expect(await snapshot()).toEqual(once);

    for (const before of feed) {
      expect(await row(before.slug), before.slug).toMatchObject({
        id: before.id,
        sourceId: before.sourceId,
        externalId: before.externalId,
        registrationUrl: before.registrationUrl,
        status: 'archived',
        canceledAt: null,
      });
    }
    const published = (await eventsTable()).filter((e) => e.status === 'published');
    for (const [slug, link] of Object.entries(NEW)) {
      expect(
        published.filter((e) => lumaLink(e.registrationUrl) === link).map((e) => e.slug),
        link,
      ).toEqual([slug]);
    }
    await expectDbEqualsTs();
  });

  it('stops before any change when the 18 November row belongs to Baserow', async () => {
    await resetToAfter0019();
    await db
      .update(schema.events)
      .set({ contentAuthority: 'baserow' })
      .where(eq(schema.events.slug, 'claude-meetup-18-november'));
    const before = await snapshot();

    expect(await run0020Error()).toMatch(
      /0020 stopped before any change: claude-meetup-18-november is a Baserow or feed row/,
    );
    expect(await snapshot()).toEqual(before);
  });

  it('stops before any change when a curated row elsewhere holds claude-m3ex', async () => {
    await resetToAfter0019();
    await db.insert(schema.events).values({
      ...strayEvent('stray-holder'),
      registrationUrl: 'https://www.luma.com/claude-m3ex/',
    });
    const before = await snapshot();

    expect(await run0020Error()).toMatch(
      /0020 stopped before any change: stray-holder \(https:\/\/www\.luma\.com\/claude-m3ex\/\) already holds/,
    );
    expect(await snapshot()).toEqual(before);
  });

  it('leaves a hand-edited 22 November row alone, and stops after its changes naming it', async () => {
    await resetToAfter0019();
    await db
      .update(schema.events)
      .set({ title: 'Claude Build Day (edited)' })
      .where(eq(schema.events.slug, 'claude-build-day-22-november'));
    const edited = await row('claude-build-day-22-november');

    expect(await run0020Error()).toMatch(
      /0020 stopped after its changes, incomplete: claude-build-day-22-november is missing[^;]*\. Fix/,
    );
    expect(await row('claude-build-day-22-november')).toEqual(edited);
    // The rest still went in.
    expect(await row('claude-meetup-18-november')).toMatchObject({
      title: 'Claude Community x Agrati Tech Meetup',
    });
    for (const [slug, link] of Object.entries(NEW)) {
      expect((await row(slug))?.registrationUrl, slug).toBe(`https://luma.com/${link}`);
    }
  });
});
