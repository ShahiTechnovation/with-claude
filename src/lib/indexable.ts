/**
 * What deserves its own place in search results.
 *
 * Being navigable and being indexable are different questions, and conflating
 * them is how a community site turns into a farm of thin programmatic landing
 * pages. Every city on the atlas gets a real page — a visitor who clicks a dot
 * should always land somewhere honest. Only a city with something actually in
 * it gets to be a search result.
 *
 * ── Who reads it ───────────────────────────────────────────────────────
 *
 * `src/pages/cities/[slug].astro` decides its `noindex` with
 * `isCityIndexable()`, passing the live record it already loaded. The sitemap
 * (`src/pages/sitemap.xml.ts`) does not import this module: it applies the
 * same five signals in SQL, so a change to the rule has to land in both.
 *
 * `nonIndexablePaths()` and `indexableCityPaths()` read `records()` from
 * `../data/dataset`, the build-time record every static page renders from.
 * Nothing in the build calls them; the equivalence suites compare them across
 * both data sources.
 */

import { records } from '../data/dataset';
import type { City, ModerationStatus } from '../data/types';
import type { RecordSet } from '../data/source';

const isPublic = (record: { status: ModerationStatus }): boolean =>
  record.status === 'published' || record.status === 'featured';

/**
 * True when a city page carries enough of the record to be worth finding
 * from a search engine rather than only from this site.
 *
 * One real record of any kind flips it — an event, a person, a project, a
 * story, or a verified Ambassador. That is a deliberately low bar: the point
 * is to exclude pages that say "nothing has happened here", not to gate
 * cities on volume.
 */
export function isCityIndexable(city: City, set: RecordSet = records()): boolean {
  if (!isPublic(city)) return false;

  // A server-rendered city page passes the live record it already loaded, so
  // "indexable" is decided by the same data the page shows — not by the
  // build-time snapshot. The sitemap applies the same five signals in SQL.
  const { ambassadors, builders, events, projects, stories } = set;

  return (
    ambassadors.filter(isPublic).some((a) => a.citySlug === city.slug) ||
    events.filter(isPublic).some((e) => e.citySlug === city.slug) ||
    builders.filter(isPublic).some((b) => b.citySlug === city.slug) ||
    projects.filter(isPublic).some((p) => p.citySlug === city.slug) ||
    stories.filter(isPublic).some((s) => s.citySlug === city.slug)
  );
}

/**
 * Route prefixes that are private by their nature, not by their content.
 *
 * ── THE BUG THIS FIXES ───────────────────────────────────────────────────
 *
 * Phase A added six account pages under `/me/`. Each one sets `noindex` and
 * `Cache-Control: private, no-store` — and every one of them was still being
 * listed in `sitemap-0.xml`, because the only exclusion rule this module had
 * was about cities. So the site was simultaneously telling crawlers "do not
 * index this" on the page and "here, index this" in the sitemap.
 *
 * A sitemap that advertises pages marked `noindex` is a crawl-budget bill
 * with no page behind it, so the two have to agree. §46 and §47 say so.
 *
 * ── WHY A PREFIX AND NOT A LIST ──────────────────────────────────────────
 *
 * Because the six paths were not forgotten out of carelessness — they were
 * forgotten because nothing connected adding an account page to updating a
 * sitemap rule. A list of six would be forgotten again by the seventh page.
 * A prefix covers `/me/anything` the moment it exists.
 *
 * This is deliberately NOT folded into `nonIndexablePaths()`. That function
 * answers a question about the RECORD — which cities have enough in them to be
 * worth finding — and the equivalence suite asserts it is identical across
 * both data sources and empty for an empty dataset. Privacy is structural and
 * has nothing to do with the record, so it gets its own predicate.
 */
export const PRIVATE_PATH_PREFIXES = ['/me/', '/api/'] as const;

/**
 * True when a path must never appear in the sitemap, whatever is in it.
 *
 * Takes the path with its trailing slash, the form every route has under
 * `trailingSlash: 'always'`. Nothing in the build calls this today:
 * `src/pages/sitemap.xml.ts` builds its list by hand, and `tests/record.test.ts`
 * pins the prefixes.
 */
export function isPrivatePath(path: string): boolean {
  const normalised = path.endsWith('/') ? path : `${path}/`;
  return PRIVATE_PATH_PREFIXES.some((prefix) => normalised.startsWith(prefix));
}

/** Root-relative paths the sitemap must leave out. */
export function nonIndexablePaths(): string[] {
  return records()
    .cities.filter((city) => !isCityIndexable(city))
    .map((city) => `/cities/${city.slug}`);
}

/**
 * The routes the sitemap SHOULD contain for city pages, under this source.
 *
 * The positive half of the same rule, so the equivalence suite can compare
 * route sets between sources directly rather than by inverting an exclusion
 * list and hoping the inversion is right.
 */
export function indexableCityPaths(): string[] {
  return records()
    .cities.filter((city) => isCityIndexable(city))
    .map((city) => `/cities/${city.slug}`);
}
