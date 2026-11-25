/**
 * LAB FORM IMPORTS — importer commands (the adapter is ./index.ts). Each
 * `LabForm` gets the four, under its prefix: `lab-oct-*` for the October 2026
 * Bhopal Impact Lab, `build-day-nov-*` for the November Build Day
 * (`../build-day-2026-11/index.ts`).
 *
 *   lab-oct-seed-event   --yes [--neon-id <uuid>]
 *                   Match or create the event's row in the Baserow Events
 *                   table by its stable key; a new row ADOPTS the form's Neon
 *                   event (`claude-code-impact-lab-october`) and mirrors it. An
 *                   existing row is reported, never overwritten. Ledgered.
 *   lab-oct-verify-links --file <xlsx> [--all]
 *                   The bounded, SSRF-safe public check of the URLs that need
 *                   one — with --all, of every URL that would be published.
 *                   Adds to imports/link-checks.json, which plan and report read.
 *   lab-oct-plan    --file <xlsx>
 *                   The dry run: imports/<batch>/plan.json, plan.md,
 *                   decisions.json, reconciliation.md and baserow-before.json.
 *                   Then `apply`.
 *   lab-oct-report  --file <xlsx> [--out <md>] [--ts <file>]
 *                   No database. The committed, privacy-safe report
 *                   (default docs/imports/2026-10-impact-lab.md); --ts also
 *                   writes the published rows as src/data/projects.ts entries
 *                   and prints their slugs, which name the drawn tiles.
 *
 * Everything written from the export passes `outputGuard` first.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { pooledDb } from '../../../../db/pool';
import * as schema from '../../../../db/schema';
import type { BaserowConfig } from '../../../../src/server/integrations/baserow/config';
import type { LiveField } from '../../../../src/server/integrations/baserow/spec';
import { projects } from '../../../../src/data/projects';
import { readWorkbook } from '../../lib/workbook';
import { buildPlan, renderPlan } from '../../lib/plan';
import { comparable, type Writer } from '../../lib/apply';
import {
  fieldOptionsFrom,
  loadBaserowProjects,
  loadCrosswalk,
  loadLastWritten,
  loadNeonProjects,
  loadProjectedSlugs,
} from '../../lib/existing';
import { FIXTURE, fail, flag, guardDatabase, option, writer } from '../../lib/cli-env';
import { readTable, snapshot, writeManifest } from '../../lib/workspace';
import { checkUrls, citiesRow, eventMirror, linkChecks } from '../../archive';
import { publishableUrls, type EventBinding } from '../event-archive-2026-09/index';
import {
  assignSlugs,
  buildLabCandidates,
  outputGuard,
  planDecisions,
  uncheckedUrls,
  type LabForm,
} from './index';
import { renderLabReport, renderProjectsEntries } from './report';

const LAB_STEPS = ['seed-event', 'verify-links', 'plan', 'report'] as const;
export const labCommands = (form: LabForm) => LAB_STEPS.map((step) => `${form.prefix}-${step}`);

type Row = { id: number } & Record<string, unknown>;
const placeholder = (form: LabForm): EventBinding => ({
  key: form.source.eventKey,
  baserowRowId: 1,
});
const exportPath = (form: LabForm) =>
  option('file') ?? fail(`--file <the ${form.source.event} form export (.xlsx)> is required.`);
/** Slugs the static record already uses, except this event's own (so a re-run keeps them). */
const takenSlugs = (form: LabForm) =>
  projects.filter((p) => p.builtAtEventSlug !== form.source.eventSlug).map((p) => p.slug);

const keyField = (config: BaserowConfig) => {
  const id = config.tables.events.fields.key;
  if (id === undefined) fail('events.key is not configured in BASEROW_CONFIG');
  return `field_${id}`;
};

/** The event's one row in the Events table, by key, held on the right day — or the plan refuses. */
async function eventBinding(
  client: Pick<Writer, 'listAllRows'>,
  config: BaserowConfig,
  form: LabForm,
): Promise<EventBinding> {
  const SOURCE = form.source;
  const hits = (await readTable(client, config.tables.events.tableId)).filter(
    (r) => r[keyField(config)] === SOURCE.eventKey,
  );
  if (hits.length === 0)
    fail(
      `the Events table has no row with key ${SOURCE.eventKey} — run ${form.prefix}-seed-event first`,
    );
  if (hits.length > 1)
    fail(
      `Events rows ${hits.map((h) => h.id).join(', ')} share key ${SOURCE.eventKey} — resolve the duplicate first`,
    );
  const df = config.tables.events.fields.date;
  const date = df === undefined ? '' : String(hits[0][`field_${df}`] ?? '');
  if (date !== SOURCE.heldOn)
    fail(
      `event ${SOURCE.eventKey} (row ${hits[0].id}) is dated ${date || '(none)'}, but the ${SOURCE.event} was held on ${SOURCE.heldOn}`,
    );
  return { key: SOURCE.eventKey, baserowRowId: hits[0].id };
}

async function seedEvent(form: LabForm) {
  const SOURCE = form.source;
  if (!flag('yes'))
    fail(`${form.prefix}-seed-event writes to the Baserow Events table. Re-run with --yes.`);
  guardDatabase();
  const db = pooledDb();
  const { client, config } = writer();
  const tableId = config.tables.events.tableId;
  const live = (await client.listFields(tableId)) as unknown as LiveField[];
  const rows = await readTable(client, tableId);
  const kf = keyField(config);
  const [event] = await db
    .select()
    .from(schema.events)
    .where(eq(schema.events.slug, SOURCE.eventSlug));
  if (!event) fail(`the database has no ${SOURCE.eventSlug} event — run db:import`);
  // For the real workspace the Neon ID is the PRODUCTION event's UUID, not this local copy's.
  const neonId =
    option('neon-id') ??
    (FIXTURE
      ? event.id
      : fail('--neon-id <uuid> is required for a real workspace: the PRODUCTION event id.'));
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(neonId))
    fail('--neon-id is not a UUID');
  const expected = await eventMirror(
    db,
    config,
    live,
    { key: SOURCE.eventKey, shortTitle: event.title },
    event,
    neonId,
    await citiesRow(db, client, config),
  );
  const hits = rows.filter((r) => r[kf] === SOURCE.eventKey);
  if (hits.length > 1)
    fail(
      `Events rows ${hits.map((h) => h.id).join(', ')} share key ${SOURCE.eventKey} — resolve the duplicate first`,
    );
  if (hits.length === 1) {
    // Already there: an organiser may have edited it. Report, never overwrite.
    const differs = Object.entries(expected)
      .filter(([f, v]) => JSON.stringify(comparable(hits[0][f])) !== JSON.stringify(comparable(v)))
      .map(([f]) => live.find((x) => `field_${x.id}` === f)?.name ?? f);
    console.log(
      `matched ${SOURCE.eventKey} → existing row ${hits[0].id}${differs.length ? `; differs from Neon in: ${differs.join(', ')} (left as it is)` : ' (identical to Neon)'}`,
    );
    return;
  }
  const neonField = `field_${config.tables.events.fields.neonId}`;
  const adopting = rows.find((r) => r[neonField] && r[neonField] === expected[neonField]);
  if (adopting)
    fail(
      `Events row ${adopting.id} already adopts that Neon event under another key — resolve it first`,
    );

  const [batch] = await db
    .insert(schema.importBatches)
    .values({
      label: `${SOURCE.label} — canonical event`,
      sourceFile: 'neon-events',
      checksum: createHash('sha256').update(JSON.stringify(expected)).digest('hex'),
      mapping: { adapter: `${form.id}:events`, tableId },
    })
    .returning({ id: schema.importBatches.id });
  const dir = join('imports', batch!.id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'baserow-before.json'),
    JSON.stringify({ takenAt: new Date().toISOString(), tableId, rows }, null, 2),
  );
  await db.insert(schema.importLedger).values({
    batchId: batch!.id,
    candidateKey: SOURCE.eventKey,
    action: 'event',
    tableId,
    before: null,
    after: expected,
    status: 'pending',
  });
  let row: Row;
  try {
    row = (await client.createRow(tableId, expected)) as Row;
  } catch (error) {
    if (
      !['timeout', 'network', 'server', 'rate-limited'].includes(
        (error as { kind?: string }).kind ?? '',
      )
    )
      throw error;
    // The create may have landed: look for the key before anything else.
    const again = (await readTable(client, tableId)).filter((r) => r[kf] === SOURCE.eventKey);
    if (again.length !== 1) throw error;
    row = again[0];
  }
  const afterHash = createHash('sha256')
    .update(
      JSON.stringify(
        Object.keys(expected)
          .sort()
          .map((k) => [k, comparable(row[k])]),
      ),
    )
    .digest('hex');
  await db
    .update(schema.importLedger)
    .set({ rowId: row.id, status: 'applied', appliedAt: new Date(), afterHash })
    .where(
      and(
        eq(schema.importLedger.batchId, batch!.id),
        eq(schema.importLedger.candidateKey, SOURCE.eventKey),
      ),
    );
  const outcome = [{ key: SOURCE.eventKey, rowId: row.id, result: 'created' }];
  await db
    .update(schema.importBatches)
    .set({ status: 'applied', appliedAt: new Date(), report: { outcome } })
    .where(eq(schema.importBatches.id, batch!.id));
  await writeManifest(db, batch!.id, dir, { kind: 'events', outcome });
  console.log(
    `created ${SOURCE.eventKey} → row ${row.id} (adopts Neon event ${neonId}, held ${SOURCE.heldOn}); wrote ${dir}/apply-manifest.json`,
  );
}

async function verifyLinks(form: LabForm) {
  const built = buildLabCandidates(
    await readWorkbook(exportPath(form)),
    placeholder(form),
    {},
    form.decisions,
    form,
  );
  const urls = [
    ...new Set([
      ...built.pendingVerification,
      ...(flag('all') ? publishableUrls(built.candidates) : []),
    ]),
  ];
  const out = await checkUrls(urls, await linkChecks());
  await mkdir('imports', { recursive: true });
  await writeFile(join('imports', 'link-checks.json'), JSON.stringify(out, null, 2));
  console.log(
    `Wrote imports/link-checks.json (git-ignored). Re-run ${form.prefix}-plan or ${form.prefix}-report to use it.`,
  );
}

async function plan(form: LabForm) {
  const SOURCE = form.source;
  guardDatabase();
  const db = pooledDb();
  const workbook = await readWorkbook(exportPath(form));
  const guard = outputGuard(workbook, form);
  const { client, config } = writer();
  const event = await eventBinding(client, config, form);
  const verified = await linkChecks();
  const built = buildLabCandidates(workbook, event, verified, form.decisions, form);
  // Fail closed: a link the check never saw would be written as submitted.
  const unchecked = uncheckedUrls(built.candidates, verified);
  if (unchecked.length)
    fail(
      `${unchecked.length} link(s) have no link check — run ${form.prefix}-verify-links --all first`,
    );
  // An earlier projection's URL stands; a new project gets the static record's slug.
  const projected = await loadProjectedSlugs(db);
  const assigned = assignSlugs(built.candidates, takenSlugs(form));
  for (const c of built.candidates) c.slug = projected.get(c.key) ?? assigned.get(c.key)!;
  const fresh = built.candidates.filter((c) => !projected.has(c.key)).map((c) => c.slug!);
  if (fresh.length) {
    const taken = await db
      .select({ slug: schema.projects.slug })
      .from(schema.projects)
      .where(inArray(schema.projects.slug, fresh));
    for (const t of taken)
      console.log(
        `! /projects/${t.slug}/ already exists in this database: the projection would give the new row another slug, and the drawn tile is named ${t.slug} — resolve before apply`,
      );
  }

  const before = await snapshot(client, config);
  const options = fieldOptionsFrom(
    (await client.listFields(config.tables.projects.tableId)) as never,
    config,
  );
  const [baserowRows, neonProjects, crosswalk, lastWritten] = await Promise.all([
    loadBaserowProjects(client, config),
    loadNeonProjects(db),
    loadCrosswalk(db),
    loadLastWritten(db, config, options),
  ]);
  if (built.checksum.actual !== built.checksum.expected)
    console.log(
      `! this export (sha256 ${built.checksum.actual.slice(0, 12)}…) is not the reviewed file — the row checks still apply`,
    );
  const label = `${SOURCE.label} (${SOURCE.heldOn})`;
  const result = buildPlan({
    label,
    file: form.file,
    checksum: built.checksum.actual,
    candidates: built.candidates,
    stats: {
      sourceRows: built.totals.sourceRows,
      blankRows: 0,
      groupedRows: 0,
      invalidLinks: 0,
      withheldColumns: [form.report.withheldColumns],
      withheldPublicValues: 0,
      creditsWithoutConsent: 0,
    },
    errors: [],
    crosswalk,
    baserowRows,
    neonProjects,
    lastWritten,
  });
  const decisions = planDecisions(result, built.candidates);
  // Refused before anything is recorded: no email, no member name, in any file.
  const saved = { plan: result, candidates: built.candidates, event };
  guard(JSON.stringify(saved));
  const planMd = guard(renderPlan(result));
  const reconciliation = guard(
    renderLabReport(built, { generatedAt: new Date().toISOString(), form }),
  );
  const [batch] = await db
    .insert(schema.importBatches)
    .values({
      label,
      sourceFile: form.id,
      checksum: built.checksum.actual,
      mapping: { adapter: form.id, event: SOURCE.eventKey },
      report: result.totals as unknown as Record<string, unknown>,
    })
    .returning({ id: schema.importBatches.id });
  const dir = join('imports', batch!.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'baserow-before.json'), JSON.stringify(before, null, 2));
  await writeFile(
    join(dir, 'plan.json'),
    JSON.stringify({ batchId: batch!.id, ...saved }, null, 2),
  );
  await writeFile(join(dir, 'plan.md'), planMd);
  await writeFile(join(dir, 'reconciliation.md'), reconciliation);
  await writeFile(join(dir, 'decisions.json'), JSON.stringify(decisions, null, 2));
  const counts = Object.values(decisions).reduce<Record<string, number>>(
    (m, d) => ({ ...m, [d]: (m[d] ?? 0) + 1 }),
    {},
  );
  console.log(JSON.stringify(built.totals, null, 2));
  console.log(planMd.split('\n').slice(0, 18).join('\n'));
  console.log(`\nDecisions: ${JSON.stringify(counts)}`);
  console.log(
    `Wrote ${dir}/plan.md, plan.json, decisions.json, reconciliation.md and baserow-before.json (batch ${batch!.id}).`,
  );
  console.log(`Next: npm run import -- apply --plan ${dir}/plan.json --publish --yes`);
}

async function report(form: LabForm) {
  const workbook = await readWorkbook(exportPath(form));
  const guard = outputGuard(workbook, form);
  const built = buildLabCandidates(
    workbook,
    placeholder(form),
    await linkChecks(),
    form.decisions,
    form,
  );
  if (built.checksum.actual !== built.checksum.expected)
    console.log(
      `! this export (sha256 ${built.checksum.actual.slice(0, 12)}…) is not the reviewed file — the row checks still apply`,
    );
  const tsOpt = option('ts');
  const ts = flag('ts') ? (tsOpt && !tsOpt.startsWith('--') ? tsOpt : form.report.ts) : undefined;
  const out = option('out') ?? form.report.out;
  const markdown = guard(
    renderLabReport(built, { generatedAt: new Date().toISOString().slice(0, 10), form }),
  );
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, markdown);
  console.log(`Wrote ${out}`);
  if (ts) {
    const slugs = assignSlugs(built.candidates, takenSlugs(form));
    const typesImport = relative(dirname(ts), join('src', 'data', 'types')).replace(/\\/g, '/');
    await mkdir(dirname(ts), { recursive: true });
    await writeFile(
      ts,
      guard(
        renderProjectsEntries(
          built,
          slugs,
          typesImport.startsWith('.') ? typesImport : `./${typesImport}`,
          form,
        ),
      ),
    );
    const published = built.candidates
      .filter((c) => c.editorial?.disposition === 'publish')
      .map((c) => slugs.get(c.key)!);
    console.log(
      `Wrote ${ts} — ${published.length} published projects; their slugs (one drawn tile each):\n${published.join('\n')}`,
    );
    const slugsFile = join(dirname(ts), 'slugs.txt');
    await writeFile(slugsFile, published.join('\n') + '\n');
    console.log(`Wrote ${slugsFile}`);

    const tilesDir = join(dirname(ts), 'tiles');
    const newSlugs = published.filter((s) => !existsSync(join(tilesDir, `${s}.svg`)));
    const newSlugsFile = join(dirname(ts), 'slugs-new.txt');
    await writeFile(newSlugsFile, newSlugs.join('\n') + '\n');
    console.log(`Wrote ${newSlugsFile} (${newSlugs.length} slugs without a tile)`);
  }
  console.log(JSON.stringify(built.totals, null, 2));
}

/** Runs `command`, one of `labCommands(form)`. */
export async function runLabCommand(form: LabForm, command: string) {
  const step = command.slice(form.prefix.length + 1) as (typeof LAB_STEPS)[number];
  const run = {
    'seed-event': seedEvent,
    'verify-links': verifyLinks,
    plan,
    report,
  }[step];
  await run(form);
  process.exit(0);
}
