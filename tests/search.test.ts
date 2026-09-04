import { describe, expect, it } from 'vitest';
import {
  groupByKind,
  isEmptyIntent,
  parseQuery,
  runSearch,
  scoreRecord,
} from '../src/lib/search-core';
import type { SearchRecord, SearchVocabulary } from '../src/lib/search-core';

/**
 * The search matcher.
 *
 * This is tested against a fixture rather than the live record on purpose:
 * the behaviour under test is the matcher, and pinning it to real data would
 * mean these tests break every time somebody adds a builder. The integrity of
 * the real index is `data.test.ts`'s job.
 *
 * The properties that matter are the ones a directory cannot get wrong:
 * a structured filter is absolute, every term has to land somewhere, and
 * nothing comes back that was not in the index.
 */
const vocabulary: SearchVocabulary = {
  cities: [
    { slug: 'bhopal', name: 'Bhopal' },
    { slug: 'bengaluru', name: 'Bengaluru' },
    { slug: 'pune', name: 'Pune' },
  ],
  surfaces: ['Claude Code', 'Claude API'],
  formats: ['conversation', 'impact-lab', 'workshop'],
};

const record = (over: Partial<SearchRecord> & Pick<SearchRecord, 'id' | 'kind' | 'title'>) =>
  ({
    subtitle: '',
    summary: '',
    href: '/',
    facets: {},
    terms: '',
    weight: 1,
    ...over,
  }) as SearchRecord;

const index: SearchRecord[] = [
  record({
    id: 'person:asha',
    kind: 'person',
    title: 'Asha Rao',
    subtitle: 'Bengaluru · Agent builder',
    terms: 'asha rao bengaluru agent builder claude code',
    facets: { city: 'bengaluru', surfaces: ['claude code'] },
  }),
  record({
    id: 'person:dev',
    kind: 'person',
    title: 'Dev Sharma',
    subtitle: 'Pune · Designer',
    terms: 'dev sharma pune designer',
    facets: { city: 'pune' },
  }),
  record({
    id: 'event:conversation',
    kind: 'event',
    title: 'Claude Conversation',
    subtitle: 'Bhopal · Conversation',
    terms: 'claude conversation bhopal',
    facets: { city: 'bhopal', format: 'conversation' },
    weight: 3,
  }),
  record({
    id: 'event:workshop',
    kind: 'event',
    title: 'Claude Code Workshop',
    subtitle: 'Bhopal · Workshop',
    terms: 'claude code workshop bhopal',
    facets: { city: 'bhopal', format: 'workshop' },
    weight: 3,
  }),
  record({
    id: 'city:bhopal',
    kind: 'city',
    title: 'Bhopal',
    subtitle: 'Madhya Pradesh · Ambassador led',
    terms: 'bhopal madhya pradesh ambassador led',
    facets: { city: 'bhopal' },
    weight: 4,
  }),
];

const query = (text: string) => runSearch(index, parseQuery(text, vocabulary));
const ids = (text: string) => query(text).map((result) => result.record.id);

describe('parseQuery', () => {
  it('lifts a city out of a plain-language question', () => {
    const intent = parseQuery('builders in Bengaluru', vocabulary);
    expect(intent.city).toBe('bengaluru');
    expect(intent.kinds).toEqual(['person']);
    expect(intent.terms).toEqual([]);
  });

  it('reads a multi-word Claude surface before its individual words', () => {
    const intent = parseQuery('Claude Code builders in Bhopal', vocabulary);
    expect(intent.surface).toBe('claude code');
    expect(intent.city).toBe('bhopal');
    expect(intent.kinds).toEqual(['person']);
  });

  it('only recognises cities that are actually in the vocabulary', () => {
    // Jaipur is not plotted, so it stays free text rather than becoming a
    // filter that silently returns nothing.
    const intent = parseQuery('builders in Jaipur', vocabulary);
    expect(intent.city).toBeUndefined();
    expect(intent.terms).toContain('jaipur');
  });

  it('reads an event format as a format, not as the whole event kind', () => {
    const intent = parseQuery('workshops', vocabulary);
    expect(intent.format).toBe('workshop');
    // Naming a format implies the kind, since only events have one.
    expect(intent.kinds).toEqual(['event']);
  });

  it('reads a hyphenated format the way somebody would say it', () => {
    expect(parseQuery('impact labs', vocabulary).format).toBe('impact-lab');
    expect(parseQuery('impact-lab', vocabulary).format).toBe('impact-lab');
  });

  it('drops filler that would otherwise dilute a score', () => {
    expect(parseQuery('the projects in India', vocabulary).terms).toEqual([]);
  });

  it('reports an empty query as empty', () => {
    expect(isEmptyIntent(parseQuery('   ', vocabulary))).toBe(true);
    expect(isEmptyIntent(parseQuery('asha', vocabulary))).toBe(false);
  });
});

describe('runSearch', () => {
  it('treats a city filter as absolute', () => {
    // Dev matches nothing about Bengaluru, and Asha is the only person there.
    expect(ids('builders in Bengaluru')).toEqual(['person:asha']);
  });

  it('never returns a record from another city, however good the text match', () => {
    for (const result of query('Bhopal')) {
      expect(result.record.facets.city).toBe('bhopal');
    }
  });

  it('requires every term to land somewhere', () => {
    // "asha" hits, "kolkata" does not — so the record is out.
    expect(ids('asha kolkata')).toEqual([]);
  });

  it('ranks a title match above a body match', () => {
    const results = query('Bhopal');
    expect(results[0].record.id).toBe('city:bhopal');
  });

  it('answers a purely structured query from the constraints alone', () => {
    const results = query('events');
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.record.kind === 'event')).toBe(true);
  });

  it('answers "workshops" with the workshops, not with every event', () => {
    // The regression this guards: a format word swallowed as a kind word
    // turns a narrow question into the entire archive.
    expect(ids('workshops')).toEqual(['event:workshop']);
  });

  it('combines a format with a city', () => {
    expect(ids('workshops in Bhopal')).toEqual(['event:workshop']);
    expect(ids('workshops in Pune')).toEqual([]);
  });

  it('filters by Claude surface', () => {
    expect(ids('Claude Code people')).toEqual(['person:asha']);
  });

  it('returns nothing rather than something plausible', () => {
    expect(ids('quantum tunnelling')).toEqual([]);
  });

  it('only ever returns records that were in the index', () => {
    const known = new Set(index.map((entry) => entry.id));
    for (const result of query('claude')) {
      expect(known).toContain(result.record.id);
    }
  });
});

describe('scoreRecord', () => {
  it('scores zero for a record failing a structured constraint', () => {
    const intent = parseQuery('Pune', vocabulary);
    const asha = index.find((entry) => entry.id === 'person:asha')!;
    expect(scoreRecord(asha, intent)).toBe(0);
  });

  it('is deterministic', () => {
    const intent = parseQuery('claude', vocabulary);
    const first = index.map((entry) => scoreRecord(entry, intent));
    const second = index.map((entry) => scoreRecord(entry, intent));
    expect(first).toEqual(second);
  });
});

describe('groupByKind', () => {
  it('returns a bucket for every kind, including the empty ones', () => {
    const groups = groupByKind(query('claude'));
    expect([...groups.keys()]).toContain('project');
    expect(groups.get('project')).toEqual([]);
  });

  it('puts every result in exactly one bucket', () => {
    const results = query('bhopal');
    const total = [...groupByKind(results).values()].reduce((sum, list) => sum + list.length, 0);
    expect(total).toBe(results.length);
  });
});
