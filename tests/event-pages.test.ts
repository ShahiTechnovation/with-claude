/**
 * THE EVENT PAGES.
 *
 * Split out of `directory-release-fixes.test.ts` with its assertions unchanged; batch 006 added the
 * offer, host-line, missing-photo and photo-framing checks.
 */
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { tsRecordSet } from '../src/data/source-ts';

describe('the event pages', () => {
  it('an event page whose projects could not be read is never stored by the CDN', () => {
    const page = readFileSync('src/pages/events/[slug].astro', 'utf8').replace(/\r\n/g, '\n');
    expect(page).toMatch(
      /eventProjects\(event\.id, 12\)\.catch\([\s\S]{0,500}privateCache\(Astro, false\);\s*projectsFailed = true;/,
    );
  });

  it('the head and the homepage feature describe free entry the same way', () => {
    const page = readFileSync('src/pages/events/[slug].astro', 'utf8');
    const feature = readFileSync('src/components/EventFeature.astro', 'utf8');
    expect(feature).toContain("'free, with approval'");
    expect(page).toContain("event.free ? 'Free, with approval' : 'Ticketed'");
  });

  it('a room that is over drops the entry terms from its head and keeps only its venue', () => {
    const page = readFileSync('src/pages/events/[slug].astro', 'utf8');
    expect(page).toMatch(/const entry = isForthcoming\(event\)\s*\?/);
    expect(page).toMatch(/: venue\s*\?\s*`At \$\{venue\}\.`\s*:\s*'';/);
  });

  it('when the projects cannot be read, the page points to every project', () => {
    const page = readFileSync('src/pages/events/[slug].astro', 'utf8');
    expect(page).toContain('<a href="/projects/">See all projects</a>');
    expect(page).not.toContain('Try the Project Directory');
  });

  it('the joint after the projects cards is trimmed on both sides, so no empty band opens', () => {
    const page = readFileSync('src/pages/events/[slug].astro', 'utf8');
    expect(page).toMatch(
      /:global\(#projects:has\(\.pgrid\):has\(\+ #more\)\) \{\s*padding-bottom: calc\(var\(--section-y\) \* 0\.75\);/,
    );
    expect(page).toMatch(
      /:global\(#projects:has\(\.pgrid\) \+ #more\) \{\s*padding-top: calc\(var\(--section-y\) \* 0\.75\);/,
    );
  });

  /** Past, cancelled and registration-closed rooms declare no offer; a sold-out one is "SoldOut". */
  it('declares a ticket offer only while the room is ahead and taking registrations', () => {
    const page = readFileSync('src/pages/events/[slug].astro', 'utf8');
    expect(page).toMatch(
      /\.\.\.\(event\.registrationUrl && isForthcoming\(event\) && lifecycle !== 'registration-closed'\s*\?\s*\{\s*offers:/,
    );
    expect(page).toMatch(/lifecycle === 'sold-out'\s*\?\s*'https:\/\/schema\.org\/SoldOut'/);
  });

  it('names the host once: the "Hosted by" heading is not repeated in its sentence', () => {
    const page = readFileSync('src/pages/events/[slug].astro', 'utf8');
    expect(page).toContain('{[<a href={hostHref}>{ambassador.name}</a>, hostTail]}');
    expect(page).not.toContain("'Hosted by ',");
  });

  /** One photo row without its file (applied before the deploy, or a file since dropped) is not a 500. */
  it('leaves out a photo whose file is missing, and logs it, instead of failing the page', () => {
    const page = readFileSync('src/pages/events/[slug].astro', 'utf8');
    expect(page).not.toContain('requireAsset');
    expect(page).toMatch(/const photos = \(event\.photos \?\? \[\]\)\.flatMap\(\(photo\) => \{/);
    expect(page).toContain('const image = asset(photo.src);');
    expect(page).toContain(
      '`[event ${event.slug}] photo ${photo.src} is in the database but not in src/assets; left out`',
    );
    // The template renders that list, never the raw rows.
    const template = page.slice(page.indexOf('\n---\n', 3));
    expect(template).not.toContain('event.photos');
    expect(template).toContain('{photos.map((photo, i) => (');
    expect(template).toContain('src={photo.image}');
  });

  /**
   * In a 3:2 tile an upright photo (9:16 to 3:4) shows only the middle 37-50% of its height, and the
   * 2:1 wide tile less; centred, that cut heads off.
   */
  it('frames an upright photo high, and leaves landscape photos centred', async () => {
    const page = readFileSync('src/pages/events/[slug].astro', 'utf8');
    expect(page).toMatch(
      /const photoStyle = \(\{ width, height \}: ImageMetadata, src: string\) =>\s*height > width \? `object-position: \$\{framing\[src\] \?\? '50% 30%'\}` : undefined;/,
    );
    expect(page).toContain('style={photoStyle(photo.image, photo.src)}');
    // Every framing key is an upright photo on the record, or it would never apply. An empty map is fine.
    const start = page.indexOf('const framing');
    expect(start, 'the framing map moved').toBeGreaterThan(-1);
    const keys = [...page.slice(start, page.indexOf('};', start)).matchAll(/'([^']+)':/g)].map(
      (m) => m[1]!,
    );
    const onRecord = new Set(
      tsRecordSet()
        .events.flatMap((event) => event.photos ?? [])
        .map((photo) => photo.src),
    );
    for (const key of keys) {
      expect(onRecord.has(key), `${key} is not a photo on the record`).toBe(true);
      const { width = 0, height = 0 } = await sharp(`src/assets/${key}`).metadata();
      expect(height, key).toBeGreaterThan(width);
    }
  });

  it('/events/ loads its next-event plate eagerly: it is the largest paint there', () => {
    const page = readFileSync('src/pages/events/index.astro', 'utf8');
    expect(page).toMatch(/<EventFeature [^>]*\bpriority \/>/);
  });

  it('the event archive sorts by date, not by the order its caller passed', () => {
    const archive = readFileSync('src/components/EventArchive.astro', 'utf8');
    const sort = /function sortEvents[\s\S]*?\n}/.exec(archive)?.[0] ?? '';
    expect(sort).not.toContain('.reverse()');
    expect(sort).toContain('b.date.localeCompare(a.date)');
    expect(sort).toContain('a.date.localeCompare(b.date)');
  });

  it('an event row with no plate draws no empty tile and drops the plate column', () => {
    const record = readFileSync('src/components/EventRecord.astro', 'utf8');
    expect(record).not.toMatch(/<span class="erow-plate"/);
    expect(record).toContain("class:list={['erow', !row.plate && 'no-plate']}");
    expect(record).toMatch(/\.erow\.no-plate \{\s*grid-template-columns: minmax\(0, 1fr\) auto;/);
  });
});
