/**
 * THE HERO MIST: the WebGL clay smoke over the sun.
 *
 * It eases in on load, keeps a slow drift while the hero is on screen, and the visitor's scroll
 * moves it further. Reduced motion gets one still frame.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INTRO_MS, mistTime, rgbTriplet } from '../src/lib/mist';

describe('the hero mist', () => {
  it('eases in on top of the drift, then drifts at a steady pace', () => {
    const at = (ms: number) => mistTime(ms, 0, false);
    expect(at(0)).toBeLessThan(at(INTRO_MS / 4));
    expect(at(INTRO_MS / 4)).toBeLessThan(at(INTRO_MS));
    const intro = at(INTRO_MS) - at(0);
    const next = at(INTRO_MS * 2) - at(INTRO_MS);
    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThan(intro);
    expect(at(INTRO_MS * 20) - at(INTRO_MS * 19)).toBeCloseTo(next);
  });

  it('follows the scroll, during the intro and after it', () => {
    for (const ms of [0, INTRO_MS / 2, INTRO_MS * 3]) {
      const rest = mistTime(ms, 0, false);
      expect(mistTime(ms, 0.5, false)).toBeGreaterThan(rest);
      expect(mistTime(ms, 0.5, false) - rest).toBeCloseTo(
        mistTime(0, 0.5, false) - mistTime(0, 0, false),
      );
    }
  });

  it('is one still frame under reduced motion: the intro end pose, deaf to the scroll', () => {
    const still = mistTime(0, 0, true);
    expect(still).toBe(mistTime(INTRO_MS, 0, false));
    expect(mistTime(INTRO_MS * 10, 2, true)).toBe(still);
  });

  it('reads the glow tokens as shader colour', () => {
    expect(rgbTriplet(' 217 119 87')).toEqual([217 / 255, 119 / 255, 87 / 255]);
  });

  it('is decorative', () => {
    const hero = readFileSync('src/components/Hero.astro', 'utf8');
    expect(hero).toMatch(
      /<div class="sky" aria-hidden="true">[\s\S]*?<canvas class="mist"><\/canvas>\s*<\/div>/,
    );
  });
});

/**
 * Loads the island against stub browser globals. Returns its queued frames, listeners, draws
 * and shader times, a switch that loses the WebGL context, and one that flips reduced motion.
 */
async function island(reduce: boolean) {
  vi.resetModules();
  const frames: FrameRequestCallback[] = [];
  const listeners = new Map<string, () => void>();
  const times: number[] = [];
  let draws = 0;
  let lost = false;
  const motion = { matches: !reduce, onchange: () => {} };
  const gl = new Proxy({} as Record<string, unknown>, {
    get: (_, k) =>
      k === 'getProgramParameter'
        ? () => true
        : k === 'isContextLost'
          ? () => lost
          : k === 'drawArrays'
            ? () => draws++
            : k === 'getUniformLocation'
              ? (_program: unknown, name: string) => name
              : k === 'uniform1f'
                ? (at: string, v: number) => at === 'u_time' && times.push(v)
                : () => ({}),
  });
  const canvas = {
    clientWidth: 100,
    clientHeight: 50,
    classList: { add() {} },
    getContext: () => gl,
  };
  const observer = class {
    observe() {}
  };
  for (const [name, value] of Object.entries({
    window: globalThis,
    document: { readyState: 'complete', querySelector: () => canvas, documentElement: {} },
    requestIdleCallback: (cb: () => void) => cb(),
    requestAnimationFrame: (cb: FrameRequestCallback) => frames.push(cb),
    matchMedia: () => ({
      get matches() {
        return motion.matches;
      },
      addEventListener: (_: string, fn: () => void) => (motion.onchange = fn),
    }),
    getComputedStyle: () => ({ getPropertyValue: () => '1 1 1' }),
    addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
    performance: { now: () => 0 },
    scrollY: 0,
    innerHeight: 800,
    ResizeObserver: observer,
    MutationObserver: observer,
  }))
    vi.stubGlobal(name, value);
  await import('../src/scripts/hero-mist');
  const loseContext = () => (lost = true);
  const allowMotion = (allowed: boolean) => {
    motion.matches = allowed;
    motion.onchange();
  };
  return { frames, listeners, times, loseContext, allowMotion, draws: () => draws };
}

describe('the hero mist island', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('draws one still frame under reduced motion, and no scroll or resize starts a loop', async () => {
    const { frames, listeners, times } = await island(true);
    expect(times.at(-1)).toBe(mistTime(0, 0, true));
    for (const fn of listeners.values()) fn();
    expect(frames).toHaveLength(0);
  });

  it('follows reduced motion turned on and off mid-visit', async () => {
    const { frames, listeners, times, draws, allowMotion } = await island(false);
    let now = 0;
    while (now < INTRO_MS * 2) frames.shift()!((now += 16));
    const moving = times.at(-1)!;
    // Reduce: the still frame at once, then the pending frame ends the loop without a draw.
    allowMotion(false);
    expect(times.at(-1)).toBe(mistTime(0, 0, true));
    const before = draws();
    frames.shift()!((now += 16));
    expect(frames).toHaveLength(0);
    for (const fn of listeners.values()) fn();
    expect(frames).toHaveLength(0);
    expect(draws()).toBe(before);
    // Motion allowed again: the drift picks up where it stopped (within a capped step), not at
    // the still pose.
    allowMotion(true);
    expect(frames).toHaveLength(1);
    frames.shift()!((now += 16));
    expect(times.at(-1)!).toBeGreaterThan(moving);
    expect(times.at(-1)! - moving).toBeLessThan(0.5);
    expect(frames).toHaveLength(1);
  });

  it('keeps drifting past the intro, one draw per frame, while the hero is on screen', async () => {
    const { frames, times, draws } = await island(false);
    let now = 0;
    while (frames.length && now < 10_000) frames.shift()!((now += 16));
    expect(frames).toHaveLength(1);
    const at10s = times.at(-1)!;
    expect(at10s).toBeGreaterThan(mistTime(INTRO_MS, 0, false));
    const before = draws();
    frames.shift()!((now += 16));
    expect(draws()).toBe(before + 1);
    expect(times.at(-1)!).toBeGreaterThan(at10s);
  });

  it('stops its loop while the hero is scrolled away, and the scroll back restarts it once', async () => {
    const { frames, listeners, draws } = await island(false);
    const scroll = listeners.get('scroll')!;
    let now = 0;
    frames.shift()!((now += 16));
    vi.stubGlobal('scrollY', 800);
    const before = draws();
    frames.shift()!((now += 16));
    expect(frames).toHaveLength(0);
    scroll();
    expect(frames).toHaveLength(0);
    expect(draws()).toBe(before);
    // Back on screen: two scroll events in one frame restart one loop.
    vi.stubGlobal('scrollY', 400);
    scroll();
    scroll();
    expect(frames).toHaveLength(1);
    frames.shift()!((now += 16));
    expect(draws()).toBe(before + 1);
    expect(frames).toHaveLength(1);
  });

  it('stops its loop when the WebGL context is lost', async () => {
    const { frames, loseContext } = await island(false);
    frames.shift()!(16);
    loseContext();
    frames.shift()!(32);
    expect(frames).toHaveLength(0);
  });

  it('restarts when a resize brings the hero back without a scroll', async () => {
    const { frames, listeners } = await island(false);
    vi.stubGlobal('scrollY', 800);
    frames.shift()!(16);
    expect(frames).toHaveLength(0);
    // A taller window (or a phone turned upright): the hero is on screen again.
    vi.stubGlobal('innerHeight', 1000);
    listeners.get('resize')!();
    expect(frames).toHaveLength(1);
  });

  it('resumes where it was after a long pause, such as a hidden tab', async () => {
    const { frames, times } = await island(false);
    let now = 0;
    while (now < INTRO_MS * 2) frames.shift()!((now += 16));
    const before = times.at(-1)!;
    frames.shift()!((now += 60_000));
    // One capped step, not the minute: unclamped, the mist would leap a minute of drift.
    expect(times.at(-1)! - before).toBeLessThan(0.5);
  });
});
