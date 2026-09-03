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

function boot(): void {
  // Claims the document, cancelling the layout's un-hide safety net.
  document.documentElement.classList.add('enhanced');
  initReveals();
  initMeridian();
  initMasthead();
  initNavToggle();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
