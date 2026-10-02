#!/usr/bin/env tsx
/**
 * THE EVENT-ARCHIVE IMPORTER.
 *
 *   npm run import -- inspect  <file>
 *   npm run import -- plan     <file> --mapping <mapping.json>
 *   npm run import -- apply    --plan imports/<batch>/plan.json [--decisions …] [--publish] --yes
 *   npm run import -- rollback --batch <batch-id> --yes
 *
 * inspect   sheets, headers, row counts and masked sample values — nothing is
 *           written anywhere
 * plan      the dry run: candidates, matches, diffs, totals. Writes
 *           `imports/<batch>/plan.json`, `plan.md` and an editable
 *           `decisions.json`, and records a `planned` batch in the database
 * apply     writes the reviewed decisions to Baserow (draft by default) with a
 *           resumable ledger; the normal sync then projects them into Neon
 * rollback  reverts this batch's Baserow rows that nobody has edited or
 *           claimed since
 *
 * The September 2026 Bhopal event archive (two organiser workbooks with
 * their own source adapter — see `scripts/import/archive.ts`):
 *
 *   archive-plan | verify-links | archive-report | fixture-seed | sync | enrich-logos
 *
 * Environment: DATABASE_URL (ledger, crosswalk), BASEROW_CONFIG, BASEROW_API_URL,
 * and BASEROW_IMPORT_TOKEN — a database token with create/update/delete on the
 * Projects and Credits tables ONLY. It is never used by the website.
 *
 * Safety rails: apply and rollback need `--yes`; a non-local DATABASE_URL needs
 * `--allow-remote-db`; the real participant files belong in `imports/` (which
 * is git-ignored) and nowhere in the repository.
 */
import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { eq } from 'drizzle-orm';
import { pooledDb } from '../../db/pool';
import * as schema from '../../db/schema';
import { readWorkbook } from './lib/workbook';
import { maskForDisplay } from './lib/normalise';
import { buildCandidates, MappingSchema } from './lib/candidates';
import { buildPlan, renderPlan, type Plan } from './lib/plan';
import { applyPlan, rollbackBatch, type Decision } from './lib/apply';
import { fieldOptionsFrom, loadBaserowProjects, loadCrosswalk, loadNeonProjects } from './lib/existing';
import { fail, flag, guardDatabase, option, positional as firstPositional, writer } from './lib/cli-env';
import { ARCHIVE_COMMANDS, runArchiveCommand } from './archive';
import { writeManifest } from './lib/workspace';

const [command] = process.argv.slice(2);
const positional = firstPositional();

async function inspect(file: string) {
  const wb = await readWorkbook(file);
  console.log(`${basename(file)} — ${wb.format}, sha256 ${wb.checksum.slice(0, 12)}…`);
  if (wb.hasMacros) console.log('  ! contains macros — they are ignored and never run');
  for (const sheet of wb.sheets) {
    console.log(`\nSheet "${sheet.name}"${sheet.hidden ? ' (hidden)' : ''}: ${sheet.rows.length} rows, ${sheet.formulaCells} formula cells (cached values only)`);
    const [header, ...samples] = sheet.rows;
    console.log(`  headers: ${(header ?? []).map((h, i) => `[${i}] ${h}`).join(' | ')}`);
    for (const row of samples.slice(0, 3)) {
      console.log(`  sample: ${row.map((v) => maskForDisplay(v).slice(0, 40)).join(' | ')}`);
    }
  }
}

async function plan(file: string) {
  const mappingPath = option('mapping') ?? fail('--mapping <file> is required.');
  const mapping = MappingSchema.parse(JSON.parse(await readFile(mappingPath, 'utf8')));
  guardDatabase();
  const db = pooledDb();
  const wb = await readWorkbook(file);
  const built = buildCandidates(wb, mapping);
  const { client, config } = writer();
  const [baserowRows, neonProjects, crosswalk] = await Promise.all([
    loadBaserowProjects(client, config),
    loadNeonProjects(db),
    loadCrosswalk(db),
  ]);
  const result = buildPlan({
    label: mapping.label,
    file: basename(file),
    checksum: wb.checksum,
    candidates: built.candidates,
    stats: built.stats,
    errors: built.errors,
    crosswalk,
    baserowRows,
    neonProjects,
  });
  const [batch] = await db
    .insert(schema.importBatches)
    .values({ label: mapping.label, sourceFile: basename(file), checksum: wb.checksum, mapping, report: result.totals as unknown as Record<string, unknown> })
    .returning({ id: schema.importBatches.id });
  const dir = join('imports', batch.id);
  await mkdir(dir, { recursive: true });
  // The plan holds public candidate fields only; private columns never reach it.
  await writeFile(join(dir, 'plan.json'), JSON.stringify({ batchId: batch.id, plan: result, candidates: built.candidates }, null, 2));
  await writeFile(join(dir, 'plan.md'), renderPlan(result));
  const decisions: Record<string, Decision> = Object.fromEntries(
    result.items.map((i) => [i.key, i.action === 'review' ? 'hold' : i.action === 'unchanged' ? 'skip' : 'apply']),
  );
  await writeFile(join(dir, 'decisions.json'), JSON.stringify(decisions, null, 2));
  console.log(renderPlan(result).split('\n').slice(0, 20).join('\n'));
  console.log(`\nWrote ${dir}/plan.md, plan.json and decisions.json (batch ${batch.id}).`);
  console.log('Review plan.md, change "hold" to "apply" or "skip" in decisions.json, then run apply.');
  process.exit(0);
}

async function apply() {
  if (!flag('yes')) fail('apply writes to Baserow. Re-run with --yes once the plan is reviewed.');
  const planPath = option('plan') ?? fail('--plan imports/<batch>/plan.json is required.');
  const saved = JSON.parse(await readFile(planPath, 'utf8')) as { batchId: string; plan: Plan; candidates: Parameters<typeof applyPlan>[0]['candidates'] };
  const decisionsPath = option('decisions') ?? join(planPath, '..', 'decisions.json');
  const decisions = JSON.parse(await readFile(decisionsPath, 'utf8')) as Record<string, Decision>;
  guardDatabase();
  const db = pooledDb();
  const [batch] = await db.select().from(schema.importBatches).where(eq(schema.importBatches.id, saved.batchId));
  if (!batch) fail(`batch ${saved.batchId} is not in this database`);
  const { client, config } = writer();
  const options = fieldOptionsFrom(await client.listFields(config.tables.projects.tableId), config);
  let report: Awaited<ReturnType<typeof applyPlan>> | null = null;
  try {
    report = await applyPlan({
      db,
      writer: client,
      config,
      batchId: saved.batchId,
      plan: saved.plan,
      candidates: saved.candidates,
      decisions,
      options,
      publish: flag('publish'),
    });
  } finally {
    // The recoverable manifest — every row this batch created or changed —
    // is written even when the run stops part-way; a re-run resumes.
    const manifest = await writeManifest(db, saved.batchId, join(planPath, '..'), { kind: 'projects', report });
    console.log(`Manifest: ${join(planPath, '..', 'apply-manifest.json')} ${JSON.stringify(manifest.counts)}`);
  }
  console.log(JSON.stringify(report, null, 2));
  console.log('\nThe website picks these rows up through the normal sync (webhook, or "Reconcile now" in the admin).');
  process.exit(report.failed.length ? 2 : 0);
}

async function rollback() {
  if (!flag('yes')) fail('rollback deletes or reverts Baserow rows. Re-run with --yes.');
  const batchId = option('batch') ?? fail('--batch <id> is required.');
  guardDatabase();
  const { client, config } = writer();
  const report = await rollbackBatch({ db: pooledDb(), writer: client, config, batchId });
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

switch (command) {
  case 'inspect':
    await inspect(positional ?? fail('inspect <file>'));
    break;
  case 'plan':
    await plan(positional ?? fail('plan <file> --mapping <mapping.json>'));
    break;
  case 'apply':
    await apply();
    break;
  case 'rollback':
    await rollback();
    break;
  default:
    if (command && (ARCHIVE_COMMANDS as readonly string[]).includes(command)) {
      await runArchiveCommand(command as (typeof ARCHIVE_COMMANDS)[number]);
      break;
    }
    fail(
      'Usage: import inspect <file> | plan <file> --mapping <m.json> | apply --plan <plan.json> --yes [--publish] | rollback --batch <id> --yes\n' +
        `       import ${ARCHIVE_COMMANDS.join(' | ')}  (see scripts/import/archive.ts)`,
    );
}
