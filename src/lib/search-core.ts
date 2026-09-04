/**
 * The search matcher — pure, and deliberately free of any data import.
 *
 * This file is the one that runs twice: once at build time to render
 * `/discover`, and once in the browser as you type. That is exactly why it
 * imports nothing from `src/data` — the island would otherwise pull the whole
 * record into the bundle, and the two copies would drift the first time
 * anybody tuned a score on one side only.
 *
 * The vocabulary it needs — real city names, real Claude surfaces — is passed
 * in rather than read, so the page can hand the browser the few hundred bytes
 * it actually needs. See `src/lib/search.ts` for the data-bound half.
 */

export type SearchKind = 'person' | 'project' | 'event' | 'city' | 'use-case' | 'story' | 'guide';

/** Group order on `/discover`. People first — the site is about who is building. */
export const SEARCH_KINDS: SearchKind[] = [
  'person',
  'project',
  'event',
  'city',
  'use-case',
  'story',
  'guide',
];

export const KIND_LABEL: Record<SearchKind, string> = {
  person: 'People',
  project: 'Projects',
  event: 'Events',
  city: 'Cities',
  'use-case': 'Use cases',
  story: 'Stories',
  guide: 'Guides',
};

/** Facet values a record can be filtered by. All optional, all from the data. */
export interface SearchFacets {
  city?: string;
  /** Project category, use-case category, city state, or story kind. */
  category?: string;
  /** Event format. */
  format?: string;
  /** Claude surfaces named on the record, lowercased. */
  surfaces?: string[];
}

export interface SearchRecord {
  id: string;
  kind: SearchKind;
  title: string;
  /** The metadata line — city, role, format. */
  subtitle: string;
  summary: string;
  href: string;
  facets: SearchFacets;
  /** Everything matchable, lowercased and joined. Precomputed once. */
  terms: string;
  /** Tie-break within a kind. Higher sorts first. */
  weight: number;
  date?: string;
}

// =========================================================================
// INTENT — the seam a natural-language layer would replace
// =========================================================================

export interface SearchIntent {
  /** What is left after the structured parts are lifted out. */
  text: string;
  terms: string[];
  /** Narrow to these kinds. Empty means all. */
  kinds: SearchKind[];
  city?: string;
  surface?: string;
  /** An event format, which implies the event kind. */
  format?: string;
}

/**
 * The words `parseQuery` is allowed to recognise, drawn from the record.
 *
 * A city is only a city if it is plotted; a surface is only a surface if
 * somebody has actually recorded using it. Handing the vocabulary in rather
 * than hard-coding it is what stops the parser from understanding a city the
 * site does not have.
 */
export interface SearchVocabulary {
  cities: { slug: string; name: string }[];
  surfaces: string[];
  /** Event formats present in the record, e.g. `workshop`, `impact-lab`. */
  formats: string[];
}

/** Words that name an entity kind, in the forms people actually type. */
const KIND_WORDS: [SearchKind, string[]][] = [
  ['person', ['people', 'person', 'builder', 'builders', 'someone', 'ambassador', 'ambassadors']],
  ['project', ['project', 'projects', 'prototype', 'prototypes', 'builds']],
  // Format names are deliberately absent here: "workshops" is a narrower
  // question than "events", and answering it with every event on the record
  // is a worse result than answering it with the workshops. They are read as
  // formats below instead.
  ['event', ['event', 'events']],
  ['city', ['city', 'cities']],
  ['use-case', ['use case', 'use cases', 'workflow', 'workflows', 'practice']],
  ['story', ['story', 'stories', 'recap', 'recaps']],
  ['guide', ['guide', 'guides']],
];

/** Filler that carries no signal. Dropped so it cannot dilute a score. */
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
  'india',
  'claude',
]);

const normalise = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Read a typed query into a structured intent — deterministically.
 *
 * "Claude Code builders in Bengaluru" resolves to `{ kinds: ['person'],
 * city: 'bengaluru', surface: 'claude code' }` by looking every part up in the
 * vocabulary. Nothing is guessed, and anything left over is treated as plain
 * text rather than interpreted.
 */
export function parseQuery(input: string, vocab: SearchVocabulary): SearchIntent {
  let rest = ` ${normalise(input)} `;
  const kinds: SearchKind[] = [];
  let city: string | undefined;
  let surface: string | undefined;
  let format: string | undefined;

  const take = (phrase: string): boolean => {
    const needle = ` ${phrase} `;
    if (!rest.includes(needle)) return false;
    rest = rest.replace(needle, ' ');
    return true;
  };

  const byLength = (a: string, b: string) => b.length - a.length;

  // Longest phrases first, so "claude code" is never read as "code" alone.
  for (const name of [...vocab.surfaces].map(normalise).sort(byLength)) {
    if (!surface && name && take(name)) surface = name;
  }

  // Formats before kinds. Each is tried the way people actually write it —
  // plural or singular, hyphenated or spaced — so "impact labs", "impact lab"
  // and "impact-lab" are all the same question. Longest candidate first, so a
  // plural is never consumed as its singular plus a stray "s".
  for (const name of [...vocab.formats].sort(byLength)) {
    if (format) break;
    const slug = normalise(name);
    const spoken = normalise(name.replace(/-/g, ' '));
    const candidates = [`${spoken}s`, `${slug}s`, spoken, slug].filter(Boolean).sort(byLength);
    for (const candidate of candidates) {
      if (take(candidate)) {
        format = name;
        break;
      }
    }
  }

  for (const record of vocab.cities) {
    if (!city && take(normalise(record.name))) city = record.slug;
  }

  for (const [kind, words] of KIND_WORDS) {
    for (const word of [...words].sort(byLength)) {
      if (take(word) && !kinds.includes(kind)) kinds.push(kind);
    }
  }

  // A format only exists on an event, so naming one narrows the kind too.
  if (format && !kinds.includes('event')) kinds.push('event');

  const text = rest.trim();
  return {
    text,
    terms: text.split(' ').filter((term) => term.length > 1 && !STOP_WORDS.has(term)),
    kinds,
    city,
    surface,
    format,
  };
}

/** True when a query asked for nothing at all. */
export function isEmptyIntent(intent: SearchIntent): boolean {
  return (
    !intent.terms.length &&
    !intent.kinds.length &&
    !intent.city &&
    !intent.surface &&
    !intent.format
  );
}

// =========================================================================
// EXECUTION — only ever reads real records
// =========================================================================

export interface SearchResult {
  record: SearchRecord;
  score: number;
}

/**
 * Score one record against an intent.
 *
 * A title match is worth far more than a body match, and a whole-phrase match
 * more than the sum of its words — which is what makes searching a person's
 * name return the person rather than every event they attended.
 *
 * Returns 0 for anything failing a structured constraint, so a filter is
 * absolute: asking for Bengaluru never returns Pune, however good the text
 * match is.
 */
export function scoreRecord(record: SearchRecord, intent: SearchIntent): number {
  if (intent.kinds.length && !intent.kinds.includes(record.kind)) return 0;
  if (intent.city && record.facets.city !== intent.city) return 0;
  if (intent.format && record.facets.format !== intent.format) return 0;
  if (intent.surface && !record.facets.surfaces?.some((s) => s.includes(intent.surface!))) return 0;

  // A query that was entirely structured — "events in Pune" — is answered by
  // the constraints alone, so everything surviving them is a hit.
  if (!intent.terms.length) return 1 + record.weight / 10;

  const title = record.title.toLowerCase();
  let score = 0;

  if (intent.text && title.includes(intent.text)) score += 12;

  for (const term of intent.terms) {
    if (title.startsWith(term)) score += 8;
    else if (title.includes(term)) score += 6;
    else if (record.subtitle.toLowerCase().includes(term)) score += 3;
    else if (record.terms.includes(term)) score += 2;
    else return 0; // every term must land somewhere — this is an AND search
  }

  return score + record.weight / 10;
}

export function runSearch(index: SearchRecord[], intent: SearchIntent): SearchResult[] {
  return index
    .map((record) => ({ record, score: scoreRecord(record, intent) }))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.record.title.localeCompare(b.record.title));
}

/** Results split into the groups `/discover` renders. */
export function groupByKind(results: SearchResult[]): Map<SearchKind, SearchResult[]> {
  const groups = new Map<SearchKind, SearchResult[]>();
  for (const kind of SEARCH_KINDS) groups.set(kind, []);
  for (const result of results) groups.get(result.record.kind)!.push(result);
  return groups;
}
