import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RecordSelectors, isPublic } from '../src/data/selectors';
import { tsRecordSet } from '../src/data/source-ts';
import type { RecordSet } from '../src/data/source';
import type { EventPhoto } from '../src/data/types';

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
