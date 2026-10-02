/**
 * THE DIRECTORY, ENHANCED. Without this file the directory is a GET form and
 * links, and works completely. With it:
 *
 *   · a filter or sort change applies at once (wide screens), search applies
 *     after a short pause, and pagination links stay on the page — each by
 *     fetching the SAME URL the form would have navigated to;
 *   · only the results, counts and checked states are swapped, in place, so
 *     focus stays on the control the visitor is using;
 *   · a newer request aborts an older one, and a late response for a URL that
 *     is no longer current is ignored;
 *   · back/forward re-render the URL they land on;
 *   · narrow screens get a filter drawer: a modal dialog with focus kept
 *     inside, Escape to close, focus returned to the "Filters" button, and
 *     Apply / Clear actions.
 *
 * Loading and failure are both said out loud in the status region. A failed
 * fetch never strands the visitor: the message links to the plain URL.
 */

const root = document.querySelector<HTMLElement>('[data-directory]');
const form = document.querySelector<HTMLFormElement>('#dir-form');

if (root && form) enhance(root, form);

function enhance(root: HTMLElement, form: HTMLFormElement) {
  const results = root.querySelector<HTMLElement>('[data-dir-results]')!;
  const panel = root.querySelector<HTMLElement>('[data-dir-filters]')!;
  const scrim = root.querySelector<HTMLElement>('[data-dir-scrim]')!;
  const status = () => root.querySelector<HTMLElement>('[data-dir-status]');
  const openButton = () => root.querySelector<HTMLButtonElement>('[data-open-filters]');
  const narrow = window.matchMedia('(max-width: 63.99em)');

  let controller: AbortController | null = null;
  let sequence = 0;

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
    controller?.abort();
    controller = new AbortController();
    const mine = ++sequence;
    results.setAttribute('aria-busy', 'true');
    say('Updating results…', 'loading');
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'text/html' }, credentials: 'same-origin' });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const html = await response.text();
      if (mine !== sequence) return; // a newer request owns the page now
      const next = new DOMParser().parseFromString(html, 'text/html');
      apply(next);
      if (mode === 'push') history.pushState({ directory: true }, '', url);
      else if (mode === 'replace') history.replaceState({ directory: true }, '', url);
      document.title = next.title || document.title;
      results.removeAttribute('aria-busy');
      document.dispatchEvent(new CustomEvent('directory:updated'));
      after?.();
    } catch (error) {
      if ((error as Error).name === 'AbortError' || mine !== sequence) return;
      results.removeAttribute('aria-busy');
      const el = status();
      if (el) {
        el.dataset.state = 'error';
        el.textContent = 'The results could not be updated. ';
        const link = document.createElement('a');
        link.href = url;
        link.textContent = 'Load this view again';
        el.append(link);
      }
    }
  }

  /** Swap results, counts and states from a freshly rendered page. */
  function apply(next: Document) {
    const nextResults = next.querySelector('[data-dir-results]');
    if (nextResults) {
      // Keep the live search box (and the caret in it); replace everything else.
      const keep = results.querySelector('.dir-search');
      const incoming = [...nextResults.children].filter((c) => !c.classList.contains('dir-search'));
      [...results.children].forEach((c) => {
        if (c !== keep) c.remove();
      });
      results.append(...incoming);
      const q = next.querySelector<HTMLInputElement>('[data-dir-q]');
      const liveQ = results.querySelector<HTMLInputElement>('[data-dir-q]');
      if (q && liveQ && document.activeElement !== liveQ) liveQ.value = q.value;
    }
    next.querySelectorAll<HTMLElement>('[data-count]').forEach((el) => {
      const mine = root.querySelector<HTMLElement>(`[data-count="${CSS.escape(el.dataset.count!)}"]`);
      if (mine) mine.textContent = el.textContent;
    });
    next.querySelectorAll<HTMLInputElement>('[data-facet]').forEach((input) => {
      const mine = root.querySelector<HTMLInputElement>(`[data-facet="${CSS.escape(input.dataset.facet!)}"]`);
      if (!mine) return;
      mine.checked = input.checked;
      const label = mine.closest('.fopt');
      if (label) label.toggleAttribute('data-empty', input.closest('.fopt')?.hasAttribute('data-empty') ?? false);
    });
    const all = root.querySelector<HTMLAnchorElement>('[data-all-events]');
    const nextAll = next.querySelector<HTMLAnchorElement>('[data-all-events]');
    if (all && nextAll) {
      all.href = nextAll.href;
      if (nextAll.hasAttribute('aria-current')) all.setAttribute('aria-current', 'true');
      else all.removeAttribute('aria-current');
    }
    const clear = root.querySelector<HTMLAnchorElement>('[data-clear-filters]');
    const nextClear = next.querySelector<HTMLAnchorElement>('[data-clear-filters]');
    if (clear && nextClear) clear.href = nextClear.href;
  }

  const drawerOpen = () => panel.classList.contains('is-open');

  // ── live changes ──────────────────────────────────────────────────────
  form.addEventListener('change', (event) => {
    if (!(event.target instanceof HTMLInputElement) || event.target.type !== 'checkbox') return;
    if (narrow.matches && drawerOpen()) return; // the drawer applies on "Apply"
    void navigate(urlFromForm(), 'push');
  });
  root.addEventListener('change', (event) => {
    const t = event.target;
    if (t instanceof HTMLSelectElement && t.matches('[data-dir-sort]')) void navigate(urlFromForm(), 'push');
  });

  let typing: number | undefined;
  root.addEventListener('input', (event) => {
    const t = event.target;
    if (!(t instanceof HTMLInputElement) || !t.matches('[data-dir-q]')) return;
    window.clearTimeout(typing);
    typing = window.setTimeout(() => void navigate(urlFromForm(), 'replace'), 350);
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    window.clearTimeout(typing);
    const wasOpen = drawerOpen();
    void navigate(urlFromForm(), 'push', () => {
      if (wasOpen) closeDrawer();
    });
  });

  // Links inside the directory (pagination, chip removal, "All events",
  // clear) re-render in place; the event badge and project links do not.
  root.addEventListener('click', (event) => {
    const link = (event.target as Element).closest<HTMLAnchorElement>('a');
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const inPager = link.closest('.dir-pager');
    const local = inPager || link.closest('.dir-chips') || link.matches('[data-all-events], [data-clear-filters], .dir-empty a');
    if (!local) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || url.pathname !== '/projects/') return;
    event.preventDefault();
    const wasOpen = drawerOpen();
    void navigate(url.pathname + url.search, 'push', () => {
      if (inPager) results.scrollIntoView({ block: 'start', behavior: 'smooth' });
      if (inPager) results.querySelector<HTMLElement>('.dir-count')?.focus({ preventScroll: true });
      if (wasOpen) closeDrawer();
    });
  });

  window.addEventListener('popstate', () => {
    void navigate(location.pathname + location.search, 'none', () => syncForm());
  });

  /** After back/forward, the form must say what the URL says. */
  function syncForm() {
    const params = new URLSearchParams(location.search);
    form.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((input) => {
      input.checked = params.getAll(input.name).includes(input.value);
    });
    const q = root.querySelector<HTMLInputElement>('[data-dir-q]');
    if (q) q.value = params.get('q') ?? '';
    const sort = root.querySelector<HTMLSelectElement>('[data-dir-sort]');
    if (sort) sort.value = params.get('sort') ?? 'event';
  }

  // ── the drawer ────────────────────────────────────────────────────────
  let restoreTo: HTMLElement | null = null;
  const inerted: HTMLElement[] = [];

  const focusables = () =>
    [...panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select, summary, [tabindex]:not([tabindex="-1"])')].filter(
      (el) => el.offsetParent !== null,
    );

  function openDrawer() {
    restoreTo = document.activeElement as HTMLElement | null;
    panel.classList.add('is-open');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    scrim.hidden = false;
    document.body.style.overflow = 'hidden';
    // Everything outside the panel becomes inert, at every level up to <body>
    // — except the scrim, which closes the drawer when tapped.
    let node: HTMLElement | null = panel;
    while (node && node !== document.body && node.parentElement) {
      for (const sibling of node.parentElement.children) {
        if (sibling !== node && sibling !== scrim && sibling instanceof HTMLElement && sibling.tagName !== 'SCRIPT' && !sibling.inert) {
          sibling.inert = true;
          inerted.push(sibling);
        }
      }
      node = node.parentElement;
    }
    openButton()?.setAttribute('aria-expanded', 'true');
    window.setTimeout(() => focusables()[0]?.focus(), 30);
  }

  function closeDrawer() {
    if (!drawerOpen()) return;
    panel.classList.remove('is-open');
    panel.removeAttribute('role');
    panel.removeAttribute('aria-modal');
    scrim.hidden = true;
    document.body.style.overflow = '';
    inerted.splice(0).forEach((el) => (el.inert = false));
    openButton()?.setAttribute('aria-expanded', 'false');
    (restoreTo && document.contains(restoreTo) ? restoreTo : openButton())?.focus();
  }

  root.addEventListener('click', (event) => {
    const t = event.target as Element;
    if (t.closest('[data-open-filters]')) openDrawer();
    else if (t.closest('[data-close-filters]') || t.closest('[data-dir-scrim]')) closeDrawer();
  });

  panel.addEventListener('keydown', (event) => {
    if (!drawerOpen()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDrawer();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusables();
    if (items.length === 0) return;
    const firstEl = items[0]!;
    const lastEl = items[items.length - 1]!;
    if (event.shiftKey && document.activeElement === firstEl) {
      event.preventDefault();
      lastEl.focus();
    } else if (!event.shiftKey && document.activeElement === lastEl) {
      event.preventDefault();
      firstEl.focus();
    }
  });

  // Growing back to the sidebar layout closes the drawer cleanly.
  narrow.addEventListener('change', () => {
    if (!narrow.matches) closeDrawer();
  });

  // The plain-HTML Clear link removes filters but keeps the search and sort;
  // in the drawer it also unticks the boxes so "Apply" agrees with it.
  panel.addEventListener('click', (event) => {
    if (!(event.target as Element).closest('[data-clear-filters]')) return;
    form.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((i) => (i.checked = false));
  });
}
