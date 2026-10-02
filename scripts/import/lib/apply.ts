/**
 * APPLY AND ROLLBACK — writing reviewed decisions to Baserow, reversibly.
 *
 * The importer writes to BASEROW, not to Neon. The normal projection
 * (webhook + reconciliation) then validates and applies those rows, so an
 * imported project goes through exactly the same gate as an organiser's edit.
 *
 *   · ONE IMPORT AT A TIME. An import lock row in `integration_state`.
 *   · RESUMABLE. Every write has a ledger row: `pending` before the call,
 *     `applied` after. A re-run skips what is applied.
 *   · AMBIGUOUS FAILURES ARE RECONCILED. A timeout on create may mean the row
 *     was created. Before retrying, the importer looks for a row carrying the
 *     candidate's key and adopts it — so a retry cannot double-create.
 *   · DRAFT BY DEFAULT. `--publish` sets `published` only for candidates that
 *     meet the archive contract; everything else stays `draft`. Updates never
 *     change editorial status: an organiser's decision in Baserow stands.
 *   · ROLLBACK IS GUARDED. It reverts a row only if it still holds exactly what
 *     this batch wrote AND its project has not been claimed. Later work wins.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../../../db/schema';
import { contentHash } from '../../../src/server/integrations/baserow/dto';
import type { BaserowConfig } from '../../../src/server/integrations/baserow/config';
import type { Candidate } from './candidates';
import { missingForArchive, type Plan, type PlannedItem } from './plan';
import { readTable } from './workspace';

type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;
type Row = { id: number } & Record<string, unknown>;

/** The Baserow operations the importer needs (see src/server/integrations/baserow/client.ts). */
export interface Writer {
  createRow(tableId: number, fields: Record<string, unknown>): Promise<Row>;
  updateRow(tableId: number, rowId: number, fields: Record<string, unknown>): Promise<Row>;
  deleteRow(tableId: number, rowId: number): Promise<void>;
  getRow(tableId: number, rowId: number): Promise<Row>;
  listAllRows(tableId: number, options?: { pageSize?: number }): Promise<{ rows: Row[]; complete: boolean; pages: number }>;
}

/** Select option ids by value, per logical field, from the live schema. */
export type FieldOptions = Partial<Record<'category' | 'tags' | 'editorialStatus' | 'buildStatus', Map<string, number>>> & {
  tagsAreText?: boolean;
};

export type Decision = 'apply' | 'skip' | 'hold';

export interface ApplyReport {
  batchId: string;
  created: number;
  updated: number;
  credits: number;
  skipped: number;
  adoptedAfterAmbiguousFailure: number;
  failed: { key: string; error: string }[];
  publishedRequested: number;
}

const LOCK_KEY = 'import-lock';
const LOCK_TTL_MS = 30 * 60_000;

// ── field mapping ────────────────────────────────────────────────────────

const fid = (config: BaserowConfig, table: 'projects' | 'credits', key: string) => {
  const id = config.tables[table].fields[key];
  return id === undefined ? null : `field_${id}`;
};

export function projectFields(
  c: Candidate,
  config: BaserowConfig,
  options: FieldOptions,
  only: Set<string> | null,
  editorial: 'draft' | 'published' | null,
  batchLabel: string,
): { fields: Record<string, unknown>; warnings: string[] } {
  const warnings: string[] = [];
  const out: Record<string, unknown> = {};
  const put = (key: string, value: unknown) => {
    if (only && !only.has(key)) return;
    const f = fid(config, 'projects', key);
    if (f) out[f] = value;
  };
  put('key', c.key);
  put('title', c.title);
  if (c.summary) put('summary', c.summary);
  if (c.description) put('description', c.description);
  const category = options.category?.get(c.category);
  if (category !== undefined) put('category', category);
  else if (!only || only.has('category')) warnings.push(`category "${c.category}" is not an option in Baserow`);
  if (c.tags.length) {
    if (options.tagsAreText) put('tags', c.tags.join(', '));
    else {
      const ids = c.tags.flatMap((t) => {
        const id = options.tags?.get(t.toLowerCase());
        if (id === undefined) warnings.push(`tag "${t}" is not an option in Baserow — add it there to keep it`);
        return id === undefined ? [] : [id];
      });
      if (ids.length) put('tags', ids);
    }
  }
  if (c.liveUrl) put('liveUrl', c.liveUrl);
  if (c.repoUrl) put('repoUrl', c.repoUrl);
  if (c.videoUrl) put('videoUrl', c.videoUrl);
  if (c.claudeUsage) put('claudeUsage', c.claudeUsage);
  if (c.teamName) put('teamName', c.teamName);
  if (c.problem) put('problem', c.problem);
  if (c.solution) put('solution', c.solution);
  if (c.builtWith) put('builtWith', c.builtWith);
  if (c.downloadUrl) put('downloadUrl', c.downloadUrl);
  if (c.artifactUrl) put('artifactUrl', c.artifactUrl);
  if (c.altVideoUrl) put('altVideoUrl', c.altVideoUrl);
  if (c.buildStatus) {
    const status = options.buildStatus?.get(c.buildStatus);
    if (status !== undefined) put('buildStatus', status);
    else if (!only || only.has('buildStatus')) warnings.push(`build status "${c.buildStatus}" is not an option in Baserow`);
  }
  if (c.slug) put('slug', c.slug);
  put('event', [c.eventRowId]);
  put('sourceBatch', batchLabel);
  put('sourceKey', c.key);
  if (c.sourceRows) put('sourceRows', c.sourceRows);
  if (c.reviewNotes) put('reviewNotes', c.reviewNotes);
  if (editorial) {
    const id = options.editorialStatus?.get(editorial);
    if (id === undefined) warnings.push(`editorial status "${editorial}" is not an option in Baserow`);
    else out[fid(config, 'projects', 'editorialStatus')!] = id;
  }
  return { fields: out, warnings };
}

/** Comparable form of a Baserow value: selects → id, links → ids, text → string. */
export function comparable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (v && typeof v === 'object' && 'id' in v ? (v as { id: number }).id : v)).sort();
  if (value && typeof value === 'object' && 'id' in (value as object)) return (value as { id: number }).id;
  if (value === null || value === undefined) return '';
  return typeof value === 'number' ? value : String(value);
}

/** A value read from Baserow, in the form Baserow accepts when writing it back. */
export function writable(value: unknown): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => (v && typeof v === 'object' && 'id' in v ? (v as { id: number }).id : v));
  if (value && typeof value === 'object' && 'id' in (value as object)) return (value as { id: number }).id;
  return value;
}

function writtenHash(fields: Record<string, unknown>, row: Record<string, unknown> | null): string {
  const keys = Object.keys(fields).sort();
  const source = row ?? fields;
  return contentHash(keys.map((k) => [k, comparable(source[k])]));
}

// ── lock, ledger, crosswalk ──────────────────────────────────────────────

/** Takes the import lock for this run and returns the run's owner token. */
async function takeLock(db: AnyDatabase, batchId: string): Promise<string> {
  const now = new Date();
  // Per run, not per batch: two runs of one batch must not both count as the holder.
  const owner = `${batchId}:${randomUUID()}`;
  const value = { owner, at: now.toISOString() };
  // One statement, so two runs cannot both find it free; only a stale lock is taken over.
  const [taken] = await db
    .insert(schema.integrationState)
    .values({ key: LOCK_KEY, value })
    .onConflictDoUpdate({
      target: schema.integrationState.key,
      set: { value, updatedAt: now },
      setWhere: sql`(${schema.integrationState.value}->>'at')::timestamptz <= ${new Date(now.getTime() - LOCK_TTL_MS).toISOString()}::timestamptz`,
    })
    .returning({ key: schema.integrationState.key });
  if (!taken) {
    const [existing] = await db.select().from(schema.integrationState).where(eq(schema.integrationState.key, LOCK_KEY));
    const other = (existing?.value as { owner?: string } | undefined)?.owner;
    throw new Error(`another import (${other}) is running; wait for it or remove the stale lock after 30 minutes`);
  }
  return owner;
}

const heldBy = (owner: string) =>
  and(eq(schema.integrationState.key, LOCK_KEY), sql`${schema.integrationState.value}->>'owner' = ${owner}`);

/** The heartbeat between items. A run whose lock went stale and was taken over stops here. */
async function refreshLock(db: AnyDatabase, owner: string) {
  const now = new Date();
  const refreshed = await db
    .update(schema.integrationState)
    .set({ value: { owner, at: now.toISOString() }, updatedAt: now })
    .where(heldBy(owner))
    .returning({ key: schema.integrationState.key });
  if (refreshed.length === 0) throw new Error('lost the import lock to another run; stopping');
}

async function releaseLock(db: AnyDatabase, owner: string) {
  await db.delete(schema.integrationState).where(heldBy(owner));
}

async function ledgerFor(db: AnyDatabase, batchId: string, key: string, action: string, tableId: number) {
  const [row] = await db
    .select()
    .from(schema.importLedger)
    .where(
      and(
        eq(schema.importLedger.batchId, batchId),
        eq(schema.importLedger.candidateKey, key),
        eq(schema.importLedger.action, action),
        eq(schema.importLedger.tableId, tableId),
      ),
    );
  return row ?? null;
}

async function upsertLedger(db: AnyDatabase, values: typeof schema.importLedger.$inferInsert) {
  await db
    .insert(schema.importLedger)
    .values(values)
    .onConflictDoUpdate({
      target: [schema.importLedger.batchId, schema.importLedger.candidateKey, schema.importLedger.action, schema.importLedger.tableId],
      set: {
        rowId: values.rowId,
        before: values.before,
        after: values.after,
        afterHash: values.afterHash,
        status: values.status,
        error: values.error ?? null,
        appliedAt: values.appliedAt ?? null,
      },
    });
}

async function rememberCrosswalk(db: AnyDatabase, c: Candidate, tableId: number, rowId: number, batchId: string) {
  await db
    .insert(schema.importCrosswalk)
    .values({ candidateKey: c.key, eventKey: c.eventKey, baserowTableId: tableId, baserowRowId: rowId, firstBatchId: batchId, lastBatchId: batchId })
    .onConflictDoUpdate({
      target: schema.importCrosswalk.candidateKey,
      set: { baserowTableId: tableId, baserowRowId: rowId, lastBatchId: batchId, updatedAt: new Date() },
    });
}

const ambiguous = (error: unknown) => {
  const kind = (error as { kind?: string }).kind;
  return kind === 'timeout' || kind === 'network' || kind === 'server' || kind === 'rate-limited';
};

// ── apply ────────────────────────────────────────────────────────────────

export async function applyPlan(input: {
  db: AnyDatabase;
  writer: Writer;
  config: BaserowConfig;
  batchId: string;
  plan: Plan;
  candidates: Candidate[];
  decisions: Record<string, Decision>;
  options: FieldOptions;
  publish: boolean;
}): Promise<ApplyReport> {
  const { db, writer, config, batchId, plan } = input;
  const projectsTable = config.tables.projects.tableId;
  const creditsTable = config.tables.credits.tableId;
  const keyField = fid(config, 'projects', 'key');
  const report: ApplyReport = { batchId, created: 0, updated: 0, credits: 0, skipped: 0, adoptedAfterAmbiguousFailure: 0, failed: [], publishedRequested: 0 };
  const byKey = new Map(input.candidates.map((c) => [c.key, c]));

  const owner = await takeLock(db, batchId);
  await db.update(schema.importBatches).set({ status: 'applying' }).where(eq(schema.importBatches.id, batchId));
  try {
    // Rows that already carry a key — used to recover ambiguous creates.
    const keyIndex = async () => {
      const rows = await readTable(writer, projectsTable);
      return new Map(rows.filter((r) => keyField && r[keyField]).map((r) => [String(r[keyField!]), r.id]));
    };
    let known = await keyIndex();

    for (const item of plan.items) {
      const decision = input.decisions[item.key] ?? (item.action === 'review' ? 'hold' : 'apply');
      const c = byKey.get(item.key);
      if (!c || decision !== 'apply' || item.action === 'unchanged') {
        report.skipped += 1;
        continue;
      }
      await refreshLock(db, owner);
      try {
        const rowId = await applyProject(item, c);
        await applyCredits(c, rowId);
      } catch (error) {
        report.failed.push({ key: item.key, error: error instanceof Error ? error.message.slice(0, 200) : 'failed' });
      }
    }

    async function applyProject(item: PlannedItem, c: Candidate): Promise<number> {
      const done = await ledgerFor(db, batchId, c.key, 'project', projectsTable);
      if (done?.status === 'applied' && done.rowId) return done.rowId;

      // RESUME. A create that was sent but never recorded (the process died,
      // or the call was ambiguous) left a `pending` ledger row. If a row with
      // this key now exists, it is that create: adopt it, do not make another.
      if (done?.status === 'pending' && done.before === null && !item.targetRowId) {
        const landed = known.get(c.key);
        if (landed) {
          const row = await writer.getRow(projectsTable, landed);
          const fields = (done.after ?? {}) as Record<string, unknown>;
          await upsertLedger(db, {
            batchId, candidateKey: c.key, action: 'project', tableId: projectsTable, rowId: landed,
            before: null, after: fields, afterHash: writtenHash(fields, row), status: 'applied', appliedAt: new Date(),
          });
          await rememberCrosswalk(db, c, projectsTable, landed, batchId);
          report.adoptedAfterAmbiguousFailure += 1;
          report.created += 1;
          return landed;
        }
      }

      // The plan said "create", yet a row with this key exists and it is not
      // ours from this batch: somebody (or another run) made it after the plan
      // was read. Writing the planned fields over it could erase their work.
      if (!item.targetRowId && known.get(c.key)) {
        throw new Error(`a row with key ${c.key} (row ${known.get(c.key)}) appeared after planning — re-run the plan`);
      }

      const existingRowId = item.targetRowId ?? null;
      if (existingRowId) {
        // UPDATE: only the fields the plan says differ; never editorial status.
        const only = new Set(item.diff.map((d) => d.field));
        if (only.size === 0) return existingRowId;
        const { fields } = projectFields(c, config, input.options, only, null, plan.label);
        const current = await writer.getRow(projectsTable, existingRowId);
        // Stored in WRITE form (select ids, link ids) so a rollback can send it back.
        const before = Object.fromEntries(Object.keys(fields).map((k) => [k, writable(current[k])]));
        await upsertLedger(db, { batchId, candidateKey: c.key, action: 'project', tableId: projectsTable, rowId: existingRowId, before, after: fields, status: 'pending' });
        const written = await writer.updateRow(projectsTable, existingRowId, fields);
        await upsertLedger(db, {
          batchId, candidateKey: c.key, action: 'project', tableId: projectsTable, rowId: existingRowId,
          before, after: fields, afterHash: writtenHash(fields, written), status: 'applied', appliedAt: new Date(),
        });
        await rememberCrosswalk(db, c, projectsTable, existingRowId, batchId);
        report.updated += 1;
        return existingRowId;
      }

      // CREATE: draft unless publishing was requested and the contract is met.
      // An editorial hold is written as a draft so it can be resolved in
      // Baserow, and is never published by --publish.
      const publishable = input.publish && missingForArchive(c).length === 0 && c.editorial?.disposition !== 'hold';
      if (publishable) report.publishedRequested += 1;
      const { fields } = projectFields(c, config, input.options, null, publishable ? 'published' : 'draft', plan.label);
      await upsertLedger(db, { batchId, candidateKey: c.key, action: 'project', tableId: projectsTable, before: null, after: fields, status: 'pending' });
      let row: Row;
      try {
        row = await writer.createRow(projectsTable, fields);
      } catch (error) {
        if (!ambiguous(error)) throw error;
        // The create may have landed. Look before trying again.
        known = await keyIndex();
        const landed = known.get(c.key);
        if (!landed) throw error;
        row = await writer.getRow(projectsTable, landed);
        report.adoptedAfterAmbiguousFailure += 1;
      }
      await upsertLedger(db, {
        batchId, candidateKey: c.key, action: 'project', tableId: projectsTable, rowId: row.id,
        before: null, after: fields, afterHash: writtenHash(fields, row), status: 'applied', appliedAt: new Date(),
      });
      known.set(c.key, row.id);
      await rememberCrosswalk(db, c, projectsTable, row.id, batchId);
      report.created += 1;
      return row.id;
    }

    async function applyCredits(c: Candidate, projectRowId: number) {
      const linkField = fid(config, 'credits', 'project');
      const nameField = fid(config, 'credits', 'displayName');
      if (!linkField || !nameField || c.credits.length === 0) return;
      // Credits already on the row (from any batch, or typed by an organiser).
      const existing = (await readTable(writer, creditsTable)).filter((r) => {
        const ids = comparable(r[linkField]);
        return Array.isArray(ids) && ids.includes(projectRowId);
      });
      const names = new Set(existing.map((r) => String(r[nameField] ?? '').toLowerCase()));
      for (const [i, credit] of c.credits.entries()) {
        if (names.has(credit.displayName.toLowerCase())) continue;
        const action = `credit:${contentHash(credit.displayName.toLowerCase()).slice(0, 12)}`;
        const done = await ledgerFor(db, batchId, c.key, action, creditsTable);
        if (done?.status === 'applied') continue;
        const fields: Record<string, unknown> = { [linkField]: [projectRowId], [nameField]: credit.displayName };
        const role = fid(config, 'credits', 'role');
        const url = fid(config, 'credits', 'publicUrl');
        const order = fid(config, 'credits', 'displayOrder');
        if (role && credit.role) fields[role] = credit.role;
        if (url && credit.publicUrl) fields[url] = credit.publicUrl;
        if (order) fields[order] = i;
        await upsertLedger(db, { batchId, candidateKey: c.key, action, tableId: creditsTable, before: null, after: fields, status: 'pending' });
        let row: Row;
        try {
          row = await writer.createRow(creditsTable, fields);
        } catch (error) {
          if (!ambiguous(error)) throw error;
          // The credit may have landed: look for it on this project by name.
          const again = (await readTable(writer, creditsTable)).find((r) => {
            const ids = comparable(r[linkField]);
            return Array.isArray(ids) && ids.includes(projectRowId) && String(r[nameField] ?? '').toLowerCase() === credit.displayName.toLowerCase();
          });
          if (!again) throw error;
          row = again;
          report.adoptedAfterAmbiguousFailure += 1;
        }
        await upsertLedger(db, {
          batchId, candidateKey: c.key, action, tableId: creditsTable, rowId: row.id, before: null, after: fields,
          afterHash: writtenHash(fields, row), status: 'applied', appliedAt: new Date(),
        });
        names.add(credit.displayName.toLowerCase());
        report.credits += 1;
      }
    }

    await db
      .update(schema.importBatches)
      .set({ status: report.failed.length ? 'failed' : 'applied', appliedAt: new Date(), report: report as unknown as Record<string, unknown> })
      .where(eq(schema.importBatches.id, batchId));
    return report;
  } finally {
    await releaseLock(db, owner);
  }
}

// ── rollback ─────────────────────────────────────────────────────────────

export interface RollbackReport {
  reverted: number;
  kept: { key: string; reason: string }[];
}

export async function rollbackBatch(input: {
  db: AnyDatabase;
  writer: Writer;
  config: BaserowConfig;
  batchId: string;
}): Promise<RollbackReport> {
  const { db, writer, config, batchId } = input;
  const report: RollbackReport = { reverted: 0, kept: [] };
  const owner = await takeLock(db, batchId);
  try {
    const entries = (
      await db
        .select()
        .from(schema.importLedger)
        .where(and(eq(schema.importLedger.batchId, batchId), eq(schema.importLedger.status, 'applied')))
    ).reverse(); // credits (written after their project) are undone first

    for (const entry of entries) {
      if (!entry.rowId) continue;
      await refreshLock(db, owner);
      const keep = async (reason: string) => {
        report.kept.push({ key: entry.candidateKey, reason });
        await db.update(schema.importLedger).set({ status: 'skipped', error: reason }).where(eq(schema.importLedger.id, entry.id));
      };

      let current: Row | null = null;
      try {
        current = await writer.getRow(entry.tableId, entry.rowId);
      } catch (error) {
        if ((error as { kind?: string }).kind !== 'not-found') throw error;
      }
      if (!current) {
        await db.update(schema.importLedger).set({ status: 'rolled_back', error: 'already gone' }).where(eq(schema.importLedger.id, entry.id));
        continue;
      }
      const after = (entry.after ?? {}) as Record<string, unknown>;
      if (writtenHash(after, current) !== entry.afterHash) {
        await keep('edited in Baserow since the import — left as it is');
        continue;
      }
      if (entry.tableId === config.tables.projects.tableId) {
        const [mapping] = await db
          .select({ entityId: schema.integrationMappings.entityId, status: schema.integrationMappings.status })
          .from(schema.integrationMappings)
          .where(and(eq(schema.integrationMappings.tableId, entry.tableId), eq(schema.integrationMappings.rowId, entry.rowId)));
        if (mapping?.status === 'released') {
          await keep('claimed by a member — the website owns it now');
          continue;
        }
      }
      if (entry.before === null) await writer.deleteRow(entry.tableId, entry.rowId);
      else await writer.updateRow(entry.tableId, entry.rowId, entry.before as Record<string, unknown>);
      await db.update(schema.importLedger).set({ status: 'rolled_back' }).where(eq(schema.importLedger.id, entry.id));
      report.reverted += 1;
    }
    await db
      .update(schema.importBatches)
      .set({ status: 'rolled_back', rolledBackAt: new Date() })
      .where(eq(schema.importBatches.id, batchId));
    return report;
  } finally {
    await releaseLock(db, owner);
  }
}
