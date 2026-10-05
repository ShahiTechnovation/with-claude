import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import * as schema from '../db/schema';

/**
 * THE SITEMAP MAY NOT ADVERTISE A URL THE ROUTE WILL REFUSE.
 *
 * Production listed 26 `/events/<slug>/` URLs and served 9 of them as 404.
 * The two lists came from different readers: `sitemap.xml.ts` ran its own
 * `status = 'published'` select, while `/events/[slug]` resolves through
 * `loadLiveRecords()`, which narrows events further.
 *
 * So the assertion here is a RELATIONSHIP, not a count. Nothing below names a
 * number or a predicate: the sitemap's event set must equal the set of slugs
 * the event route can resolve, whatever that set happens to be. Remove the
 * narrowing and both sides grow together; add a new one and both sides shrink
 * together. A test that said "17" would pass today and lie by next week.
 *
 * The fixture deliberately contains published events the route cannot
 * resolve, which is what makes the equality a real check rather than a
 * tautology — the old implementation listed exactly those.
 */

let db: TestDatabase;
vi.mock('../db/pool', () => ({
  pooledDb: () => db,
}));

import { GET } from '../src/pages/sitemap.xml';
import { loadLiveRecords } from '../src/server/directory';
import { RecordSelectors } from '../src/data/selectors';

const CITY_ID = '00000000-0000-0000-0011-000000000001';
/** The host the live visibility rule is currently written around. */
const HOSTING_AMBASSADOR_ID = '00000000-0000-0000-0012-000000000001';
/** A second published ambassador, so "published" and "resolvable" can differ. */
const OTHER_AMBASSADOR_ID = '00000000-0000-0000-0012-000000000002';

/** The slugs `/events/[slug]` would render, read the way the route reads them. */
async function routeResolvableEventSlugs(): Promise<Set<string>> {
  const selectors = new RecordSelectors(await loadLiveRecords(db));
  return new Set(selectors.eventBySlug.keys());
}

/** The slugs the sitemap offers a crawler. */
function sitemapEventSlugs(xml: string): Set<string> {
  const slugs = new Set<string>();
  for (const match of xml.matchAll(
    /<loc>https:\/\/www\.withclaude\.in\/events\/([^/<]+)\/<\/loc>/g,
  )) {
    slugs.add(match[1]);
  }
  return slugs;
}

describe('the sitemap and the event route agree on which events exist', () => {
  beforeAll(async () => {
    db = await createTestDatabase();

    await db.insert(schema.cities).values({
      id: CITY_ID,
      slug: 'sitemap-city',
      name: 'Sitemap City',
      region: 'Test Region',
      lat: 0,
      lon: 0,
      blurb: 'Somewhere with events.',
      status: 'published',
    });

    await db.insert(schema.ambassadors).values([
      {
        id: HOSTING_AMBASSADOR_ID,
        slug: 'aniket-sahu',
        name: 'Aniket Sahu',
        cityId: CITY_ID,
        verifiedVia: 'Confirmed for the test',
        status: 'published',
      },
      {
        id: OTHER_AMBASSADOR_ID,
        slug: 'another-ambassador',
        name: 'Another Ambassador',
        cityId: CITY_ID,
        verifiedVia: 'Confirmed for the test',
        status: 'published',
      },
    ]);

    await db.insert(schema.events).values([
      {
        slug: 'event-the-route-renders',
        title: 'A room the site will show you',
        format: 'meetup',
        cityId: CITY_ID,
        ambassadorId: HOSTING_AMBASSADOR_ID,
        date: '2026-09-01',
        startTime: '18:00',
        venueName: 'Somewhere',
        summary: 'A room.',
        status: 'published',
      },
      // Published, and the route still will not render it. This row is the
      // whole point of the fixture: the old sitemap query listed it.
      {
        slug: 'event-the-route-declines',
        title: 'A room the site withholds',
        format: 'meetup',
        cityId: CITY_ID,
        ambassadorId: OTHER_AMBASSADOR_ID,
        date: '2026-09-02',
        startTime: '18:00',
        venueName: 'Somewhere else',
        summary: 'A room.',
        status: 'published',
      },
      // Not published at all — neither side should ever have offered it.
      {
        slug: 'event-still-a-draft',
        title: 'A room nobody has announced',
        format: 'meetup',
        cityId: CITY_ID,
        ambassadorId: HOSTING_AMBASSADOR_ID,
        date: '2026-09-03',
        startTime: '18:00',
        venueName: 'Somewhere',
        summary: 'A room.',
        status: 'draft',
      },
    ]);
  });

  afterAll(async () => {
    await db?.$close();
  });

  it('offers a crawler exactly the event pages the route resolves', async () => {
    const xml = await (await GET({} as any)).text();
    const advertised = sitemapEventSlugs(xml);
    const resolvable = await routeResolvableEventSlugs();

    // Non-vacuity: an empty sitemap would satisfy set equality and prove
    // nothing. The fixture has at least one event on both sides.
    expect(resolvable.size).toBeGreaterThan(0);
    expect([...advertised].sort()).toEqual([...resolvable].sort());
  });

  it('advertises no event URL that would answer 404', async () => {
    const xml = await (await GET({} as any)).text();
    const resolvable = await routeResolvableEventSlugs();

    const dead = [...sitemapEventSlugs(xml)].filter((slug) => !resolvable.has(slug));
    expect(dead).toEqual([]);
  });

  it('withholds no event page the route would happily render', async () => {
    const xml = await (await GET({} as any)).text();
    const advertised = sitemapEventSlugs(xml);

    const missing = [...(await routeResolvableEventSlugs())].filter(
      (slug) => !advertised.has(slug),
    );
    expect(missing).toEqual([]);
  });

  it('never offers an unpublished event, whichever reader is asked', async () => {
    const xml = await (await GET({} as any)).text();
    expect(xml).not.toContain('event-still-a-draft');
    expect([...(await routeResolvableEventSlugs())]).not.toContain('event-still-a-draft');
  });
});
