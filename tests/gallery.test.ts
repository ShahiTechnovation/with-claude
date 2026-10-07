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

  it('heads each event with its name, date and place, and shows photos without captions', () => {
    expect(page).toContain('<h2 class="t-h3 room-title"');
    expect(page).toContain('formatDateCompact(event.date)');
    expect(page).toContain('href={`/events/${event.slug}/`}');
    // The alt text stays on the image for screen readers; nothing is printed under it.
    expect(page).toContain('alt={plate.alt}');
    expect(page).not.toContain('<figcaption');
    // Only the first photo of the first event loads eagerly.
    expect(page).toContain("loading={r === 0 && i === 0 ? 'eager' : 'lazy'}");
  });

  it('never leaves a hole or a part-empty row, and never fills a screen with one photo', () => {
    // The frontmatter packs each room as the dense grid does and widens a photo to close a gap.
    expect(page).toContain('grid-auto-flow: dense;');
    expect(page).toContain('if (fills(base, cols)) return base;');
    // One photo fills the row; two share two equal columns.
    expect(page).toContain('.room-plates > :only-child {');
    expect(page).toContain('.room-plates:has(> li:nth-child(2):last-child) {');
    // A photo widened across the room is a wide banner, not a 3:2 frame the width of the screen.
    expect(page).toMatch(/\.w3-3:not\(\.is-lead\) \.frame \{\s*aspect-ratio: 21 \/ 9;/);
    expect(page).toMatch(/\.w2-2:not\(\.is-lead\) \.frame \{\s*aspect-ratio: 21 \/ 9;/);
    // Sizes follow the spans, so a half-width photo never downloads the full-width file.
    expect(page).toContain("w3 === 3 ? '100vw' : w3 === 2 ? '860px' : '420px'");
  });

  it('gives a portrait a tall tile instead of bars at its sides', () => {
    expect(page).toContain('p.image.height > p.image.width');
    expect(page).toMatch(/\.is-tall \.frame \{\s*aspect-ratio: 3 \/ 4;/);
    expect(page).not.toContain('object-fit: contain');
    // A portrait forced wide takes the banner ratio, not a 3:2 frame.
    expect(page).toContain('.is-tall:not(.h2-2, .w2-2) .frame {');
    expect(page).toContain('.is-tall:not(.h3-2, .w3-2, .w3-3) .frame {');
  });
});

// The page's own packer, lifted out of the frontmatter and run over every portrait pattern.
describe('the gallery grid packer', async () => {
  const ts = await import('typescript');
  const page = readFileSync('src/pages/gallery.astro', 'utf8');
  const code = page.slice(page.indexOf('type Span'), page.indexOf('const layout ='));
  const js = ts.transpileModule(`${code}\nexport { fills, pack };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  type Span = [number, number];
  const { fills, pack } = (await import(`data:text/javascript,${encodeURIComponent(js)}`)) as {
    fills: (spans: Span[], cols: number) => boolean;
    pack: (tall: boolean[], cols: number) => Span[];
  };

  it('closes every room of 3 to 9 photos at two and three columns', () => {
    for (let n = 3; n <= 9; n++) {
      for (let m = 0; m < 1 << n; m += 2) {
        const tall = Array.from({ length: n }, (_, i) => Boolean((m >> i) & 1));
        for (const cols of [2, 3]) {
          const spans = pack(tall, cols);
          expect(fills(spans, cols), `${n} ${m} ${cols}`).toBe(true);
          // A portrait never widens, unless every photo after the lead is one.
          if (!tall.slice(1).every(Boolean))
            tall.forEach((t, i) => t && expect(spans[i][0], `${n} ${m} ${cols} ${i}`).toBe(1));
        }
      }
    }
  });

  it('keeps a lone portrait tall and widens a landscape photo beside it', () => {
    expect(pack([false, false, true, false], 3)).toEqual([
      [2, 2],
      [1, 1],
      [1, 2],
      [2, 1],
    ]);
    expect(pack([false, false, true, false], 2)).toEqual([
      [2, 1],
      [1, 1],
      [1, 2],
      [1, 1],
    ]);
    // A seventh photo alone after the lead block becomes the full-width banner.
    expect(pack(Array(7).fill(false), 3).at(-1)).toEqual([3, 1]);
  });
});
