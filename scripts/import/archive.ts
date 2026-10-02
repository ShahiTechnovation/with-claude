/**
 * THE SEPTEMBER 2026 BHOPAL EVENT ARCHIVE — importer commands.
 *
 *   archive-seed-events --yes [--neon-ids impact-lab-2=<uuid>,fable-5-1=<uuid>]
 *                   Match or create the two canonical event rows in the
 *                   Baserow Events table, by their stable key. A new row
 *                   ADOPTS the Neon event (`Neon ID`) and mirrors it —
 *                   including the held date and "rescheduled from" — so a
 *                   later feed or sync cannot revert the correction. An
 *                   existing row is reported, never overwritten. Ledgered.
 *   archive-plan    --impact <xlsx> --fable <xlsx>
 *                   The dry run. Reads both workbooks through the source
 *                   adapter, snapshots every Baserow row it could touch,
 *                   compares with Baserow and the local database, and writes
 *                   imports/<batch>/plan.json, plan.md, decisions.json,
 *                   reconciliation.md and baserow-before.json. Then `apply`.
 *   archive-verify  --batch <id> --impact … --fable … [--with-neon] [--out <md>]
 *                   Read-back verification of what Baserow STORES against
 *                   the plan and the workbook cells, and the reconciliation
 *                   of every source row. Exit 1 if any check fails.
 *   archive-rebind  --from-fixture imports/<file>.json [--yes]
 *                   LOCAL DATABASE ONLY. Re-point the mappings of an earlier
 *                   file-fixture rehearsal to the real Baserow rows with the
 *                   same keys, so the sync updates those projects in place
 *                   instead of creating duplicates. Dry run without --yes.
 *   verify-links    --impact … --fable … [--all]
 *                   A bounded, SSRF-safe public check of the URLs that need
 *                   one (an access parameter was removed) — or, with --all,
 *                   of every URL that would be published. Writes
 *                   imports/link-checks.json, which archive-plan reads.
 *   archive-report  --impact … --fable … [--out docs/imports/…md]
 *                   The committed, privacy-safe adapter report, with
 *                   public/draft counts read back from the database.
 *   sync --yes      reconcile + drain the queue, exactly as the cron does.
 *   fixture-seed    alias of archive-seed-events for the file fixture.
 *   enrich-logos    [--probe] favicon enrichment for public projects with no
 *                   logo; stores only with BLOB_READ_WRITE_TOKEN.
 *
 * The original workbooks stay where the organiser keeps them; nothing here
 * copies them, and nothing here prints an email, a member name or the
 * withheld credential URL.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, inArray, like } from 'drizzle-orm';
import { pooledDb } from '../../db/pool';
import * as schema from '../../db/schema';
import { createBaserowClient } from '../../src/server/integrations/baserow/client';
import { reconcile, runQueue, type RowSource } from '../../src/server/integrations/baserow/sync';
import type { BaserowConfig } from '../../src/server/integrations/baserow/config';
import type { LiveField } from '../../src/server/integrations/baserow/spec';
import { buildPlan, renderPlan, type Plan } from './lib/plan';
import { comparable, type Decision, type Writer } from './lib/apply';
import { fieldOptionsFrom, loadBaserowProjects, loadCrosswalk, loadLastWritten, loadNeonProjects, loadProjectedSlugs } from './lib/existing';
import { comparableUrl } from './lib/links';
import { safeFetch, UnsafeTarget } from './lib/safe-fetch';
import { FileBaserow } from './lib/file-baserow';
import { FIXTURE, fail, flag, guardDatabase, isLocalDatabase, option, settings, writer } from './lib/cli-env';
import { optionIds, readTable, snapshot, writeManifest } from './lib/workspace';
import {
  buildArchiveCandidates,
  publishableUrls,
  readArchiveWorkbooks,
  SOURCES,
  type EventBinding,
  type LinkVerification,
  type SourceId,
} from './sources/event-archive-2026-09/index';
import { renderReconciliation, type PublishedCounts } from './sources/event-archive-2026-09/report';
import { renderBaserowReconciliation, verifyImport } from './sources/event-archive-2026-09/verify';
import { enrichLogos } from '../media/logos';
import { nextAvailableSlug, slugifyTitle } from '../../src/server/members/projects';

export const ARCHIVE_COMMANDS = [
  'archive-seed-events',
  'archive-plan',
  'archive-verify',
  'archive-rebind',
  'verify-links',
  'archive-report',
  'fixture-seed',
  'sync',
  'enrich-logos',
] as const;

/** The two events' stable keys in the Baserow Events table. */
export const ARCHIVE_EVENT_KEYS: Record<SourceId, string> = {
  'impact-lab-2': 'evt-bhopal-impact-lab-2-2026-09',
  'fable-5-1': 'evt-bhopal-fable-5-1-build-day-2026-09',
};

/** The badge labels — editorial, carried by the adopting Baserow row. */
export const ARCHIVE_SHORT_TITLES: Record<SourceId, string> = {
  'impact-lab-2': 'Impact Lab 2',
  'fable-5-1': 'Fable 5.1 Build Day',
};

const SOURCE_IDS = Object.keys(ARCHIVE_EVENT_KEYS) as SourceId[];
type Db = ReturnType<typeof pooledDb>;
type Row = { id: number } & Record<string, unknown>;

/** How each event is found in Neon: by its stable curated slug / feed identity, never a date. */
async function neonEvents(db: Db) {
  const [impact] = await db.select().from(schema.events).where(eq(schema.events.slug, 'claude-impact-lab-september'));
  const [fable] = await db.select().from(schema.events).where(eq(schema.events.externalId, 'evt-4zpHOs9YWXolVLg'));
  return { 'impact-lab-2': impact, 'fable-5-1': fable } as const;
}

function archivePaths(): Record<SourceId, string> {
  return {
    'impact-lab-2': option('impact') ?? fail('--impact <Impact Lab 2 workbook> is required.'),
    'fable-5-1': option('fable') ?? fail('--fable <Fable 5.1 workbook> is required.'),
  };
}

const keyField = (config: BaserowConfig) => {
  const id = config.tables.events.fields.key;
  if (id === undefined) fail('events.key is not configured in BASEROW_CONFIG');
  return `field_${id}`;
};

/**
 * The two canonical event rows, found BY KEY in the Events table (fixture or
 * real). Exactly one row per key, or the import refuses to plan: a project
 * must link to the one canonical event, never to a lookalike.
 */
async function eventBindings(client: Pick<Writer, 'listAllRows'>, config: BaserowConfig): Promise<Record<SourceId, EventBinding>> {
  const rows = await readTable(client, config.tables.events.tableId);
  const kf = keyField(config);
  const df = config.tables.events.fields.date;
  const out = {} as Record<SourceId, EventBinding>;
  for (const id of SOURCE_IDS) {
    const hits = rows.filter((r) => r[kf] === ARCHIVE_EVENT_KEYS[id]);
    if (hits.length === 0) fail(`the Events table has no row with key ${ARCHIVE_EVENT_KEYS[id]} — run archive-seed-events first`);
    if (hits.length > 1) fail(`Events rows ${hits.map((h) => h.id).join(', ')} share key ${ARCHIVE_EVENT_KEYS[id]} — resolve the duplicate first`);
    const date = df === undefined ? '' : String(hits[0][`field_${df}`] ?? '');
    if (date !== SOURCES[id].heldOn) fail(`event ${ARCHIVE_EVENT_KEYS[id]} (row ${hits[0].id}) is dated ${date || '(none)'}, but ${SOURCES[id].event} was held on ${SOURCES[id].heldOn}`);
    out[id] = { key: ARCHIVE_EVENT_KEYS[id], baserowRowId: hits[0].id };
  }
  return out;
}

async function linkChecks(): Promise<LinkVerification> {
  try {
    return JSON.parse(await readFile(option('link-checks') ?? join('imports', 'link-checks.json'), 'utf8')) as LinkVerification;
  } catch {
    return {};
  }
}

const PLACEHOLDER_EVENTS: Record<SourceId, EventBinding> = {
  'impact-lab-2': { key: ARCHIVE_EVENT_KEYS['impact-lab-2'], baserowRowId: 1 },
  'fable-5-1': { key: ARCHIVE_EVENT_KEYS['fable-5-1'], baserowRowId: 1 },
};

// ── events ───────────────────────────────────────────────────────────────

/**
 * The Events row that adopts a Neon event, in Baserow's WRITE form. It
 * mirrors every column the projection writes, so adoption changes nothing
 * but the authority — and carries the held date from then on.
 */
async function eventMirror(
  db: Db,
  config: BaserowConfig,
  live: LiveField[],
  id: SourceId,
  event: typeof schema.events.$inferSelect,
  neonId: string,
  cityRowId: number | null = null,
): Promise<Record<string, unknown>> {
  const ev = config.tables.events.fields;
  const options = optionIds(live);
  const out: Record<string, unknown> = {};
  const put = (key: string, value: unknown, required = true) => {
    const fid = ev[key];
    if (fid === undefined) {
      if (required) fail(`events.${key} is not configured in BASEROW_CONFIG — adoption would blank it in Neon`);
      return;
    }
    out[`field_${fid}`] = value;
  };
  const select = (key: string, value: string) => {
    const option = options.get(ev[key]!)?.get(value);
    if (option === undefined) fail(`events.${key} has no option "${value}" in Baserow`);
    return option;
  };
  const [city] = await db.select({ slug: schema.cities.slug }).from(schema.cities).where(eq(schema.cities.id, event.cityId));
  const cityField = live.find((f) => f.id === ev.city);
  const cityIsLink = cityField?.type === 'link_row';
  if (cityIsLink && (!config.tables.cities || !cityRowId)) {
    fail('events.city links to a Cities table, but none is configured — make City a text field holding the Neon city slug');
  }
  put('key', ARCHIVE_EVENT_KEYS[id]);
  put('neonId', neonId);
  put('title', event.title);
  put('slug', event.slug);
  put('summary', event.summary);
  put('description', event.description ?? null);
  put('city', cityIsLink ? [cityRowId] : (city?.slug ?? fail('the Neon event has no city')));
  put('venueName', event.venueName);
  put('venueAddress', event.venueAddress || null);
  put('venuePrivate', event.venuePrivate);
  put('date', String(event.date).slice(0, 10));
  put('rescheduledFrom', event.rescheduledFrom ? String(event.rescheduledFrom).slice(0, 10) : null);
  put('shortTitle', event.shortTitle ?? ARCHIVE_SHORT_TITLES[id]);
  put('startTime', String(event.startTime).slice(0, 5));
  put('endTime', event.endTime ? String(event.endTime).slice(0, 5) : null);
  put('timezone', event.timezone ?? 'Asia/Kolkata');
  put('format', select('format', event.format));
  put('registrationUrl', event.registrationUrl ?? null);
  put('coverRef', event.coverImagePath || null);
  put('lifecycle', select('lifecycle', event.statusOverride ?? 'scheduled'));
  put('editorialStatus', select('editorialStatus', event.status === 'published' ? 'published' : event.status === 'archived' ? 'archived' : 'draft'));
  put('featured', event.featured);
  put('lumaId', event.externalId ?? null, false);
  return out;
}

function neonIdOverrides(): Partial<Record<SourceId, string>> {
  const given = option('neon-ids');
  if (!given) return {};
  const map = Object.fromEntries(given.split(',').map((pair) => pair.split('=').map((x) => x.trim())));
  const out: Partial<Record<SourceId, string>> = {};
  for (const id of SOURCE_IDS) {
    if (!map[id]) continue;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(map[id])) fail(`--neon-ids ${id} is not a UUID`);
    out[id] = map[id];
  }
  return out;
}

/** A workspace WITH a Cities table (the original file fixture): the Bhopal row, created if missing. */
async function citiesRow(db: Db, client: Writer & { listFields(tableId: number): Promise<unknown[]> }, config: BaserowConfig): Promise<number | null> {
  const cities = config.tables.cities;
  if (!cities) return null;
  const [city] = await db.select().from(schema.cities).where(eq(schema.cities.slug, 'bhopal'));
  if (!city) fail('the local database has no Bhopal city — run db:import');
  const slugField = `field_${cities.fields.slug}`;
  const rows = await readTable(client, cities.tableId);
  const hit = rows.find((r) => r[slugField] === 'bhopal');
  if (hit) return hit.id;
  const fields: Record<string, unknown> = { [slugField]: 'bhopal' };
  if (cities.fields.name !== undefined) fields[`field_${cities.fields.name}`] = city.name;
  return (await client.createRow(cities.tableId, fields)).id;
}

async function seedEvents() {
  if (!flag('yes')) fail('archive-seed-events writes to the Baserow Events table. Re-run with --yes.');
  guardDatabase();
  const db = pooledDb();
  const { client, config } = writer();
  const tableId = config.tables.events.tableId;
  const live = (await client.listFields(tableId)) as unknown as LiveField[];
  const rows = await readTable(client, tableId);
  const kf = keyField(config);
  const events = await neonEvents(db);
  const overrides = neonIdOverrides();
  // For the real workspace the Neon ID must be the PRODUCTION event's UUID —
  // the database that will adopt the row — not this local copy's.
  if (!FIXTURE && SOURCE_IDS.some((id) => !overrides[id])) {
    fail('--neon-ids impact-lab-2=<uuid>,fable-5-1=<uuid> is required for a real workspace: the PRODUCTION event ids.');
  }
  const cityRowId = await citiesRow(db, client, config);
  const mirrors = {} as Record<SourceId, Record<string, unknown>>;
  for (const id of SOURCE_IDS) {
    const event = events[id];
    if (!event) {
      fail(
        id === 'impact-lab-2'
          ? 'the local database has no claude-impact-lab-september event — run db:import'
          : 'the local database has no Fable 5.1 Build Day — ingest the Luma sample feed (scripts/dev/ingest-sample-feed.ts)',
      );
    }
    mirrors[id] = await eventMirror(db, config, live, id, event, overrides[id] ?? event.id, cityRowId);
  }
  const checksum = createHash('sha256').update(JSON.stringify(mirrors)).digest('hex');
  const [batch] = await db
    .insert(schema.importBatches)
    .values({ label: 'Bhopal event archive — canonical events', sourceFile: 'neon-events', checksum, mapping: { adapter: 'event-archive-2026-09:events', tableId } })
    .returning({ id: schema.importBatches.id });
  const dir = join('imports', batch!.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'baserow-before.json'), JSON.stringify({ takenAt: new Date().toISOString(), tableId, rows }, null, 2));

  const outcome: Record<string, unknown>[] = [];
  for (const id of SOURCE_IDS) {
    const key = ARCHIVE_EVENT_KEYS[id];
    const expected = mirrors[id];
    const hits = rows.filter((r) => r[kf] === key);
    if (hits.length > 1) fail(`Events rows ${hits.map((h) => h.id).join(', ')} share key ${key} — resolve the duplicate first`);
    if (hits.length === 1) {
      // Already there: an organiser may have edited it. Report, never overwrite.
      const differs = Object.entries(expected)
        .filter(([f, v]) => JSON.stringify(comparable(hits[0][f])) !== JSON.stringify(comparable(v)))
        .map(([f]) => live.find((x) => `field_${x.id}` === f)?.name ?? f);
      console.log(`matched ${key} → existing row ${hits[0].id}${differs.length ? `; differs from Neon in: ${differs.join(', ')} (left as it is)` : ' (identical to Neon)'}`);
      outcome.push({ key, rowId: hits[0].id, result: 'matched', differs });
      continue;
    }
    const neonField = `field_${config.tables.events.fields.neonId}`;
    const adopting = rows.find((r) => r[neonField] && r[neonField] === expected[neonField]);
    if (adopting) fail(`Events row ${adopting.id} already adopts that Neon event under another key — resolve it first`);

    await db.insert(schema.importLedger).values({ batchId: batch!.id, candidateKey: key, action: 'event', tableId, before: null, after: expected, status: 'pending' });
    let row: Row;
    try {
      row = (await client.createRow(tableId, expected)) as Row;
    } catch (error) {
      const kind = (error as { kind?: string }).kind;
      if (!['timeout', 'network', 'server', 'rate-limited'].includes(kind ?? '')) throw error;
      // The create may have landed: look for the key before anything else.
      const again = (await readTable(client, tableId)).filter((r) => r[kf] === key);
      if (again.length !== 1) throw error;
      row = again[0];
    }
    await db
      .update(schema.importLedger)
      .set({ rowId: row.id, status: 'applied', appliedAt: new Date(), afterHash: createHash('sha256').update(JSON.stringify(Object.keys(expected).sort().map((k) => [k, comparable(row[k])]))).digest('hex') })
      .where(and(eq(schema.importLedger.batchId, batch!.id), eq(schema.importLedger.candidateKey, key)));
    console.log(`created ${key} → row ${row.id} (adopts Neon event ${String(expected[neonField])}, held ${String(expected[`field_${config.tables.events.fields.date}`])})`);
    outcome.push({ key, rowId: row.id, result: 'created' });
  }
  await db.update(schema.importBatches).set({ status: 'applied', appliedAt: new Date(), report: { outcome } }).where(eq(schema.importBatches.id, batch!.id));
  await writeManifest(db, batch!.id, dir, { kind: 'events', outcome });
  console.log(`Wrote ${dir}/apply-manifest.json (batch ${batch!.id}).`);
}

// ── projects: the plan ───────────────────────────────────────────────────

async function archivePlan() {
  guardDatabase();
  const db = pooledDb();
  const workbooks = await readArchiveWorkbooks(archivePaths());
  const { client, config } = writer();
  const bindings = await eventBindings(client, config);
  const built = buildArchiveCandidates(workbooks, bindings, await linkChecks());
  // Keep the URL an earlier projection already gave each project; give a
  // new one the slug the projection would choose, so Baserow carries every
  // project's URL from the first write and a re-run has nothing to add.
  const slugs = await loadProjectedSlugs(db);
  const reserved = new Set(slugs.values());
  for (const c of built.candidates) {
    let slug = slugs.get(c.key) ?? null;
    if (!slug) {
      slug = await nextAvailableSlug(c.title, db);
      for (let n = 2; reserved.has(slug); n += 1) slug = `${slugifyTitle(c.title)}-${n}`;
    }
    reserved.add(slug);
    c.slug = slug;
  }

  const before = await snapshot(client, config);
  const projectFields = await client.listFields(config.tables.projects.tableId);
  const options = fieldOptionsFrom(projectFields as never, config);
  const [baserowRows, neonProjects, crosswalk, lastWritten] = await Promise.all([
    loadBaserowProjects(client, config),
    loadNeonProjects(db),
    loadCrosswalk(db),
    loadLastWritten(db, config, options),
  ]);
  const totals = Object.values(built.totals);
  const label = 'Bhopal event archive — Impact Lab 2 (15 Sep 2026) and Fable 5.1 Build Day (20 Sep 2026)';
  const checksum = [built.checksums['impact-lab-2'].actual, built.checksums['fable-5-1'].actual].join('+');
  for (const id of SOURCE_IDS) {
    const c = built.checksums[id];
    if (c.actual !== c.expected) console.log(`! ${SOURCES[id].label}: this workbook (sha256 ${c.actual.slice(0, 12)}…) is not the reviewed file — the row checks below still apply`);
  }
  const result = buildPlan({
    label,
    file: 'Impact Lab 2 + Fable 5.1 workbooks',
    checksum,
    candidates: built.candidates,
    stats: {
      sourceRows: totals.reduce((n, t) => n + t.sourceRows, 0),
      blankRows: 0,
      groupedRows: totals.reduce((n, t) => n + t.merged, 0),
      invalidLinks: 0,
      withheldColumns: [
        'Impact Lab 2: emails (B, C, E, H, J, L), member names (D, G, I, K), team size (M), timestamps (A), acknowledgements (V–Z), notes (AA)',
        'Fable 5.1: email (B), timestamps (A), showcase posts (J), confirmation (K)',
      ],
      withheldPublicValues: 0,
      creditsWithoutConsent: 0,
    },
    errors: [],
    crosswalk,
    baserowRows,
    neonProjects,
    lastWritten,
  });
  const [batch] = await db
    .insert(schema.importBatches)
    .values({ label, sourceFile: 'event-archive-2026-09', checksum, mapping: { adapter: 'event-archive-2026-09', events: bindings }, report: result.totals as unknown as Record<string, unknown> })
    .returning({ id: schema.importBatches.id });
  const dir = join('imports', batch!.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'baserow-before.json'), JSON.stringify(before, null, 2));
  await writeFile(join(dir, 'plan.json'), JSON.stringify({ batchId: batch!.id, plan: result, candidates: built.candidates, events: bindings }, null, 2));
  await writeFile(join(dir, 'plan.md'), renderPlan(result));
  await writeFile(join(dir, 'reconciliation.md'), renderReconciliation(built, { generatedAt: new Date().toISOString() }));
  // Editorial holds are written as DRAFTS, so they can be resolved in Baserow.
  // A weak identity (no artifact to match on) is acceptable for a draft that
  // is held anyway. Anything else the planner flags — a possible duplicate of
  // an existing project, a weak identity that would be PUBLISHED — waits.
  const byKey = new Map(built.candidates.map((c) => [c.key, c]));
  const decisions: Record<string, Decision> = Object.fromEntries(
    result.items.map((i) => {
      if (i.action === 'unchanged') return [i.key, 'skip'];
      if (i.action !== 'review') return [i.key, 'apply'];
      const heldDraft = byKey.get(i.key)?.editorial?.disposition === 'hold';
      const acceptable = i.reasons.every((r) => r.startsWith('held:') || (heldDraft && r.startsWith('weak identity')));
      return [i.key, acceptable ? 'apply' : 'hold'];
    }),
  );
  await writeFile(join(dir, 'decisions.json'), JSON.stringify(decisions, null, 2));
  console.log(JSON.stringify(built.totals, null, 2));
  console.log(renderPlan(result).split('\n').slice(0, 18).join('\n'));
  const counts = Object.values(decisions).reduce<Record<string, number>>((m, d) => ({ ...m, [d]: (m[d] ?? 0) + 1 }), {});
  console.log(`\nDecisions: ${JSON.stringify(counts)}`);
  console.log(`Snapshot: ${Object.entries(before.tables).map(([t, v]) => `${t} ${v?.count}`).join(', ')} rows → ${dir}/baserow-before.json`);
  console.log(`Wrote ${dir}/plan.md, plan.json, decisions.json and reconciliation.md (batch ${batch!.id}).`);
  console.log(`Next: npm run import -- apply --plan ${dir}/plan.json --publish --yes`);
}

// ── read-back verification ───────────────────────────────────────────────

async function archiveVerify() {
  const batchId = option('batch') ?? fail('--batch <id> is required.');
  guardDatabase();
  const db = pooledDb();
  const dir = join('imports', batchId);
  const saved = JSON.parse(await readFile(join(dir, 'plan.json'), 'utf8')) as {
    plan: Plan;
    candidates: Parameters<typeof verifyImport>[0]['candidates'];
    events: Record<SourceId, EventBinding>;
  };
  const decisions = JSON.parse(await readFile(join(dir, 'decisions.json'), 'utf8')) as Record<string, Decision>;
  const [batch] = await db.select().from(schema.importBatches).where(eq(schema.importBatches.id, batchId));
  const publish = Boolean((batch?.report as { publishedRequested?: number } | null)?.publishedRequested);
  const workbooks = await readArchiveWorkbooks(archivePaths());
  const adapter = buildArchiveCandidates(workbooks, saved.events, await linkChecks());
  const { client, config } = writer();
  const rows = {
    events: await readTable(client, config.tables.events.tableId),
    projects: await readTable(client, config.tables.projects.tableId),
    credits: await readTable(client, config.tables.credits.tableId),
  };
  const eventsLive = (await client.listFields(config.tables.events.tableId)) as unknown as LiveField[];
  const projectFields = (await client.listFields(config.tables.projects.tableId)) as unknown as LiveField[];
  const neonEventRows = await neonEvents(db);
  const overrides = neonIdOverrides();
  const events = {} as Parameters<typeof verifyImport>[0]['events'];
  for (const id of SOURCE_IDS) {
    // The mirror is re-derived from the database; Neon ID is checked only when given.
    const cityRow = config.tables.cities ? (await readTable(client, config.tables.cities.tableId)).find((r) => r[`field_${config.tables.cities!.fields.slug}`] === 'bhopal')?.id ?? null : null;
    const mirror = await eventMirror(db, config, eventsLive, id, neonEventRows[id]!, overrides[id] ?? '', cityRow);
    if (!overrides[id]) delete mirror[`field_${config.tables.events.fields.neonId}`];
    events[id] = { ...saved.events[id], expected: mirror };
  }
  let neon: Map<number, { slug: string; publication: string; moderation: string; authority: string }> | undefined;
  if (flag('with-neon')) {
    const mapped = await db
      .select({
        rowId: schema.integrationMappings.rowId,
        slug: schema.projects.slug,
        publication: schema.projects.publicationStatus,
        moderation: schema.projects.moderationState,
        authority: schema.projects.contentAuthority,
      })
      .from(schema.integrationMappings)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.integrationMappings.entityId))
      .where(and(eq(schema.integrationMappings.tableId, config.tables.projects.tableId), eq(schema.integrationMappings.entityType, 'project')));
    neon = new Map(mapped.map((m) => [m.rowId, { slug: m.slug, publication: m.publication, moderation: m.moderation, authority: m.authority }]));
  }
  const result = verifyImport({ config, plan: saved.plan, candidates: saved.candidates, decisions, adapter, workbooks, events, rows, projectFields, publish, neon });

  const recon = result.reconciliation;
  const count = (d: string) => recon.filter((r) => r.disposition === d).length;
  const importedRows = recon.filter((r) => r.disposition.startsWith('imported'));
  const counts: Record<string, number | string> = {
    'Raw submissions (source rows)': recon.length,
    '— Impact Lab 2 / Fable 5.1': `${recon.filter((r) => r.source === 'impact-lab-2').length} / ${recon.filter((r) => r.source === 'fable-5-1').length}`,
    'Unique projects (candidates after merging repeats, excluding junk)': saved.candidates.length,
    'Merged repeat submissions': count('merged'),
    'Junk submissions held (quarantined)': count('quarantined'),
    'Imported into Baserow — new rows created by this import': importedRows.length,
    '— of which published': count('imported-published'),
    '— of which draft, held for review': count('imported-draft-held'),
    '— of which already a local project through the earlier rehearsal (matched by source key)': importedRows.filter((r) => r.matchedLocalProject).length,
    'Held for review — not imported': count('held-not-imported'),
    'Failed': count('failed'),
    'Baserow Projects rows (table total)': rows.projects.length,
    'Baserow Events rows (table total; 2 pre-existing blank rows)': rows.events.length,
    'Baserow ProjectCredits rows (table total; 2 pre-existing blank rows)': rows.credits.length,
    ...(neon
      ? {
          'Website (local sync): public': importedRows.filter((r) => r.neon?.startsWith('published')).length,
          'Website (local sync): draft': importedRows.filter((r) => r.neon?.startsWith('draft')).length,
        }
      : {}),
  };
  for (const c of result.checks) console.log(`${c.ok ? 'pass' : 'FAIL'}  ${c.name} — ${c.detail}`);
  for (const w of result.warnings) console.log(`warn  ${w}`);
  console.log(JSON.stringify(counts, null, 2));
  const md = renderBaserowReconciliation({
    generatedAt: new Date().toISOString().slice(0, 10),
    rows: recon,
    checks: result.checks,
    warnings: result.warnings,
    counts,
    workspace: FIXTURE ? `file fixture ${FIXTURE} (rehearsal — not the real Baserow)` : `Baserow database ${option('database') ?? '(configured)'} — Projects ${config.tables.projects.tableId}, Events ${config.tables.events.tableId}, ProjectCredits ${config.tables.credits.tableId}`,
  });
  await writeFile(join(dir, 'verification.json'), JSON.stringify({ ok: result.ok, checks: result.checks, warnings: result.warnings, counts, reconciliation: recon }, null, 2));
  await writeFile(join(dir, 'baserow-reconciliation.md'), md);
  const out = option('out');
  if (out) await writeFile(out, md);
  console.log(`\n${result.ok ? 'VERIFIED' : 'VERIFICATION FAILED'} — wrote ${dir}/verification.json and baserow-reconciliation.md${out ? ` and ${out}` : ''}.`);
  process.exit(result.ok ? 0 : 1);
}

// ── local: re-point an earlier rehearsal's mappings ──────────────────────

/**
 * An earlier LOCAL rehearsal projected projects from a file fixture, so this
 * database maps (fixture table, fixture row) → project. The real Baserow
 * rows carry the same source keys. Re-pointing each mapping to the real row
 * with the same key lets the sync update those projects IN PLACE — no
 * duplicates, same UUIDs, same slugs, member claims and moderation intact.
 */
async function archiveRebind() {
  guardDatabase();
  if (!isLocalDatabase()) fail('archive-rebind only runs against a local database. Production never had the rehearsal.');
  const fixturePath = option('from-fixture') ?? fail('--from-fixture imports/<file>.json is required (the rehearsal fixture).');
  if (!existsSync(fixturePath)) fail(`${fixturePath} does not exist`);
  const old = new FileBaserow(fixturePath);
  const { client, config } = writer();
  if (FIXTURE && FIXTURE === fixturePath) fail('--from-fixture must be the OLD rehearsal fixture, not the target.');
  const db = pooledDb();
  const plans: { entity: 'event' | 'project'; key: string; from: [number, number]; to: [number, number] }[] = [];
  const pairs: { entity: 'event' | 'project'; oldTable: number; oldKey: string; newTable: number; newKey: string }[] = [
    { entity: 'event', oldTable: old.config.tables.events.tableId, oldKey: old.field('events', 'key'), newTable: config.tables.events.tableId, newKey: keyField(config) },
    { entity: 'project', oldTable: old.config.tables.projects.tableId, oldKey: old.field('projects', 'key'), newTable: config.tables.projects.tableId, newKey: `field_${config.tables.projects.fields.key}` },
  ];
  // Which old row each key was: for projects the DATABASE'S OWN import
  // ledger is the authority (a fixture file may be a different rehearsal's —
  // trusting one would swap projects). Events were not ledgered by the old
  // seed, so the fixture row is used, but only if its Neon ID is the event
  // the database actually mapped it to.
  const ledgerRows = await db
    .select({ key: schema.importLedger.candidateKey, rowId: schema.importLedger.rowId })
    .from(schema.importLedger)
    .where(and(eq(schema.importLedger.tableId, pairs[1].oldTable), eq(schema.importLedger.action, 'project'), eq(schema.importLedger.status, 'applied')));
  const ledgerKey = new Map(ledgerRows.filter((l) => l.rowId).map((l) => [l.rowId!, l.key]));
  let disagreements = 0;
  for (const p of pairs) {
    const oldRows = (await old.listAllRows(p.oldTable)).rows;
    const newRows = await readTable(client, p.newTable);
    const newByKey = new Map<string, number[]>();
    for (const r of newRows) {
      const k = String(r[p.newKey] ?? '');
      if (k) newByKey.set(k, [...(newByKey.get(k) ?? []), r.id]);
    }
    const oldPairs: [string, number][] =
      p.entity === 'project'
        ? [...ledgerKey.entries()].map(([rowId, key]) => [key, rowId])
        : oldRows.map((r) => [String(r[p.oldKey] ?? ''), r.id]);
    if (p.entity === 'project') {
      for (const r of oldRows) if (ledgerKey.has(r.id) && ledgerKey.get(r.id) !== String(r[p.oldKey] ?? '')) disagreements += 1;
    }
    for (const [k, oldRowId] of oldPairs) {
      const target = newByKey.get(k);
      if (!k || !target) continue;
      if (target.length > 1) fail(`real Baserow has ${target.length} rows with key ${k} — resolve before rebinding`);
      if (p.entity === 'event') {
        const oldRow = oldRows.find((r) => r.id === oldRowId)!;
        const [m] = await db
          .select({ entityId: schema.integrationMappings.entityId })
          .from(schema.integrationMappings)
          .where(and(eq(schema.integrationMappings.tableId, p.oldTable), eq(schema.integrationMappings.rowId, oldRowId)));
        if (m && m.entityId !== String(oldRow[old.field('events', 'neonId')] ?? '')) {
          fail(`event ${k}: the fixture row's Neon ID is not the event this database mapped — wrong fixture file`);
        }
      }
      plans.push({ entity: p.entity, key: k, from: [p.oldTable, oldRowId], to: [p.newTable, target[0]] });
    }
  }
  if (disagreements) console.log(`! ${disagreements} project row(s) in ${fixturePath} disagree with this database's ledger — the ledger is used.`);
  console.log(`${plans.filter((p) => p.entity === 'event').length} event and ${plans.filter((p) => p.entity === 'project').length} project mapping(s) to re-point.`);
  if (!flag('yes')) {
    console.log('Dry run — nothing changed. Re-run with --yes to apply.');
    return;
  }
  let moved = 0;
  let already = 0;
  let credits = 0;
  await db.transaction(async (tx) => {
    for (const p of plans) {
      const [current] = await tx
        .select()
        .from(schema.integrationMappings)
        .where(and(eq(schema.integrationMappings.provider, 'baserow'), eq(schema.integrationMappings.tableId, p.from[0]), eq(schema.integrationMappings.rowId, p.from[1])));
      const [taken] = await tx
        .select()
        .from(schema.integrationMappings)
        .where(and(eq(schema.integrationMappings.provider, 'baserow'), eq(schema.integrationMappings.tableId, p.to[0]), eq(schema.integrationMappings.rowId, p.to[1])));
      if (!current) {
        if (taken) already += 1;
        continue;
      }
      if (taken) {
        if (taken.entityId !== current.entityId) throw new Error(`row ${p.to.join(':')} is already mapped to another ${p.entity}`);
        already += 1;
        continue;
      }
      // sourceHash cleared: reconciliation must re-read the real row.
      await tx
        .update(schema.integrationMappings)
        .set({ tableId: p.to[0], rowId: p.to[1], sourceHash: null, contentHash: null, updatedAt: new Date() })
        .where(eq(schema.integrationMappings.id, current.id));
      if (p.entity === 'project') {
        // The team credit is keyed by its Baserow row; move it with the row so
        // the next projection updates it instead of adding a second one.
        const updated = await tx
          .update(schema.projectCredits)
          .set({ sourceKey: `baserow:${p.to[0]}:${p.to[1]}:team`, updatedAt: new Date() })
          .where(eq(schema.projectCredits.sourceKey, `baserow:${p.from[0]}:${p.from[1]}:team`))
          .returning({ id: schema.projectCredits.id });
        credits += updated.length;
      }
      moved += 1;
    }
    // Jobs still pending for the rehearsal tables would only fail now.
    await tx
      .delete(schema.integrationJobs)
      .where(and(inArray(schema.integrationJobs.tableId, [pairs[0].oldTable, pairs[1].oldTable]), eq(schema.integrationJobs.status, 'pending')));
  });
  const leftover = await db
    .select({ id: schema.projectCredits.id })
    .from(schema.projectCredits)
    .where(like(schema.projectCredits.sourceKey, `baserow:${pairs[1].oldTable}:%`));
  console.log(`re-pointed ${moved} mapping(s) (${already} already pointed at the real rows); moved ${credits} team credit key(s); ${leftover.length} credit(s) still keyed to the rehearsal table.`);
}

// ── links ────────────────────────────────────────────────────────────────

async function verifyLinks() {
  const workbooks = await readArchiveWorkbooks(archivePaths());
  const built = buildArchiveCandidates(workbooks, PLACEHOLDER_EVENTS);
  const urls = [...new Set([...built.pendingVerification, ...(flag('all') ? publishableUrls(built.candidates) : [])])];
  const out: LinkVerification = await linkChecks();
  console.log(`Checking ${urls.length} public URL(s) with the bounded fetcher…`);
  for (const url of urls) {
    let status: number | undefined;
    let ok = false;
    let finalUrl = url;
    try {
      let res = await safeFetch(url, { method: 'HEAD', maxBytes: 1, timeoutMs: 8_000 });
      if ([403, 405, 501].includes(res.status)) res = await safeFetch(url, { maxBytes: 16 * 1024, timeoutMs: 8_000 });
      status = res.status;
      finalUrl = res.finalUrl;
      // A redirect to a hosting provider's login wall is not public.
      ok = res.status >= 200 && res.status < 400 && !/^https:\/\/(vercel\.com\/(login|sso)|accounts\.google\.com)/.test(finalUrl);
    } catch (error) {
      if (error instanceof UnsafeTarget) console.log(`  refused (${error.reason})`);
    }
    out[comparableUrl(url)] = { ok, ...(status ? { status } : {}), checkedAt: new Date().toISOString() };
    const u = new URL(url);
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${status ?? '—'}  ${u.hostname}${u.pathname}`);
  }
  await mkdir('imports', { recursive: true });
  await writeFile(join('imports', 'link-checks.json'), JSON.stringify(out, null, 2));
  console.log('Wrote imports/link-checks.json (git-ignored). Re-run archive-plan to use it.');
}

// ── sync ─────────────────────────────────────────────────────────────────

async function sync() {
  if (!flag('yes')) fail('sync writes to the database. Re-run with --yes.');
  guardDatabase();
  const db = pooledDb();
  let source: RowSource;
  let config: BaserowConfig;
  if (FIXTURE) {
    const w = writer();
    source = w.client;
    config = w.config;
  } else {
    const s = settings();
    const token = process.env.BASEROW_READ_TOKEN?.trim() || fail('BASEROW_READ_TOKEN is not set.');
    source = createBaserowClient({ baseUrl: s.apiUrl, token });
    config = s.config!;
  }
  // A row whose dependency was applied later in the same pass is quarantined
  // and re-queued by the next reconcile — so a few passes converge, exactly
  // as successive cron runs would.
  for (let pass = 1; pass <= 4; pass += 1) {
    const report = await reconcile(db, source, config);
    console.log(`reconcile ${pass}:`, JSON.stringify(report.tables.map((t) => ({ table: t.table, rows: t.rows, changed: t.changed }))));
    const total: Record<string, number> = {};
    for (let round = 0; round < 60; round += 1) {
      const counts = (await runQueue(db, source, config, { budgetMs: 30_000, trigger: 'manual', batchSize: 25 })) as unknown as Record<string, number>;
      for (const [k, v] of Object.entries(counts)) if (typeof v === 'number') total[k] = (total[k] ?? 0) + v;
      if ((counts.claimed ?? 0) === 0) break;
    }
    console.log(`queue ${pass}:`, JSON.stringify(total));
    if (!total.quarantined) break;
  }
}

async function archiveReport() {
  guardDatabase();
  const db = pooledDb();
  const workbooks = await readArchiveWorkbooks(archivePaths());
  const built = buildArchiveCandidates(workbooks, PLACEHOLDER_EVENTS, await linkChecks());
  const events = await neonEvents(db);
  const published: PublishedCounts = {};
  for (const id of Object.keys(events) as SourceId[]) {
    const event = events[id];
    if (!event) continue;
    const rows = await db
      .select({ status: schema.projects.publicationStatus, moderation: schema.projects.moderationState })
      .from(schema.projects)
      .where(and(eq(schema.projects.builtAtEventId, event.id), eq(schema.projects.contentAuthority, 'baserow')));
    published[id] = {
      public: rows.filter((r) => r.status === 'published' && r.moderation === 'clean').length,
      draft: rows.filter((r) => r.status === 'draft').length,
    };
  }
  const out = option('out') ?? join('docs', 'imports', '2026-09-event-archive.md');
  await mkdir(join(out, '..'), { recursive: true });
  await writeFile(out, renderReconciliation(built, { generatedAt: new Date().toISOString().slice(0, 10), published }));
  console.log(`Wrote ${out}`);
  console.log(JSON.stringify({ totals: built.totals, published }, null, 2));
}

async function enrich() {
  guardDatabase();
  const db = pooledDb();
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
  if (!token && !flag('probe')) {
    console.log('No BLOB_READ_WRITE_TOKEN: nothing can be stored, so enrichment is DEFERRED and every project keeps the placeholder.');
    console.log('Run with --probe to test icon discovery without storing anything.');
    return;
  }
  const store =
    flag('probe') || !token
      ? null
      : {
          async put(pathname: string, png: Buffer) {
            const { put } = await import('@vercel/blob');
            const blob = await put(pathname, png, { access: 'public', contentType: 'image/png', token, addRandomSuffix: false, allowOverwrite: true });
            return { url: blob.url, pathname: blob.pathname };
          },
        };
  const known = new Set<string>(JSON.parse(await readFile('config/generic-icons.json', 'utf8').catch(() => '[]')) as string[]);
  const { outcomes } = await enrichLogos({ db, store, knownGeneric: known, limit: Number(option('limit') ?? 200) });
  const tally = outcomes.reduce<Record<string, number>>((m, o) => ({ ...m, [o.result]: (m[o.result] ?? 0) + 1 }), {});
  for (const o of outcomes) {
    console.log(`  ${o.result.padEnd(17)} ${o.slug}${'reason' in o ? ` — ${o.reason}` : ` ← ${new URL(o.source).hostname} ${o.width}×${o.height}`}`);
  }
  console.log(JSON.stringify(tally));
}

export async function runArchiveCommand(command: (typeof ARCHIVE_COMMANDS)[number]) {
  const run = {
    'archive-seed-events': seedEvents,
    'fixture-seed': seedEvents,
    'archive-plan': archivePlan,
    'archive-verify': archiveVerify,
    'archive-rebind': archiveRebind,
    'verify-links': verifyLinks,
    'archive-report': archiveReport,
    sync,
    'enrich-logos': enrich,
  }[command];
  await run();
  process.exit(0);
}
