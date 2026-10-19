/**
 * The photo strips' glide, shared by the homepage strip (home/PhotoStrip.astro) and the /builders/
 * and /stories/ strip (StoryStrip.astro). Each marks its sideways scroller `data-autoscroll`; the
 * scroller's first child sets the step.
 *
 * One item forward every 3.5 s while the strip is half on screen and the tab is visible, back to
 * the start at the end. Hover or focus pauses it, each holding its own pause. Any key pressed in
 * the strip, or a wheel or swipe aimed sideways at it, stops it for good. Reduced motion is read
 * live: on at load, it never moves; switched on mid-visit, it stops at the next tick. Without
 * JS the strip is a plain sideways scroller.
 */
const motion = matchMedia('(prefers-reduced-motion: no-preference)');

export function glide(strip: HTMLElement): void {
  let visible = false;
  let hovered = false;
  let focused = false;
  let stopped = false;
  new IntersectionObserver(([entry]) => (visible = entry.isIntersecting), {
    threshold: 0.5,
  }).observe(strip);
  // Two flags, so the pointer leaving does not end a pause that focus inside still holds.
  strip.addEventListener('pointerenter', () => (hovered = true));
  strip.addEventListener('pointerleave', () => (hovered = false));
  strip.addEventListener('focusin', () => (focused = true));
  strip.addEventListener('focusout', () => (focused = false));
  // Any key pressed inside the strip, or a wheel or swipe aimed sideways at it, stops it for
  // good; a wheel or swipe that scrolls the page past it does not.
  const stop = () => (stopped = true);
  strip.addEventListener('keydown', stop);
  strip.addEventListener(
    'wheel',
    (e) => (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) && stop(),
    { passive: true },
  );
  let x0 = 0;
  let y0 = 0;
  strip.addEventListener(
    'touchstart',
    (e) => ([x0, y0] = [e.touches[0].clientX, e.touches[0].clientY]),
    { passive: true },
  );
  strip.addEventListener(
    'touchmove',
    (e) => Math.abs(e.touches[0].clientX - x0) > Math.abs(e.touches[0].clientY - y0) && stop(),
    { passive: true },
  );
  const timer = setInterval(() => {
    if (stopped || !motion.matches) return clearInterval(timer);
    if (!visible || hovered || focused || document.hidden) return;
    const item = strip.firstElementChild as HTMLElement | null;
    if (!item) return;
    // `normal` (no gap set) parses to NaN, which would send every step back to 0.
    const step = item.offsetWidth + (parseFloat(getComputedStyle(strip).columnGap) || 0);
    const atEnd = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 4;
    strip.scrollTo({ left: atEnd ? 0 : strip.scrollLeft + step, behavior: 'smooth' });
  }, 3500);
}

if (motion.matches) document.querySelectorAll<HTMLElement>('[data-autoscroll]').forEach(glide);
