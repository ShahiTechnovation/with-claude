/**
 * THE HOMEPAGE AND THE ROUTES AROUND IT.
 *
 * `/` is the deployed composition (production at 83a8f41): the cover, then
 * eleven sections in a fixed order. A redesign once replaced it with a
 * five-section page and moved three of those sections to /about and
 * /community; this pins the restored shape so that cannot happen quietly.
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
  it('renders the deployed sections, in the deployed order', () => {
    const body = home.slice(home.indexOf('\n---', 3) + 4); // after the frontmatter
    expect(body.indexOf('<Hero ')).toBeGreaterThan(-1);
    const ids = [...body.matchAll(/<Section id="([a-z]+)"/g)]
      .map((m) => m[1])
      .filter((id) => id !== 'unavailable');
    expect(ids).toEqual([
      'signal',
      'search',
      'next',
      'atlas',
      'builders',
      'projects',
      'practice',
      'stories',
      'with',
      'join',
      'record',
    ]);
    expect(body.indexOf('<Hero ')).toBeLessThan(body.indexOf('<Section id="signal"'));
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
    for (const component of [
      'Hero',
      'CommunitySignal',
      'SearchPrompt',
      'NextEvent',
      'CityAtlas',
      'BuilderIndex',
      'ProjectArchive',
      'PracticeLibrary',
      'StoryStrip',
      'WithIndex',
      'Manifesto',
    ]) {
      expect(home, component).toMatch(new RegExp(`<${component}\\b[^>]*selectors=\\{selectors\\}`));
    }
    // The ghost atlas inside the cover reads the same records.
    expect(source('src/components/Hero.astro')).toContain(
      '<CityAtlas variant="ghost" selectors={selectors} />',
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

  it('keeps the cover actions pointed where production points them', () => {
    const hero = source('src/components/Hero.astro');
    expect(hero).toMatch(/<a href="\/cities" class="btn btn-solid"/);
    expect(hero).toMatch(/<a href="\/events" class="btn"/);
    expect(hero).toMatch(/<a href="\/submit\/" class="link-arrow">/);
  });

  it('names the event a previewed project was built at, from public events only', () => {
    const archive = source('src/components/ProjectArchive.astro');
    expect(archive).toContain('data.eventBySlug.get(project.builtAtEventSlug)');
    expect(archive).toContain('Built at ${entry.event.shortTitle ?? entry.event.title}');
  });
});

describe('sections that belong to the homepage stay there', () => {
  it.each([
    ['src/pages/about.astro', ['WithIndex', 'Manifesto']],
    ['src/pages/community.astro', ['CommunitySignal']],
  ] as const)('%s does not carry a copy of the homepage', (file, components) => {
    const page = source(file);
    for (const component of components) expect(page, component).not.toContain(`<${component}`);
  });
});

describe('the project directory at /projects/', () => {
  const index = source('src/pages/projects/index.astro');
  const detail = source('src/pages/projects/[slug].astro');

  it('is its own server-rendered page, never a redirect', () => {
    expect(index).toContain('export const prerender = false;');
    expect(index).not.toMatch(/Astro\.redirect\(/);
    expect(index).toContain('projectArchive(Astro.url.searchParams)');
  });

  it('answers a missing or hidden project with a real 404, not a redirect', () => {
    expect(detail).not.toMatch(/Astro\.redirect\(/);
    expect(detail).toMatch(/Astro\.rewrite\('\/not-found\/'\)|Astro\.response\.status = 404/);
  });

  /** Directory styles load on the routes that use them, never site-wide. */
  it('keeps directory.css off the shared layout and the homepage', () => {
    expect(source('src/layouts/Base.astro')).not.toContain('directory.css');
    const css = source('src/styles/directory.css').replace(/\/\*[\s\S]*?\*\//g, '');
    // No bare element or shared-primitive selector, at the top level or inside a media query.
    const selectors = [...css.matchAll(/(?:^|[{}])\s*([^{}@;]+?)\s*\{/g)].flatMap((m) =>
      m[1]!.split(',').map((s) => s.trim()),
    );
    expect(selectors.length).toBeGreaterThan(50);
    for (const selector of selectors) {
      expect(selector, selector).not.toMatch(
        /^(html|body|main|header|footer|section|a|h[1-6]|p|ul|ol|button|input)\b/,
      );
      expect(selector, selector).not.toMatch(
        /^\.(btn|section|section-head|container|container-wide|eyebrow|prose|plate|label|link-arrow)\b/,
      );
    }
  });
});

describe('the masthead', () => {
  const masthead = source('src/components/Masthead.astro');

  it('links the logo home and Projects to the directory', () => {
    // `/` everywhere except projects.withclaude.in, where `/` is the directory.
    expect(masthead).toContain('const home = homeHref(Astro.url.hostname);');
    expect(masthead).toMatch(/<a href=\{home\} class="brand"/);
    expect(masthead).toContain("{ href: '/projects', label: 'Projects' }");
  });

  /**
   * Two scripts bound the same menu button (this one and `enhance.ts`), so
   * each tap opened the drawer and shut it again: on a phone the menu never
   * opened, in production included.
   */
  it('binds the phone menu button exactly once', () => {
    const scripts = [
      'src/scripts/enhance.ts',
      'src/components/Masthead.astro',
      'src/layouts/Base.astro',
    ];
    const binders = scripts.filter((file) =>
      /querySelector[^(]*\(\s*['"]\[data-nav-toggle\]['"]\s*\)/.test(source(file)),
    );
    expect(binders).toEqual(['src/components/Masthead.astro']);
  });

  /**
   * `#privy-root` sits inside the masthead's flex row. As a block it took a
   * flex gap of its own and pushed the account control ~20px off the column
   * edge on every page; the island it replaced was `display: contents`.
   */
  it('keeps the Privy mount point out of the masthead layout', () => {
    expect(source('src/components/AccountNav.astro')).toMatch(
      /#privy-root\s*\{\s*display:\s*contents;/,
    );
  });
});

describe('the narrow-phone rules actually apply', () => {
  /**
   * A media-query override placed BEFORE the base rule it overrides loses at
   * equal specificity, so the 375px fix for the WITH index never took effect
   * and the page scrolled sideways.
   */
  it('places the WITH index phone override after its base rule', () => {
    const css = source('src/components/WithIndex.astro');
    const base = css.indexOf('  .with-link {\n    display: grid;');
    const phone = css.indexOf('@media (max-width: 29.99em) {\n    .with-link {');
    expect(base).toBeGreaterThan(-1);
    expect(phone).toBeGreaterThan(base);
  });
});

describe('signing in returns to the page that asked', () => {
  /**
   * The project page sends a signed-out visitor to `/me/projects/claim/?project=…`.
   * The gate's return address was the bare pathname, so after signing in the
   * claim page no longer knew which project it was for.
   */
  it('keeps the claim page query through sign-in', () => {
    expect(source('src/pages/projects/[slug].astro')).toContain(
      '/me/projects/claim/?project=${project.slug}',
    );
    expect(source('src/pages/me/projects/claim.astro')).toContain(
      '<AuthRequired reason={guard.reason} next={Astro.url.pathname + Astro.url.search} />',
    );
  });

  it('defaults every other gate to the server pathname, never a client-supplied URL', () => {
    expect(source('src/components/AuthRequired.astro')).toContain(
      'next = Astro.url.pathname } = Astro.props',
    );
  });
});

describe('deployment routing', () => {
  it('has no rewrites or redirects that could capture a public route', () => {
    const vercel = JSON.parse(source('vercel.json')) as Record<string, unknown>;
    expect(vercel.trailingSlash).toBe(true);
    // The only redirect allowed is scoped to the Project Directory's own host
    // (projects.withclaude.in → www for non-directory paths). Nothing may
    // apply to www.withclaude.in or the apex, and there are no rewrites.
    const redirects = (vercel.redirects ?? []) as { has?: { type: string; value: string }[] }[];
    for (const r of redirects) {
      expect(r.has).toEqual([{ type: 'host', value: 'projects.withclaude.in' }]);
    }
    expect(redirects.length).toBeLessThanOrEqual(1);
    expect(vercel.rewrites).toBeUndefined();
    expect(vercel.routes).toBeUndefined();
    expect(source('astro.config.mjs')).not.toMatch(/\bredirects\s*:/);
  });

  it('keeps the legacy paths as their documented redirects, none to the homepage directory', () => {
    expect(source('src/pages/submit.astro')).toContain("Astro.redirect('/me/projects/new/', 308)");
    expect(source('src/pages/city.astro')).toContain("Astro.redirect('/me/profile/edit/', 308)");
    expect(source('src/pages/join.astro')).toContain("Astro.redirect('/', 308)");
  });
});
