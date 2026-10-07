#!/usr/bin/env node
// Lint WITH CLAUDE project icons against STYLE.md.
// usage: node scripts/icons/lint.mjs icon.svg [more.svg ...]      self-check: node scripts/icons/lint.mjs --self-test
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const STROKE = 4,
  INK = '#141413',
  PAPER = '#FAF9F5',
  TILE = '#D97757',
  MAX_SHAPES = 4;
const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
const TAGS = new Set(['svg', 'g', ...SHAPES]);
const INHERITED = ['fill', 'stroke', 'stroke-width', 'stroke-linejoin', 'stroke-linecap'];
const ATTRS = new Set([
  ...INHERITED,
  'xmlns',
  'viewBox',
  'width',
  'height',
  'd',
  'x',
  'y',
  'rx',
  'ry',
  'cx',
  'cy',
  'r',
  'x1',
  'y1',
  'x2',
  'y2',
  'points',
  'transform',
  'fill-rule',
  'aria-hidden',
  'role',
]);
const FILLS = new Set(['none', PAPER, INK, TILE]);
const TAG_RE =
  /<!--[\s\S]*?-->|<\?xml[^>]*\?>|<(\/?)([\w:-]+)((?:\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;

export function lint(src) {
  const p = [];
  const bytes = Buffer.byteLength(src);
  if (bytes >= 4096) p.push(`${bytes} bytes, must be under 4096`);
  const stray = src.replace(TAG_RE, '').trim();
  if (stray)
    p.push(
      `stray content outside tags (text is not allowed): ${JSON.stringify(stray.slice(0, 40))}`,
    );
  // SVG defaults: an element with no fill paints pure black, which is not in the palette.
  const stack = [
    {
      fill: '#000000',
      stroke: 'none',
      'stroke-width': '1',
      'stroke-linejoin': 'miter',
      'stroke-linecap': 'butt',
    },
  ];
  let first = true,
    tile = false,
    shapes = 0;
  for (const [, close, tag, attrText = '', selfClose] of src.matchAll(TAG_RE)) {
    if (!tag) continue; // comment or <?xml?>
    if (close) {
      stack.pop();
      continue;
    }
    const a = Object.fromEntries(
      [...attrText.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(([, k, v1, v2]) => [
        k,
        (v1 ?? v2).trim(),
      ]),
    );
    if (first && (tag !== 'svg' || a.xmlns !== 'http://www.w3.org/2000/svg'))
      p.push('must start with <svg xmlns="http://www.w3.org/2000/svg">');
    if (tag === 'svg' && a.viewBox?.replace(/[\s,]+/g, ' ') !== '0 0 96 96')
      p.push(`viewBox must be "0 0 96 96" (got ${JSON.stringify(a.viewBox ?? null)})`);
    first = false;
    if (!TAGS.has(tag))
      p.push(
        tag === 'text' || tag === 'tspan'
          ? `<${tag}>: no text, letters or numbers`
          : `<${tag}> not allowed`,
      );
    for (const k of Object.keys(a))
      if (!ATTRS.has(k)) p.push(`<${tag}> attribute "${k}" not allowed`);
    if (a.fill && !FILLS.has(a.fill.toUpperCase().replace('NONE', 'none')))
      p.push(`fill ${a.fill} not allowed (use ${PAPER}, ${INK}, ${TILE} or none)`);
    if (a.stroke && !['none', INK].includes(a.stroke.toUpperCase().replace('NONE', 'none')))
      p.push(`stroke ${a.stroke} not allowed (use ${INK})`);
    if (a['stroke-width'] && Number(a['stroke-width']) !== STROKE)
      p.push(`stroke-width ${a['stroke-width']} must be ${STROKE}`);
    if (a.transform && !/^(\s*(translate|rotate)\([^)]*\)\s*)+$/.test(a.transform))
      p.push(
        `transform "${a.transform}" not allowed (translate/rotate only, scaling changes the stroke weight)`,
      );
    const eff = { ...stack.at(-1) };
    for (const k of INHERITED) if (a[k]) eff[k] = a[k].toUpperCase().replace('NONE', 'none');
    if (SHAPES.has(tag)) {
      if (!tile) {
        tile = true;
        if (
          tag !== 'rect' ||
          a.width !== '96' ||
          a.height !== '96' ||
          +(a.x ?? 0) ||
          +(a.y ?? 0) ||
          a.rx !== '8' ||
          eff.fill !== TILE ||
          eff.stroke !== 'none' ||
          a.transform ||
          stack.length !== 2
        )
          p.push(
            `first shape must be the tile: <rect width="96" height="96" rx="8" fill="${TILE}"/> directly inside <svg>, no stroke`,
          );
      } else {
        shapes++;
        if (eff.fill === '#000000')
          p.push(
            `<${tag}> has no fill, so it paints pure black; set fill="none" or a palette colour`,
          );
        if (eff.stroke !== 'none') {
          if (Number(eff['stroke-width']) !== STROKE)
            p.push(`<${tag}> strokes at ${eff['stroke-width']}, must be ${STROKE}`);
          if (eff['stroke-linejoin'] !== 'ROUND' || eff['stroke-linecap'] !== 'ROUND')
            p.push(`<${tag}> needs stroke-linejoin="round" and stroke-linecap="round"`);
        } else if (eff.fill === PAPER || eff.fill === TILE)
          p.push(`<${tag}> filled ${eff.fill} without the ${INK} outline`);
      }
    }
    if (!selfClose) stack.push(eff);
  }
  if (!tile) p.push('no tile background');
  if (tile && !shapes) p.push('no object drawn');
  if (shapes > MAX_SHAPES)
    p.push(`${shapes} shapes on the tile, max ${MAX_SHAPES} (merge parts into one <path>)`);
  return [...new Set(p)];
}

// Run as a CLI only; importing lint() (tests/project-card.test.ts) must not run this or exit.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv[2] === '--self-test') {
    const good =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="8" fill="${TILE}"/>` +
      `<g fill="${PAPER}" stroke="${INK}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"><circle cx="48" cy="48" r="20"/></g></svg>`;
    assert.deepEqual(lint(good), []);
    const bad = lint(
      good
        .replace('r="20"/>', 'r="20"/><text>Hi</text>')
        .replace('</g>', '</g><path d="M0 0h9"/>')
        .replace(PAPER, '#FFFFFF')
        .replace('"4"', '"2"'),
    ).join('\n');
    for (const want of ['<text>', '#FFFFFF', 'stroke-width 2', 'pure black', 'stray content'])
      assert(bad.includes(want), want);
    console.log('self-test ok');
  } else {
    const files = process.argv.slice(2);
    if (!files.length) {
      console.error('usage: node lint.mjs icon.svg [more.svg ...]');
      process.exit(2);
    }
    let failed = 0;
    for (const f of files) {
      const p = lint(readFileSync(f, 'utf8'));
      if (p.length) failed++;
      console.log(p.length ? `FAIL ${f}\n${p.map((x) => `  - ${x}`).join('\n')}` : `PASS ${f}`);
    }
    process.exit(failed ? 1 : 0);
  }
}
