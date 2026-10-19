/**
 * NON-TEXT CONTRAST AT 3:1 (WCAG 1.4.11), computed from the tokens, in dark and light.
 *
 * Field borders. `.input` paints `--rule-field` over its own `--paper` fill (default
 * `background-clip`), and a field often sits inside a `--paper-raised` panel such as the Report
 * dialog. A translucent dark `--rule-field` therefore has to clear 3:1 against both grounds once
 * it is composited over `--paper`. At alpha 0.36 it measured 2.90:1 against the dialog (batch 006
 * round F1).
 *
 * Status dots. A pip's dot takes its label's colour (`.pip::before`, currentColor), so no tone
 * may paint its own dot, and each label colour has to clear 3:1 on the grounds pips sit on.
 * Clay on cream was 2.96:1 and `--rule-strong` 1.6:1 (batch 006, F53). Every status-badge dot
 * in forms.css, the base and each tone, has to clear it too: draft's clay was the same 2.96:1
 * (batch 006, round F2).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sheet = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
const tokens = sheet('src/styles/tokens.css');
const primitives = sheet('src/styles/primitives.css');
const forms = sheet('src/styles/forms.css');

/** The custom properties of the first block whose selector list contains `selector`. */
function themeBlock(selector: string): Map<string, string> {
  const at = tokens.indexOf(selector);
  expect(at, selector).toBeGreaterThan(-1);
  const body = tokens.slice(tokens.indexOf('{', at) + 1, tokens.indexOf('}', at));
  return new Map([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

/** Every top-level rule (unindented, so not one inside an at-rule): its selector list and body. */
function topRules(css: string): { selectors: string[]; body: string }[] {
  return [...css.matchAll(/(?:^|\n)([^\s@{}][^{}]*)\{([^}]*)\}/g)].map((m) => ({
    selectors: m[1]!.split(',').map((s) => s.trim()),
    body: m[2]!,
  }));
}

/** The bodies of every top-level rule whose selector list includes `selector`, grouped or not. */
function rules(css: string, selector: string): string {
  return topRules(css)
    .filter((rule) => rule.selectors.includes(selector))
    .map((rule) => rule.body)
    .join('\n');
}

type RGBA = [number, number, number, number];
function colour(value: string): RGBA {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)).concat(1) as RGBA;
  const rgb = value.match(
    /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[/,]\s*([\d.]+))?\s*\)$/,
  );
  if (!rgb) throw new Error(`not a colour: ${value}`);
  return [
    Number(rgb[1]),
    Number(rgb[2]),
    Number(rgb[3]),
    rgb[4] === undefined ? 1 : Number(rgb[4]),
  ];
}
const over = ([r, g, b, a]: RGBA, [R, G, B]: RGBA): RGBA => [
  r * a + R * (1 - a),
  g * a + G * (1 - a),
  b * a + B * (1 - a),
  1,
];
const lum = ([r, g, b]: RGBA) => {
  const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a: RGBA, b: RGBA) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

const THEMES = [
  ['dark', "[data-theme='dark']"],
  ['light', "[data-theme='light']"],
] as const;

/** The token a declaration such as `color: var(--clay-deep)` names. */
function tokenOf(body: string, property: string): string {
  const m = body.match(new RegExp(`(?:^|[\\s;])${property}:\\s*var\\((--[\\w-]+)\\)`));
  expect(m, `${property} in ${body}`).not.toBeNull();
  return m![1]!;
}

describe('field borders', () => {
  it.each(THEMES)('clear 3:1 in %s, on the field and on a raised panel', (_theme, selector) => {
    const t = themeBlock(selector);
    const paper = colour(t.get('--paper')!);
    const raised = colour(t.get('--paper-raised')!);
    const border = over(colour(t.get('--rule-field')!), paper);
    expect(contrast(border, paper)).toBeGreaterThanOrEqual(3);
    expect(contrast(border, raised)).toBeGreaterThanOrEqual(3);
  });
});

describe('status dots', () => {
  it('draw each pip dot in its label colour', () => {
    expect(rules(primitives, '.pip::before')).toMatch(/background: currentColor;/);
    for (const tone of ['live', 'next', 'archive'])
      expect(rules(primitives, `.pip-${tone}::before`), tone).not.toMatch(/background/);
  });

  it.each(THEMES)('clear 3:1 in %s on the page, the band and a panel', (_theme, selector) => {
    const t = themeBlock(selector);
    const grounds = ['--paper', '--paper-sunk', '--paper-raised'].map((g) => colour(t.get(g)!));
    // Every rule that paints a badge dot, so a new tone is held to 3:1 as soon as it lands.
    const badges = topRules(forms).filter((rule) =>
      rule.selectors.some((s) => /^\.status-badge(--[\w-]+)?::before$/.test(s)),
    );
    expect(badges.flatMap((rule) => rule.selectors)).toEqual(
      expect.arrayContaining(['.status-badge::before', '.status-badge--draft::before']),
    );
    const dots = [
      ...['live', 'next', 'archive'].map((tone) =>
        tokenOf(rules(primitives, `.pip-${tone}`), 'color'),
      ),
      ...badges.map((rule) => tokenOf(rule.body, 'background')),
    ];
    for (const token of dots)
      for (const ground of grounds)
        expect(contrast(over(colour(t.get(token)!), ground), ground), token).toBeGreaterThanOrEqual(
          3,
        );
  });
});
