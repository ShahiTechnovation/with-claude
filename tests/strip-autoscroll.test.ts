/**
 * THE PHOTO STRIPS' GLIDE: src/scripts/strip-glide.ts, shared by the homepage strip
 * (home/PhotoStrip.astro) and the /builders/ and /stories/ strip (StoryStrip.astro). The module
 * runs against a stub strip and stub browser globals: one item forward every 3.5 s while on screen
 * and the tab is visible, back to the start at the end, paused by hover or focus (each holds its
 * own pause), stopped for good by a key or by a wheel or swipe aimed sideways, and never under
 * reduced motion, which it reads live. Both components are checked for the hook and the import.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const STRIPS = [
  ['src/components/home/PhotoStrip.astro', 'strip'],
  ['src/components/StoryStrip.astro', 'floor-track'],
] as const;

async function strip({ reduce = false, gap = '16px' } = {}) {
  vi.resetModules();
  const listeners = new Map<string, (e?: object) => void>();
  let onView: (entries: { isIntersecting: boolean }[]) => void = () => {};
  const el = {
    scrollLeft: 0,
    clientWidth: 800,
    scrollWidth: 2000,
    lefts: [] as number[],
    firstElementChild: { offsetWidth: 300 },
    addEventListener: (type: string, fn: (e?: object) => void) => listeners.set(type, fn),
    scrollTo({ left }: { left: number }) {
      el.lefts.push(left);
      el.scrollLeft = left;
    },
  };
  // One media query list, as the browser gives, so a test can switch reduced motion on mid-visit.
  const motion = { matches: !reduce };
  const doc = {
    hidden: false,
    // Only the real hook answers, so a renamed hook leaves the strip still and fails the tests.
    querySelectorAll: (sel: string) => (sel === '[data-autoscroll]' ? [el] : []),
  };
  vi.useFakeTimers();
  vi.stubGlobal('document', doc);
  vi.stubGlobal('matchMedia', (query: string) =>
    query === '(prefers-reduced-motion: no-preference)' ? motion : { matches: false },
  );
  vi.stubGlobal('getComputedStyle', () => ({ columnGap: gap }));
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(cb: typeof onView) {
        onView = cb;
      }
      observe() {}
    },
  );
  await import('../src/scripts/strip-glide');
  return {
    el,
    doc,
    motion,
    on: (type: string, e: object = {}) => listeners.get(type)!(e),
    view: (isIntersecting: boolean) => onView([{ isIntersecting }]),
    tick: () => vi.advanceTimersByTime(3500),
  };
}

const touch = (x: number, y: number) => ({ touches: [{ clientX: x, clientY: y }] });

describe('the strip glide', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('glides one item forward while on screen, and back to the start at the end', async () => {
    const s = await strip();
    s.tick();
    expect(s.el.lefts).toEqual([]);
    s.view(true);
    s.tick();
    s.tick();
    expect(s.el.lefts).toEqual([316, 632]);
    s.el.scrollLeft = 1200;
    s.tick();
    expect(s.el.lefts.at(-1)).toBe(0);
  });

  it('holds still off screen and in a background tab, and goes on after', async () => {
    const s = await strip();
    s.view(true);
    s.tick();
    s.view(false);
    s.tick();
    s.view(true);
    s.doc.hidden = true;
    s.tick();
    expect(s.el.lefts).toEqual([316]);
    s.doc.hidden = false;
    s.tick();
    expect(s.el.lefts).toEqual([316, 632]);
  });

  it('pauses on hover and focus, and resumes after', async () => {
    const s = await strip();
    s.view(true);
    s.on('pointerenter');
    s.tick();
    s.on('pointerleave');
    s.on('focusin');
    s.tick();
    expect(s.el.lefts).toEqual([]);
    s.on('focusout');
    s.tick();
    expect(s.el.lefts).toEqual([316]);
  });

  it('stays paused while either hover or focus still holds it', async () => {
    const s = await strip();
    s.view(true);
    // A keyboard user is on a plate; the mouse passes over the strip and leaves.
    s.on('focusin');
    s.on('pointerenter');
    s.on('pointerleave');
    s.tick();
    // The pointer comes back, then focus leaves the strip.
    s.on('pointerenter');
    s.on('focusout');
    s.tick();
    expect(s.el.lefts).toEqual([]);
    s.on('pointerleave');
    s.tick();
    expect(s.el.lefts).toEqual([316]);
  });

  it('stops for good on a sideways wheel, not on a page scroll passing over it', async () => {
    const s = await strip();
    s.view(true);
    s.on('wheel', { deltaX: 0, deltaY: 120 });
    s.tick();
    expect(s.el.lefts).toEqual([316]);
    s.on('wheel', { deltaX: 120, deltaY: 0 });
    s.tick();
    s.tick();
    expect(s.el.lefts).toEqual([316]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['a shift+wheel', 'wheel', { deltaX: 0, deltaY: 120, shiftKey: true }],
    ['a key press', 'keydown', {}],
  ])('stops for good on %s', async (_, type, e) => {
    const s = await strip();
    s.view(true);
    s.on(type, e);
    s.tick();
    expect(s.el.lefts).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps gliding when a finger scrolls the page over it, stops on a sideways swipe', async () => {
    const s = await strip();
    s.view(true);
    s.on('touchstart', touch(100, 300));
    s.on('touchmove', touch(104, 200));
    s.tick();
    expect(s.el.lefts).toEqual([316]);
    s.on('touchstart', touch(300, 300));
    s.on('touchmove', touch(200, 296));
    s.tick();
    expect(s.el.lefts).toEqual([316]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never moves under reduced motion', async () => {
    const s = await strip({ reduce: true });
    s.view(true);
    s.tick();
    expect(s.el.lefts).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops at the next tick when reduced motion is switched on mid-visit', async () => {
    const s = await strip();
    s.view(true);
    s.tick();
    s.motion.matches = false;
    s.tick();
    expect(s.el.lefts).toEqual([316]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('steps by the item alone when the strip sets no gap', async () => {
    const s = await strip({ gap: 'normal' });
    s.view(true);
    s.tick();
    expect(s.el.lefts).toEqual([300]);
  });
});

it.each(STRIPS)(
  '%s marks its scroller (.%s) data-autoscroll and loads the shared glide',
  (file, scroller) => {
    const page = readFileSync(file, 'utf8');
    const tag = page.match(/<\w+\b[^>]*\bdata-autoscroll\b[^>]*>/)?.[0];
    expect(tag).toMatch(new RegExp(`\\bclass="${scroller}"`));
    expect(page).toMatch(/<script>\s*import '@\/scripts\/strip-glide';/);
    // No pasted copy of the glide left behind in the component.
    expect(page).not.toMatch(/setInterval|IntersectionObserver/);
  },
);

it('the /builders/ and /stories/ photos rest in the same black and white as the homepage strip', () => {
  const rest = (file: string) =>
    readFileSync(file, 'utf8').match(/filter: (grayscale\([^;]*);/)?.[1];
  expect(rest(STRIPS[0][0])).toBe('grayscale(1) brightness(0.92)');
  expect(rest(STRIPS[1][0])).toBe(rest(STRIPS[0][0]));
});
