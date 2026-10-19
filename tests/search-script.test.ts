/**
 * ON /discover/, A PINNED TAB FILTERS WHAT SHOWS, NOT WHAT COUNTS.
 *
 * Pinning a tab used to write its kind into the query before anything was
 * counted, so with "bhopal" typed and Events pinned every other tab read 0
 * and All read the event count: numbers that said no person or project
 * matched (F080).
 *
 * This runs the real island, `src/scripts/search.ts`, over a stand-in page.
 * No DOM library is installed, so `El` carries only what the island calls,
 * and its `dataset` keys double as the `[data-*]` attributes it selects by.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

class El {
  dataset: Record<string, string>;
  hidden = false;
  textContent = '';
  value = '';
  parentElement: El | null = null;
  children: El[] = [];
  listeners: Record<string, () => void> = {};
  classList = { toggle: (): void => {} };

  constructor(dataset: Record<string, string> = {}, children: El[] = []) {
    this.dataset = dataset;
    for (const child of children) this.append(child);
  }

  append(child: El): void {
    const siblings = child.parentElement?.children;
    siblings?.splice(siblings.indexOf(child), 1);
    child.parentElement = this;
    this.children.push(child);
  }

  setAttribute(): void {}

  addEventListener(type: string, listener: () => void): void {
    this.listeners[type] = listener;
  }

  focus(): void {}

  /** Bare `[data-…]` selectors only, which is all the island uses. */
  querySelectorAll(selector: string): El[] {
    const key = selector
      .slice('[data-'.length, -1)
      .replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase());
    return this.children.flatMap((child) => [
      ...(key in child.dataset ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }

  querySelector(selector: string): El | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

const row = (kind: string, n: number, city: string): El =>
  new El({
    searchItem: '',
    id: `${kind}:${n}`,
    kind,
    title: `${kind} ${n}`,
    subtitle: '',
    city,
    category: '',
    format: '',
    surfaces: '',
    terms: `${kind} ${n}`,
    weight: '1',
  });

const rows: Record<string, El[]> = {
  person: [row('person', 1, 'bhopal'), row('person', 2, 'delhi')],
  project: [row('project', 1, 'bhopal'), row('project', 2, 'bhopal'), row('project', 3, 'delhi')],
  event: [row('event', 1, 'bhopal'), row('event', 2, 'delhi')],
};

const input = new El({ searchInput: '' });
const status = new El({ searchStatus: '' });
const empty = new El({ searchEmpty: '' });
const vocabulary = new El({ searchVocabulary: '' });
vocabulary.textContent = JSON.stringify({
  cities: [
    { slug: 'bhopal', name: 'Bhopal' },
    { slug: 'delhi', name: 'Delhi' },
  ],
  surfaces: [],
  formats: [],
});
const tabs = ['all', 'person', 'project', 'event'].map(
  (kind) => new El({ searchKind: kind }, [new El({ searchTabCount: '' })]),
);
const groups = Object.entries(rows).map(
  ([kind, items]) =>
    new El({ searchGroup: kind }, [new El({ searchGroupCount: '' }), new El({}, items)]),
);
const root = new El({ searchRoot: '' }, [
  vocabulary,
  new El({ searchForm: '' }, [input, status]),
  ...tabs,
  new El({ searchClear: '' }),
  ...groups,
  empty,
]);

const type = (query: string): void => {
  input.value = query;
  input.listeners.input!();
};
const press = (kind: string): void =>
  tabs.find((tab) => tab.dataset.searchKind === kind)!.listeners.click!();
const counts = (): Record<string, string> =>
  Object.fromEntries(
    tabs.map((tab) => [
      tab.dataset.searchKind,
      tab.querySelector('[data-search-tab-count]')!.textContent,
    ]),
  );
/** What shows: each visible group's heading, then its visible rows. */
const showing = (): string[] =>
  groups
    .filter((group) => !group.hidden)
    .flatMap((group) => [
      `${group.dataset.searchGroup} heading`,
      ...group
        .querySelectorAll('[data-search-item]')
        .filter((item) => !item.hidden)
        .map((item) => item.dataset.id!),
    ]);

describe('the /discover/ tabs', () => {
  beforeAll(async () => {
    vi.stubGlobal('document', { querySelector: () => root });
    vi.stubGlobal('window', {
      location: { href: 'https://www.withclaude.in/discover/', search: '' },
    });
    await import('../src/scripts/search');
  });

  it('keeps every tab count when one is pinned, and shows only that kind', () => {
    press('all');
    type('bhopal');
    const unpinned = counts();
    expect(unpinned).toEqual({ all: '4', person: '1', project: '2', event: '1' });

    press('event');
    expect(counts()).toEqual(unpinned);
    expect(showing()).toEqual(['event heading', 'event:1']);
    expect(status.textContent).toBe('1 result · in Bhopal · events');
  });

  it('counts everything when a tab is pinned with nothing typed', () => {
    press('all');
    type('');
    press('project');
    expect(counts()).toEqual({ all: '7', person: '2', project: '3', event: '2' });
    expect(showing()).toEqual(['project heading', 'project:1', 'project:2', 'project:3']);
    expect(status.textContent).toBe('3 results · projects');
  });

  it('still narrows by a kind the query names', () => {
    press('all');
    type('people in bhopal');
    press('event');
    expect(counts()).toEqual({ all: '1', person: '1', project: '0', event: '0' });
    expect(showing()).toEqual([]);
    expect(empty.hidden).toBe(false);
  });
});
