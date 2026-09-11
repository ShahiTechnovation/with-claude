/**
 * PHASE 0 VERIFICATION — read-only.
 *
 * Asserts the state the two data decisions of 2026-09-09 were supposed to
 * produce, against the real database, and exits non-zero if any of it is not
 * true. Written as assertions rather than as a report because a verification
 * that prints numbers for a human to eyeball is one somebody eventually
 * eyeballs wrongly.
 *
 *     npx tsx scripts/verify-phase0.mjs
 *
 * Reads. Writes nothing, changes nothing, and takes no arguments.
 */
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { count, eq } from 'drizzle-orm';
import * as schema from '../db/schema.ts';
import { loadRecordSet } from '../src/data/source-db.ts';
import { tsRecordSet } from '../src/data/source-ts.ts';

const db = drizzle(neon(process.env.DATABASE_URL), { schema });

const failures = [];
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${label}\n        got      ${JSON.stringify(actual)}` +
      (ok ? '' : `\n        expected ${JSON.stringify(expected)}`),
  );
  if (!ok) failures.push(label);
};

// ── The raw table ────────────────────────────────────────────────────────
const byStatus = Object.fromEntries(
  (
    await db
      .select({ status: schema.builders.status, n: count() })
      .from(schema.builders)
      .groupBy(schema.builders.status)
  ).map((r) => [r.status, Number(r.n)]),
);
const [{ n: totalRows }] = await db.select({ n: count() }).from(schema.builders);

console.log('BUILDER ROWS IN NEON');
console.log(`  by status  ${JSON.stringify(byStatus)}`);
console.log(`  total      ${totalRows}\n`);

console.log('THE TWO DECISIONS');

// 1. The test builder is archived, present, and still has its full history.
const [testRow] = await db
  .select({ id: schema.builders.id, status: schema.builders.status })
  .from(schema.builders)
  .where(eq(schema.builders.slug, 'prod-test-builderprod-test-builder'));

check('test builder row still exists (not hard-deleted)', Boolean(testRow), true);
check('test builder is archived', testRow?.status, 'archived');

const history = await db
  .select({ action: schema.auditLog.action })
  .from(schema.auditLog)
  .where(eq(schema.auditLog.entityId, testRow.id));
check(
  'test builder audit history preserved and added to',
  history.map((h) => h.action).sort(),
  ['builder.archived', 'builder.published', 'promoted'],
);

// 2. punit is still published.
const [punitRow] = await db
  .select({ status: schema.builders.status })
  .from(schema.builders)
  .where(eq(schema.builders.slug, 'punit'));
check('punit is still published', punitRow?.status, 'published');

/**
 * ── WHY THERE ARE NO FIXED TOTALS HERE ANY MORE ─────────────────────────
 *
 * This script originally asserted 72 builders, 26 projects and a published set
 * of exactly three. Those were the right assertions on 2026-09-09, when the
 * database was a frozen copy of the repository and the question was whether
 * the migration had damaged it.
 *
 * The site is live now. Editors promote real submissions and members publish
 * their own profiles, so a fixed total is a number that goes stale on its own
 * and then gets "fixed" by editing it to whatever today happens to be — which
 * is a test that only ever confirms the present. Two genuine members
 * (`hamza`, `naman-gupta-2`) and one project arrived between this script being
 * written and being re-run, and that is the system working.
 *
 * So the assertions became relational: the legacy record is a SUBSET of the
 * database, unchanged; growth is allowed; shrinkage is not. Those hold
 * whatever the counts are.
 */
console.log('\nCOUNTS');
check('exactly one archived builder', byStatus.archived ?? 0, 1);
check(
  'nothing is in an unexpected state',
  Object.keys(byStatus).sort(),
  ['archived', 'pending', 'published'],
);

// ── The record sets ──────────────────────────────────────────────────────
const dbSet = await loadRecordSet(db);
const ts = tsRecordSet();
const isPublic = (r) => r.status === 'published' || r.status === 'featured';

console.log('\nRECORD SETS');
check(
  'the archived builder does not reach the record set',
  dbSet.builders.some((b) => b.slug === 'prod-test-builderprod-test-builder'),
  false,
);

const dbSlugs = new Set(dbSet.builders.map((b) => b.slug));
const missingLegacy = ts.builders.map((b) => b.slug).filter((slug) => !dbSlugs.has(slug));
check('every legacy builder is still in the database', missingLegacy, []);

// Growth is reported, never asserted — it is information, not a rule.
const newcomers = [...dbSlugs].filter((slug) => !ts.builders.some((b) => b.slug === slug));
console.log(
  `  INFO  ${newcomers.length} builder(s) in the database and not in src/data/builders.ts` +
    (newcomers.length ? `: ${newcomers.join(', ')}` : ''),
);
console.log('        §59: new content belongs in Neon, not written back into the record files.');

console.log('\nTHE PUBLISHED PUBLIC SET');
const dbPublic = dbSet.builders.filter(isPublic).map((b) => b.slug);
const tsPublic = ts.builders.filter(isPublic).map((b) => b.slug);
check(
  'every builder the record publishes is published in the database too',
  tsPublic.filter((slug) => !dbPublic.includes(slug)),
  [],
);
console.log(`  INFO  published in the database: ${dbPublic.join(', ')}`);

// punit's own fields, verbatim — the point being that they were NOT tidied.
const punit = dbSet.builders.find((b) => b.slug === 'punit');
const punitTs = ts.builders.find((b) => b.slug === 'punit');
console.log('\nPUNIT PRESERVED VERBATIM, NOT NORMALISED');
check('claudeTools kept as typed (lower-case c)', punit?.claudeTools, ['Claude code']);
check('ts side carries the same value', punitTs?.claudeTools, ['Claude code']);
check('links kept as the database resolved them', punit?.links, [
  { label: 'impure.me', url: 'https://impure.me/' },
]);
check('ts side carries the same link', punitTs?.links, [
  { label: 'impure.me', url: 'https://impure.me/' },
]);
check(
  'the rendered record still leaks no ownership column',
  'owner_member_id' in (punit ?? {}) || 'ownerMemberId' in (punit ?? {}),
  false,
);

// ── The other entities, still whole ──────────────────────────────────────
//
// Subset checks for the same reason as above: a project or event may be added,
// but one the repository knows about may never vanish.
console.log('\nNOTHING WENT MISSING');
// Singulars written out, because `'cities'.replace(/s$/, '')` is "citie".
for (const [key, singular] of [
  ['projects', 'project'],
  ['events', 'event'],
  ['cities', 'city'],
  ['ambassadors', 'ambassador'],
]) {
  const present = new Set(dbSet[key].map((r) => r.slug));
  const missing = ts[key].map((r) => r.slug).filter((slug) => !present.has(slug));
  check(`every legacy ${singular} is still present`, missing, []);
  console.log(`        ${key}: ${dbSet[key].length} in the database, ${ts[key].length} in the record`);
}

console.log('');
if (failures.length) {
  console.log(`NOT VERIFIED — ${failures.length} check(s) failed:`);
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('VERIFIED — every Phase 0 assertion holds.');
process.exit(0);
