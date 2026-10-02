/**
 * THE EVENT-ARCHIVE IMPORTER, END TO END — synthetic data only.
 *
 * Spreadsheet → candidates → plan → apply (to a fake Baserow) → the real
 * projection → Neon. Plus re-runs, revised sheets, failures and rollback.
 * No real participant data appears in this file or its fixtures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import * as schema from '../db/schema';
import { BaserowError } from '../src/server/integrations/baserow/client';
import { ConfigSchema } from '../src/server/integrations/baserow/config';
import { reconcile, runQueue } from '../src/server/integrations/baserow/sync';
import { buildCandidates, MappingSchema, type Mapping } from '../scripts/import/lib/candidates';
import { buildPlan } from '../scripts/import/lib/plan';
import { applyPlan, rollbackBatch, type Writer } from '../scripts/import/lib/apply';
import { fieldOptionsFrom, loadBaserowProjects, loadCrosswalk, loadLastWritten, loadNeonProjects } from '../scripts/import/lib/existing';
import { candidateIdentity } from '../scripts/import/lib/normalise';
import type { Workbook } from '../scripts/import/lib/workbook';

const T = { cities: 201, events: 202, projects: 203, credits: 204 };
const config = ConfigSchema.parse({
  tables: {
    cities: { tableId: T.cities, fields: { slug: 1 } },
    events: {
      tableId: T.events,
      fields: { key: 10, title: 12, summary: 14, city: 16, venueName: 17, date: 19, startTime: 20, format: 23, editorialStatus: 26 },
    },
    projects: {
      tableId: T.projects,
      fields: {
        key: 30, title: 32, summary: 34, description: 35, category: 36, tags: 37, liveUrl: 38, repoUrl: 39, videoUrl: 40,
        claudeUsage: 41, event: 42, teamName: 44, editorialStatus: 45, sourceBatch: 48, sourceKey: 49,
      },
    },
    credits: { tableId: T.credits, fields: { project: 50, displayName: 51, role: 52, publicUrl: 53, displayOrder: 54 } },
  },
});

const OPTIONS = {
  36: ['product', 'agent', 'developer-tool', 'research', 'creative', 'campus', 'experiment', 'startup'],
  45: ['draft', 'ready', 'published', 'archived'],
  26: ['draft', 'ready', 'published', 'archived'],
  23: ['hackathon', 'workshop'],
  37: ['Claude Code', 'MCP', 'Python'],
};
const SELECTS = new Set([36, 45, 26, 23]);
const MULTI = new Set([37]);
const LINKS = new Set([16, 42, 50]);
const optionId = (field: number, value: string) => 1000 * field + OPTIONS[field as keyof typeof OPTIONS].indexOf(value);
const optionValue = (field: number, id: number) => OPTIONS[field as keyof typeof OPTIONS][id - 1000 * field];

/** An in-memory Baserow: writes take ids, reads return objects, like the real API. */
class FakeBaserow implements Writer {
  tables = new Map<number, Map<number, Record<string, unknown>>>();
  next = 1;
  failCreateAt: { n: number; error: BaserowError; landed: boolean } | null = null;
  creates = 0;
  private table(id: number) {
    if (!this.tables.has(id)) this.tables.set(id, new Map());
    return this.tables.get(id)!;
  }
  private read(row: Record<string, unknown> & { id: number }) {
    const out: Record<string, unknown> = { id: row.id };
    for (const [k, v] of Object.entries(row)) {
      if (k === 'id') continue;
      const field = Number(k.slice(6));
      if (SELECTS.has(field) && typeof v === 'number') out[k] = { id: v, value: optionValue(field, v) };
      else if (MULTI.has(field) && Array.isArray(v)) out[k] = (v as number[]).map((id) => ({ id, value: optionValue(field, id) }));
      else if (LINKS.has(field) && Array.isArray(v)) out[k] = (v as number[]).map((id) => ({ id, value: String(id) }));
      else out[k] = v;
    }
    return out as { id: number } & Record<string, unknown>;
  }
  seed(tableId: number, row: Record<string, unknown> & { id: number }) {
    this.table(tableId).set(row.id, row);
    this.next = Math.max(this.next, row.id + 1);
  }
  async createRow(tableId: number, fields: Record<string, unknown>) {
    this.creates += 1;
    const fail = this.failCreateAt && this.failCreateAt.n === this.creates ? this.failCreateAt : null;
    if (fail && !fail.landed) throw fail.error;
    const row = { id: this.next++, ...fields };
    this.table(tableId).set(row.id, row);
    if (fail) throw fail.error; // the write landed, the answer did not
    return this.read(row);
  }
  async updateRow(tableId: number, rowId: number, fields: Record<string, unknown>) {
    const row = { ...this.table(tableId).get(rowId)!, ...fields, id: rowId };
    this.table(tableId).set(rowId, row);
    return this.read(row as never);
  }
  async deleteRow(tableId: number, rowId: number) {
    this.table(tableId).delete(rowId);
  }
  async getRow(tableId: number, rowId: number) {
    const row = this.table(tableId).get(rowId);
    if (!row) throw new BaserowError('not-found', 'not found', { status: 404, retryable: false });
    return this.read(row as never);
  }
  /** Tables whose scan reports itself incomplete, as a timed-out page would. */
  partial = new Set<number>();
  async listAllRows(tableId: number) {
    return { rows: [...this.table(tableId).values()].map((r) => this.read(r as never)), complete: !this.partial.has(tableId), pages: 1 };
  }
  fields() {
    return Object.entries(OPTIONS).map(([id, values]) => ({
      id: Number(id),
      type: 'single_select',
      select_options: values.map((value) => ({ id: optionId(Number(id), value), value })),
    }));
  }
}

const sheet = (name: string, rows: string[][]) => ({ name, rows, dateCells: new Set<string>(), formulaCells: 0, hidden: false });
const HEAD = ['Submission ID', 'Project', 'One-liner', 'Track', 'Tech', 'Demo', 'Repo', 'Team', 'Member', 'Role', 'Show my name?', 'Email', 'Phone'];

function workbook(rows: string[][], second?: string[][]): Workbook {
  return {
    format: 'xlsx',
    hasMacros: false,
    date1904: false,
    checksum: 'synthetic',
    sheets: [sheet('Projects', [HEAD, ...rows]), ...(second ? [sheet('Day 2', [HEAD, ...second])] : [])],
  } as Workbook;
}

const MAPPING: Mapping = MappingSchema.parse({
  label: 'Synthetic Build Day',
  event: { key: 'evt-a', baserowRowId: 900 },
  sheets: [
    {
      name: 'Projects',
      shape: 'per-person',
      columns: {
        submissionId: 'Submission ID', title: 'Project', summary: 'One-liner', category: 'Track', tags: 'Tech',
        liveUrl: 'Demo', repoUrl: 'Repo', teamName: 'Team', personName: 'Member', personRole: 'Role', publicCreditConsent: 'Show my name?',
      },
      categoryMap: { 'AI Agents': 'agent' },
      creditPolicy: 'consent-column',
    },
    {
      name: 'Day 2',
      shape: 'per-person',
      event: { key: 'evt-b', baserowRowId: 901 },
      columns: { title: 'Project', summary: 'One-liner', repoUrl: 'Repo', teamName: 'Team', personName: 'Member', publicCreditConsent: 'Show my name?' },
      creditPolicy: 'consent-column',
    },
  ],
});

const ROWS = [
  ['S-1', 'Kisan Price', 'Helps farmers price their crops.', 'AI Agents', 'Claude Code, Python', 'kisan.example', 'https://github.com/demo/kisan', 'Team Kisan', 'Asha Rao', 'Lead', 'yes', 'asha@private.example', '+91 98765 43210'],
  ['S-1', 'Kisan Price', '', 'AI Agents', '', '', '', 'Team Kisan', 'Ravi Kumar', 'Design', 'Yes', 'ravi@private.example', ''],
  ['S-1', 'Kisan Price', '', 'AI Agents', '', '', '', 'Team Kisan', 'Hidden Person', 'Dev', 'no', 'hidden@private.example', ''],
  ['S-2', 'Clinic Queue', 'Shortens clinic waiting lines.', 'Product', 'MCP', '', 'javascript:alert(1)', 'Team Q', 'Meera', 'Dev', 'yes', '', ''],
  ['S-3', 'No Links Yet', 'Contact me at someone@example.com', 'Research', '', '', '', '', 'Solo Builder', '', 'yes', '', ''],
];
const DAY2 = [['', 'Kisan Price', 'Same name, different event.', '', '', '', 'https://github.com/demo/other', 'Team Other', 'Dev Two', '', 'yes', '', '']];

let db: TestDatabase;
let baserow: FakeBaserow;
let cityId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  const [city] = await db
    .insert(schema.cities)
    .values({ slug: 'zz-import-city', name: 'Import City', region: 'R', lat: 20, lon: 75, blurb: 'Fixture.', status: 'published' })
    .returning({ id: schema.cities.id });
  cityId = city.id;
}, 60_000);
afterAll(async () => db?.$close());

beforeEach(async () => {
  for (const t of [schema.importLedger, schema.importCrosswalk, schema.importBatches, schema.integrationJobs, schema.integrationMappings, schema.projectCredits, schema.projects, schema.events]) {
    await db.delete(t);
  }
  await db.delete(schema.integrationState);
  baserow = new FakeBaserow();
  baserow.seed(T.cities, { id: 1, field_1: 'zz-import-city' });
  for (const [id, key] of [[900, 'evt-a'], [901, 'evt-b']] as const) {
    baserow.seed(T.events, {
      id, field_10: key, field_12: `Event ${key}`, field_14: 'A build day.', field_16: [1], field_17: 'Hall', field_19: '2026-02-01',
      field_20: '10:00', field_23: optionId(23, 'hackathon'), field_26: optionId(26, 'published'),
    });
  }
});

async function planFor(wb: Workbook) {
  const built = buildCandidates(wb, MAPPING);
  const plan = buildPlan({
    label: MAPPING.label, file: 'synthetic.xlsx', checksum: wb.checksum, candidates: built.candidates, stats: built.stats, errors: built.errors,
    crosswalk: await loadCrosswalk(db), baserowRows: await loadBaserowProjects(baserow, config), neonProjects: await loadNeonProjects(db),
    lastWritten: await loadLastWritten(db, config, fieldOptionsFrom(baserow.fields(), config)),
  });
  const [batch] = await db.insert(schema.importBatches).values({ label: MAPPING.label, sourceFile: 'synthetic.xlsx', checksum: wb.checksum, mapping: MAPPING }).returning();
  return { built, plan, batchId: batch.id };
}

async function applyAll(wb: Workbook, extra: { publish?: boolean; decisions?: Record<string, 'apply' | 'skip' | 'hold'> } = {}) {
  const { built, plan, batchId } = await planFor(wb);
  const decisions = Object.fromEntries(plan.items.map((i) => [i.key, 'apply' as const]));
  const report = await applyPlan({
    db, writer: baserow, config, batchId, plan, candidates: built.candidates, decisions: { ...decisions, ...extra.decisions },
    options: fieldOptionsFrom(baserow.fields(), config), publish: extra.publish ?? false,
  });
  return { built, plan, batchId, report };
}

const projectRows = () => [...(baserow.tables.get(T.projects)?.values() ?? [])];

/** Reconcile and drain the bounded worker (see baserow-sync.test.ts). */
async function project() {
  await reconcile(db, baserow, config);
  for (let i = 0; i < 10; i += 1) {
    const counts = await runQueue(db, baserow, config, { budgetMs: 10_000, trigger: 'manual' });
    if (counts.claimed === 0) break;
  }
}

describe('candidates', () => {
  it('consolidates per-person rows, honours consent, and keeps events apart', () => {
    const { candidates, stats, errors } = buildCandidates(workbook(ROWS, DAY2), MAPPING);
    expect(errors).toEqual([]);
    expect(candidates).toHaveLength(4);
    const kisan = candidates.find((c) => c.eventKey === 'evt-a' && c.title === 'Kisan Price')!;
    expect(kisan.credits.map((c) => c.displayName)).toEqual(['Asha Rao', 'Ravi Kumar']);
    expect(kisan.sources[0].rows).toEqual([2, 3, 4]);
    expect(kisan.liveUrl).toBe('https://kisan.example/');
    expect(kisan.category).toBe('agent');
    // Same title in another event is a different project.
    expect(candidates.filter((c) => c.title === 'Kisan Price').map((c) => c.eventKey).sort()).toEqual(['evt-a', 'evt-b']);
    expect(stats).toMatchObject({ sourceRows: 6, groupedRows: 2, creditsWithoutConsent: 1, invalidLinks: 1 });
    // Unmapped private columns are withheld, and named in the report.
    expect(stats.withheldColumns).toEqual(expect.arrayContaining(['Projects: Email', 'Projects: Phone']));
    // Contact details inside a public field are withheld too.
    expect(candidates.find((c) => c.title === 'No Links Yet')!.summary).toBeNull();
    expect(stats.withheldPublicValues).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(candidates)).not.toMatch(/private\.example|98765/);
  });

  it('never uses a row number or a title alone as identity', () => {
    const a = candidateIdentity({ eventKey: 'e', title: 'Same', teamName: 'A', artifacts: [] });
    const b = candidateIdentity({ eventKey: 'e', title: 'Same', teamName: 'B', artifacts: [] });
    expect(a.key).not.toBe(b.key);
    expect(a.strength).toBe('title-team');
    const viaRepo = candidateIdentity({ eventKey: 'e', title: 'Renamed', artifacts: ['https://www.github.com/Demo/Repo.git/'] });
    const same = candidateIdentity({ eventKey: 'e', title: 'Other', artifacts: ['https://github.com/demo/repo'] });
    expect(viaRepo.key).toBe(same.key);
  });
});

describe('plan → apply → project', () => {
  it('dry run totals, then drafts by default, then the projection publishes nothing yet', async () => {
    const { plan } = await planFor(workbook(ROWS, DAY2));
    expect(plan.totals).toMatchObject({ sourceRows: 6, candidates: 4, groupedRows: 2, create: 4, update: 0, unchanged: 0 });
    expect(plan.totals.missing).toEqual({ 'artifact link': 2, summary: 1 });
    expect(projectRows()).toHaveLength(0); // planning writes nothing upstream

    const { report } = await applyAll(workbook(ROWS, DAY2));
    expect(report).toMatchObject({ created: 4, failed: [] });
    expect(report.credits).toBe(5);
    expect(projectRows().every((r) => r.field_45 === optionId(45, 'draft'))).toBe(true);

    await project();
    const projects = await db.select().from(schema.projects);
    expect(projects.filter((p) => p.publicationStatus === 'published')).toHaveLength(0);
    expect(projects.every((p) => p.contentAuthority === 'baserow' && p.ownerMemberId === null)).toBe(true);
  });

  it('--publish publishes only what meets the archive contract', async () => {
    const { report } = await applyAll(workbook(ROWS, DAY2), { publish: true });
    expect(report.publishedRequested).toBe(2); // Kisan (evt-a), Kisan (evt-b); Clinic lost its only link; No Links has none
    await project();
    const published = (await db.select().from(schema.projects)).filter((p) => p.publicationStatus === 'published');
    expect(published.map((p) => p.title).sort()).toEqual(['Kisan Price', 'Kisan Price']);
    const [event] = await db.select().from(schema.events).where(eq(schema.events.cityId, cityId)).limit(1);
    expect(event.contentAuthority).toBe('baserow');
  });

  it('an identical re-run creates nothing', async () => {
    await applyAll(workbook(ROWS, DAY2));
    const before = projectRows().length;
    const { plan, report } = await applyAll(workbook(ROWS, DAY2));
    expect(plan.totals).toMatchObject({ create: 0, update: 0, unchanged: 4 });
    expect(report).toMatchObject({ created: 0, updated: 0, credits: 0 });
    expect(projectRows()).toHaveLength(before);
  });

  it('a revised sheet updates by identity, adds what is new, and never clears on a blank', async () => {
    await applyAll(workbook(ROWS, DAY2));
    const revised = ROWS.map((r) => [...r]);
    revised[0][2] = 'Helps farmers price crops fairly.'; // edited summary
    revised[3][2] = ''; // blank cell: missing, not "clear"
    revised.push(['S-4', 'New Entry', 'Arrived later.', 'Product', '', '', 'https://github.com/demo/new', 'Team N', 'Late Joiner', '', 'yes', '', '']);
    const { plan, report } = await applyAll(workbook(revised, DAY2));
    expect(plan.totals).toMatchObject({ create: 1, update: 1, unchanged: 3 });
    const update = plan.items.find((i) => i.action === 'update')!;
    expect(update.diff).toEqual([{ field: 'summary', before: 'Helps farmers price their crops.', after: 'Helps farmers price crops fairly.' }]);
    expect(report).toMatchObject({ created: 1, updated: 1 });
    const clinic = projectRows().find((r) => r.field_32 === 'Clinic Queue')!;
    expect(clinic.field_34).toBe('Shortens clinic waiting lines.');
  });

  it('an organiser edit in Baserow stands: a re-import updates only fields it still owns', async () => {
    await applyAll(workbook(ROWS, DAY2));
    const kisan = projectRows().find((r) => r.field_32 === 'Kisan Price' && JSON.stringify(r.field_42).includes('900'))!;
    // An organiser rewrites the summary in Baserow after the import.
    await baserow.updateRow(T.projects, kisan.id as number, { field_34: 'Organiser-written summary.' });
    const revised = ROWS.map((r) => [...r]);
    revised[0][2] = 'Helps farmers price crops fairly.'; // the sheet changed too
    const { plan, report } = await applyAll(workbook(revised, DAY2));
    const item = plan.items.find((i) => i.targetRowId === (kisan.id as number))!;
    expect(item.action).toBe('unchanged');
    expect(item.kept).toEqual([{ field: 'summary', current: 'Organiser-written summary.', source: 'Helps farmers price crops fairly.' }]);
    expect(plan.totals.keptEdits).toBe(1);
    expect(report.updated).toBe(0);
    expect(projectRows().find((r) => r.id === kisan.id)!.field_34).toBe('Organiser-written summary.');
  });

  it('a create interrupted before it was recorded is adopted on resume, not repeated', async () => {
    // The row lands, but the process "dies" before the ledger says applied.
    baserow.failCreateAt = { n: 1, error: new Error('process killed') as never, landed: true };
    const first = await applyAll(workbook(ROWS, DAY2));
    expect(first.report.failed).toHaveLength(1);
    baserow.failCreateAt = null;
    const { report } = await applyAll(workbook(ROWS, DAY2));
    expect(report.failed).toHaveLength(0);
    expect(projectRows()).toHaveLength(4);
  });

  it('a failed apply resumes without duplicates', async () => {
    baserow.failCreateAt = { n: 2, error: new BaserowError('bad-request', 'rejected', { status: 400, retryable: false }), landed: false };
    const first = await applyAll(workbook(ROWS, DAY2));
    expect(first.report.failed).toHaveLength(1);
    baserow.failCreateAt = null;
    const second = await applyAll(workbook(ROWS, DAY2));
    expect(second.report.failed).toHaveLength(0);
    expect(projectRows()).toHaveLength(4);
  });

  it('an ambiguous timeout after the row landed is adopted, not duplicated', async () => {
    baserow.failCreateAt = { n: 1, error: new BaserowError('timeout', 'timed out', { retryable: true }), landed: true };
    const { report } = await applyAll(workbook(ROWS, DAY2));
    expect(report.adoptedAfterAmbiguousFailure).toBe(1);
    expect(report.failed).toHaveLength(0);
    expect(projectRows()).toHaveLength(4);
  });

  it('review items are held unless a person decides', async () => {
    const weak = [['', 'Untitled Hack', 'No ids anywhere.', '', '', '', '', 'Team W', 'Someone', '', 'yes', '', '']];
    const { plan } = await planFor(workbook(weak));
    expect(plan.items[0]).toMatchObject({ action: 'review' });
    const built = buildCandidates(workbook(weak), MAPPING);
    const report = await applyPlan({
      db, writer: baserow, config, batchId: (await planFor(workbook(weak))).batchId, plan, candidates: built.candidates, decisions: {},
      options: fieldOptionsFrom(baserow.fields(), config), publish: false,
    });
    expect(report.created).toBe(0);
    expect(projectRows()).toHaveLength(0);
  });
});

describe('rollback', () => {
  it('reverts only what nobody has touched since, and never a claimed project', async () => {
    const { batchId } = await applyAll(workbook(ROWS, DAY2));
    await project();

    // An organiser edits one imported row after the import…
    const edited = projectRows().find((r) => r.field_32 === 'Clinic Queue')!;
    await baserow.updateRow(T.projects, edited.id as number, { field_32: 'Clinic Queue (organiser fixed)' });
    // …and a member's claim on another is approved (its mapping is released).
    const claimed = projectRows().find((r) => r.field_32 === 'No Links Yet')!;
    await db.update(schema.integrationMappings).set({ status: 'released' }).where(eq(schema.integrationMappings.rowId, claimed.id as number));

    const report = await rollbackBatch({ db, writer: baserow, config, batchId });
    const remaining = projectRows().map((r) => r.field_32).sort();
    expect(remaining).toEqual(['Clinic Queue (organiser fixed)', 'No Links Yet']);
    expect(report.kept.map((k) => k.reason).join(' ')).toMatch(/edited in Baserow/);
    expect(report.kept.map((k) => k.reason).join(' ')).toMatch(/claimed/);
    const [batch] = await db.select().from(schema.importBatches).where(eq(schema.importBatches.id, batchId));
    expect(batch.status).toBe('rolled_back');
  });
});

describe('import safety', () => {
  const applyPlanned = ({ built, plan, batchId }: Awaited<ReturnType<typeof planFor>>) =>
    applyPlan({
      db, writer: baserow, config, batchId, plan, candidates: built.candidates,
      decisions: Object.fromEntries(plan.items.map((i) => [i.key, 'apply' as const])),
      options: fieldOptionsFrom(baserow.fields(), config), publish: false,
    });
  const lock = async () =>
    (await db.select().from(schema.integrationState).where(eq(schema.integrationState.key, 'import-lock')))[0];

  it('lets only one of two concurrent imports take the lock', async () => {
    const [a, b] = [await planFor(workbook(ROWS)), await planFor(workbook(ROWS))];
    const results = await Promise.allSettled([applyPlanned(a), applyPlanned(b)]);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(refused).toHaveLength(1);
    expect(String(refused[0].reason)).toMatch(/another import/);
  });

  it('lets only one of two concurrent runs of the same batch take the lock', async () => {
    const planned = await planFor(workbook(ROWS));
    const results = await Promise.allSettled([applyPlanned(planned), applyPlanned(planned)]);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(refused).toHaveLength(1);
    expect(String(refused[0].reason)).toMatch(/another import/);
  });

  it('keeps its lock fresh while it works', async () => {
    const planned = await planFor(workbook(ROWS));
    const stale = new Date(Date.now() - 31 * 60_000).toISOString();
    const seen: string[] = [];
    const createRow = baserow.createRow.bind(baserow);
    baserow.createRow = async (tableId: number, fields: Record<string, unknown>) => {
      if (tableId === T.projects) {
        const held = (await lock())!.value as Record<string, string>;
        seen.push(held.at);
        // As if this item had taken half an hour.
        await db.update(schema.integrationState).set({ value: { ...held, at: stale } }).where(eq(schema.integrationState.key, 'import-lock'));
      }
      return createRow(tableId, fields);
    };
    await applyPlanned(planned);
    expect(seen).toHaveLength(3);
    expect(seen.slice(1)).not.toContain(stale);
  });

  it('stops when another run takes its lock over, and leaves that lock alone', async () => {
    const planned = await planFor(workbook(ROWS));
    const createRow = baserow.createRow.bind(baserow);
    baserow.createRow = async (tableId: number, fields: Record<string, unknown>) => {
      // The lock went stale mid-run and another import took it over.
      await db
        .update(schema.integrationState)
        .set({ value: { owner: 'another-batch:another-run', at: new Date().toISOString() } })
        .where(eq(schema.integrationState.key, 'import-lock'));
      return createRow(tableId, fields);
    };
    await expect(applyPlanned(planned)).rejects.toThrow(/lost the import lock/);
    expect((await lock())?.value).toMatchObject({ owner: 'another-batch:another-run' });
  });

  it('writes nothing against a partial scan of Baserow', async () => {
    const planned = await planFor(workbook(ROWS, DAY2));

    baserow.partial = new Set([T.projects]);
    await expect(applyPlanned(planned)).rejects.toThrow(/could not read every row/);
    expect(projectRows()).toHaveLength(0);

    baserow.partial = new Set([T.credits]);
    const report = await applyPlanned(planned);
    expect(report.credits).toBe(0);
    expect(report.failed.map((f) => f.error).join(' ')).toMatch(/could not read every row/);
    expect(baserow.tables.get(T.credits)?.size ?? 0).toBe(0);
  });
});
