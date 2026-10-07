/**
 * The search island.
 *
 * Progressive by construction. `/discover` server-renders the entire index,
 * ranked and grouped, so with scripts blocked the page is a complete browsable
 * directory and the input is simply absent. This file adds live filtering to
 * a page that already worked.
 *
 * It does not fetch an index and it does not carry a second copy of one: every
 * record is already in the DOM with its precomputed haystack on a data
 * attribute, so the island reads what is on the page and scores it with the
 * same `search-core` matcher the server used. One implementation, two runtimes.
 */

import { KIND_LABEL, isEmptyIntent, parseQuery, runSearch } from '@/lib/search-core';
import type { SearchKind, SearchRecord, SearchVocabulary } from '@/lib/search-core';

const root = document.querySelector<HTMLElement>('[data-search-root]');

function init(scope: HTMLElement): void {
  const input = scope.querySelector<HTMLInputElement>('[data-search-input]');
  const form = scope.querySelector<HTMLFormElement>('[data-search-form]');
  const status = scope.querySelector<HTMLElement>('[data-search-status]');
  const empty = scope.querySelector<HTMLElement>('[data-search-empty]');
  const emptyTerm = scope.querySelector<HTMLElement>('[data-search-empty-term]');
  const clear = scope.querySelector<HTMLButtonElement>('[data-search-clear]');
  const groups = Array.from(scope.querySelectorAll<HTMLElement>('[data-search-group]'));
  const nodes = Array.from(scope.querySelectorAll<HTMLElement>('[data-search-item]'));
  const tabs = Array.from(scope.querySelectorAll<HTMLButtonElement>('[data-search-kind]'));
  if (!input || !nodes.length) return;

  let vocabulary: SearchVocabulary = { cities: [], surfaces: [], formats: [] };
  const raw = scope.querySelector<HTMLScriptElement>('[data-search-vocabulary]')?.textContent;
  if (raw) {
    try {
      vocabulary = JSON.parse(raw) as SearchVocabulary;
    } catch {
      // A malformed vocabulary costs the query parser its city, surface and
      // format shortcuts. Plain text search still works, so this is not fatal.
    }
  }

  // Rebuild the records from what the server already put in the page.
  const records = new Map<HTMLElement, SearchRecord>();
  for (const node of nodes) {
    const data = node.dataset;
    records.set(node, {
      id: data.id ?? '',
      kind: (data.kind ?? 'person') as SearchKind,
      title: data.title ?? '',
      subtitle: data.subtitle ?? '',
      summary: '',
      href: '',
      facets: {
        city: data.city || undefined,
        category: data.category || undefined,
        format: data.format || undefined,
        surfaces: data.surfaces ? data.surfaces.split('|') : undefined,
      },
      terms: data.terms ?? '',
      weight: Number(data.weight ?? '1'),
    });
  }
  const nodeOf = new Map([...records].map(([node, record]) => [record, node]));

  /** Kind narrowing from the tabs, which is a filter rather than a query. */
  let pinned: SearchKind | 'all' = 'all';

  const apply = (): void => {
    const intent = parseQuery(input.value, vocabulary);
    if (pinned !== 'all') intent.kinds = [pinned];

    const blank = isEmptyIntent(intent);
    const ranked = blank
      ? [...records.values()]
      : runSearch([...records.values()], intent).map((result) => result.record);

    const hits = new Set(ranked);
    const perKind = new Map<SearchKind, number>();

    for (const [node, record] of records) {
      const hit = hits.has(record);
      node.hidden = !hit;
      if (hit) perKind.set(record.kind, (perKind.get(record.kind) ?? 0) + 1);
    }

    // Rank order goes into the DOM itself, not a CSS `order`: Tab and screen
    // readers follow the DOM, so `order` showed one ranking and read out
    // another. Focus is in the field or on a tab while this runs, never in a list.
    for (const record of ranked) {
      const node = nodeOf.get(record)!;
      node.parentElement!.append(node);
    }

    for (const group of groups) {
      const kind = group.dataset.searchGroup as SearchKind;
      const count = perKind.get(kind) ?? 0;
      group.hidden = count === 0;
      const counter = group.querySelector<HTMLElement>('[data-search-group-count]');
      if (counter) counter.textContent = String(count);
    }

    for (const tab of tabs) {
      const kind = tab.dataset.searchKind as SearchKind | 'all';
      const on = kind === pinned;
      tab.classList.toggle('is-on', on);
      tab.setAttribute('aria-pressed', String(on));
      const counter = tab.querySelector<HTMLElement>('[data-search-tab-count]');
      if (counter) {
        counter.textContent = String(
          kind === 'all' ? ranked.length : (perKind.get(kind as SearchKind) ?? 0),
        );
      }
    }

    const total = ranked.length;
    if (empty) empty.hidden = total > 0;
    if (emptyTerm) emptyTerm.textContent = input.value.trim();
    if (clear) clear.hidden = blank && pinned === 'all';

    if (status) {
      // Describe the interpretation, not just the count — a query that was
      // read as a city filter should say so, or the zero looks like a bug.
      const parts: string[] = [];
      if (intent.city) {
        const city = vocabulary.cities.find((c) => c.slug === intent.city);
        if (city) parts.push(`in ${city.name}`);
      }
      if (intent.surface) parts.push(`using ${intent.surface}`);
      if (intent.format) parts.push(intent.format.replace(/-/g, ' '));
      if (intent.kinds.length === 1) parts.push(KIND_LABEL[intent.kinds[0]].toLowerCase());

      status.textContent = blank
        ? `${total} records`
        : `${total} ${total === 1 ? 'result' : 'results'}${parts.length ? ` · ${parts.join(' · ')}` : ''}`;
    }
  };

  // Typing is cheap here — a few hundred records, one pass, no network — so
  // there is nothing to debounce and the results keep up with the keyboard.
  input.addEventListener('input', apply);

  // A committed query (Enter, or leaving the field — which clicking a result
  // does) goes into the URL, so Back from a result or a reload returns to the
  // same results. Not on every keystroke: Safari caps replaceState calls.
  const remember = (): void => {
    const url = new URL(window.location.href);
    const q = input.value.trim();
    if (q) url.searchParams.set('q', q);
    else url.searchParams.delete('q');
    history.replaceState(history.state, '', url);
  };
  input.addEventListener('change', remember);

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    apply();
    remember();
  });

  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      const kind = tab.dataset.searchKind as SearchKind | 'all';
      pinned = pinned === kind && kind !== 'all' ? 'all' : kind;
      apply();
    });
  }

  clear?.addEventListener('click', () => {
    input.value = '';
    pinned = 'all';
    apply();
    remember();
    input.focus();
  });

  // A query in the URL makes a result set linkable — `/discover?q=bhopal`.
  const initial = new URLSearchParams(window.location.search).get('q');
  if (initial) input.value = initial;

  scope.dataset.searchReady = 'true';
  apply();
}

if (root) init(root);
