/**
 * THE COMMUNITY GLOBE: the hand-and-globe drawing above "Want a room in your city?".
 *
 * It plays once when it scrolls into view. The markup is the finished drawing, so the
 * start state exists only once the script has armed it, and the script arms it only
 * for visitors who have not asked for reduced motion.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const globe = source('src/components/CommunityGlobe.astro');
const join = source('src/components/home/JoinBand.astro');
const script = globe.match(/<script is:inline>([\s\S]*?)<\/script>/)?.[1] ?? '';
const style = globe.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';

describe('the community globe', () => {
  it('never runs forever', () => {
    expect(globe).not.toMatch(/\binfinite\b/);
  });

  it('is decorative', () => {
    expect(globe).toMatch(/<figure class="cg" aria-hidden="true">/);
    expect(globe).not.toMatch(/<(text|title|figcaption)\b/);
  });

  it('arms the start state only under no-preference, then plays once in view', () => {
    const gate = script.indexOf("matchMedia('(prefers-reduced-motion: no-preference)').matches");
    const arm = script.indexOf("classList.add('is-armed')");
    expect(gate).toBeGreaterThan(-1);
    expect(arm).toBeGreaterThan(gate);
    expect(script).toContain('new IntersectionObserver');
    expect(script).toContain('io.disconnect()');
  });

  it('keeps every animation inside the reduced-motion gate and behind the armed class', () => {
    const gated = style.split('@media (prefers-reduced-motion: no-preference)');
    expect(gated).toHaveLength(2);
    expect(gated[0]).not.toMatch(/animation\s*:|stroke-dash/);
    const rules = gated[1].split('@keyframes')[0];
    const animated = [...rules.matchAll(/([^{}]+)\{[^{}]*animation:/g)].map((m) => m[1]);
    expect(animated.length).toBeGreaterThan(3);
    for (const selector of animated) expect(selector).toContain('.cg.is-armed');
  });

  it('holds every animated part until it plays, with selectors as specific as the animations', () => {
    const rules = style.split('@keyframes')[0].replace(/\/\*[\s\S]*?\*\//g, '');
    const list = (state: string) =>
      (rules.match(new RegExp(`([^{}]+)\\{\\s*animation-play-state: ${state};`))?.[1] ?? '')
        .split(',')
        .map((s) => s.trim());
    const paused = list('paused');
    const running = list('running');
    const parts = [...rules.matchAll(/\.cg\.is-armed ([^,{]+?)\s*\{[^{}]*animation:/g)].map(
      (m) => m[1],
    );
    expect(parts.length).toBe(4);
    expect(rules).not.toMatch(/:is\(/);
    for (const part of parts) {
      expect(paused).toContain(`.cg.is-armed ${part}`);
      expect(running).toContain(`.cg.is-playing ${part}`);
    }
  });

  it('sits in the join band above its heading', () => {
    expect(join).toContain("import CommunityGlobe from '@/components/CommunityGlobe.astro';");
    expect(join.indexOf('<CommunityGlobe />')).toBeGreaterThan(-1);
    expect(join.indexOf('<CommunityGlobe />')).toBeLessThan(join.indexOf('id="join-heading"'));
  });
});
