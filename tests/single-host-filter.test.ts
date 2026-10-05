/**
 * THE SINGLE-HOST EVENT FILTER — the reminder Vishal asked for.
 *
 * `loadLiveRecords()` narrows every event the public site reads to the ones
 * `aniket-sahu` hosts, and drops the rest with no error and no log. Vishal's
 * decision on 5 October 2026 was "leave it, remind me when it starts hiding
 * something". A reminder somebody has to remember is not a reminder, so it is
 * this file.
 *
 * The reminder is `keeps every event in the curated record`. All 17 events in
 * `src/data/events.ts` are hosted by `aniket-sahu` today, so it is green; it
 * goes red the first time somebody adds an event to the record hosted by
 * anybody else, which is the moment the filter starts hiding curated work.
 *
 * ── WHAT THIS FILE CANNOT SEE ────────────────────────────────────────────
 *
 * Production holds 9 published events the filter is hiding RIGHT NOW. They
 * are not a regression and they are not in the list below by accident: all 9
 * are absent from `src/data/events.ts` entirely, so something other than the
 * committed record wrote them, and they carry zero `event_hosts` rows, which
 * is why the filter drops them.
 *
 * No test in this repo can observe those rows — they exist only in Neon. The
 * set is pinned here as documentation of the known-hidden baseline, so that
 * whoever next counts hidden events in production knows which ones were
 * already accounted for on 5 October 2026 and which are new.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import * as schema from '../db/schema';
import { hostedByAniketSahu, loadLiveRecords } from '../src/server/directory';
import { events as recordEvents } from '../src/data/events';

/**
 * The 9 events production hides, read read-only from Neon on 5 October 2026.
 * Every one is `status = 'published'` with no `event_hosts` row and no entry
 * in `src/data/events.ts`. Not asserted against — see the file header.
 */
const KNOWN_HIDDEN_IN_PRODUCTION = [
  'claude-code-meetup-mumbai',
  'claude-code-meetup-bengaluru',
  'claude-code-new-delhi-init-meetup',
  'hyderabad-claude-code-workshop-for-everyone',
  'bangalore-cccl-blr1-claude-for-everyone',
  'ahmedabad-claude-code-for-everyone',
  'mumbai-claude-fable-5-1-build-day',
  'bangalore-claude-fable-build-day',
  'mumbai-claude-conversation',
] as const;

describe('the single-host event filter', () => {
  it('keeps every event in the curated record', () => {
    const hidden = recordEvents.filter((event) => !hostedByAniketSahu(event));

    // The message matters more than the assertion: whoever trips this is
    // about to lose an event from the public site and needs to know why.
    expect(
      hidden.map((event) => event.slug),
      'These curated events are no longer hosted by aniket-sahu, so the ' +
        'single-host filter in loadLiveRecords() will hide them from ' +
        '/events/, /gallery and every city page. This is the reminder ' +
        'Vishal asked for: either credit aniket-sahu on them or widen the ' +
        'filter. Do not delete this test to go green.',
    ).toEqual([]);

    // Guards the guard: an empty record would also produce zero hidden
    // events and pass vacuously.
    expect(recordEvents.length).toBeGreaterThanOrEqual(17);
  });

  describe('the three attributions it accepts', () => {
    const base = { slug: 'x', title: 'x', format: 'meetup', citySlug: 'bhopal' };

    it('keeps an event aniket-sahu headlines', () => {
      expect(
        hostedByAniketSahu({ ...base, host: { ambassadorSlug: 'aniket-sahu' } } as never),
      ).toBe(true);
    });

    it('keeps an event aniket-sahu co-hosts as a builder', () => {
      expect(
        hostedByAniketSahu({
          ...base,
          host: { ambassadorSlug: 'priya-nair', builderSlugs: ['aniket-sahu'] },
        } as never),
      ).toBe(true);
    });

    it('keeps an event aniket-sahu is credited on', () => {
      expect(
        hostedByAniketSahu({
          ...base,
          host: {
            ambassadorSlug: 'priya-nair',
            credits: [{ ambassadorSlug: 'aniket-sahu', role: 'host', source: 'curated', confidence: 1 }],
          },
        } as never),
      ).toBe(true);
    });

    it('drops an event hosted by somebody else', () => {
      expect(
        hostedByAniketSahu({ ...base, host: { ambassadorSlug: 'priya-nair' } } as never),
      ).toBe(false);
    });

    it('drops an event with no host at all', () => {
      expect(hostedByAniketSahu({ ...base } as never)).toBe(false);
      expect(hostedByAniketSahu({ ...base, host: {} } as never)).toBe(false);
    });
  });

  /**
   * The predicate tests above would still pass if somebody unwired the filter
   * from `loadLiveRecords`. This one reads through the real function against a
   * real PostgreSQL, which is the shape production's 9 hidden rows take: a
   * published event with no host row.
   */
  describe('read through loadLiveRecords', () => {
    let db: TestDatabase;

    beforeAll(async () => {
      db = await createTestDatabase();

      const [{ id: cityId }] = await db
        .insert(schema.cities)
        .values({
          slug: 'bhopal',
          name: 'Bhopal',
          region: 'Madhya Pradesh',
          lat: 23.25,
          lon: 77.4,
          blurb: 'x',
          status: 'published',
        })
        .returning({ id: schema.cities.id });

      const [{ id: aniket }] = await db
        .insert(schema.ambassadors)
        .values({
          slug: 'aniket-sahu',
          name: 'Aniket Sahu',
          cityId,
          verifiedVia: 'test',
          status: 'published',
          lumaDisplayName: 'Aniket Sahu',
        })
        .returning({ id: schema.ambassadors.id });

      const event = (slug: string, ambassadorId: string | null) => ({
        slug,
        title: slug,
        format: 'meetup' as const,
        cityId,
        date: '2026-03-01',
        startTime: '10:00:00',
        venueName: 'Somewhere',
        summary: 'x',
        status: 'published' as const,
        ...(ambassadorId ? { ambassadorId } : {}),
      });

      await db.insert(schema.events).values([
        event('hosted-by-aniket', aniket),
        event('hosted-by-nobody', null),
      ]);
    });

    afterAll(async () => {
      await db?.$close();
    });

    it('serves the hosted event and silently withholds the host-less one', async () => {
      const rs = await loadLiveRecords(db as never);

      expect(rs.events.map((e) => e.slug)).toEqual(['hosted-by-aniket']);
    });

    it('withholds it from the record set rather than marking it', async () => {
      // The drop is total: nothing downstream can tell that an event was
      // withheld, which is the property that made this filter invisible.
      const rs = await loadLiveRecords(db as never);

      expect(rs.events.find((e) => e.slug === 'hosted-by-nobody')).toBeUndefined();
      expect(KNOWN_HIDDEN_IN_PRODUCTION).toHaveLength(9);
    });
  });
});
