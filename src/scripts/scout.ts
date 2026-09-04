/**
 * THE SCOUT — gaze engine.
 *
 * One pointer listener for the document, one animation frame while anything is
 * still moving, and nothing at all on a coarse pointer or under reduced
 * motion. The figure itself is drawn by `src/components/Scout.astro`.
 *
 * Three things can hold the scout's attention, in order of priority:
 *
 *   1. A fixed point published by another island — the atlas dispatches one
 *      when you hover a city (`scout:look` / `scout:release`).
 *   2. An element marked `data-scout-target`: the handful of controls on the
 *      page that actually matter.
 *   3. The pointer itself.
 *
 * After a couple of seconds without movement it lets go and settles. The loop
 * stops the moment every channel has arrived, so a page nobody is touching
 * costs nothing.
 */

/** Plate units the eyes travel from centre. */
const MAX_EYE = 3.4;
/** Degrees of lean, pivoted at the feet. */
const MAX_LEAN = 4.5;
/** Plate units the body shifts with the lean. */
const MAX_SHIFT = 1.5;
/** Distance, in CSS pixels, at which the scout notices you. */
const ALERT_RADIUS = 230;
/** Distance below which the eyes converge rather than point. */
const NEAR = 66;
/** Pointer stillness before the scout goes back to rest. */
const REST_AFTER = 2600;
/** Per-frame approach. Slow enough to read as a head turn, not a snap. */
const EASE = 0.16;

interface Channels {
  ex: number;
  ey: number;
  lean: number;
  shift: number;
}

interface Scout {
  root: SVGGElement;
  anchor: SVGGraphicsElement;
  lean: SVGGElement;
  eyes: SVGGElement;
  sight: SVGGElement;
  seen: boolean;
  now: Channels;
  aim: Channels;
}

interface Aim {
  x: number;
  y: number;
  /** A named target earns the sightline; a drifting cursor does not. */
  fixed: boolean;
  /**
   * Who set it. A pin from a marked control is dropped the moment the pointer
   * leaves it, but one published by another island is that island's to
   * release — otherwise the pointer event that follows would cancel the look
   * it just asked for.
   */
  source?: 'control' | 'island';
}

const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max);
const rest = (): Channels => ({ ex: 0, ey: 0, lean: 0, shift: 0 });

const scouts: Scout[] = [];

/** What has the scouts' attention right now, or null for "nothing". */
let aim: Aim | null = null;
/** A point published by another island, or a marked control. Outranks the cursor. */
let pinned: Aim | null = null;
/** The last raw pointer position, so releasing a pin can fall back to it. */
let pointer: { x: number; y: number } | null = null;

let frame = 0;
let idle = 0;

function collect(root: SVGGElement): Scout | null {
  const anchor = root.querySelector<SVGGraphicsElement>('[data-scout-anchor]');
  const lean = root.querySelector<SVGGElement>('[data-scout-lean]');
  const eyes = root.querySelector<SVGGElement>('[data-scout-eyes]');
  const sight = root.querySelector<SVGGElement>('[data-scout-sight]');
  if (!anchor || !lean || !eyes || !sight) return null;
  return { root, anchor, lean, eyes, sight, seen: true, now: rest(), aim: rest() };
}

/** Work out where one scout should be looking, and set its target channels. */
function retarget(scout: Scout): void {
  if (!aim) {
    scout.aim = rest();
    scout.root.classList.remove('is-alert', 'is-fixed');
    return;
  }

  const box = scout.anchor.getBoundingClientRect();
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  const dx = aim.x - cx;
  const dy = aim.y - cy;
  const dist = Math.hypot(dx, dy);

  // Close up there is no direction worth pointing in, so the eyes come back to
  // centre rather than swinging as the cursor crosses the face.
  const reach = dist < 0.001 ? 0 : (MAX_EYE * Math.min(1, dist / NEAR)) / dist;
  scout.aim.ex = dx * reach;
  scout.aim.ey = dy * reach;

  const side = clamp(dx / 280, -1, 1);
  scout.aim.lean = side * MAX_LEAN;
  scout.aim.shift = side * MAX_SHIFT;

  scout.root.classList.toggle('is-alert', aim.fixed || dist < ALERT_RADIUS);
  scout.root.classList.toggle('is-fixed', aim.fixed);
}

function paint(scout: Scout): boolean {
  const { now, aim: want } = scout;
  let moving = false;

  for (const key of ['ex', 'ey', 'lean', 'shift'] as const) {
    const delta = want[key] - now[key];
    if (Math.abs(delta) < 0.004) {
      now[key] = want[key];
      continue;
    }
    now[key] += delta * EASE;
    moving = true;
  }

  scout.eyes.setAttribute('transform', `translate(${now.ex.toFixed(2)} ${now.ey.toFixed(2)})`);
  scout.lean.setAttribute(
    'transform',
    `rotate(${now.lean.toFixed(2)} 0 26.5) translate(${now.shift.toFixed(2)} 0)`,
  );

  // The sightline takes its angle from the smoothed gaze, so it turns with the
  // eyes instead of snapping to each new target.
  if (Math.hypot(now.ex, now.ey) > 0.05) {
    const deg = (Math.atan2(now.ey, now.ex) * 180) / Math.PI;
    scout.sight.setAttribute('transform', `rotate(${deg.toFixed(1)})`);
  }

  return moving;
}

function tick(): void {
  frame = 0;
  let moving = false;

  for (const scout of scouts) {
    if (!scout.seen) continue;
    retarget(scout);
    if (paint(scout)) moving = true;
  }

  if (moving) request();
}

function request(): void {
  if (frame) return;
  frame = requestAnimationFrame(tick);
}

/** True while a target is somewhere a scout could plausibly be looking. */
function onScreen(rect: DOMRect): boolean {
  return (
    rect.bottom > 0 &&
    rect.top < window.innerHeight &&
    rect.right > 0 &&
    rect.left < window.innerWidth
  );
}

/** The pointer has gone quiet: hold any pin, otherwise look at nothing. */
function settle(): void {
  aim = pinned;
  request();
}

function refresh(): void {
  if (pinned) aim = pinned;
  else if (pointer) aim = { x: pointer.x, y: pointer.y, fixed: false };
  request();
}

function initScouts(): void {
  const nodes = document.querySelectorAll<SVGGElement>('[data-scout]');
  if (!nodes.length) return;

  const motionOk = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (!motionOk || !canHover) return;

  nodes.forEach((node) => {
    const scout = collect(node);
    if (scout) scouts.push(scout);
  });
  if (!scouts.length) return;

  // A scout off screen is not thinking about anything.
  if ('IntersectionObserver' in window) {
    const scope = (scout: Scout): Element => scout.root.closest('.atlas') ?? scout.root;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const scout = scouts.find((s) => scope(s) === entry.target);
          if (scout) scout.seen = entry.isIntersecting;
        }
        request();
      },
      { rootMargin: '120px' },
    );
    scouts.forEach((s) => observer.observe(scope(s)));
  }

  document.addEventListener(
    'pointermove',
    (event) => {
      if (event.pointerType === 'touch') return;
      pointer = { x: event.clientX, y: event.clientY };
      refresh();
      window.clearTimeout(idle);
      idle = window.setTimeout(settle, REST_AFTER);
    },
    { passive: true },
  );

  // Marked controls outrank the bare cursor: the scout looks at the thing you
  // are about to press, not at your hand.
  document.addEventListener(
    'pointerover',
    (event) => {
      if (event.pointerType === 'touch') return;
      const target = (event.target as Element | null)?.closest<HTMLElement>('[data-scout-target]');
      if (!target) {
        if (pinned?.source === 'control') pinned = null;
        refresh();
        return;
      }
      const rect = target.getBoundingClientRect();
      if (!onScreen(rect)) return;
      pinned = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        fixed: true,
        source: 'control',
      };
      refresh();
    },
    { passive: true },
  );

  // Published by the atlas when a city takes hover or focus.
  document.addEventListener('scout:look', (event) => {
    const point = (event as CustomEvent<{ x: number; y: number }>).detail;
    if (!point) return;
    pinned = { x: point.x, y: point.y, fixed: true, source: 'island' };
    refresh();
  });

  document.addEventListener('scout:release', () => {
    pinned = null;
    refresh();
  });

  window.addEventListener('blur', () => {
    pinned = null;
    pointer = null;
    settle();
  });

  request();
}

initScouts();
