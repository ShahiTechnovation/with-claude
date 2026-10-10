/**
 * THE HOMEPAGE AND THE ROUTES AROUND IT.
 *
 * `/` is the hero with the room band, then five sections in a fixed order:
 * the next event, the cities, what was made, the photographs and the join
 * band (the Cinematic dark build, plan section 3). This pins that shape, and
 * that the homepage's own sections are not copied onto /about/ or /community/.
 *
 * Source-level, like `account-routing.test.ts`: the guarantees are about which
 * file renders which route, what it links to and where its data comes from,
 * and those are properties of the source. Runtime status codes are checked by
 * `scripts/dev/route-audit.mjs` against a loopback server.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// LF regardless of how the checkout was made (core.autocrlf on Windows).
const source = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const home = source('src/pages/index.astro');

describe('the homepage at /', () => {
  it('renders the hero, then the five sections in order', () => {
    const body = home.slice(home.indexOf('\n---', 3) + 4); // after the frontmatter
    expect(body.indexOf('<Hero ')).toBeGreaterThan(-1);
    const ids = [...body.matchAll(/<Section id="([a-z]+)"/g)]
      .map((m) => m[1])
      .filter((id) => id !== 'unavailable');
    expect(ids).toEqual(['next', 'cities', 'projects', 'photos', 'join']);
    expect(body.indexOf('<Hero ')).toBeLessThan(body.indexOf('<Section id="next"'));
  });

  it('serves the page itself — no redirect, no rewrite, not the directory', () => {
    expect(home).not.toMatch(/Astro\.(redirect|rewrite)\(/);
    expect(home).not.toContain('directory.css');
    expect(home).not.toContain('components/directory/');
    expect(home).not.toContain('ProjectRow');
  });

  /**
   * Prerendered, the homepage showed the build-time snapshot: a takedown stayed
   * up until the nightly rebuild. Every record-reading section must take the
   * request-local selectors, or it silently falls back to that snapshot.
   */
  it('feeds every record-reading section the request-local live selectors', () => {
    expect(home).toContain('export const prerender = false;');
    expect(home).toContain('new RecordSelectors(await loadLiveRecords())');
    expect(home).toContain('publicCache(Astro)');
    for (const component of ['Hero', 'EventFeature', 'CitiesBand', 'MadeWith', 'PhotoStrip']) {
      expect(home, component).toMatch(new RegExp(`<${component}\\b[^>]*selectors=\\{selectors\\}`));
    }
    // The old sections are gone, not just unfed.
    expect(home).not.toMatch(
      /<(WithIndex|Manifesto|CommunitySignal|SearchPrompt|NextEvent|LatestEventProjects)\b/,
    );
  });

  it('puts the compact map in the cities band, and none in the hero', () => {
    expect(source('src/components/home/CitiesBand.astro')).toContain(
      '<CityAtlas size="compact" selectors={selectors} />',
    );
    expect(source('src/components/Hero.astro')).not.toContain('CityAtlas');
  });

  it('says "has" when one city has held an event, like the map label', () => {
    const band = source('src/components/home/CitiesBand.astro');
    expect(band).toContain("{held.length === 1 ? 'has' : 'have'} held events so far.");
    expect(band).not.toMatch(/\{held\} have held/);
  });

  it('lets the room band zoom on scroll and leaves it out of print', () => {
    const hero = source('src/components/Hero.astro');
    const room = hero.slice(hero.indexOf('  .room {'));
    // overflow: hidden makes the figure a scroll container, so the img's view() never moves.
    expect(room.slice(0, room.indexOf('}'))).toContain('overflow: clip;');
    expect(hero).toMatch(/@media print \{\s*\.room \{\s*display: none;/);
  });

  it('puts ambassadors first among the three builders on the homepage', () => {
    expect(source('src/components/home/MadeWith.astro')).toMatch(
      /\.sort\(\(a, b\) => Number\(b\.ambassador\) - Number\(a\.ambassador\)\)\s*\.slice\(0, 3\)/,
    );
  });

  it('runs the scroll stage only over a photo, and lets the faded copy pass clicks through', () => {
    const hero = source('src/components/Hero.astro');
    expect(hero).toContain("class:list={['hero', room && roomImage && 'has-room']}");
    expect(hero).toContain(':global(.js) .hero.has-room {');
    expect(hero).not.toMatch(/:global\(\.js\) \.hero \{/);
    // The click-through flip lives in its own keyframes on the same scroll timeline as the lift.
    expect(hero).toMatch(/@keyframes lift-hit \{\s*to \{[^}]*pointer-events: none;/);
    expect(hero).toMatch(
      /\.hero-copy \{[^}]*animation:[^;]*lift-hit linear both[^}]*animation-timeline: --hero;/,
    );
  });

  it('answers a failed read with an uncached 503, not stale or empty sections', () => {
    expect(home).toContain("logReadFailure('home', error)");
    expect(home).toContain('Astro.response.status = 503');
    expect(home).toContain('privateCache(Astro)');
  });

  it('never names a venue that is shared only with registrants', () => {
    expect(home).toContain(
      'event.venue.private ? selectors!.cityName(event.citySlug) : event.venue.name',
    );
  });

  it('keeps the hero copy to one h1, one sentence and one link', () => {
    const hero = source('src/components/Hero.astro');
    const copy = hero.slice(hero.indexOf('class="container hero-copy"'));
    const block = copy.slice(0, copy.indexOf('</div>'));
    expect(block.match(/<h1\b/g)).toHaveLength(1);
    expect(block.match(/<p\b/g)).toHaveLength(1);
    expect(block.match(/<a\b/g)).toHaveLength(1);
    expect(block).toContain('<h1 id="hero-title" class="t-poster">');
    expect(hero).toContain("{ href: '#next', label: 'Join the next event' }");
    expect(hero).toContain("{ href: '/events/', label: 'See past events' }");
  });
});

describe('sections that belong to the homepage stay there', () => {
  it.each([
    ['src/pages/about.astro', ['EventFeature']],
    ['src/pages/community.astro', ['EventFeature']],
  ] as const)('%s does not carry a copy of the homepage', (file, components) => {
    const page = source(file);
    for (const component of components) expect(page, component).not.toContain(`<${component}`);
  });
});
