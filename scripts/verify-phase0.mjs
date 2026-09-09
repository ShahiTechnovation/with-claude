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

// ── The counts the owner asked to see ────────────────────────────────────
console.log('\nCOUNTS');
check(
  'builders excluding the archived one',
  totalRows - (byStatus.archived ?? 0),
  72,
);
check('exactly one archived builder', byStatus.archived ?? 0, 1);

// ── The record sets ──────────────────────────────────────────────────────
const dbSet = await loadRecordSet(db);
const ts = tsRecordSet();
const isPublic = (r) => r.status === 'published' || r.status === 'featured';

console.log('\nRECORD SETS');
check('db record set loads 72 builders', dbSet.builders.length, 72);
check('ts record set holds 72 builders', ts.builders.length, 72);
check(
  'the archived builder does not reach the record set',
  dbSet.builders.some((b) => b.slug === 'prod-test-builderprod-test-builder'),
  false,
);

const dbSlugs = dbSet.builders.map((b) => b.slug).sort();
const tsSlugs = ts.builders.map((b) => b.slug).sort();
check('every builder slug matches, both directions', dbSlugs, tsSlugs);

console.log('\nTHE PUBLISHED PUBLIC SET (step 7)');
const dbPublic = dbSet.builders.filter(isPublic).map((b) => b.slug);
const tsPublic = ts.builders.filter(isPublic).map((b) => b.slug);
check('published builders are the same, in the same order', dbPublic, tsPublic);
check('and there are three of them', dbPublic, ['aniket-sahu', 'vishal-kumar', 'punit']);

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
check('no ownership inferred — builders.owner_member_id does not exist yet', 'owner_member_id' in (punit ?? {}), false);

// ── The other entities, untouched ────────────────────────────────────────
console.log('\nNOTHING ELSE MOVED');
check('projects', dbSet.projects.length, 26);
check('events', dbSet.events.length, 14);
check('cities', dbSet.cities.length, 14);
check('ambassadors', dbSet.ambassadors.length, 1);

console.log('');
if (failures.length) {
  console.log(`NOT VERIFIED — ${failures.length} check(s) failed:`);
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('VERIFIED — every Phase 0 assertion holds.');
process.exit(0);
