/**
 * THE CINEMATIC THEME: dark by default, cream by choice, light in print.
 *
 * The theme is applied before first paint by an inline script in Base.astro:
 * the visitor's saved choice, else the server's dark default, on every page
 * (the member area included). That script is run here against stubbed storage,
 * so its branches are tested as written. The rest pins the token contract (build
 * plan 1.1 to 1.6) and the motion rules: no endless CSS animation but the film
 * grain, each JS loop behind its own reduced-motion check, and every
 * scroll-driven effect behind both the reduced-motion and the support gate.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const base = source('src/layouts/Base.astro');
const tokens = source('src/styles/tokens.css');
const baseCss = source('src/styles/base.css');
const primitives = source('src/styles/primitives.css');

/** Every file under `src` the site is built from. */
const srcFiles = (() => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(astro|css|ts|tsx|js|mjs)$/.test(name)) files.push(path);
    }
  };
  walk('src');
  return files;
})();

const headScript =
  /<script is:inline>\s*(\(function \(d\) \{[\s\S]*?)<\/script>/.exec(base)?.[1] ?? '';

function firstPaint({
  saved,
  storageBlocked = false,
}: {
  saved?: string;
  storageBlocked?: boolean;
}) {
  const classes = new Set<string>();
  // The server's markup: `data-theme="dark"` on every page.
  const html = {
    dataset: { theme: 'dark' } as Record<string, string>,
    classList: { add: (name: string) => classes.add(name) },
  };
  const meta = { content: '#141413' };
  const localStorage = {
    getItem: (key: string) => {
      if (storageBlocked) throw new Error('blocked');
      return key === 'wc-theme' ? (saved ?? null) : null;
    },
  };
  const document = {
    documentElement: html,
    querySelector: (selector: string) => (selector === 'meta[name="theme-color"]' ? meta : null),
  };
  new Function('document', 'localStorage', headScript)(document, localStorage);
  return { theme: html.dataset.theme, meta: meta.content, js: classes.has('js') };
}

describe('the theme before first paint', () => {
  it('is an inline script in the layout head, after the theme-color meta', () => {
    expect(headScript).toContain("localStorage.getItem('wc-theme')");
    const at = base.indexOf(headScript);
    expect(at).toBeGreaterThan(base.indexOf('<meta name="theme-color"'));
    expect(at).toBeLessThan(base.indexOf('</head>'));
    // Storage is read inside try, so a blocked store cannot break the page.
    expect(headScript).toMatch(/try \{[^}]*localStorage\.getItem\('wc-theme'\)/);
  });

  it('is dark unless the visitor chose cream', () => {
    expect(firstPaint({})).toEqual({ theme: 'dark', meta: '#141413', js: true });
    expect(firstPaint({ saved: 'light' })).toEqual({ theme: 'light', meta: '#FAF9F5', js: true });
    expect(firstPaint({ saved: 'dark' }).theme).toBe('dark');
    expect(firstPaint({ saved: 'sepia' }).theme).toBe('dark');
    expect(firstPaint({ storageBlocked: true })).toEqual({
      theme: 'dark',
      meta: '#141413',
      js: true,
    });
  });

  // The member area used to be locked light, with the toggle hidden; it follows the site now.
  it('is rendered by the server: dark on every page, the member area included', () => {
    expect(base).toContain('<html lang="en-IN" data-theme="dark">');
    expect(base).toContain('<meta name="theme-color" content="#141413" />');
    expect(base).not.toMatch(/lockLight|data-theme-lock|startsWith\('\/me\/'\)/);
    // Nothing sets the lock now, so no script or rule may still key off it.
    expect(srcFiles.filter((file) => source(file).includes('data-theme-lock'))).toEqual([]);
  });

  // The member area's editors and gate now render dark too, so their styles carry tokens only.
  it('styles the member area from tokens alone, with `--rule-field` on every field border (the ratio is pinned in tests/non-text-contrast.test.ts)', () => {
    const forms = source('src/styles/forms.css');
    expect(forms).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    expect(forms).toMatch(/\.input \{[^}]*border: var\(--border-hair\) solid var\(--rule-field\);/);
  });

  it('loads no monospace face and no enhancement bundle', () => {
    expect(base).not.toMatch(/ibm-plex-mono/);
    expect(base).not.toMatch(/scripts\/enhance/);
    expect(base).not.toMatch(/setTimeout/);
    expect(srcFiles).not.toContain(join('src', 'scripts', 'enhance.ts'));
  });
});

/** The custom properties declared in the first block that follows `selector`. */
function block(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(selector);
  expect(start, selector).toBeGreaterThan(-1);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  return new Map(
    [...body.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [
      m[1]!,
      m[2]!.trim(),
    ]),
  );
}

const COLOURS = [
  '--paper',
  '--paper-sunk',
  '--paper-raised',
  '--paper-raised-2',
  '--ink',
  '--ink-2',
  '--ink-3',
  '--rule',
  '--rule-strong',
  '--rule-field',
  '--clay',
  '--clay-deep',
  '--clay-tint',
  '--focus',
  '--btn-ink',
  '--glow',
  '--hot',
  '--nav-bg',
  '--grain',
  '--grain-o',
  '--map-land',
  '--map-land-hot',
  '--map-state',
  '--map-pin',
  '--map-pin-lead',
  '--map-label',
];

describe('the tokens', () => {
  const dark = block(tokens, ":root,\n[data-theme='dark'] {");
  const light = block(tokens, ":root[data-theme='light'],\n[data-theme='light'] {");
  const print = block(tokens.slice(tokens.indexOf('@media print')), ':root,\n  [data-theme] {');

  it('give every colour a literal value in the dark, light and print blocks', () => {
    for (const [name, values] of [
      ['dark', dark],
      ['light', light],
      ['print', print],
    ] as const) {
      for (const token of COLOURS) {
        expect(values.get(token), `${token} in ${name}`).toBeDefined();
        // A var() would resolve where it is declared, not in the scope reading it.
        expect(values.get(token), `${token} in ${name}`).not.toMatch(/var\(/);
      }
    }
    expect(tokens).toMatch(/:root,\n\[data-theme='dark'\] \{[^}]*color-scheme: dark;/);
    expect(tokens).toMatch(/\[data-theme='light'\] \{[^}]*color-scheme: light;/);
  });

  it('print the cream theme', () => {
    expect(Object.fromEntries(print)).toEqual(Object.fromEntries(light));
    expect(baseCss).toMatch(/@media print \{\s*body::after \{\s*display: none;/);
    // Every element prints its finished state (the map's pins and arcs run on a scroll
    // timeline too), with no glow.
    expect(baseCss).toMatch(
      /@media print \{\s*\*,\s*\*::before,\s*\*::after \{\s*animation: none !important;\s*transition: none !important;\s*box-shadow: none !important;\s*text-shadow: none !important;/,
    );
    // The clay full stop is 2.96:1 on cream; the deeper clay clears 3:1 on screen and paper.
    const primitives = source('src/styles/primitives.css');
    expect(primitives).toMatch(/\[data-theme='light'\] \.dot \{\s*color: var\(--clay-deep\);/);
    expect(primitives).toMatch(/@media print \{\s*\.dot \{\s*color: var\(--clay-deep\);/);
  });

  // Chrome's default print setting drops backgrounds. A filled chip, tab or pager page is an ink or
  // clay fill with a --paper label, so unless it asks to keep its fill it prints as pale text on
  // white (F102: "All 122", the Ambassador badge, the pager's current page, the /discover/ tab).
  it('print the filled chips, tabs and the pager’s current page with their fill', () => {
    const exact = (file: string) =>
      declarations(cssOf(file))
        .filter(
          (d) =>
            d.within[0] === '@media print' &&
            /^(-webkit-)?print-color-adjust:\s*exact$/.test(d.decl),
        )
        .flatMap((d) => (d.within[1] ?? '').split(',').map((selector) => selector.trim()));

    const chips = exact('src/styles/primitives.css');
    for (const selector of [
      '.chip-verified',
      ".chip[aria-pressed='true']",
      '.chip.is-on',
      '.chip:has(> input:checked)',
      'input:checked + .chip',
      ".filter[aria-pressed='true']",
      '.filter.is-on',
    ]) {
      expect(chips, selector).toContain(selector);
    }
    expect(exact('src/styles/directory.css')).toContain(".dir-pager [aria-current='page']");

    // The Chrome-only prefix goes with the standard property, so Safari prints the fill too.
    const rules = declarations(cssOf('src/styles/primitives.css')).filter(
      (d) => d.within[0] === '@media print' && d.decl.includes('print-color-adjust'),
    );
    expect(rules.some((d) => d.decl.startsWith('-webkit-print-color-adjust'))).toBe(true);

    // Only the filled states are kept: a plain chip or pager link stays unfilled on paper.
    expect(chips).not.toContain('.chip');
    expect(chips).not.toContain('.dir-pager a');
  });

  it('keep the text floor at 15px, and the page is not scaled down', () => {
    const rem = (name: string) => Number(new RegExp(`${name}: ([\\d.]+)rem;`).exec(tokens)?.[1]);
    expect(rem('--t-body') * 16).toBeGreaterThanOrEqual(15);
    expect(rem('--t-small') * 16).toBe(15);
    // The deprecated aliases are gone with their last readers.
    expect(tokens).not.toMatch(
      /--(t-meta|t-micro|track-meta|font-mono|font-sans|section-y-sm|section-y-lg|measure-wide|night|on-night|rule-night|clay-lift|state-|panel|dir-|logo-|shade-1)\b/,
    );
    // The header and the projects toolbar read --nav-bg: 95% paper keeps their text AA.
    expect(tokens.match(/--nav-bg: rgb\([\d ]+\/ 0\.95\);/g)).toHaveLength(3);
    expect(baseCss).not.toMatch(/\bzoom\s*:/);
    expect(tokens).not.toMatch(/\bzoom\s*:/);
  });

  /** Every custom property a page reads must exist, or the declaration silently falls away. */
  it('define every name the site reads without a fallback', () => {
    const defined = new Set<string>();
    const unguarded = new Map<string, string>();
    for (const file of srcFiles) {
      const text = source(file);
      for (const [, name] of text.matchAll(/(--[\w-]+)\s*:/g)) defined.add(name!);
      for (const [, name] of text.matchAll(/setProperty\(\s*['"](--[\w-]+)/g)) defined.add(name!);
      for (const [, name] of text.matchAll(/['"](--[\w-]+)['"]\s*:/g)) defined.add(name!);
      for (const [, name, next] of text.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)) {
        if (next === ')' && !unguarded.has(name!)) unguarded.set(name!, file);
      }
    }
    const missing = [...unguarded].filter(([name]) => !defined.has(name));
    expect(missing.map(([name, file]) => `${name} (${file})`)).toEqual([]);
  });

  it('carry no eyebrow: the rule and the markup are gone', () => {
    expect(primitives).not.toMatch(/\.eyebrow\b/);
    for (const file of srcFiles.filter((f) => f.endsWith('.astro'))) {
      expect(source(file), file).not.toMatch(/class(:list)?=[^>]*\beyebrow\b|\beyebrow[=?]/);
    }
  });
});

/** The CSS text of a file: the whole file for .css, the `<style>` blocks for .astro. */
function cssOf(file: string): string {
  const text = source(file);
  if (file.endsWith('.css')) return text;
  if (file.endsWith('.astro')) {
    return [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
  }
  return '';
}

/** Each declaration in `css` with the at-rule and selector headers it sits inside. */
function declarations(css: string): { decl: string; within: string[] }[] {
  const out: { decl: string; within: string[] }[] = [];
  const stack: string[] = [];
  let segment = '';
  for (const char of css.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (char === '{') {
      stack.push(segment.trim());
      segment = '';
    } else if (char === ';' || char === '}') {
      if (segment.trim()) out.push({ decl: segment.trim(), within: [...stack] });
      segment = '';
      if (char === '}') stack.pop();
    } else segment += char;
  }
  return out;
}

describe('motion', () => {
  it('has no endless CSS animation but the film grain, and that only with motion allowed', () => {
    // The grain is the one CSS `infinite` (the owner asked for moving grain, 2026-10-16).
    const endless = srcFiles.filter((file) => /\binfinite\b/.test(source(file)));
    expect(endless).toEqual(['src/styles/base.css']);
    const loops = declarations(baseCss).filter(({ decl }) => /\binfinite\b/.test(decl));
    expect(loops.map((l) => l.within)).toEqual([
      ['@media (prefers-reduced-motion: no-preference)', 'body::after'],
    ]);
  });

  it('keeps its JS loops, the mist and the strip glide, to scripts that check reduced motion', () => {
    // The CSS reset cannot stop a script, so each loop checks the setting itself; the behaviour
    // is tested in tests/hero-mist.test.ts and tests/strip-autoscroll.test.ts. A new frame loop
    // or timer fails here until it is added, with its own check.
    const loops = srcFiles.filter((file) =>
      /\b(setInterval|requestAnimationFrame)\(/.test(source(file)),
    );
    expect(loops.sort()).toEqual(['src/scripts/hero-mist.ts', 'src/scripts/strip-glide.ts']);
    for (const file of loops) {
      expect(source(file), file).toContain('prefers-reduced-motion: no-preference');
    }
  });

  it('puts every scroll-driven effect behind reduced motion and scroll-timeline support', () => {
    const gate = [
      '@media (prefers-reduced-motion: no-preference)',
      '@supports (animation-timeline: view())',
    ];
    const loose: string[] = [];
    let seen = 0;
    for (const file of srcFiles) {
      for (const { decl, within } of declarations(cssOf(file))) {
        if (!/^(animation-timeline|view-timeline|scroll-timeline)(-[\w]+)?\s*:/.test(decl))
          continue;
        seen += 1;
        if (!gate.every((g) => within.includes(g))) loose.push(`${file}: ${decl}`);
      }
    }
    expect(seen).toBeGreaterThan(0);
    expect(loose).toEqual([]);
  });

  it('reveals with CSS alone, so nothing waits on a script', () => {
    expect(baseCss).not.toMatch(/is-revealed|html\.js \[data-reveal\]/);
    expect(baseCss).toMatch(
      /\[data-reveal\] \{\s*animation: rise linear both;\s*animation-timeline: view\(\);/,
    );
  });
});
