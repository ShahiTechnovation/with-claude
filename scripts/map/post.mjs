// Turns mapshaper's raw SVG into src/data/india-map.ts.
// usage: node post.mjs <raw.svg> <out.ts>   (scripts/map/build.sh runs it)
// Checks that every source island is drawn, no two land rings cross, and the outline
// clears the viewBox edge, then writes the three paths as one TypeScript module.
import { readFileSync, writeFileSync } from 'node:fs';

const [, , rawPath, outPath] = process.argv;
const raw = readFileSync(rawPath, 'utf8');

const [W, H] = raw
  .match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)
  .slice(1)
  .map(Number);
const FINE = 1000; // raw.svg is written at 0.001 viewBox units; all maths here is in those integer steps
const GRID = 100; // output grid: 0.1 units
const MIN_MARGIN = 15; // viewBox units of empty space the outline keeps from every edge

const fine = (v) => Math.round(parseFloat(v) * FINE);
const snap = (v) => Math.round(v / GRID) * GRID;
const same = (a, b) => a[0] === b[0] && a[1] === b[1];
const num = (n) => String(n / FINE).replace(/^(-?)0\./, '$1.');

// Join numbers with the fewest separators the SVG path grammar allows.
function join_(tokens) {
  let out = '';
  for (const t of tokens) {
    const prev = out.at(-1);
    const needSep =
      out &&
      /[\d.]/.test(prev) &&
      !t.startsWith('-') &&
      !(t.startsWith('.') && /\.\d*$/.test(out.match(/[-\d.]+$/)?.[0] ?? ''));
    out += (needSep ? ' ' : '') + t;
  }
  return out;
}

const group = (id) => raw.match(new RegExp(`<g id="${id}"[^>]*>([\\s\\S]*?)</g>`))[1];
const circlesOf = (id) =>
  [...group(id).matchAll(/<circle[^>]*>/g)].map(([c]) => {
    const attr = (k) => c.match(new RegExp(` ${k}="([^"]+)"`))?.[1];
    return { id: attr('id'), x: fine(attr('cx')), y: fine(attr('cy')) };
  });

// mapshaper writes absolute "M x y x y ... [Z]"; a closed ring repeats its first point
// before the Z. Each subpath keeps its exact points next to the ones snapped to GRID.
function parse(id) {
  const ds = [...group(id).matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
  return ds
    .join(' ')
    .split('M')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((sub) => {
      const closed = sub.endsWith('Z');
      const v = sub.replace(/Z$/, '').trim().split(/\s+/).map(fine);
      if (v.some(Number.isNaN)) throw new Error('unexpected path data: ' + sub.slice(0, 80));
      const exact = [];
      for (let i = 0; i < v.length; i += 2) exact.push([v[i], v[i + 1]]);
      if (closed && exact.length > 1 && same(exact[0], exact.at(-1))) exact.pop();
      return { closed, exact, pts: exact.map(([x, y]) => [snap(x), snap(y)]) };
    });
}

// All of a group's subpaths as one relative path.
function encode(subpaths) {
  let cur = [0, 0];
  let out = '';
  const kept = [];
  for (const { closed, pts: all } of subpaths) {
    const pts = all.filter((p, i) => i === 0 || !same(p, all[i - 1]));
    if (closed && pts.length > 1 && same(pts[0], pts.at(-1))) pts.pop();
    if (pts.length < 2) continue;
    const toks = [];
    let prev = cur;
    for (const p of pts) {
      toks.push(num(p[0] - prev[0]), num(p[1] - prev[1]));
      prev = p;
    }
    out += 'm' + join_(toks) + (closed ? 'z' : '');
    cur = closed ? pts[0] : prev;
    kept.push(pts);
  }
  // Self-check: decoding the relative path must give back exactly the snapped points.
  if (JSON.stringify(decode(out)) !== JSON.stringify(kept))
    throw new Error('path round-trip mismatch');
  return out;
}

function decode(d) {
  const subs = [];
  let cur = [0, 0],
    start = cur,
    nums = [];
  const flush = () => {
    for (let i = 0; i < nums.length; i += 2) {
      cur = [cur[0] + fine(nums[i]), cur[1] + fine(nums[i + 1])];
      if (i === 0) {
        start = cur;
        subs.push([]);
      }
      subs.at(-1).push(cur);
    }
    nums = [];
  };
  for (const t of d.match(/[mz]|-?(?:\d+(?:\.\d*)?|\.\d+)/g)) {
    if (t === 'm') flush();
    else if (t === 'z') {
      flush();
      cur = start;
    } else nums.push(t);
  }
  flush();
  return subs;
}

const india = parse('india');
const islands = parse('islands');
const states = parse('states');
const land = [...india, ...islands];

// ---- geometry helpers ----
const box = (pts) =>
  pts.reduce(
    (b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
const overlaps = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const turn = (o, a, b) => Math.sign((a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]));
const next = (r, k) => r[(k + 1) % r.length];
const inRing = ([x, y], r) =>
  r.filter((p, i) => {
    const q = next(r, i);
    return p[1] > y !== q[1] > y && x < p[0] + ((y - p[1]) * (q[0] - p[0])) / (q[1] - p[1]);
  }).length %
    2 ===
  1;
const toSegment = (p, a, b) => {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const t = Math.max(
    0,
    Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)),
  );
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};

// Segments of different rings that properly cross, as [ring, segment] pairs.
function crossings(rings) {
  const boxes = rings.map(box),
    hits = [];
  const segs = (i, b) =>
    rings[i]
      .map((p, k) => [k, p, next(rings[i], k)])
      .filter(([, p, q]) => overlaps(box([p, q]), b));
  for (let i = 0; i < rings.length; i++) {
    for (let j = i + 1; j < rings.length; j++) {
      if (!overlaps(boxes[i], boxes[j])) continue;
      const B = segs(j, boxes[i]);
      for (const [k, p, q] of segs(i, boxes[j])) {
        for (const [l, r, s] of B) {
          if (turn(p, q, r) * turn(p, q, s) < 0 && turn(r, s, p) * turn(r, s, q) < 0)
            hits.push([i, k], [j, l]);
        }
      }
    }
  }
  return hits;
}

// Snapping to GRID can make rings a few hundred metres apart cross (Austen Strait between
// North and Middle Andaman, the islets beside them). Like mapshaper's fix-geometry, put
// those segments back on their exact points until nothing crosses.
let hits = crossings(land.map((s) => s.pts));
for (let pass = 0; hits.length && pass < 10; pass++) {
  for (const [i, k] of hits) {
    const s = land[i];
    for (const v of [k, (k + 1) % s.pts.length]) s.pts[v] = s.exact[v];
  }
  hits = crossings(land.map((s) => s.pts));
}
if (hits.length)
  throw new Error(`land rings still cross near ${land[hits[0][0]].pts[hits[0][1]].map(num)}`);

// ---- checks ----
const rings = land.map((s) => s.pts);

// 1. Every source part (one interior point each, taken before simplifying) is still drawn:
//    inside one land ring, or within 1 unit of one, since keep-shapes can leave a tiny
//    island as a few of its own vertices that miss the old interior point. The land
//    rings have no holes, so a point inside two rings means two parts overlap.
const lost = circlesOf('probes')
  .map((c) => [c.x, c.y])
  .filter((p) => {
    const depth = rings.filter((r) => inRing(p, r)).length;
    return (
      depth > 1 ||
      (depth === 0 && !rings.some((r) => r.some((a, i) => toSegment(p, a, next(r, i)) <= FINE)))
    );
  });
if (lost.length)
  throw new Error(`islands lost at ${lost.map((p) => p.map(num).join(',')).join(' ')}`);

// 2. The outline keeps MIN_MARGIN clear of every viewBox edge.
const [x0, y0, x1, y1] = box(rings.flat()).map((v) => v / FINE);
const margins = { left: x0, top: y0, right: +(W - x1).toFixed(1), bottom: +(H - y1).toFixed(1) };
for (const [side, m] of Object.entries(margins)) {
  if (m < MIN_MARGIN) throw new Error(`outline is ${m} from the ${side} edge`);
}

// ---- output ----
// Laid out as prettier lays it out, so a rebuild is byte-identical to the checked-in file.
const ts = `// Generated by scripts/map/build.sh. Do not edit.
// State boundary maps are provided by Data{Meet} Community Maps Project (https://projects.datameet.org/maps/),
// made available under the Creative Commons Attribution 2.5 India licence. Simplified and reprojected.
// Source: github.com/datameet/maps States/Admin2.shp; Barren and Narcondam from Country/india-composite.geojson (CC0).
// Frame: E,N = +proj=lcc +lat_1=12 +lat_2=28 +lat_0=22 +lon_0=80 +datum=WGS84; x = (E + 1268500) / 2925, y = (1754300 - N) / 2925
export const INDIA_MAP = {
  width: ${W},
  height: ${H},
  india:
    '${encode(india)}',
  islands:
    '${encode(islands)}',
  states:
    '${encode(states)}',
} as const;
`;
writeFileSync(outPath, ts);
console.log(
  JSON.stringify({
    W,
    H,
    bytes: Buffer.byteLength(ts),
    mainlandRings: india.length,
    islandRings: islands.length,
    landRings: land.length,
    exactVertices: land.reduce(
      (n, s) => n + s.pts.filter((p) => p[0] % GRID || p[1] % GRID).length,
      0,
    ),
    probes: circlesOf('probes').length,
    margins,
  }),
);
