/**
 * THE DIRECTORY, ENHANCED. Without this file the directory is a GET form and
 * links (an Apply button submits it), and works completely. With it:
 *
 *   · picking an event or a type applies at once, search applies after a
 *     short pause, and pagination and pill links stay on the page — each by
 *     fetching the SAME URL the form would have navigated to;
 *   · only the results, counts and checked states are swapped, in place, so
 *     focus stays on the control the visitor is using;
 *   · a newer request aborts an older one, and a late response for a URL that
 *     is no longer current is ignored;
 *   · back/forward re-render the URL they land on.
 *
 * Loading and failure are both said out loud in the status region. A failed
 * fetch never strands the visitor: the message links to the plain URL.
 */

const root = document.querySelector<HTMLElement>('[data-directory]');
const form = document.querySelector<HTMLFormElement>('#dir-form');

if (root && form) enhance(root, form);

function enhance(root: HTMLElement, form: HTMLFormElement) {
  const results = root.querySelector<HTMLElement>('[data-dir-results]')!;
  const swap = () => root.querySelector<HTMLElement>('[data-dir-swap]');
  const count = () => root.querySelector<HTMLElement>('[data-dir-count]');
  let rendered = location.pathname + location.search;
  const status = () => root.querySelector<HTMLElement>('[data-dir-status]');

  let controller: AbortController | null = null;
  let sequence = 0;
  /** The search box's debounce timer. */
  let typing: number | undefined;

  // A link such as /projects/?event=… can check a pill that starts past the fade:
  // centre it in its row. Only the row scrolls, never the page.
  const checkedPill = form.querySelector('input[name="event"]:checked')?.closest('label');
  const pillRow = checkedPill?.parentElement;
  if (checkedPill && pillRow) {
    const pill = checkedPill.getBoundingClientRect();
    const row = pillRow.getBoundingClientRect();
    pillRow.scrollLeft += pill.left - row.left - (row.width - pill.width) / 2;
  }

  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const urlFromForm = (): string => {
    const data = new FormData(form);
    const params = new URLSearchParams();
    for (const [key, value] of data) {
      const v = String(value).trim();
      if (!v || (key === 'sort' && v === 'event')) continue;
      params.append(key, v);
    }
    const qs = params.toString();
    return `/projects/${qs ? `?${qs}` : ''}`;
  };

  const say = (text: string, state?: 'loading' | 'error') => {
    const el = status();
    if (!el) return;
    el.textContent = '';
    if (state) el.dataset.state = state;
    else delete el.dataset.state;
    el.append(text);
  };

  async function navigate(url: string, mode: 'push' | 'replace' | 'none', after?: () => void) {
    // A search still waiting on its debounce is out of date the moment anything
    // else navigates. Left running, it would abort this request and, after a
    // Back, replace the history entry the visitor had just returned to.
    window.clearTimeout(typing);
    controller?.abort();
    controller = new AbortController();
    const mine = ++sequence;
    // Only the swapped region is busy: the status and count stay live, so a
    // screen reader hears "Updating results…" and then the new count.
    swap()?.setAttribute('aria-busy', 'true');
    say('Updating results…', 'loading');
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'text/html' },
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const html = await response.text();
      if (mine !== sequence) return; // a newer request owns the page now
      const next = new DOMParser().parseFromString(html, 'text/html');
      apply(next);
      if (mode === 'push') history.pushState({ directory: true }, '', url);
      else if (mode === 'replace') history.replaceState({ directory: true }, '', url);
      rendered = url;
      document.title = next.title || document.title;
      swap()?.removeAttribute('aria-busy');
      say('');
      document.dispatchEvent(new CustomEvent('directory:updated'));
      after?.();
    } catch (error) {
      if ((error as Error).name === 'AbortError' || mine !== sequence) return;
      swap()?.removeAttribute('aria-busy');
      const el = status();
      if (el) {
        el.dataset.state = 'error';
        el.textContent = 'The results could not be updated. ';
        const link = document.createElement('a');
        link.href = url;
        link.textContent = 'Load this view again';
        el.append(link);
        // Someone still typing a search keeps the caret; the status region
        // announces the failure either way.
        if (!document.activeElement?.matches('[data-dir-q]')) link.focus();
      }
    }
  }

  /**
   * Bring this page in line with a freshly rendered one. The search box, the
   * toolbar (event pills, type) and the count and status lines persist —
   * focus and caret stay where they are and the live regions keep announcing —
   * and only `[data-dir-swap]` (pills, cards, pager) is replaced.
   */
  function apply(next: Document) {
    const mine = swap();
    const theirs = next.querySelector('[data-dir-swap]');
    if (mine && theirs)
      mine.replaceChildren(...[...theirs.childNodes].map((n) => document.importNode(n, true)));
    const nextCount = next.querySelector('[data-dir-count]');
    const liveCount = count();
    if (nextCount && liveCount) {
      if (liveCount.innerHTML !== nextCount.innerHTML) liveCount.innerHTML = nextCount.innerHTML;
      liveCount.className = nextCount.className;
    }
    const nextType = next.querySelector<HTMLSelectElement>('[data-dir-category]');
    const liveType = root.querySelector<HTMLSelectElement>('[data-dir-category]');
    if (nextType && liveType) {
      // The options carry counts, which follow the other filters.
      if (liveType.innerHTML !== nextType.innerHTML) liveType.innerHTML = nextType.innerHTML;
      liveType.value = nextType.value;
    }
    const q = next.querySelector<HTMLInputElement>('[data-dir-q]');
    const liveQ = root.querySelector<HTMLInputElement>('[data-dir-q]');
    if (q && liveQ && document.activeElement !== liveQ) liveQ.value = q.value;
    next.querySelectorAll<HTMLElement>('[data-count]').forEach((el) => {
      const mine = root.querySelector<HTMLElement>(
        `[data-count="${CSS.escape(el.dataset.count!)}"]`,
      );
      if (mine) mine.textContent = el.textContent;
    });
    next.querySelectorAll<HTMLInputElement>('[data-facet]').forEach((input) => {
      const mine = root.querySelector<HTMLInputElement>(
        `[data-facet="${CSS.escape(input.dataset.facet!)}"]`,
      );
      if (mine) mine.checked = input.checked;
    });
  }

  // From the sticky toolbar a shorter list can leave the page scrolled past it:
  // bring the results' top back into view. Focus stays on the control.
  const reveal = () => {
    if (results.getBoundingClientRect().top < 0)
      results.scrollIntoView({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' });
  };

  // ── live changes ──────────────────────────────────────────────────────
  // An event pill or the type select applies at once; the search box has its own pause below.
  form.addEventListener('change', (event) => {
    const t = event.target;
    if (t instanceof HTMLInputElement && t.type === 'radio') {
      // Arrowing along the pills on a phone: bring the whole pill into the sideways row.
      t.closest('label')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      void navigate(urlFromForm(), 'push', reveal);
    } else if (t instanceof HTMLSelectElement) void navigate(urlFromForm(), 'push', reveal);
  });

  root.addEventListener('input', (event) => {
    const t = event.target;
    if (!(t instanceof HTMLInputElement) || !t.matches('[data-dir-q]')) return;
    window.clearTimeout(typing);
    typing = window.setTimeout(() => void navigate(urlFromForm(), 'replace'), 350);
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void navigate(urlFromForm(), 'push');
  });

  // Links inside the directory (pagination, pill removal, "Clear all", the
  // empty state's "Show all") re-render in place; project and event links do not.
  root.addEventListener('click', (event) => {
    const link = (event.target as Element).closest<HTMLAnchorElement>('a');
    if (
      !link ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const inPager = link.closest('.dir-pager');
    const local = inPager || link.closest('.dir-chips') || link.matches('.dir-empty a');
    if (!local) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || url.pathname !== '/projects/') return;
    event.preventDefault();
    void navigate(url.pathname + url.search, 'push', () => {
      if (inPager)
        results.scrollIntoView({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' });
      // A pill, pager or empty-state link is gone (it was in the swapped
      // region), so focus moves to the count, which says what the visitor
      // now sees. Where the count is only announced (the grouped view), focus
      // goes to the checked event pill instead, so a sighted keyboard user sees
      // it land. A link that survives the swap keeps focus.
      if (!document.contains(link)) {
        const live = count();
        const target = live?.classList.contains('visually-hidden')
          ? form.querySelector<HTMLInputElement>('input[name="event"]:checked')
          : live;
        target?.focus({ preventScroll: target === live && !inPager });
      }
    });
  });

  window.addEventListener('popstate', () => {
    const here = location.pathname + location.search;
    // A fragment link (e.g. "Skip to content") changes only the hash.
    if (here === rendered) return;
    // Follow the history entry, not the last finished render: a Forward that
    // lands while a Back is still loading must replace that request.
    rendered = here;
    void navigate(here, 'none', () => syncForm());
  });

  /** After back/forward, the form must say what the URL says. */
  function syncForm() {
    const params = new URLSearchParams(location.search);
    const events = params.getAll('event');
    form
      .querySelectorAll<HTMLInputElement>('input[type="radio"][name="event"]')
      .forEach((input) => {
        input.checked = input.value
          ? events.length === 1 && events[0] === input.value
          : events.length === 0;
      });
    const q = root.querySelector<HTMLInputElement>('[data-dir-q]');
    if (q) q.value = params.get('q') ?? '';
    const type = root.querySelector<HTMLSelectElement>('[data-dir-category]');
    if (type) type.value = params.get('category') ?? '';
  }
}
