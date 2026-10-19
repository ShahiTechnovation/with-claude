/**
 * THE CITY PAGES: the projects a city page shows.
 *
 * "Made in {city}" groups the city's public projects by the event they were built at. A group is
 * only ever named after a public event, so a card list never names a hidden one; the rest close the
 * list as independent projects.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// LF regardless of how the checkout was made (core.autocrlf on Windows).
const source = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const page = source('src/pages/cities/[slug].astro');

describe('the projects on a city page', () => {
  it('takes the city’s projects from the selectors and renders them as cards', () => {
    expect(page).toContain('selectors.projectsInCity(city.slug)');
    expect(page).toContain('cardProps(p)');
    expect(page).toContain("import ProjectGroup from '@/components/ProjectGroup.astro'");
    expect(page).not.toContain('ProjectArchive');
    expect(existsSync('src/components/ProjectArchive.astro')).toBe(false);
  });

  it('names a group only after a public event, newest first, independent projects last', () => {
    // The key is kept only when the slug resolves among public events.
    expect(page).toContain('selectors.eventBySlug.has(p.builtAtEventSlug)');
    expect(page).toContain('event: eventSlug ? selectors.eventBySlug.get(eventSlug) : undefined');
    expect(page).toContain(
      '!a.event ? 1 : !b.event ? -1 : b.event.date.localeCompare(a.event.date)',
    );
    expect(page).toContain('title={eventLabel(event.title, event.shortTitle ?? null, city.name)}');
    expect(page).toContain('plate={eventPlate(event)}');
    expect(page).toContain('id="g-independent"');
  });

  it('nests the groups under the "Made in" heading, cards one level below', () => {
    expect(page).toMatch(/<h2 id="projects-heading">Made in \{city\.name\}<\/h2>/);
    expect(page.match(/level="h3"/g)?.length).toBe(2);
  });
});

describe('the status band of a live city', () => {
  // A live city's h2 is visually hidden, so on a wide screen the band's own columns hold the photo
  // and the side wrapper, which filled column 1 and left column 2 empty (F003). Dissolving the
  // wrapper makes the photo the first item and Local channels the second.
  const wide = page.slice(page.indexOf('@media (min-width: 62em)'));

  it('puts the photo and Local channels in a column each from 62em', () => {
    expect(wide).toMatch(
      /\.status:has\(> \.visually-hidden\) > \.status-side \{\s*display: contents;\s*\}/,
    );
    // The rule's two hooks: a live city's hidden h2 is a direct child of `.status`, and the side
    // wrapper holds the photo. A quiet city's h2 is its visible title, so the rule never matches it.
    expect(page).toMatch(/live \? \(\s*<h2 id="status-heading" class="visually-hidden">/);
    expect(page).toContain('<div class="status-side">');
    expect(page).toMatch(/<h2 id="status-heading" class="status-title">/);
  });

  // Round 1 measured a 71px channels block at the top of column 2 beside a 534px photo (1440): a
  // 526 x 463 blank under it. These two rules shrink it; each hangs off the same hidden-h2 hook,
  // so a quiet city, whose h2 is visible, never matches them.
  it('sets the channels on the photo’s bottom edge, from 62em', () => {
    expect(wide).toMatch(/\.status:has\(> \.visually-hidden\) \{[^}]*align-items: end;[^}]*\}/);
  });

  it('crops the photo to a capped 16:9, framed on the statue, from 62em', () => {
    const photo =
      wide.match(/\.status:has\(> \.visually-hidden\) \.status-image img \{([^}]*)\}/)?.[1] ?? '';
    expect(photo, 'a rule for the live photo inside the 62em block').not.toBe('');
    expect(photo).toMatch(/aspect-ratio: 16 \/ 9;/);
    // Without the cap the photo keeps growing with the column, and so does the blank above the channels.
    expect(photo).toMatch(/max-height: \d+(\.\d+)?rem;/);
    // The source is a portrait; a centred crop cuts the statue's crown.
    expect(photo).toMatch(/object-position: 50% 28%;/);
  });
});
