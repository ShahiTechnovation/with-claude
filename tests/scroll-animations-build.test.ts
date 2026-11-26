import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every scroll-driven animation survives the CSS minifier.
 *
 * Since Vite 8 (PR #59) the build minifies CSS with Lightning CSS, which rewrites any rule that
 * pairs an `animation` shorthand with an `animation-timeline` longhand. It either writes the
 * shorthand out as longhands with `animation-duration: 0s`, which Chrome holds on the last frame,
 * or folds the timeline into the shorthand (`animation: linear both rise view()`), which Chrome
 * drops whole. The source stays correct and the dev server never minifies, so only the build shows
 * it: the home page went live with the hero copy invisible. `animation-duration: auto` after each
 * shorthand stops both rewrites (THE REVEAL in src/styles/base.css).
 *
 * Read from the build: its CSS files, the inline `<style>` of its HTML, and the server function,
 * where small stylesheets of on-demand pages such as `/` are inlined.
 */

/** Whichever build output is on disk (the lookup in tests/admin-isolation.test.ts). */
function publicClientDir(): string | undefined {
  for (const dir of ['dist/client', '.vercel/output/static', 'dist']) {
    try {
      if (statSync(dir).isDirectory()) {
        if (dir === 'dist' && existsSync('dist/client')) continue;
        return dir;
      }
    } catch {
      /* not built */
    }
  }
  return undefined;
}

function filesUnder(dir: string, extensions: string[]): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.astro') continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(path);
    }
  };
  walk(dir);
  return out;
}

const FUNCTIONS = '.vercel/output/functions';

/** The CSS a built file carries: all of a stylesheet or server chunk, an HTML page's `<style>`s. */
function cssOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  if (!file.endsWith('.html')) return [text];
  return [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
}

/** Every innermost `selector { declarations }` block. */
function blocks(css: string): { selector: string; body: string }[] {
  return css.split('}').flatMap((piece) => {
    const open = piece.lastIndexOf('{');
    if (open < 0) return [];
    const head = piece.slice(0, open);
    return [
      { selector: head.slice(head.lastIndexOf('{') + 1).trim(), body: piece.slice(open + 1) },
    ];
  });
}

/** `0s` or `0ms` anywhere in a duration list; `10s` and `.01ms` are not zero. */
const hasZero = (durations: string) => durations.split(',').some((d) => parseFloat(d) === 0);

/** A timeline in a shorthand: `view()`, `scroll()` or a `--name`; `var(--dur-3)` is a value. */
const hasTimeline = (value: string) =>
  /(?<![\w-])(?:view|scroll)\(|(?<![\w-])--\w/.test(value.replace(/var\(\s*--[\w-]+/g, 'var('));

describe('the production CSS build', () => {
  it('keeps every scroll timeline out of the animation shorthand and off a 0s duration', () => {
    const dir = publicClientDir();
    if (!dir) {
      // Say so rather than pass quietly, as tests/event-share-image.test.ts does. CI builds first.
      console.warn(
        'no build output — run `npm run build` first (skipped the scroll-animation check)',
      );
      return;
    }

    const files = [
      ...filesUnder(dir, ['.css', '.html']),
      ...filesUnder(FUNCTIONS, ['.mjs', '.js']),
    ];
    let timelines = 0;
    const broken: string[] = [];
    for (const file of files) {
      for (const css of cssOf(file)) {
        for (const { selector, body } of blocks(css)) {
          const rule = `${file}: ${selector}`;
          if (/animation-timeline\s*:/.test(body)) {
            timelines += 1;
            for (const [, durations] of body.matchAll(/animation-duration\s*:([^;]*)/g)) {
              if (hasZero(durations)) broken.push(`${rule} has animation-duration:${durations}`);
            }
          }
          for (const [, value] of body.matchAll(/(?<![\w-])animation\s*:([^;]*)/g)) {
            if (hasTimeline(value)) {
              broken.push(`${rule} folds its timeline into animation:${value}`);
            }
          }
        }
      }
    }

    expect(broken).toEqual([]);
    // A scan that read nothing must not pass: the build has scroll-driven rules.
    expect(timelines, `no animation-timeline rule found under ${dir}`).toBeGreaterThan(0);
  });
});
