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
