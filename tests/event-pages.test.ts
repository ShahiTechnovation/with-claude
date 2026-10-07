/**
 * THE EVENT PAGES.
 *
 * Split out of `directory-release-fixes.test.ts`; the assertions are unchanged.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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
