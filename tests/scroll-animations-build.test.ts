import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, type TestContext } from 'vitest';

/**
 * Every scroll-driven and scroll-triggered animation survives the CSS minifier.
 *
 * Since Vite 8 (PR #59) the build minifies CSS with Lightning CSS, which rewrites any rule that
 * pairs a plain `animation` shorthand with an `animation-timeline` longhand. It either writes the
 * shorthand out as longhands with `animation-duration: 0s`, which Chrome holds on the last frame,
 * or folds the timeline into the shorthand (`animation: linear both rise view()`), which Chrome
 * drops whole. The source stays correct and the dev server never minifies, so only the build shows
 * it: the home page went live with the hero copy invisible. `animation-duration: auto` after each
 * shorthand stops both rewrites (THE REVEAL in src/styles/base.css). A shorthand with a `var()` in
 * it is left as written, so a literal `0s` there is checked too.
 *
 * Lightning CSS also moves `animation-trigger` ahead of a plain shorthand. Chrome 158 keeps the
 * trigger whichever comes first, so the order check is a guard: should a browser have the shorthand
 * reset the trigger, as it resets `animation-timeline`, the reveals would play at once. A scroll
 * trigger also keeps its written-out `view(block 0px)`: a bare `view()` takes the page's
 * scroll-padding as its inset, and a row a jump lands under the bar never fires (batch 021).
 *
 * The page cross-fade's opt-in also sits in an inline `<style>` at the top of every page's `<head>`.
 * Asked for only in a linked stylesheet, it aborted on most page changes in the production build
 * (batch 024), with an uncaught "Transition was aborted because of invalid state".
 *
 * Read from the build: its CSS files, the inline `<style>` of its HTML, and the server function,
 * where small stylesheets of on-demand pages such as `/` are inlined as JSON. Each rule is read
 * with its own declarations, a nested rule split out of its parent. A scan that misses the home
 * page or the motion stylesheet cannot pass: it must find the hero copy's lift, `bar-tint` and
 * `photo-settle` on their timelines, the scroll triggers and `@view-transition`.
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

/** The CSS a built file carries: a stylesheet, an HTML page's `<style>`s, a server chunk's styles. */
function cssOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  if (file.endsWith('.css')) return [text];
  if (file.endsWith('.html')) {
    return [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]!);
  }
  // Astro inlines small stylesheets into the server bundle as `{"type":"inline","content":"…"}`.
  return [...text.matchAll(/"content":("(?:[^"\\]|\\.)*")/g)].flatMap((m) => {
    try {
      return [JSON.parse(m[1]!) as string];
    } catch {
      return [];
    }
  });
}

type Rule = { path: string[]; decls: string[] };

/**
 * Every rule with its own declarations, nested rules split out of their parent, and the selectors
 * and at-rules it sits in. Brackets and quotes are kept whole, so a `;` in a `url()` stays put.
 */
function rules(css: string): Rule[] {
  const out: Rule[] = [];
  const open: Rule[] = [];
  let text = '';
  let depth = 0;
  let quote = '';
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (quote) {
      text += c;
      if (c === '\\') text += source[++i] ?? '';
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
      text += c;
    } else if (depth > 0 || !'{};'.includes(c)) {
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      text += c;
    } else {
      if (c === '{') open.push({ path: [...(open.at(-1)?.path ?? []), text.trim()], decls: [] });
      else {
        if (text.trim()) open.at(-1)?.decls.push(text.trim());
        if (c === '}') {
          const rule = open.pop();
          if (rule) out.push(rule);
        }
      }
      text = '';
    }
  }
  return out;
}

const property = (decl: string) => decl.slice(0, decl.indexOf(':')).trim().toLowerCase();
const value = (decl: string) => decl.slice(decl.indexOf(':') + 1).trim();
const values = (rule: Rule, name: string) =>
  rule.decls.filter((d) => property(d) === name).map(value);

/** The layers of a comma list; a comma inside brackets stays in its layer. */
function layers(list: string): string[] {
  const out = [''];
  let depth = 0;
  for (const c of list) {
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    if (c === ',' && depth === 0) out.push('');
    else out[out.length - 1] += c;
  }
  return out.map((layer) => layer.trim());
}

/** `0s` or `0ms` anywhere in a duration list; `10s` and `.01ms` are not zero. */
const hasZero = (durations: string) => layers(durations).some((d) => parseFloat(d) === 0);

/** A shorthand layer whose duration, its first time, is a literal zero (a `var()` before it hides it). */
const zeroDuration = (layer: string) => {
  const time = /(?<![\w.-])(\d*\.?\d+)m?s(?![\w-])/.exec(layer);
  return !!time && !layer.slice(0, time.index).includes('var(') && parseFloat(time[1]!) === 0;
};

/** A timeline in a shorthand: `view()`, `scroll()` or a `--name`; `var(--dur-3)` is a value. */
const hasTimeline = (shorthand: string) =>
  /(?<![\w-])(?:view|scroll)\(|(?<![\w-])--\w/.test(shorthand.replace(/var\(\s*--[\w-]+/g, 'var('));

const onTimeline = (rule: Rule) => values(rule, 'animation-timeline').length > 0;

/** The page cross-fade's opt-in. */
const optsIn = (rule: Rule) =>
  rule.path.at(-1) === '@view-transition' && values(rule, 'navigation').includes('auto');

/** The rule plays `name`, by its shorthand or its `animation-name`. */
const plays = (rule: Rule, name: string) =>
  [...values(rule, 'animation'), ...values(rule, 'animation-name')].some((v) =>
    new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(v),
  );

/** What the build must hold, so a scan that read the wrong files cannot pass. */
const REQUIRED: [string, (rule: Rule) => boolean][] = [
  [
    'the hero copy on a scroll timeline (Hero.astro)',
    (r) => onTimeline(r) && r.path.some((s) => /\.hero-copy(?![\w-])/.test(s)),
  ],
  ['bar-tint on a scroll timeline (Hero.astro)', (r) => onTimeline(r) && plays(r, 'bar-tint')],
  [
    'photo-settle on a scroll timeline (motion.css)',
    (r) => onTimeline(r) && plays(r, 'photo-settle'),
  ],
  ['a timeline-trigger', (r) => values(r, 'timeline-trigger').length > 0],
  ['an animation-trigger', (r) => values(r, 'animation-trigger').length > 0],
  ['@view-transition { navigation: auto }', optsIn],
];

/** The build's client folder. Without one it skips here, and fails in CI, which builds first. */
function built(ctx: TestContext): string {
  const dir = publicClientDir();
  if (dir) return dir;
  // CI builds before it runs the tests (.github/workflows/ci.yml): there, no build is a failure.
  expect(process.env.CI, 'no build output, but CI builds before the tests').toBeFalsy();
  return ctx.skip('no build output — run `npm run build` first');
}

describe('the production CSS build', () => {
  it('keeps every scroll timeline and trigger intact, and carries the site’s motion', (ctx) => {
    const dir = built(ctx);
    const files = [
      ...filesUnder(dir, ['.css', '.html']),
      ...filesUnder(FUNCTIONS, ['.mjs', '.js']),
    ];
    const all: Rule[] = [];
    const broken: string[] = [];
    for (const file of files) {
      for (const css of cssOf(file)) {
        for (const rule of rules(css)) {
          all.push(rule);
          const name = `${file}: ${rule.path.filter((s) => !s.startsWith('@')).join(' ')}`;
          const shorthands = values(rule, 'animation');
          if (onTimeline(rule)) {
            for (const durations of values(rule, 'animation-duration')) {
              if (hasZero(durations)) broken.push(`${name} has animation-duration:${durations}`);
            }
            for (const shorthand of shorthands) {
              if (layers(shorthand).some(zeroDuration)) {
                broken.push(`${name} has a 0s duration in animation:${shorthand}`);
              }
            }
          }
          for (const shorthand of shorthands) {
            if (hasTimeline(shorthand)) {
              broken.push(`${name} folds its timeline into animation:${shorthand}`);
            }
          }
          const trigger = rule.decls.findIndex((d) => property(d) === 'animation-trigger');
          if (trigger >= 0 && rule.decls.slice(trigger).some((d) => property(d) === 'animation')) {
            broken.push(
              `${name} has animation: after animation-trigger (keep the shorthand first)`,
            );
          }
          for (const trigger of values(rule, 'timeline-trigger')) {
            if (/view\(\s*(?:block|inline|x|y)?\s*\)/.test(trigger)) {
              broken.push(`${name} has timeline-trigger:${trigger} without its 0px inset`);
            }
          }
        }
      }
    }

    const missing = REQUIRED.filter(([, found]) => !all.some(found)).map(
      ([what]) => `no rule found for ${what} under ${dir} or ${FUNCTIONS}`,
    );
    expect([...broken, ...missing]).toEqual([]);
  });

  it('opts every prerendered page into the cross-fade before its first stylesheet', (ctx) => {
    const late: string[] = [];
    let pages = 0;
    for (const file of filesUnder(built(ctx), ['.html'])) {
      const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(readFileSync(file, 'utf8'))?.[1] ?? '';
      const link = head.search(/<link\b[^>]*\brel=["']?stylesheet\b/i);
      if (link < 0) continue; // a redirect stub: no stylesheet, no page to fade
      pages += 1;
      const inline = [...head.slice(0, link).matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)];
      if (!inline.some((m) => rules(m[1]!).some(optsIn))) {
        late.push(
          `${file}: no @view-transition { navigation: auto } in a <style> before its first stylesheet <link>`,
        );
      }
    }
    expect(pages, 'no prerendered page with a stylesheet in the build').toBeGreaterThan(0);
    expect(late).toEqual([]);
  });
});
