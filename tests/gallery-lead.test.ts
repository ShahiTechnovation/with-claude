/**
 * At three columns (1100px and up) the 2x2 lead on /gallery/ fills its two rows like every other
 * spanning tile. Left out of the stretch rules, its own 3:2 frame ended a third of a gap short of
 * the two tiles beside it: a 6.6px step under the lead in ten rooms.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('the gallery lead tile', () => {
  it('stretches to its grid area at three columns', () => {
    const page = readFileSync('src/pages/gallery.astro', 'utf8').replace(/\s+/g, ' ');
    const wide = page.slice(page.indexOf('@media (min-width: 1100px)'));
    expect(wide).toContain(':is(.h3-2, .w3-2) { align-self: stretch; }');
    expect(wide).toContain(':is(.h3-2, .w3-2) :is(figure, .frame) { height: 100%; }');
  });
});
