/**
 * THE INDIA MAP: the generated outline (src/data/india-map.ts), its projection and the
 * component that draws it.
 *
 * The boundary checks guard the source. India's outline here follows DataMeet's Admin2
 * states, which follow the Survey of India line; publishing a different outline is a
 * regulated matter in India. A de facto outline (Natural Earth, OpenStreetMap) puts
 * Gilgit, Aksai Chin or the Shaksgam valley outside and fails this file.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { INDIA_MAP } from '../src/data/india-map';
import { projectIndia } from '../src/lib/geo';

type Pt = [number, number];

/** The relative m/z paths scripts/map/post.mjs writes, back to absolute rings. */
function decode(d: string): Pt[][] {
  const rings: Pt[][] = [];
  let cur: Pt = [0, 0];
  let start = cur;
  let nums: string[] = [];
  const flush = () => {
    for (let i = 0; i < nums.length; i += 2) {
      cur = [cur[0] + Number(nums[i]), cur[1] + Number(nums[i + 1])];
      if (i === 0) {
        start = cur;
        rings.push([]);
      }
      rings.at(-1)!.push(cur);
    }
    nums = [];
  };
  for (const t of d.match(/[mz]|-?(?:\d+(?:\.\d*)?|\.\d+)/g) ?? []) {
    if (t === 'm') flush();
    else if (t === 'z') {
      flush();
      cur = start;
    } else nums.push(t);
  }
  flush();
  return rings;
}

const inRing = ([x, y]: Pt, r: Pt[]) =>
  r.filter((p, i) => {
    const q = r[(i + 1) % r.length];
    return p[1] > y !== q[1] > y && x < p[0] + ((y - p[1]) * (q[0] - p[0])) / (q[1] - p[1]);
  }).length %
    2 ===
  1;
const toSegment = (p: Pt, a: Pt, b: Pt) => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.max(
    0,
    Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)),
  );
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};
const span = (r: Pt[]) => {
  const xs = r.map((p) => p[0]);
  const ys = r.map((p) => p[1]);
  return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
};
const at = (lat: number, lon: number): Pt => {
  const { x, y } = projectIndia(lat, lon);
  return [x, y];
};

const mainland = decode(INDIA_MAP.india);
const islands = decode(INDIA_MAP.islands);
const states = decode(INDIA_MAP.states);

describe('projectIndia', () => {
  // From the verified v2 build ($SP/map-v2/cities.json, rounded to 0.1), at the
  // coordinates in src/data/cities.ts.
  const expected: Record<string, [lat: number, lon: number, x: number, y: number]> = {
    ahmedabad: [23.0225, 72.5714, 175.6, 555.6],
    bengaluru: [12.9716, 77.5946, 344.7, 938.1],
    bhopal: [23.2599, 77.4126, 343.9, 551.8],
    chandigarh: [30.7333, 76.7794, 327.4, 268.8],
    chennai: [13.0827, 80.2707, 443.7, 934.6],
    delhi: [28.6139, 77.209, 340.2, 349.7],
    guwahati: [26.1445, 91.7362, 832.9, 429.9],
    hyderabad: [17.385, 78.4867, 379.2, 772.5],
    indore: [22.7196, 75.8577, 289.5, 571],
    jaipur: [26.9124, 75.7873, 291, 413.1],
    kochi: [9.9312, 76.2673, 293, 1052.3],
    kolkata: [22.5726, 88.3639, 725.1, 571],
    mumbai: [19.076, 72.8777, 179.9, 704],
    pune: [18.5204, 73.8567, 214, 726.2],
  };

  it.each(Object.entries(expected))('places %s where the map build did', (_, [lat, lon, x, y]) => {
    const p = projectIndia(lat, lon);
    expect(Math.abs(p.x - x)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(p.y - y)).toBeLessThanOrEqual(0.05);
  });
});

describe('the India map data', () => {
  it('has the frame and ring counts of the verified build', () => {
    expect([INDIA_MAP.width, INDIA_MAP.height]).toEqual([1040, 1176]);
    expect(mainland).toHaveLength(71);
    expect(islands).toHaveLength(77);
  });

  it('keeps at least 15 units clear of every edge', () => {
    for (const p of [...mainland, ...islands, ...states].flat()) {
      expect(p[0]).toBeGreaterThanOrEqual(15);
      expect(p[1]).toBeGreaterThanOrEqual(15);
      expect(INDIA_MAP.width - p[0]).toBeGreaterThanOrEqual(15);
      expect(INDIA_MAP.height - p[1]).toBeGreaterThanOrEqual(15);
    }
  });

  // Even-odd over every mainland ring.
  const insideIndia = (p: Pt) => mainland.filter((r) => inRing(p, r)).length % 2 === 1;

  it.each([
    ['Gilgit', 35.9208, 74.3089],
    ['Muzaffarabad', 34.37, 73.471],
    ['Mirpur', 33.1478, 73.7517],
    ['K2', 35.8808, 76.5155],
    ['Shaksgam', 36.1, 76.6],
    ['Aksai Chin', 35.25, 79.25],
    ['Lingzi Tang', 35.0, 78.9],
    ['Tawang', 27.5861, 91.8594],
    ['Kibithu', 28.2829, 97.0136],
  ])('draws %s inside the official boundary', (_, lat, lon) => {
    expect(insideIndia(at(lat, lon))).toBe(true);
  });

  it.each([
    ['Islamabad', 33.6844, 73.0479],
    ['Lahore', 31.5204, 74.3587],
    ['Kathmandu', 27.7172, 85.324],
    ['Lhasa', 29.65, 91.1],
    ['Dhaka', 23.8103, 90.4125],
    ['Rutog', 33.3808, 79.7255],
  ])('draws %s outside the boundary', (_, lat, lon) => {
    expect(insideIndia(at(lat, lon))).toBe(false);
  });

  // Small islands are the first thing a simplifier drops. Each of these must still be its
  // own small ring in the islands path (the mainland path is never searched).
  it.each([
    ['Kavaratti', 10.5626, 72.6369],
    ['Neil', 11.832, 93.031],
    ['Long Island', 12.38, 92.93],
    ['Barren', 12.278, 93.858],
    ['Narcondam', 13.433, 94.267],
    ['Minicoy', 8.28, 73.05],
  ])('keeps %s as an island', (_, lat, lon) => {
    const p = at(lat, lon);
    const found = islands.filter(
      (r) =>
        span(r) <= 8 &&
        (inRing(p, r) || r.some((a, i) => toSegment(p, a, r[(i + 1) % r.length]) <= 1)),
    );
    expect(found.length).toBeGreaterThan(0);
  });
});

describe('CityAtlas', () => {
  const atlas = readFileSync('src/components/CityAtlas.astro', 'utf8').replace(/\r\n/g, '\n');

  it('keeps every stroke one screen pixel wide on the land and the islands', () => {
    // vector-effect is not inherited, so it sits on the paths, not on the <use>s.
    expect(atlas).toMatch(
      /<path\s+id="in-land"\s+d=\{INDIA_MAP\.india\}\s+vector-effect="non-scaling-stroke"/,
    );
    expect(atlas).toMatch(
      /<path\s+class="islands"\s+d=\{INDIA_MAP\.islands\}\s+vector-effect="non-scaling-stroke"/,
    );
  });

  it('credits DataMeet and the licence on /about/, not under the map, with both links', () => {
    // The owner took the credit off the map (7 October 2026); CC BY 2.5 IN still needs it.
    expect(atlas).not.toContain('datameet.org');
    expect(atlas).not.toContain('figcaption');
    const about = readFileSync('src/pages/about.astro', 'utf8');
    expect(about).toContain('href="https://projects.datameet.org/maps/"');
    expect(about).toContain('href="https://creativecommons.org/licenses/by/2.5/in/"');
    expect(about).toContain('State boundary maps are provided by');
    expect(about).toContain('Data&#123;Meet&#125; Community Maps Project');
    expect(about).toContain('Creative Commons Attribution 2.5 India');
    expect(about).toContain('Simplified and reprojected.');
    expect(about).toMatch(/<p class="small map-credit" set:html=\{MAP_CREDIT\} \/>/);
  });

  it('sets label sizes per kind of city, never per city', () => {
    // One rule per kind (quiet, active, lead), so Kochi matches every other quiet city:
    // a pin's only inline style is its position, and no rule targets a city by slug.
    const styles = [...atlas.matchAll(/style=\{`([^`]*)`\}/g)].map((m) => m[1]);
    expect(styles).toEqual(['--x:${pct(p.x, W)};--y:${pct(p.y, H)}']);
    expect(atlas).not.toMatch(/\[data-pin=/);
    expect(atlas).not.toMatch(/\.pin\.(?!lead|active|quiet|[rltd]\b)[a-z]/);
  });

  it('ends each ring run on the resting ring, not with a jump', () => {
    const ring = atlas.slice(atlas.indexOf('@keyframes ring'));
    const frames = ring.slice(0, ring.indexOf('\n  }\n'));
    // No `to` frame: the run eases back to the resting opacity 0.55 at scale 1.
    expect(frames).not.toMatch(/\bto \{|100% \{/);
    expect(atlas).toMatch(/animation: ring [^;]* 2;/);
  });

  it('keeps quiet labels and the light lead dot clear of the land and glow', () => {
    expect(atlas).toContain('0 0 1px var(--paper-sunk),');
    expect(atlas).toMatch(
      /:global\(\[data-theme='light'\]\) \.pin\.lead::before \{\s*box-shadow:\s*0 0 0 3px var\(--map-land-hot\),/,
    );
  });

  it('rings the lit dots in light and print, and prints the dots in colour', () => {
    // An outline, not a shadow: base.css drops every box-shadow in print.
    expect(atlas).toMatch(
      /:global\(\[data-theme='light'\]\) \.pin\.active::before \{\s*outline: 1\.5px solid var\(--clay-deep\);/,
    );
    const print = atlas.slice(atlas.indexOf('@media print {'));
    expect(print).toMatch(/\.map-figure \{\s*print-color-adjust: exact;/);
    expect(print).toMatch(/\.pin\.active::before \{\s*outline: 1\.5px solid var\(--clay-deep\);/);
  });
});
