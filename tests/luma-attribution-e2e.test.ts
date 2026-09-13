/**
 * §60 — THE LIVE FEED, END TO END, INCLUDING WHO RAN THE EVENTS.
 *
 * `tests/event-ingestion.test.ts` already proves the feed parses, the India
 * filter holds and nothing duplicates. What it does not cover is the part added
 * for §16–§19: that a real organiser string from the real calendar reaches
 * `event_hosts` when — and only when — an admin has configured the mapping.
 *
 * So this runs the actual 317-event capture through `syncSource()` against a
 * real PostgreSQL, twice, with one ambassador configured and one not.
 *
 * ── THE MEASURED BASELINE ──────────────────────────────────────
 *
 * Against the capture, with every city it names seeded:
 *
 *     317  events in the feed         it is a GLOBAL calendar
 *      13  placed in India            the India filter's actual yield
 *       8  Indian cities
 *       0  attributed, before any mapping is configured
 *
 * The 13 are hosted by seven distinct organiser names, and three of them are
 * "Aniket Sahu" — the ambassador already on the curated record. So the feed
 * does carry an ambassador's real events, and it carries them under a display
 * name that means nothing to the system until somebody configures it.
 *
 * The test asserts the zero as firmly as it asserts the three-after-mapping.
 * §31: an unattributed event is a correct outcome, not a failure, and this is
 * what the correct outcome looks like on real data.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import * as schema from '../db/schema';
import { parseIcs } from '../src/server/events/ics';
import { normalizeLumaIcsEvent } from '../src/server/events/luma';
import { syncSource } from '../src/server/events/sync';
import type { EventSource, NormalizedEvent } from '../src/server/events/source';
import { attributionDrift, unresolvedOrganizers } from '../src/server/events/hosts';
import { registrationLink } from '../src/lib/attribution';

const SAMPLE = new URL('../luma-sample.ics', import.meta.url);

/** The capture, as `NormalizedEvent`s — exactly what the ICS source returns. */
function feedEvents(): NormalizedEvent[] {
  return parseIcs(readFileSync(SAMPLE, 'utf8'))
    .events.map(normalizeLumaIcsEvent)
    .filter((event): event is NormalizedEvent => Boolean(event));
}

/** A source that serves the capture, so nothing here touches the network. */
function captureSource(events: NormalizedEvent[]): EventSource {
  return {
    key: 'luma:claudecommunity',
    provider: 'luma',
    label: 'Claude Community Events',
    syncMode: 'ics',
    calendarId: 'cal-test',
    feedUrl: 'https://api.luma.com/ics/get?entity=calendar&id=cal-test',
    fetch: async () => ({ ok: true, events, complete: true }),
  };
}

let db: TestDatabase;
let bhopal: string;
let mumbai: string;

beforeAll(async () => {
  db = await createTestDatabase();

  /**
   * Every city the feed's Indian events resolve to. An event whose city has no
   * row cannot be promoted — `events.city_id` is NOT NULL — so a short seed
   * list would understate the India filter and make this test measure the
   * fixture instead of the feed.
   */
  const cities = await db
    .insert(schema.cities)
    .values([
      { slug: 'bhopal', name: 'Bhopal', region: 'Madhya Pradesh', lat: 23.2599, lon: 77.4126, blurb: 'x', status: 'published' },
      { slug: 'mumbai', name: 'Mumbai', region: 'Maharashtra', lat: 19.076, lon: 72.8777, blurb: 'x', status: 'published' },
      { slug: 'bengaluru', name: 'Bengaluru', region: 'Karnataka', lat: 12.9716, lon: 77.5946, blurb: 'x', status: 'published' },
      { slug: 'delhi', name: 'Delhi', region: 'Delhi', lat: 28.6139, lon: 77.209, blurb: 'x', status: 'published' },
      { slug: 'hyderabad', name: 'Hyderabad', region: 'Telangana', lat: 17.385, lon: 78.4867, blurb: 'x', status: 'published' },
      { slug: 'ahmedabad', name: 'Ahmedabad', region: 'Gujarat', lat: 23.0225, lon: 72.5714, blurb: 'x', status: 'published' },
      { slug: 'puducherry', name: 'Puducherry', region: 'Puducherry', lat: 11.9416, lon: 79.8083, blurb: 'x', status: 'published' },
    ])
    .returning({ id: schema.cities.id, slug: schema.cities.slug });
  bhopal = cities.find((c) => c.slug === 'bhopal')!.id;
  mumbai = cities.find((c) => c.slug === 'mumbai')!.id;
});

afterAll(async () => {
  await db.$close();
});

describe('the live capture, synced', () => {
  it('publishes only the Indian events, and leaves them unattributed', async () => {
    const summary = await syncSource(captureSource(feedEvents()), db);

    expect(summary.ok).toBe(true);
    expect(summary.seen).toBeGreaterThan(300);

    // The India filter is what makes this 13 rather than 317.
    const published = await db
      .select({ slug: schema.events.slug, title: schema.events.title })
      .from(schema.events)
      .where(eq(schema.events.status, 'published'));
    expect(published).toHaveLength(13);

    /**
     * THE HONEST NUMBER. All 13 name an organiser; none of those organisers is
     * configured against an ambassador yet, so not one event is attributed.
     * §31 — every one of them is published regardless.
     */
    expect(summary.hostsMatched).toBe(0);
    expect(summary.hostsUnresolved).toBe(13);

    const credits = await db.select().from(schema.eventHosts);
    expect(credits).toEqual([]);
    expect(await attributionDrift(db)).toEqual([]);
  });

  it('names the organisers it could not resolve, and only those', async () => {
    const unresolved = await unresolvedOrganizers(db as never);

    /**
     * Seven names, not the 134 the feed's other 304 events carry between them.
     * The queue is scoped to events that actually reached the site — see the
     * note on `unresolvedOrganizers`.
     */
    expect(unresolved.map((row) => row.organizer).sort()).toEqual([
      'Aniket Sahu',
      'Claude Community',
      'Hakkei Sekine',
      'Shubhangi Gupta',
      'Sumeet G Doshi',
      'Vikram Pawar',
      'Vivek Rp',
    ]);

    // Commonest first, so the mapping most worth configuring reads at the top.
    expect(unresolved[0]).toEqual({ organizer: 'Sumeet G Doshi', events: 4 });
    expect(unresolved.find((row) => row.organizer === 'Aniket Sahu')).toEqual({
      organizer: 'Aniket Sahu',
      events: 3,
    });
  });

  it('attributes on the next sync once an admin configures the mapping', async () => {
    /**
     * The whole mechanism, on real data. A moderator has seen "Aniket Sahu" in
     * the unresolved list, confirmed it is the Bhopal ambassador, and put the
     * string on that ambassador's record.
     *
     * Three events in the capture carry that organiser. All three are
     * attributed on the next sync, with nothing about the feed having changed.
     */
    await db.insert(schema.ambassadors).values({
      slug: 'aniket-sahu',
      name: 'Aniket Sahu',
      cityId: bhopal,
      verifiedVia: 'Configured in test',
      status: 'published',
      lumaDisplayName: 'Aniket Sahu',
    });

    const summary = await syncSource(captureSource(feedEvents()), db);
    expect(summary.hostsMatched).toBe(3);
    expect(summary.hostsUnresolved).toBe(10);

    const credits = await db.select().from(schema.eventHosts);
    expect(credits).toHaveLength(3);
    for (const credit of credits) {
      expect(credit).toMatchObject({
        role: 'primary_host',
        source: 'ingest',
        confidence: '1.00',
        sourceLabel: 'Aniket Sahu',
      });
    }

    // And the denormalised column moved with every one of them.
    expect(await attributionDrift(db)).toEqual([]);
  });

  it('does not attribute an ambassador whose mapping is not configured', async () => {
    /**
     * "Sumeet G Doshi" hosts four of the 13 and his name is now on the record
     * verbatim — and still matches nothing, because no mapping was configured.
     * §16: a name appearing in a feed is not evidence that the person on our
     * record is the person the feed means.
     */
    await db.insert(schema.ambassadors).values({
      slug: 'sumeet-doshi',
      name: 'Sumeet G Doshi',
      cityId: mumbai,
      verifiedVia: 'Configured in test',
      status: 'published',
    });

    const summary = await syncSource(captureSource(feedEvents()), db);

    /**
     * Nothing NEW matched, and the three from the previous test are counted as
     * kept rather than re-matched — they already have a host, so the sync did
     * not revisit them. Four events that name this person by their exact
     * recorded name remain unattributed.
     */
    expect(summary.hostsMatched).toBe(0);
    expect(summary.hostsKept).toBe(3);
    expect(await db.select().from(schema.eventHosts)).toHaveLength(3);
  });

  it('does not duplicate an event or a credit on a repeated sync', async () => {
    const before = await db.select({ id: schema.events.id }).from(schema.events);
    const creditsBefore = await db.select().from(schema.eventHosts);

    await syncSource(captureSource(feedEvents()), db);
    await syncSource(captureSource(feedEvents()), db);

    expect(await db.select({ id: schema.events.id }).from(schema.events)).toHaveLength(
      before.length,
    );
    expect(await db.select().from(schema.eventHosts)).toHaveLength(creditsBefore.length);
    expect(await attributionDrift(db)).toEqual([]);
  });

  it('does not overwrite a moderator correction on the next sync', async () => {
    // §37, against the real feed rather than a fixture.
    // A third person, so this test does not depend on either mapping above.
    const [other] = await db
      .insert(schema.ambassadors)
      .values({
        slug: 'vikram-pawar',
        name: 'Vikram Pawar',
        cityId: bhopal,
        verifiedVia: 'Configured in test',
        status: 'published',
      })
      .returning({ id: schema.ambassadors.id });

    const [event] = await db
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(eq(schema.events.status, 'published'))
      .limit(1);

    // A moderator reassigns the host.
    await db.delete(schema.eventHosts).where(eq(schema.eventHosts.eventId, event.id));
    await db.insert(schema.eventHosts).values({
      eventId: event.id,
      ambassadorId: other.id,
      role: 'primary_host',
      source: 'manual',
    });
    await db
      .update(schema.events)
      .set({ ambassadorId: other.id })
      .where(eq(schema.events.id, event.id));

    await syncSource(captureSource(feedEvents()), db);

    const [after] = await db
      .select()
      .from(schema.eventHosts)
      .where(eq(schema.eventHosts.eventId, event.id));
    expect(after).toMatchObject({ ambassadorId: other.id, source: 'manual' });
    expect(await attributionDrift(db)).toEqual([]);
  });

  it('carries the canonical UTM source on every registration link', async () => {
    const rows = await db
      .select({ registrationUrl: schema.events.registrationUrl })
      .from(schema.events)
      .where(eq(schema.events.status, 'published'));

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const link = registrationLink(row.registrationUrl);
      // Every ingested Indian event has a Luma page to register on.
      expect(link).toBeTruthy();
      expect(new URL(link!).searchParams.get('utm_source')).toBe('withclaude.in');
    }
  });

  it('records the sync against the source, honestly', async () => {
    const [source] = await db
      .select()
      .from(schema.eventSources)
      .where(eq(schema.eventSources.key, 'luma:claudecommunity'));

    expect(source.syncMode).toBe('ics');
    /**
     * `partial`, and that is the correct value. It means staged records were
     * held for review rather than published — which on a global calendar is
     * the permanent steady state, not an incident. `ok` here would mean the
     * India filter had made a confident call about all 317.
     */
    expect(source.lastSyncStatus).toBe('partial');
    expect(source.lastSyncedAt).toBeInstanceOf(Date);
    expect(source.lastSeenCount).toBeGreaterThan(300);
    expect(source.lastPromotedCount).toBe(13);
  });
});
