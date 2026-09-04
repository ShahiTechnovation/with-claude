/**
 * What deserves its own place in search results.
 *
 * Being navigable and being indexable are different questions, and conflating
 * them is how a community site turns into a farm of thin programmatic landing
 * pages. Every city on the atlas gets a real page — a visitor who clicks a dot
 * should always land somewhere honest. Only a city with something actually in
 * it gets to be a search result.
 *
 * ── Why the imports here are relative ──────────────────────────────────
 *
 * This module is loaded by `astro.config.mjs`, which is evaluated before the
 * project's `@` alias exists. Everything it imports must therefore resolve
 * relatively and must not pull in a module that uses the alias at runtime —
 * the leaf data files and `city.ts` only import types, which are erased.
 *
 * The alternative was to restate the rule in the config, which would put the
 * sitemap and the page's `noindex` on separate copies of the same condition,
 * free to drift. One definition, imported twice, is worth the odd import path.
 */

import { ambassadors } from '../data/ambassadors';
import { builders } from '../data/builders';
import { cities } from '../data/cities';
import { events } from '../data/events';
import { projects } from '../data/projects';
import { stories } from '../data/stories';
import type { City, ModerationStatus } from '../data/types';

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
export function isCityIndexable(city: City): boolean {
  if (!isPublic(city)) return false;

  return (
    ambassadors.filter(isPublic).some((a) => a.citySlug === city.slug) ||
    events.filter(isPublic).some((e) => e.citySlug === city.slug) ||
    builders.filter(isPublic).some((b) => b.citySlug === city.slug) ||
    projects.filter(isPublic).some((p) => p.citySlug === city.slug) ||
    stories.filter(isPublic).some((s) => s.citySlug === city.slug)
  );
}

/** Root-relative paths the sitemap must leave out. */
export function nonIndexablePaths(): string[] {
  return cities.filter((city) => !isCityIndexable(city)).map((city) => `/cities/${city.slug}`);
}
