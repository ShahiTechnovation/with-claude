/**
 * Progressive enhancement.
 *
 * Everything here is additive: with this file blocked, the page is still
 * complete, readable and navigable. Nothing is hidden waiting for JS.
 */

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Reveal-on-scroll. One observer for the whole document. */
function initReveals(): void {
  const targets = document.querySelectorAll<HTMLElement>('[data-reveal]');
  if (!targets.length) return;

  if (prefersReducedMotion() || !('IntersectionObserver' in window)) {
    targets.forEach((el) => el.classList.add('is-revealed'));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-revealed');
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -10% 0px', threshold: 0 },
  );

  targets.forEach((el) => observer.observe(el));
}

/**
 * The meridian draws itself as you travel down the page. One passive scroll
 * listener, coalesced into a frame — this is the site's signature device, so
 * it earns its handful of bytes.
 */
function initMeridian(): void {
  const meridian = document.querySelector<HTMLElement>('.meridian');
  if (!meridian || prefersReducedMotion()) return;

  let ticking = false;

  const update = () => {
    ticking = false;
    const rect = meridian.getBoundingClientRect();
    const travel = rect.height - window.innerHeight;
    if (travel <= 0) {
      meridian.style.setProperty('--meridian-progress', '1');
      return;
    }
    const scrolled = Math.min(Math.max(-rect.top, 0), travel);
    const progress = scrolled / travel;
    meridian.style.setProperty('--meridian-progress', progress.toFixed(4));
  };

  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(update);
  };

  update();
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
}

/** Sticky masthead: condenses once you leave the hero. */
function initMasthead(): void {
  const masthead = document.querySelector<HTMLElement>('[data-masthead]');
  if (!masthead) return;

  const sentinel = document.createElement('div');
  sentinel.setAttribute('aria-hidden', 'true');
  sentinel.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:1px';
  document.body.prepend(sentinel);

  if (!('IntersectionObserver' in window)) return;

  new IntersectionObserver(
    ([entry]) => masthead.classList.toggle('is-condensed', !entry?.isIntersecting),
    { rootMargin: '-88px 0px 0px 0px' },
  ).observe(sentinel);
}

/** Mobile navigation drawer. */
function initNavToggle(): void {
  const toggle = document.querySelector<HTMLButtonElement>('[data-nav-toggle]');
  const drawer = document.querySelector<HTMLElement>('[data-nav-drawer]');
  if (!toggle || !drawer) return;

  const setOpen = (open: boolean) => {
    toggle.setAttribute('aria-expanded', String(open));
    drawer.toggleAttribute('data-open', open);
    document.documentElement.style.overflow = open ? 'hidden' : '';
  };

  toggle.addEventListener('click', () => {
    setOpen(toggle.getAttribute('aria-expanded') !== 'true');
  });

  drawer.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('a')) setOpen(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
      setOpen(false);
      toggle.focus();
    }
  });
}

/**
 * Archival plates.
 *
 * The photograph behaves like a print held between two fingers: it shifts a
 * little, tilts a degree or so, and its shadow moves the other way. All of the
 * displacement lives in two CSS custom properties, so the stylesheet owns how
 * far a degree goes and this only reports where the pointer is.
 *
 * Fine pointers only. There is nothing here to feel through a fingertip, and
 * a tilt that fires on tap would read as a bug.
 */
function initArchivalPlates(): void {
  const plates = document.querySelectorAll<HTMLElement>('[data-archival]');
  if (!plates.length) return;
  if (prefersReducedMotion()) return;
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

  const clamp = (n: number) => Math.min(Math.max(n, -1), 1);

  plates.forEach((figure) => {
    const surface = figure.querySelector<HTMLElement>('.plate');
    if (!surface) return;

    let frame = 0;
    let last: PointerEvent | null = null;

    const apply = () => {
      frame = 0;
      if (!last) return;
      const box = surface.getBoundingClientRect();
      if (!box.width || !box.height) return;
      figure.style.setProperty(
        '--tilt-x',
        clamp(((last.clientX - box.left) / box.width) * 2 - 1).toFixed(3),
      );
      figure.style.setProperty(
        '--tilt-y',
        clamp(((last.clientY - box.top) / box.height) * 2 - 1).toFixed(3),
      );
    };

    figure.addEventListener(
      'pointermove',
      (event) => {
        if (event.pointerType === 'touch') return;
        last = event;
        figure.classList.add('is-held');
        if (!frame) frame = requestAnimationFrame(apply);
      },
      { passive: true },
    );

    figure.addEventListener('pointerleave', () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      last = null;
      figure.classList.remove('is-held');
      figure.style.setProperty('--tilt-x', '0');
      figure.style.setProperty('--tilt-y', '0');
    });
  });
}

/**
 * WITH — the connection index.
 *
 * Each strand publishes what it is connected to. Only one preview is shown at
 * a time and they are all server-rendered, so with scripts blocked the first
 * strand's preview stands and every row is still an ordinary link.
 *
 * Hover drives it on a fine pointer; focus drives it everywhere, which is what
 * makes the thing usable from a keyboard rather than merely non-broken.
 */
function initWithIndex(): void {
  const roots = document.querySelectorAll<HTMLElement>('[data-with]');
  if (!roots.length) return;

  const canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  roots.forEach((root) => {
    const links = root.querySelectorAll<HTMLElement>('[data-with-link]');
    const previews = root.querySelectorAll<HTMLElement>('[data-with-preview]');
    if (!links.length || !previews.length) return;

    const show = (key: string) => {
      links.forEach((link) => link.classList.toggle('is-active', link.dataset.withLink === key));
      previews.forEach((panel) => {
        const on = panel.dataset.withPreview === key;
        panel.toggleAttribute('data-active', on);
        panel.setAttribute('aria-hidden', String(!on));
      });
    };

    const from = (event: Event): string | undefined =>
      (event.target as Element | null)?.closest<HTMLElement>('[data-with-link]')?.dataset.withLink;

    if (canHover) {
      root.addEventListener(
        'pointerover',
        (event) => {
          const key = from(event);
          if (key) show(key);
        },
        { passive: true },
      );
    }

    root.addEventListener('focusin', (event) => {
      const key = from(event);
      if (key) show(key);
    });
  });
}

function boot(): void {
  // Claims the document, cancelling the layout's un-hide safety net.
  document.documentElement.classList.add('enhanced');
  initReveals();
  initMeridian();
  initMasthead();
  initNavToggle();
  initArchivalPlates();
  initWithIndex();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
