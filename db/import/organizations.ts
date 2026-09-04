/**
 * Organisation normalisation.
 *
 * The repository names the same organisations in three shapes: bare strings in
 * `event.host.organisations`, a `{ name, url }` object on a city's `organiser`,
 * and nothing at all where an organisation was never recorded. "The Origin
 * Guild" is currently both a host string on nine events and the Bhopal city
 * organiser, and those are one organisation.
 *
 * So the importer collects every mention, folds them together on a normalised
 * name, and keeps the best URL any mention carried. What it does NOT do is
 * invent an organisation: only names that appear in `src/data/*.ts` become
 * rows, and a name with no URL anywhere gets a row with no URL rather than a
 * guessed homepage.
 */
import type { City, CommunityEvent } from '../../src/data/types';

export interface OrganizationSeed {
  slug: string;
  name: string;
  url?: string;
}

/**
 * `The Origin Guild` → `the-origin-guild`.
 *
 * Stable, so a second import matches the first row rather than creating a
 * near-duplicate — which is the whole reason organisations get a slug at all.
 */
export function organizationSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The comparison key for deduplication. Case and spacing are not identity. */
function fold(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Every organisation named anywhere in the record, once each.
 *
 * Returned in a stable order (by slug) so two runs produce the same thing and
 * a diff of the import summary is readable.
 */
export function collectOrganizations(source: {
  cities: City[];
  events: CommunityEvent[];
}): OrganizationSeed[] {
  const { cities, events } = source;

  const byKey = new Map<string, OrganizationSeed>();

  const add = (rawName: string, url?: string): void => {
    const name = rawName.trim().replace(/\s+/g, ' ');
    if (!name) return;

    const key = fold(name);
    const existing = byKey.get(key);
    if (existing) {
      // A later mention may carry the URL an earlier one did not. It never
      // overwrites a URL that is already known.
      if (url && !existing.url) existing.url = url;
      return;
    }
    byKey.set(key, { slug: organizationSlug(name), name, url });
  };

  // City organisers carry a URL, so they are read first and become the
  // canonical spelling for any organisation named in both places.
  for (const city of cities) {
    if (city.organiser) add(city.organiser.name, city.organiser.url);
  }

  for (const event of events) {
    for (const name of event.host.organisations ?? []) add(name);
  }

  const seeds = [...byKey.values()].sort((a, b) => a.slug.localeCompare(b.slug));

  // Two different names folding to one slug would silently merge two real
  // organisations. That is a data problem worth stopping for, not routing
  // around.
  const bySlug = new Map<string, string>();
  for (const seed of seeds) {
    const clash = bySlug.get(seed.slug);
    if (clash && clash !== seed.name) {
      throw new Error(
        `Organisation slug "${seed.slug}" is claimed by both "${clash}" and "${seed.name}". ` +
          `Rename one of them in src/data before importing.`,
      );
    }
    bySlug.set(seed.slug, seed.name);
  }

  return seeds;
}

/** Look up the slug a mention resolves to, for attaching relationships. */
export function organizationKey(name: string): string {
  return organizationSlug(name.trim().replace(/\s+/g, ' '));
}
