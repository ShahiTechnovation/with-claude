/**
 * SEARCH THE COMMUNITY — the data-bound half.
 *
 * One flat index over the whole graph — people, projects, events, cities, use
 * cases, stories, guides — built at compile time from the same selectors every
 * page reads. There is no second copy of the record here and no search-only
 * content: if something is not published, it is not in the index.
 *
 * ── Why there is no model in this file ──────────────────────────────────
 *
 * The obvious version of this feature ships an LLM and calls the result
 * "AI search". For a few hundred records that is slower, less predictable and
 * less honest than matching strings, and it fails in the one way a directory
 * must not: by inventing a plausible answer.
 *
 * So the work is split in two, and the seam is the interesting part:
 *
 *   parseQuery(text, vocab)  →  SearchIntent     what is being asked for
 *   runSearch(index, intent) →  SearchResult[]   what the record contains
 *
 * `runSearch` only ever reads real records, so it cannot return something that
 * is not there. `parseQuery` is today a deterministic parser that reads city
 * names, entity words and Claude surfaces straight out of the data. When a
 * natural-language layer is worth adding, it replaces `parseQuery` alone — it
 * produces a `SearchIntent`, and everything downstream is unchanged. A model
 * would get to interpret the question; it would never get to answer it.
 *
 * The matcher itself is in `search-core.ts`, which imports no data so the
 * browser island can run the identical scoring as you type.
 */

import {
  builderNamesOf,
  buildersOf,
  cityName,
  citySignalsRanked,
  claudeSurfaces,
  eventsChronological,
  guidesChronological,
  publicBuilders,
  publicCities,
  publicProjects,
  publicStories,
  useCasesChronological,
} from '@/data';
import type { CitySignal } from '@/data';
import { formatName, lifecycleOf } from '@/lib/status';
import { SEARCH_KINDS, parseQuery, runSearch } from '@/lib/search-core';
import type { SearchRecord, SearchResult, SearchVocabulary } from '@/lib/search-core';

export * from '@/lib/search-core';

// =========================================================================
// BUILDING THE INDEX
// =========================================================================

const lower = (parts: (string | undefined)[]): string =>
  parts.filter(Boolean).join(' ').toLowerCase();

function personRecords(): SearchRecord[] {
  return publicBuilders.map((builder) => ({
    id: `person:${builder.slug}`,
    kind: 'person' as const,
    title: builder.name,
    subtitle: [cityName(builder.citySlug), builder.role].filter(Boolean).join(' · '),
    summary: builder.building ?? builder.bio ?? builder.role,
    href: `/builders/${builder.slug}`,
    facets: {
      city: builder.citySlug,
      category: builder.roles[0],
      surfaces: (builder.claudeTools ?? []).map((t) => t.toLowerCase()),
    },
    terms: lower([
      builder.name,
      builder.role,
      builder.building,
      builder.bio,
      cityName(builder.citySlug),
      builder.roles.join(' '),
      (builder.claudeTools ?? []).join(' '),
    ]),
    weight: builder.status === 'featured' ? 2 : 1,
  }));
}

function projectRecords(): SearchRecord[] {
  return publicProjects.map((project) => ({
    id: `project:${project.slug}`,
    kind: 'project' as const,
    title: project.title,
    subtitle: [cityName(project.citySlug), formatName(project.category)].join(' · '),
    summary: project.summary,
    href: `/projects/${project.slug}`,
    facets: {
      city: project.citySlug,
      category: project.category,
      surfaces: (project.tags ?? []).map((t) => t.toLowerCase()),
    },
    terms: lower([
      project.title,
      project.summary,
      project.description,
      project.claudeUsage,
      cityName(project.citySlug),
      project.category,
      (project.tags ?? []).join(' '),
      buildersOf(project)
        .map((b) => b.name)
        .concat(builderNamesOf(project).map((b) => b.name))
        .join(' '),
    ]),
    weight: project.status === 'featured' ? 2 : 1,
    date: project.createdAt,
  }));
}

function eventRecords(now: Date): SearchRecord[] {
  return eventsChronological.map((event) => {
    const lifecycle = lifecycleOf(event, now);
    const ahead = lifecycle !== 'past' && lifecycle !== 'cancelled';
    return {
      id: `event:${event.slug}`,
      kind: 'event' as const,
      title: event.title,
      subtitle: [cityName(event.citySlug), formatName(event.format)].join(' · '),
      summary: event.summary,
      href: `/events/${event.slug}`,
      facets: { city: event.citySlug, format: event.format },
      terms: lower([
        event.title,
        event.summary,
        event.description,
        cityName(event.citySlug),
        event.format,
        event.venue.name,
        (event.host.organisations ?? []).join(' '),
      ]),
      // Anything still ahead outranks the archive: a search is usually a
      // question about what you can still turn up to.
      weight: ahead ? 3 : 1,
      date: event.date,
    };
  });
}

function cityRecords(signals: CitySignal[]): SearchRecord[] {
  return signals.map(({ city, state, eventCount, builderCount }) => ({
    id: `city:${city.slug}`,
    kind: 'city' as const,
    title: city.name,
    subtitle: [city.state, formatName(state)].join(' · '),
    summary: city.blurb,
    href: `/cities/${city.slug}`,
    facets: { city: city.slug, category: state },
    terms: lower([city.name, city.state, city.blurb, state.replace(/-/g, ' ')]),
    // Ranked by what is actually there, so searching a state name surfaces the
    // cities where something is happening first.
    weight:
      (state === 'ambassador-led' ? 4 : state === 'event-activity' ? 3 : 1) +
      Math.min(eventCount + builderCount, 4) / 10,
  }));
}

function useCaseRecords(): SearchRecord[] {
  return useCasesChronological().map((useCase) => ({
    id: `use-case:${useCase.slug}`,
    kind: 'use-case' as const,
    title: useCase.title,
    subtitle: [
      useCase.citySlug ? cityName(useCase.citySlug) : undefined,
      formatName(useCase.category),
    ]
      .filter(Boolean)
      .join(' · '),
    summary: useCase.summary,
    href: `/use-cases/${useCase.slug}`,
    facets: {
      city: useCase.citySlug,
      category: useCase.category,
      surfaces: useCase.tools.map((t) => t.toLowerCase()),
    },
    terms: lower([
      useCase.title,
      useCase.summary,
      useCase.problem,
      useCase.context,
      useCase.result,
      useCase.tools.join(' '),
      useCase.category,
      useCase.citySlug ? cityName(useCase.citySlug) : undefined,
      useCase.author.name,
    ]),
    weight: useCase.status === 'featured' ? 2 : 1,
    date: useCase.date,
  }));
}

function storyRecords(): SearchRecord[] {
  return publicStories.map((story) => ({
    id: `story:${story.slug}`,
    kind: 'story' as const,
    title: story.title,
    subtitle: [story.citySlug ? cityName(story.citySlug) : undefined, formatName(story.kind)]
      .filter(Boolean)
      .join(' · '),
    summary: story.standfirst,
    href: `/stories/${story.slug}`,
    facets: { city: story.citySlug, category: story.kind },
    terms: lower([
      story.title,
      story.standfirst,
      (story.body ?? []).join(' '),
      story.author,
      story.citySlug ? cityName(story.citySlug) : undefined,
      story.kind,
    ]),
    weight: story.status === 'featured' ? 2 : 1,
    date: story.date,
  }));
}

function guideRecords(): SearchRecord[] {
  return guidesChronological().map((guide) => ({
    id: `guide:${guide.slug}`,
    kind: 'guide' as const,
    title: guide.title,
    subtitle: 'Guide',
    summary: guide.standfirst,
    href: `/guides/${guide.slug}`,
    facets: {},
    terms: lower([
      guide.title,
      guide.question,
      guide.standfirst,
      (guide.body ?? []).flatMap((block) => [block.heading, ...block.paragraphs]).join(' '),
      guide.author.name,
    ]),
    weight: guide.status === 'featured' ? 2 : 1,
    date: guide.modified ?? guide.published,
  }));
}

/**
 * The whole searchable record, ordered by kind and then by weight.
 *
 * Called once per build. The order it returns is the order `/discover`
 * renders, which is what makes the page useful with scripts blocked: it is a
 * complete, ranked, browsable index before anything is typed.
 */
export function buildSearchIndex(now: Date = new Date()): SearchRecord[] {
  const signals = citySignalsRanked(now);
  const all = [
    ...personRecords(),
    ...projectRecords(),
    ...eventRecords(now),
    ...cityRecords(signals),
    ...useCaseRecords(),
    ...storyRecords(),
    ...guideRecords(),
  ];

  return all.sort(
    (a, b) =>
      SEARCH_KINDS.indexOf(a.kind) - SEARCH_KINDS.indexOf(b.kind) ||
      b.weight - a.weight ||
      a.title.localeCompare(b.title),
  );
}

// =========================================================================
// VOCABULARY — what the parser is allowed to recognise
// =========================================================================

/**
 * The city names and Claude surfaces the parser may read out of a query.
 *
 * Serialised into `/discover` so the browser island parses queries exactly as
 * the server does. It is a few hundred bytes and it is derived, so it can
 * never name a city the atlas does not plot.
 */
export function searchVocabulary(): SearchVocabulary {
  return {
    cities: publicCities.map((city) => ({ slug: city.slug, name: city.name })),
    surfaces: claudeSurfaces(),
    // Only formats that actually occur. The parser should not understand a
    // format nobody has run.
    formats: [...new Set(eventsChronological.map((event) => event.format))].sort(),
  };
}

/** Parse against the real record. The convenience wrapper for server callers. */
export function parse(input: string) {
  return parseQuery(input, searchVocabulary());
}

/** The whole round trip, for callers that only have a string. */
export function search(index: SearchRecord[], input: string): SearchResult[] {
  return runSearch(index, parse(input));
}
