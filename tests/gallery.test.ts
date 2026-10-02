import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importRecords, repositoryRecords } from '../db/import';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import { RecordSelectors, isPublic } from '../src/data/selectors';
import { tsRecordSet } from '../src/data/source-ts';
import type { RecordSet } from '../src/data/source';
import type { CommunityEvent, EventPhoto } from '../src/data/types';
import { galleryRooms } from '../src/server/public/pages';

const record = tsRecordSet();

// Photos on every event and one event withdrawn, so order and exclusion are tested whatever photos are published.
const everyEventPhotographed: RecordSet = {
  ...record,
  events: record.events.map((event, i) => ({
    ...event,
    status: i === 0 ? 'pending' : event.status,
    photos: [1, 2].map((n) => ({
      src: `events/${event.slug}-${n}.jpg`,
      alt: `${event.title}, frame ${n}`,
    })),
  })),
};

const photo = ({ src, alt }: EventPhoto): EventPhoto => ({ src, alt });
const bySrc = (a: EventPhoto, b: EventPhoto) => a.src.localeCompare(b.src);

describe.each<[string, RecordSet]>([
  ['the record', record],
  ['a record with every event photographed', everyEventPhotographed],
])('the gallery, over %s', (_, rs) => {
  const rooms = new RecordSelectors(rs).photoRecordByEvent();

  it('lists every event photo exactly once, with its alt text', () => {
    const listed = rooms.flatMap((room) => room.plates.map(photo));
    const published = rs.events.filter(isPublic).flatMap((event) => event.photos ?? []);
    expect(listed.sort(bySrc)).toEqual(published.sort(bySrc));
    for (const { src, alt } of listed) expect(alt.trim(), src).not.toBe('');
  });

  it('groups the photos by event, newest event first', () => {
    for (const { event, plates } of rooms) {
      expect(plates.map(photo), event.slug).toEqual(event.photos);
    }
    const slugs = rooms.map(({ event }) => event.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    const dates = rooms.map(({ event }) => event.date);
    expect(dates).toEqual([...dates].sort().reverse());
  });
});

describe('the gallery the page renders, through the live loader', () => {
  let db: TestDatabase;

  // A photographed room the live loader's host filter drops (see loadLiveRecords): it must be left out.
  const unhosted: CommunityEvent = {
    ...repositoryRecords.events[0]!,
    id: 'evt-unhosted',
    slug: 'unhosted-room',
    title: 'A room nobody hosted',
    host: {},
    date: '2026-09-25',
    photos: [{ src: 'covers/cover-vol01.jpg', alt: 'A room with no Ambassador on the record' }],
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    await importRecords(db as never, {
      ...repositoryRecords,
      events: [...repositoryRecords.events, unhosted],
    });
  }, 180_000);

  afterAll(async () => {
    await db?.$close();
  });

  it('shows every photograph on the record, and none from a room the live filter leaves out', async () => {
    const ts = new RecordSelectors(record);
    const expected = ts.photoRecordByEvent().map(({ event, plates }) => ({
      slug: event.slug,
      city: ts.cityName(event.citySlug),
      plates: plates.map(({ src, alt, plate }) => ({ src, alt, plate })),
    }));

    const live = await galleryRooms(db as never);

    expect(
      live.map(({ event, city, plates }) => ({
        slug: event.slug,
        city,
        plates: plates.map(({ src, alt, plate }) => ({ src, alt, plate })),
      })),
    ).toEqual(expected);
    for (const plate of live.flatMap((room) => room.plates)) {
      expect(plate.image, plate.src).toBeTruthy();
    }
  });
});

describe('the /gallery/ page', () => {
  const page = readFileSync('src/pages/gallery.astro', 'utf8');

  it('renders that live gallery, with each photo’s alt text', () => {
    expect(page).toContain('await galleryRooms()');
    expect(page).toContain('alt={plate.alt}');
    // Resolved inside the guarded read, where a missing file is a 503 rather than a raw 500.
    expect(page).not.toContain('requireAsset');
  });

  it('answers a failed read with an uncached 503, as the homepage does', () => {
    expect(page).toContain("logReadFailure('gallery', error)");
    expect(page).toContain('Astro.response.status = 503');
    expect(page).toContain("Astro.response.headers.set('Retry-After', '30')");
    expect(page).toContain('privateCache(Astro)');
  });
});
