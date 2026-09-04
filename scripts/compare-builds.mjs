/**
 * COMPARE TWO BUILDS — the §21 check.
 *
 * Takes two `dist/` directories, one built with `DATA_SOURCE=ts` and one with
 * `DATA_SOURCE=db`, and reports every difference between them:
 *
 *   · the route set        exactly the same pages, or name what is missing
 *   · the HTML             equivalent, modulo build hashes
 *   · the sitemap          exactly the same URLs
 *
 * ── WHAT IS NORMALISED, AND WHAT IS NOT ──────────────────────────────────
 *
 * ONLY genuinely nondeterministic build metadata:
 *
 *   · asset fingerprints   `/_astro/name.D4tA1Ur3.css` → `/_astro/name.HASH.css`
 *   · Astro's own build id, which changes every run
 *
 * Everything a reader could notice is compared verbatim: text, links, dates,
 * counts, titles, entity names, JSON-LD, canonical URLs, and the `noindex`
 * state of every page. If the two sources disagree about any of those, this
 * says so and names the file.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const [, , tsDir, dbDir] = process.argv;
if (!tsDir || !dbDir) {
  console.error('usage: node compare-builds.mjs <ts-dist> <db-dist>');
  process.exit(2);
}

/** Every `.html` file under a directory, as root-relative POSIX routes. */
function pages(root) {
  const out = new Map();
  if (!existsSync(root)) return out;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.html')) {
        out.set('/' + relative(root, path).split(sep).join('/'), path);
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Strip the build's own nondeterminism, and nothing else.
 *
 * Each pattern is deliberately narrow: a content hash inside a filename, and
 * Astro's per-build id. Anything broader would risk normalising away a real
 * difference — which would turn this comparison into a way of not noticing.
 */
function normalise(html) {
  return (
    html
      // /_astro/hero.BQ2kF9zT.webp  and  hero.BQ2kF9zT_Z1abcd.webp
      .replace(/\.[A-Za-z0-9_-]{8,}\.(webp|avif|png|jpe?g|css|js|svg|woff2?)/g, '.HASH.$1')
      // Astro's build id, emitted in a few data attributes.
      .replace(/data-astro-(cid|source)-[A-Za-z0-9-]+/g, 'data-astro-$1-HASH')
      .replace(/astro-[a-z0-9]{8,}/g, 'astro-HASH')
  );
}

const ts = pages(join(tsDir, 'client'));
const db = pages(join(dbDir, 'client'));

const problems = [];

// ── Routes ──────────────────────────────────────────────────────────────
const tsRoutes = [...ts.keys()].sort();
const dbRoutes = [...db.keys()].sort();

const onlyTs = tsRoutes.filter((r) => !db.has(r));
const onlyDb = dbRoutes.filter((r) => !ts.has(r));

console.log(`routes:  ts=${tsRoutes.length}  db=${dbRoutes.length}`);
if (onlyTs.length) problems.push(`only in ts: ${onlyTs.join(', ')}`);
if (onlyDb.length) problems.push(`only in db: ${onlyDb.join(', ')}`);
if (!onlyTs.length && !onlyDb.length) console.log('         ✓ identical route set');

// ── HTML ────────────────────────────────────────────────────────────────
let identical = 0;
const differing = [];

for (const route of tsRoutes) {
  if (!db.has(route)) continue;
  const a = normalise(readFileSync(ts.get(route), 'utf8'));
  const b = normalise(readFileSync(db.get(route), 'utf8'));
  if (a === b) {
    identical++;
    continue;
  }

  // Report the first differing line, so a failure is actionable.
  const al = a.split('\n');
  const bl = b.split('\n');
  let at = -1;
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] !== bl[i]) {
      at = i;
      break;
    }
  }
  differing.push({
    route,
    line: at + 1,
    ts: (al[at] ?? '').trim().slice(0, 200),
    db: (bl[at] ?? '').trim().slice(0, 200),
  });
}

console.log(`html:    ${identical}/${tsRoutes.length} byte-identical after hash normalisation`);
if (differing.length) {
  problems.push(`${differing.length} page(s) differ`);
  for (const d of differing.slice(0, 10)) {
    console.log(`\n  ✗ ${d.route}  (line ${d.line})`);
    console.log(`      ts: ${d.ts}`);
    console.log(`      db: ${d.db}`);
  }
} else {
  console.log('         ✓ every page equivalent');
}

// ── Sitemap ─────────────────────────────────────────────────────────────
function sitemapUrls(root) {
  const urls = [];
  const dir = join(root, 'client');
  if (!existsSync(dir)) return urls;
  for (const name of readdirSync(dir)) {
    if (!/^sitemap.*\.xml$/.test(name)) continue;
    const xml = readFileSync(join(dir, name), 'utf8');
    for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      if (!m[1].includes('sitemap')) urls.push(m[1]);
    }
  }
  return urls.sort();
}

const tsMap = sitemapUrls(tsDir);
const dbMap = sitemapUrls(dbDir);

console.log(`sitemap: ts=${tsMap.length}  db=${dbMap.length}`);
const mapOnlyTs = tsMap.filter((u) => !dbMap.includes(u));
const mapOnlyDb = dbMap.filter((u) => !tsMap.includes(u));
if (mapOnlyTs.length) problems.push(`sitemap only in ts: ${mapOnlyTs.join(', ')}`);
if (mapOnlyDb.length) problems.push(`sitemap only in db: ${mapOnlyDb.join(', ')}`);
if (!mapOnlyTs.length && !mapOnlyDb.length && tsMap.length > 0) {
  console.log('         ✓ identical sitemap');
}

// ── Verdict ─────────────────────────────────────────────────────────────
console.log('');
if (problems.length === 0) {
  console.log('EQUIVALENT — routes, HTML and sitemap all match.');
  process.exit(0);
}
console.log('NOT EQUIVALENT:');
for (const p of problems) console.log(`  · ${p}`);
process.exit(1);
