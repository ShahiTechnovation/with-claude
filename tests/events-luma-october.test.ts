/**
 * MIGRATION 0018, ON A REAL DATABASE (PGlite, all migrations).
 *
 * The record is imported, every row 0018 touches is put back to its value
 * before 0018, and the three new events are deleted. Then 0018's statements
 * run twice. After the first run the database has to read back exactly as
 * `src/data/events.ts` says; the second run has to change nothing.
 *
 * The other cases check the guards. Baserow-owned and already-edited rows are
 * left alone. A Luma link another row already holds, in any form, stops the
 * migration before it writes anything. A new event that could not be added
 * stops it at the end, with the stray row untouched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, inArray, like, sql } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import { importRecords, repositoryRecords } from '../db/import';
import * as schema from '../db/schema';
import { loadRecordSet } from '../src/data/source-db';
import { tsRecordSet } from '../src/data/source-ts';
import type { CommunityEvent } from '../src/data/types';

type EventRow = Partial<typeof schema.events.$inferInsert>;

/** Each touched row as it was before 0018 (the old `src/data/events.ts`). */
const OLD: Record<string, EventRow> = {
  'claude-code-for-builders': { endTime: null },
  'claude-meetup': { endTime: null },
  'claude-community-conversation': { endTime: null },
  'getting-started-with-claude': { endTime: null },
  'claude-code-workshop': { endTime: null },
  'claude-code-workshop-part-two': { endTime: null },
  'claude-meetup-indore': { endTime: null, registrationUrl: null },
  'claude-for-businesses': { endTime: null },
  'claude-code-impact-lab': { endTime: '19:00' },
  'claude-for-college-builders': { startTime: '16:00', endTime: null },
  'claude-code-workshop-september': { venueAddress: 'Chiklod Road, Bhopal' },
  'claude-meetup-delhi': { endTime: null, venueAddress: 'Delhi' },
  'claude-conversation-september': { startTime: '18:00' },
  'claude-code-build-day-fable': { endTime: null },
  'agent-and-learn-workshop': { endTime: null },
  'claude-code-impact-lab-october': {
    title: 'Claude Code Impact Lab',
    date: '2026-10-10',
    startTime: '09:00',
    endTime: '18:00',
  },
};

const NEW = [
  'claude-for-everyone-bhopal',
  'claude-community-workshop',
  'claude-code-workshop-october',
];

function statements(): string[] {
  return readFileSync(join(process.cwd(), 'db/migrations/0018_events_luma_october.sql'), 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function run0018() {
  for (const s of statements()) await db.execute(sql.raw(s));
}

/** Runs 0018 and returns the database's error, or '' if every statement ran. */
async function run0018Error(): Promise<string> {
  try {
    await run0018();
    return '';
  } catch (error) {
    // Drizzle wraps it: the message is the failed SQL, the cause is Postgres's error.
    return ((error as Error).cause as Error | undefined)?.message ?? String(error);
  }
}

/** Before 0018: touched rows at their old values, new events and strays absent. */
async function resetToOld() {
  await db.delete(schema.events).where(inArray(schema.events.slug, NEW));
  await db.delete(schema.events).where(like(schema.events.slug, 'stray-%'));
  for (const [slug, old] of Object.entries(OLD)) {
    await db
      .update(schema.events)
      .set({ ...old, contentAuthority: 'curated' })
      .where(eq(schema.events.slug, slug));
  }
}

/**
 * What a page reads: every field but ids, timestamps and derived lists. And
 * photos: they reach the database through `npm run backfill:photos`, not 0018
 * (tests/backfill-event-photos.test.ts).
 */
const visible = ({ id, createdAt, updatedAt, projectSlugs, photos, ...rest }: CommunityEvent) =>
  rest;
const bySlug = (a: { slug: string }, b: { slug: string }) => a.slug.localeCompare(b.slug);

async function snapshot() {
  return {
    events: await db.select().from(schema.events).orderBy(schema.events.slug),
    hosts: await db.select().from(schema.eventHosts),
    coHosts: await db.select().from(schema.eventCoHosts),
    orgs: await db.select().from(schema.eventOrganizations),
  };
}

let db: TestDatabase;

const row = async (slug: string) =>
  (await db.select().from(schema.events).where(eq(schema.events.slug, slug)))[0];

/** The required fields of an event 0018 did not write, in Bhopal. */
function strayEvent(slug: string) {
  return {
    slug,
    title: 'Stray',
    format: 'meetup' as const,
    cityId: bhopalId,
    date: '2026-10-06',
    startTime: '17:30',
    venueName: 'Bhopal',
    summary: 'Already here.',
    status: 'published' as const,
  };
}
let bhopalId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  await importRecords(db as never, repositoryRecords);
  bhopalId = (await db.select().from(schema.cities).where(eq(schema.cities.slug, 'bhopal')))[0]!.id;
}, 180_000);

afterAll(async () => {
  await db?.$close();
});

describe('migration 0018: the Luma October corrections', () => {
  it('brings the old rows to the record, adds the three events, and is a no-op the second time', async () => {
    await resetToOld();
    const [lab] = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.slug, 'claude-code-impact-lab-october'));

    await run0018();
    const once = await snapshot();
    await run0018();
    expect(await snapshot()).toEqual(once);

    const fromDb = (await loadRecordSet(db as never)).events.map(visible).sort(bySlug);
    const fromTs = tsRecordSet().events.map(visible).sort(bySlug);
    expect(fromDb).toEqual(fromTs);

    // The two-day programme: Day 2 keeps the row's UUID, Day 1 is its own event.
    const [after] = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.slug, 'claude-code-impact-lab-october'));
    expect(after!.id).toBe(lab!.id);
    expect(after).toMatchObject({ date: '2026-10-11', startTime: '09:00:00', endTime: '19:30:00' });
    const workshop = fromDb.find((e) => e.slug === 'claude-community-workshop')!;
    expect(workshop.host).toMatchObject({
      ambassadorSlug: 'aniket-sahu',
      builderSlugs: ['vishal-kumar'],
      organisations: ['Builder Base'],
      credits: [
        { ambassadorSlug: 'aniket-sahu', role: 'primary_host', source: 'curated', confidence: 1 },
      ],
    });
  });

  it('leaves every Baserow-owned row exactly as it was', async () => {
    await resetToOld();
    const touched = inArray(schema.events.slug, Object.keys(OLD));
    await db.update(schema.events).set({ contentAuthority: 'baserow' }).where(touched);
    const read = () => db.select().from(schema.events).where(touched).orderBy(schema.events.slug);
    const before = await read();

    // Day 2 stays unsplit, so Day 1 is not added and the closing check stops.
    expect(await run0018Error()).toMatch(
      /0018 stopped after its changes.*claude-community-workshop is missing/,
    );
    expect(await read()).toEqual(before);
    expect(await row('claude-community-workshop')).toBeUndefined();
  });

  it.each([
    ['https://luma.com/claude-lulm', false],
    ['https://lu.ma/claude-lulm/', false],
    ['https://luma.com/claude-t91n', true],
    // www., a query and a fragment: forms the sync's registrationKey() reads as the same event.
    ['https://www.luma.com/claude-pmjo?utm_source=luma', false],
    ['https://www.lu.ma/claude-3brg#about', false],
  ])('stops before any change when another row holds %s (feed row: %s)', async (url, feed) => {
    await resetToOld();
    const sourceId = feed
      ? (
          await db
            .insert(schema.eventSources)
            .values({ key: 'luma:stray', provider: 'luma', label: 'Stray', syncMode: 'ics' })
            .onConflictDoUpdate({ target: schema.eventSources.key, set: { label: 'Stray' } })
            .returning()
        )[0]!.id
      : null;
    await db.insert(schema.events).values({
      ...strayEvent('stray-from-feed'),
      registrationUrl: url,
      sourceId,
      externalId: feed ? 'evt-stray' : null,
    });
    const before = await snapshot();

    expect(await run0018Error()).toMatch(
      /0018 stopped before any change: stray-from-feed \(https?:\/\/(www\.)?lu.*\) already hold/,
    );
    expect(await snapshot()).toEqual(before);
  });

  it('leaves an edited row alone, and stops when a stray row already holds a new slug', async () => {
    await resetToOld();
    await db
      .update(schema.events)
      .set({ endTime: '21:00' })
      .where(eq(schema.events.slug, 'claude-code-impact-lab'));
    const [stray] = await db
      .insert(schema.events)
      .values({ ...strayEvent('claude-code-workshop-october'), registrationUrl: null })
      .returning();

    expect(await run0018Error()).toMatch(
      /0018 stopped after its changes.*claude-code-workshop-october is missing/,
    );

    expect((await row('claude-code-impact-lab'))!.endTime).toBe('21:00:00');
    const after = await row('claude-code-workshop-october');
    expect(after).toMatchObject({ id: stray!.id, title: 'Stray', registrationUrl: null });
    const strayHosts = await db
      .select()
      .from(schema.eventHosts)
      .where(eq(schema.eventHosts.eventId, stray!.id));
    expect(strayHosts).toEqual([]);
    // The other two new events still went in.
    expect((await row('claude-for-everyone-bhopal'))!.date).toBe('2026-10-06');
    expect((await row('claude-community-workshop'))!.date).toBe('2026-10-10');
  });
});
