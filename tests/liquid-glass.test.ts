/**
 * THE LIQUID GLASS: src/scripts/liquid-glass.ts, run against stub elements and browser globals.
 *
 * The lens, built only where the browser says it is Chromium (with `html.lg-lens`): one SVG filter
 * per `[data-lens]`, its map drawn at the element's size and bending the backdrop inward at the rim,
 * thicker while pressed. The liquid button: it leans toward a nearby pointer, and a press squashes
 * it, 107% wide and 92% tall where it leans (the demo's squish, kept by the user's choice in batch
 * 024), until it is let go. Only the main button presses, and a window blur or a hidden page lets go.
 * Under reduced motion, read live, nothing leans, stretches or squashes.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Listener = (e?: unknown) => void;

/** A stub element: attributes, inline custom properties, classes, listeners and a box. */
class Stub {
  attrs = new Map<string, string>();
  vars = new Map<string, string>();
  classes = new Set<string>();
  children: Stub[] = [];
  offsetWidth = 200;
  offsetHeight = 52;
  box = { left: 100, top: 300, width: 200, height: 52 };
  style: Record<string, unknown> = { setProperty: (k: string, v: string) => this.vars.set(k, v) };
  classList = {
    add: (c: string) => this.classes.add(c),
    remove: (c: string) => this.classes.delete(c),
    toggle: (c: string, on: boolean) => (on ? this.classes.add(c) : this.classes.delete(c)),
  };
  tag: string;
  dataset: Record<string, string>;
  private listeners = new Map<string, Listener[]>();
  constructor(tag = 'div', dataset: Record<string, string> = {}) {
    this.tag = tag;
    this.dataset = dataset;
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  append(...kids: Stub[]) {
    this.children.push(...kids);
  }
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  fire(type: string, e: unknown = {}) {
    this.listeners.get(type)?.forEach((fn) => fn(e));
  }
  getBoundingClientRect() {
    const { left, top, width, height } = this.box;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }
}

/** Loads the script against a page with a glass bar and a liquid glass button. */
async function glass({
  brands = ['Chromium', 'Google Chrome'] as string[] | null,
  reduce = false,
}) {
  vi.resetModules();
  const html = new Stub('html');
  const body = new Stub('body');
  const bar = new Stub('div', { lens: 'lg-lens-nav', lensScale: '30' });
  const button = new Stub('a', { lens: 'lg-apple', lensScale: '46', liquid: '' });
  const frames: FrameRequestCallback[] = [];
  const onWindow = new Map<string, Listener[]>();
  const resized: (() => void)[] = [];
  const maps: { width: number; height: number; data: Uint8ClampedArray }[] = [];
  // One media query list, as the browser gives, so a test can switch reduced motion mid-visit.
  const motion = { matches: !reduce };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: (img: { data: Uint8ClampedArray }) =>
        maps.push({ width: canvas.width, height: canvas.height, data: img.data }),
    }),
    toDataURL: () => `data:image/png;base64,map-${maps.length}`,
  };
  for (const [name, value] of Object.entries({
    navigator: brands ? { userAgentData: { brands: brands.map((brand) => ({ brand })) } } : {},
    document: {
      body,
      documentElement: html,
      createElementNS: (_ns: string, tag: string) => new Stub(tag),
      createElement: () => canvas,
      // Only the real hooks answer, so a renamed hook leaves the glass untouched and fails here.
      querySelectorAll: (sel: string) =>
        sel === '[data-lens]' ? [bar, button] : sel === '[data-liquid]' ? [button] : [],
    },
    matchMedia: (query: string) =>
      query === '(prefers-reduced-motion: no-preference)' ? motion : { matches: false },
    requestAnimationFrame: (cb: FrameRequestCallback) => frames.push(cb),
    addEventListener: (type: string, fn: Listener) =>
      onWindow.set(type, [...(onWindow.get(type) ?? []), fn]),
    ResizeObserver: class {
      constructor(cb: () => void) {
        resized.push(cb);
      }
      observe() {}
    },
  }))
    vi.stubGlobal(name, value);
  await import('../src/scripts/liquid-glass');
  return {
    html,
    body,
    bar,
    button,
    maps,
    motion,
    resize: () => resized.forEach((cb) => cb()),
    flush: () => {
      while (frames.length) frames.shift()!(0);
    },
    /** Fires an event at the window, as the browser would. */
    window: (type: string, e: unknown = {}) => onWindow.get(type)?.forEach((fn) => fn(e)),
    move: (clientX: number, clientY: number) =>
      onWindow.get('pointermove')?.forEach((fn) => fn({ clientX, clientY })),
  };
}

/** The transform the script asks for, read back from the custom properties it sets. */
const asked = (el: Stub) => ({
  x: parseFloat(el.vars.get('--lx') ?? '0'),
  y: parseFloat(el.vars.get('--ly') ?? '0'),
  sx: Number(el.vars.get('--lsx') ?? 1),
  sy: Number(el.vars.get('--lsy') ?? 1),
});
const AT_REST = { x: 0, y: 0, sx: 1, sy: 1 };

describe('the lens', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('builds the lens and turns on html.lg-lens only where the browser says it is Chromium', async () => {
    const chrome = await glass({});
    expect(chrome.html.classes.has('lg-lens')).toBe(true);
    expect(chrome.body.children).toHaveLength(1);
    // Safari's brands, or no userAgentData at all (Safari, Firefox): plain frosted glass, and no
    // filter, canvas or map is made for nothing.
    for (const brands of [['Safari'], null]) {
      const other = await glass({ brands });
      other.resize();
      expect(other.html.classes.has('lg-lens'), String(brands)).toBe(false);
      expect(other.body.children, String(brands)).toEqual([]);
      expect(other.maps, String(brands)).toEqual([]);
    }
  });

  it('draws one filter per [data-lens] element, at its size, thicker while pressed', async () => {
    const g = await glass({});
    const [defs] = g.body.children;
    const filters = defs!.children;
    expect(filters.map((f) => f.attrs.get('id'))).toEqual(['lg-lens-nav', 'lg-apple']);
    g.bar.offsetWidth = 1328;
    g.bar.offsetHeight = 54;
    g.resize();
    const [nav] = filters;
    const map = nav!.children.find((c) => c.tag === 'feImage')!;
    for (const node of [nav!, map]) {
      expect([node.attrs.get('width'), node.attrs.get('height')]).toEqual(['1328', '54']);
    }
    expect(map.attrs.get('href')).toMatch(/^data:image\/png/);
    expect(g.maps[0]).toMatchObject({ width: 1328, height: 54 });

    const scales = () =>
      nav!.children.filter((c) => c.tag === 'feDisplacementMap').map((c) => c.attrs.get('scale'));
    expect(scales()).toEqual(['30', String(30 * 0.913), String(30 * 0.826)]);
    const thick = [30 * 1.3, 30 * 0.913 * 1.3, 30 * 0.826 * 1.3];
    g.bar.fire('pointerdown');
    expect(scales().map(Number)).toEqual(thick);
    g.bar.fire('pointerup');
    expect(scales()).toEqual(['30', String(30 * 0.913), String(30 * 0.826)]);
    // A right-click is not a press; a press the window loses settles as a release does.
    g.bar.fire('pointerdown', { button: 2 });
    expect(scales()).toEqual(['30', String(30 * 0.913), String(30 * 0.826)]);
    for (const type of ['blur', 'pagehide']) {
      g.bar.fire('pointerdown', { button: 0 });
      expect(scales().map(Number), type).toEqual(thick);
      g.window(type);
      expect(scales(), type).toEqual(['30', String(30 * 0.913), String(30 * 0.826)]);
    }
    // A context menu opened on a main-button press (a macOS ctrl-click) settles it too.
    g.bar.fire('pointerdown', { button: 0 });
    g.bar.fire('contextmenu');
    expect(scales()).toEqual(['30', String(30 * 0.913), String(30 * 0.826)]);
  });

  it('bends the backdrop inward at the rim and leaves the middle and the corners alone', async () => {
    const g = await glass({});
    g.resize();
    const { width: w, height: h, data } = g.maps.at(-1)!; // the button, 200 x 52
    const at = (x: number, y: number) => [data[(y * w + x) * 4]!, data[(y * w + x) * 4 + 1]!];
    const mid = Math.floor(h / 2);
    const row = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => at(from + i, mid)[0]!);
    const column = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => at(w / 2, from + i)[1]!);
    // feDisplacementMap samples from x + scale * (R / 255 - 0.5): above 128 reads from the right.
    const left = row(0, h / 2);
    const right = row(w - h / 2, w);
    const top = column(0, mid);
    const bottom = column(mid + 1, h);
    expect(Math.min(...left)).toBeGreaterThanOrEqual(128);
    expect(Math.max(...left)).toBeGreaterThan(128);
    expect(Math.max(...right)).toBeLessThanOrEqual(128);
    expect(Math.min(...right)).toBeLessThan(128);
    expect(Math.min(...top)).toBeGreaterThanOrEqual(128);
    expect(Math.max(...top)).toBeGreaterThan(128);
    expect(Math.max(...bottom)).toBeLessThanOrEqual(128);
    expect(Math.min(...bottom)).toBeLessThan(128);
    expect(at(w / 2, mid)).toEqual([128, 128]);
    expect(at(0, 0)).toEqual([128, 128]); // outside the capsule
  });
});

describe('the liquid button', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('leans and stretches toward a nearby pointer, and settles when it leaves', async () => {
    const g = await glass({});
    g.move(320, 330); // 20px right of the box, inside the 80px field
    g.flush();
    const lean = asked(g.button);
    expect(lean.x).toBe(12);
    expect(lean.sx).toBeGreaterThan(1);
    expect(g.button.vars.get('--mx')).toBe('220px');
    g.move(900, 900); // far away
    g.flush();
    expect(asked(g.button)).toEqual(AT_REST);
    g.move(320, 330);
    g.flush();
    g.html.fire('pointerleave');
    g.flush();
    expect(asked(g.button)).toEqual(AT_REST);
  });

  const SQUASH = { sx: 1.07, sy: 0.92 };

  it('squashes on a press, 107% wide and 92% tall where it leans, until it is let go', async () => {
    const g = await glass({});
    g.move(320, 330);
    g.flush();
    const lean = asked(g.button);
    g.button.fire('pointerdown');
    expect(g.button.classes.has('is-pressed')).toBe(true);
    g.flush();
    const squashed = asked(g.button);
    expect(squashed).toEqual({ x: lean.x, y: lean.y, ...SQUASH });
    // Moving while pressed changes nothing.
    g.move(150, 310);
    g.flush();
    expect(asked(g.button)).toEqual(squashed);
    g.button.fire('pointerup');
    expect(g.button.classes.has('is-pressed')).toBe(false);
    g.flush();
    // Let go, it follows the pointer again; the CSS spring carries it there.
    expect(asked(g.button).sx).toBeLessThan(SQUASH.sx);
    expect(asked(g.button).sy).toBeGreaterThan(SQUASH.sy);
  });

  it('squashes in place when pressed with no pointer before it, as on a tap', async () => {
    const g = await glass({});
    g.button.fire('pointerdown');
    g.flush();
    expect(asked(g.button)).toEqual({ x: 0, y: 0, ...SQUASH });
    g.button.fire('pointerup');
    g.flush();
    // After a lean and the pointer gone, the next press does not jump to the old lean.
    g.move(320, 330);
    g.flush();
    g.html.fire('pointerleave');
    g.flush();
    g.button.fire('pointerdown');
    g.flush();
    expect(asked(g.button)).toEqual({ x: 0, y: 0, ...SQUASH });
  });

  it('takes a press only from the main button, and lets go when the window loses it', async () => {
    const g = await glass({});
    g.button.fire('pointerdown', { button: 2 }); // a right-click: its release may never come
    g.flush();
    expect(g.button.classes.has('is-pressed')).toBe(false);
    expect(asked(g.button)).toEqual(AT_REST);
    for (const type of ['blur', 'pagehide']) {
      g.button.fire('pointerdown', { button: 0 });
      g.flush();
      expect(asked(g.button), type).toEqual({ x: 0, y: 0, ...SQUASH });
      g.window(type);
      expect(g.button.classes.has('is-pressed'), type).toBe(false);
      g.flush();
      expect(asked(g.button), type).toEqual(AT_REST);
    }
  });

  // A macOS ctrl-click reports the main button and opens a menu that may swallow the release.
  it('lets go on cancel, leave or a context menu as on release', async () => {
    const g = await glass({});
    for (const type of ['pointercancel', 'pointerleave', 'contextmenu']) {
      g.button.fire('pointerdown');
      g.flush();
      expect(asked(g.button), type).toEqual({ x: 0, y: 0, ...SQUASH });
      g.button.fire(type);
      expect(g.button.classes.has('is-pressed'), type).toBe(false);
      g.flush();
      expect(asked(g.button), type).toEqual(AT_REST);
    }
  });

  it('under reduced motion does not lean, stretch or squash, and follows the setting live', async () => {
    const g = await glass({ reduce: true });
    g.move(320, 330);
    g.flush();
    expect(asked(g.button)).toEqual(AT_REST);
    g.button.fire('pointerdown');
    g.flush();
    expect(asked(g.button)).toEqual(AT_REST);
    expect(g.button.classes.has('is-pressed')).toBe(true); // the CSS still sees the press
    g.button.fire('pointerup');
    g.flush();
    // Motion allowed mid-visit: it leans again; reduced again: it settles at the next move.
    g.motion.matches = true;
    g.move(320, 330);
    g.flush();
    expect(asked(g.button).x).toBe(12);
    g.motion.matches = false;
    g.move(321, 330);
    g.flush();
    expect(asked(g.button)).toEqual(AT_REST);
  });
});

/** Every file under `src` the site is built from. */
function srcFiles(dir = 'src'): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return srcFiles(path);
    return /\.(astro|css|ts)$/.test(name) ? [path] : [];
  });
}

/** Each declaration in `css` with the at-rules and selectors it sits in. */
function declarations(css: string): { decl: string; within: string[] }[] {
  const out: { decl: string; within: string[] }[] = [];
  const stack: string[] = [];
  let text = '';
  let depth = 0;
  for (const c of css.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    if (depth > 0 || !'{};'.includes(c)) {
      text += c;
      continue;
    }
    if (c === '{') stack.push(text.trim());
    else {
      if (text.trim()) out.push({ decl: text.trim(), within: [...stack] });
      if (c === '}') stack.pop();
    }
    text = '';
  }
  return out;
}

describe('the hooks the script and the styles share', () => {
  const files = srcFiles().map((path) => ({ path, text: readFileSync(path, 'utf8') }));
  const markup = files.filter(({ path }) => path.endsWith('.astro')).map(({ text }) => text);
  const decls = declarations(
    files
      .map(({ path, text }) =>
        path.endsWith('.css')
          ? text
          : [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n'),
      )
      .join('\n'),
  );
  /** The selectors a declaration sits in, without its at-rules. */
  const selectors = (d: { within: string[] }) => d.within.filter((h) => !h.startsWith('@'));

  it('is loaded on every page, by the masthead', () => {
    const masthead = readFileSync('src/components/Masthead.astro', 'utf8');
    expect(masthead).toMatch(/import '@\/scripts\/liquid-glass';/);
  });

  it('gives every data-lens a backdrop-filter url() behind html.lg-lens', () => {
    const lenses = markup.flatMap((text) =>
      [...text.matchAll(/\bdata-lens="([\w-]+)"/g)].map((m) => m[1]!),
    );
    expect(lenses.length).toBeGreaterThan(0);
    for (const id of lenses) {
      const uses = decls.filter((d) =>
        new RegExp(`url\\(\\s*['"]?#${id}['"]?\\s*\\)`).test(d.decl),
      );
      expect(uses.length, id).toBeGreaterThan(0);
      // Anywhere else a url() Safari cannot run would drop the whole backdrop-filter.
      for (const use of uses) {
        expect(selectors(use).join(' '), `${id}: ${use.decl}`).toMatch(/\bhtml\.lg-lens\b/);
      }
    }
  });

  it('moves the data-liquid element with the properties the script sets, and marks the press', () => {
    // The liquid element, and the classes only it carries: its rules are the ones that name them.
    const tag = markup
      .map((text) => /<\w+\b[^>]*\bdata-liquid\b[^>]*>/.exec(text)?.[0])
      .find(Boolean);
    expect(tag, 'no element carries data-liquid').toBeDefined();
    const classesOf = (attrs: string) => /\bclass="([^"]*)"/.exec(attrs)?.[1]?.split(/\s+/) ?? [];
    const elsewhere = new Set(
      markup.flatMap((text) =>
        [...text.matchAll(/<\w+\b[^>]*>/g)]
          .map((m) => m[0])
          .filter((t) => t !== tag)
          .flatMap(classesOf),
      ),
    );
    const own = classesOf(tag!).filter((c) => c && !elsewhere.has(c));
    expect(own.length, `no class only the liquid element has, in ${tag}`).toBeGreaterThan(0);
    const mine = (d: { within: string[] }) =>
      selectors(d).some(
        (s) =>
          s.includes('[data-liquid]') || own.some((c) => new RegExp(`\\.${c}(?![\\w-])`).test(s)),
      );

    const reads = (name: string) => decls.filter((d) => d.decl.includes(`var(${name}`));
    // The lean and the stretch are this script's alone: every read sits in the element's rules.
    for (const name of ['--lx', '--ly', '--lsx', '--lsy']) {
      expect(reads(name).length, name).toBeGreaterThan(0);
      for (const d of reads(name))
        expect(mine(d), `${name} read outside its element: ${d.decl}`).toBe(true);
    }
    // The light under the pointer reads --mx and --my in the element's own rule. (ProjectCard.astro
    // sets and reads the same two names for its own card light.)
    expect(
      decls.some((d) => mine(d) && d.decl.includes('var(--mx') && d.decl.includes('var(--my')),
    ).toBe(true);
    // The lean and the stretch move it, in one transform.
    expect(
      decls.some(
        (d) =>
          mine(d) &&
          /^transform\s*:/.test(d.decl) &&
          ['--lx', '--ly', '--lsx', '--lsy'].every((name) => d.decl.includes(`var(${name}`)),
      ),
    ).toBe(true);
    expect(decls.some((d) => selectors(d).some((s) => /\.is-pressed\b/.test(s)) && mine(d))).toBe(
      true,
    );
  });
});
