/**
 * THE DIRECTORY LOOK: what `directory.css` may and may not do.
 *
 * The directory is set in the site's language (tokens.css): pills, the serif
 * and sans pair, 15px at the smallest, sentence case, no monospace.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const css = read('src/styles/directory.css');
/** The body of the first top-level rule for `selector`. */
const rule = (selector: string) =>
  css.match(new RegExp(`\\n${selector.replace(/[.[\]()*+?^$|]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ??
  '';

describe('the directory look', () => {
  it('the old row list is gone: projects render as cards everywhere', () => {
    expect(css).not.toMatch(/\.(prow|badge-event|meta-chip|dir-list|dir-clear)\b/);
  });

  it("colours and radii come from the site's tokens", () => {
    const tokens = read('src/styles/tokens.css');
    // No raw hex and no radius the site does not have.
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/border-radius:\s*(\d+px|999)/);
    // The DIRECTORY SURFACES aliases are gone (panel, dir, logo and radius), and the pill
    // radius exists.
    expect(tokens).not.toMatch(/DIRECTORY SURFACES|--panel|--dir-|--logo-|--radius-chip/);
    expect(tokens).toMatch(/--radius-pill: 999px;/);
    expect(css).not.toMatch(/var\(--(panel|logo-)/);
  });

  it('there is no monospace, no uppercase, no tracking and nothing under 15px', () => {
    const base = read('src/layouts/Base.astro');
    const tokens = read('src/styles/tokens.css');
    expect(base).not.toMatch(/ibm-plex-mono/i);
    expect(tokens).not.toMatch(/--font-mono/);

    expect(css).not.toMatch(
      /--font-mono|text-transform:\s*uppercase|letter-spacing:\s*0\.\d*[1-9]/,
    );
    expect(css).not.toMatch(/--t-micro|--t-meta|--dir-text|--track-meta/);
    // Literal sizes are rem or px at 15px and up; the rest are type tokens.
    for (const [, value] of css.matchAll(/font-size:\s*([^;]+);/g)) {
      expect(value, value).toMatch(/^var\(--t-[a-z0-9-]+\)$|^clamp\(/);
      // A clamp's floor is its smallest size.
      const floor = value.match(/^clamp\(\s*([\d.]+)(rem|px)/);
      if (value.startsWith('clamp(')) {
        expect(floor, value).not.toBeNull();
        expect(Number(floor![1]) * (floor![2] === 'rem' ? 16 : 1), value).toBeGreaterThanOrEqual(
          15,
        );
      }
    }
  });

  it('the display serif is left to headings: the directory sets no serif of its own', () => {
    expect(css).not.toMatch(/--font-display/);
  });

  it('the toolbar is sticky only from 1100px, on the header ground, and anchors land below both bars', () => {
    const wide = css.slice(css.indexOf('@media (min-width: 1100px)'));
    expect(rule('.dir-bar')).not.toMatch(/position:\s*sticky/);
    const bar = wide.match(/\.dir-bar \{([^}]*)\}/)?.[1] ?? '';
    expect(bar).toContain('position: sticky');
    expect(bar).toContain('top: var(--nav-h)');
    expect(bar).toContain('height: var(--dir-tools-h)');
    // The sweep raises --nav-bg's alpha for AA; the toolbar must follow the token.
    expect(bar).toContain('background: var(--nav-bg)');
    // The root's scroll-padding stays over the header only: stretched over the toolbar, a
    // focused search box or pill counts as hidden and Chrome scrolls the page to it. The bar's
    // controls sit inside the padding; what lies below (cards and anchors) clears the bar.
    expect(css).not.toMatch(/scroll-padding-top/);
    expect(wide).toMatch(/:root:has\(\[data-directory\]\) \{\s*--dir-stuck: var\(--dir-tools-h\);/);
    expect(wide).toMatch(/\.dir-bar \* \{\s*scroll-margin-top: -1rem;/);
    expect(wide).toMatch(
      /\.dir-bar ~ \*,\s*\.dir-bar ~ \* \* \{\s*scroll-margin-top: var\(--dir-stuck\);/,
    );
    expect(read('src/components/ProjectCard.astro')).toContain(
      'scroll-margin-top: calc(40px + var(--dir-stuck, 0px));',
    );
    expect(css).toMatch(/:root:has\(\[data-directory\]\) \{\s*--dir-tools-h: 74px;/);
  });

  it('the event pills keep their focus ring inside the scroll box, and the hidden radio inside the pill', () => {
    const events = rule('.dir-events');
    expect(events).toContain('overflow-x: auto');
    expect(events).toMatch(/margin: -5px/);
    expect(events).toMatch(/padding: 5px/);
    expect(rule('.dir-pill')).toContain('position: relative');
    expect(rule('.dir-pill:has(input:focus-visible)')).toContain('outline: 2px solid var(--focus)');
  });

  it('the empty status line stays rendered, so its live region is in the tree before it speaks', () => {
    expect(rule('.dir-status:empty')).toMatch(/^\s*margin: 0;\s*$/);
    expect(css).not.toMatch(/\.dir-status[^{]*\{[^}]*display: none/);
  });

  it('the page wires every hook directory.ts needs, and the Apply button shows only without JS', () => {
    const page = read('src/pages/projects/index.astro');
    for (const hook of [
      'data-directory',
      'id="dir-form"',
      'data-dir-results',
      'data-dir-swap',
      'data-dir-count',
      'data-dir-status',
      'data-dir-q',
      'data-dir-category',
    ]) {
      expect(page, hook).toContain(hook);
    }
    expect(page).toMatch(/<button class="btn btn-sm no-js-only" type="submit">/);
    expect(page).toContain('type="radio"');
    expect(page).toContain('name="event"');
    expect(page).toContain('name="category"');
    expect(page).toContain('placeholder="Search projects"');
  });
});
