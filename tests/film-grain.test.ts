/**
 * THE MOVING FILM GRAIN (src/styles/base.css): the fixed layer overhangs the viewport, and no
 * keyframe shifts it further than that overhang, so an edge of the grain never shows.
 */
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('never shifts the grain layer further than it overhangs the viewport', () => {
  const css = readFileSync('src/styles/base.css', 'utf8');
  const overhang = -Number(css.match(/body::after \{[^}]*?inset: (-\d+)px;/)![1]);
  const keyframes = css.match(/@keyframes grain \{([\s\S]*?)\n\}/)![1];
  // Every px value in the keyframes, so translate3d(), translateX/Y(), the `translate`
  // property and decimals all count.
  const shifts = [...keyframes.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map((m) => Math.abs(Number(m[1])));
  expect(shifts.length).toBeGreaterThan(0);
  expect(Math.max(...shifts)).toBeLessThan(overhang);
});
