/**
 * DURABLE SYNC: the job queue, the bounded worker, and reconciliation.
 *
 * ── WHY A QUEUE IN NEON ──────────────────────────────────────────────────
 *
 * A Vercel function is frozen or killed once its response is sent, and is
 * capped at 15 s here. So a webhook is never "processed in the background":
 * its row ids are written to `integration_jobs` BEFORE the response, and the
 * same request then works through as many jobs as fit its time budget. What
 * does not fit stays pending for the next webhook, the reconciliation cron,
 * or a moderator's "Process now" in the admin. No new queue vendor.
 *
 * ── WHY RE-READ THE ROW ──────────────────────────────────────────────────
 *
 * A webhook is a NOTIFICATION, not the truth. Two edits can arrive in either
 * order, or twice. Each job fetches the row as it is NOW and applies that,
 * under a per-row advisory lock with a content-hash short-circuit, so any
 * sequence of duplicate or out-of-order notifications converges on the
 * current upstream content.
 *
 * ── WHY RECONCILIATION, AND ITS ONE RULE ─────────────────────────────────
 *
 * Baserow drops webhooks once its pending-call limit is reached, and retries
 * are finite. Reconciliation pages through EVERY row of each table and diffs
 * against the mappings. A row missing upstream is inferred deleted ONLY from
 * a scan that completed — every page fetched, row count equal to Baserow's
 * reported count. A timeout, a permission error or a partial page never
 * archives anything.
 */
import { and, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../../../../db/schema';
import { BaserowError } from './client';
import { configuredTables, tableIdOf, tableKeyFor, type BaserowConfig } from './config';
import { contentHash, type RawRow } from './dto';
import { applyRow, tombstoneRow, type ApplyOutcome } from './projection';
import { TABLE_ORDER, type TableKey } from './spec';

type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;
type Job = typeof schema.integrationJobs.$inferSelect;

/** The slice of the client this module needs — injectable for tests. */
export interface RowSource {
  getRow(tableId: number, rowId: number): Promise<{ id: number } & Record<string, unknown>>;
  listAllRows(
    tableId: number,
    options?: { pageSize?: number; maxPages?: number },
  ): Promise<{ rows: ({ id: number } & Record<string, unknown>)[]; complete: boolean; pages: number }>;
}

export const LEASE_MS = 60_000;

// ── the queue ────────────────────────────────────────────────────────────

export interface NewJob {
  kind: 'row.sync' | 'row.delete';
  tableId: number;
  rowId: number;
  sourceEventId?: string | null;
}

/**
 * Persist jobs. Idempotent: a pending job for the same (kind, table, row)
 * absorbs the duplicate. A deletion supersedes a pending sync for the row,
 * and vice versa the latest notification decides — the worker re-reads the
 * row either way, so this is an optimisation, not a correctness rule.
 */
export async function enqueue(db: AnyDatabase, config: BaserowConfig, jobs: NewJob[]): Promise<number> {
  if (jobs.length === 0) return 0;
  const rows = jobs.map((j) => {
    const table = tableKeyFor(config, j.tableId);
    return {
      provider: 'baserow' as const,
      kind: j.kind,
      tableId: j.tableId,
      rowId: j.rowId,
      dedupeKey: `${j.kind}:${j.tableId}:${j.rowId}`,
      // Parents before children; deletions after everything else.
      priority: (table ? TABLE_ORDER.indexOf(table) : 9) + (j.kind === 'row.delete' ? 10 : 0),
      sourceEventId: j.sourceEventId ?? null,
    };
  });
  const inserted = await db
    .insert(schema.integrationJobs)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: schema.integrationJobs.id });
  return inserted.length;
}

/**
 * Lease up to `limit` ready jobs. `FOR UPDATE SKIP LOCKED` lets two workers
 * (a webhook and the cron) run at once without taking the same job; a job
 * whose lease expired (its worker was killed) is picked up again.
 */
export async function claim(db: AnyDatabase, limit: number, now = new Date()): Promise<Job[]> {
  const leaseUntil = new Date(now.getTime() + LEASE_MS);
  const result = await db.execute(sql`
    update integration_jobs
       set status = 'running', lease_until = ${leaseUntil}, attempts = attempts + 1, updated_at = ${now}
     where id in (
       select id from integration_jobs
        where (status = 'pending' and run_after <= ${now})
           or (status = 'running' and lease_until < ${now})
        order by priority, run_after
        limit ${limit}
        for update skip locked)
    returning id`);
  const ids = ((result as unknown as { rows?: { id: string }[] }).rows ?? (result as unknown as { id: string }[])).map(
    (r) => r.id,
  );
  if (ids.length === 0) return [];
  return db.select().from(schema.integrationJobs).where(inArray(schema.integrationJobs.id, ids));
}

/** Bounded exponential backoff with full jitter: up to 30 s, 2 min, 8 min… */
export function retryDelayMs(attempts: number, random: () => number = Math.random): number {
  const ceiling = Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
  return Math.round(ceiling * (0.5 + random() / 2));
}

async function finish(db: AnyDatabase, job: Job, now: Date) {
  await db
    .update(schema.integrationJobs)
    .set({ status: 'done', leaseUntil: null, lastError: null, finishedAt: now, updatedAt: now })
    .where(eq(schema.integrationJobs.id, job.id));
}

async function fail(db: AnyDatabase, job: Job, error: string, retryable: boolean, now: Date) {
  const exhausted = job.attempts >= job.maxAttempts;
  await db
    .update(schema.integrationJobs)
    .set(
      retryable && !exhausted
        ? { status: 'pending', leaseUntil: null, lastError: error, runAfter: new Date(now.getTime() + retryDelayMs(job.attempts)), updatedAt: now }
        : { status: retryable ? 'dead' : 'failed', leaseUntil: null, lastError: error, finishedAt: now, updatedAt: now },
    )
    .where(eq(schema.integrationJobs.id, job.id));
}

/** A safe one-line description of a failure. No payloads, no tokens. */
function describe(error: unknown): { message: string; retryable: boolean } {
  if (error instanceof BaserowError) {
    const config = error.kind === 'auth' || error.kind === 'bad-request' || error.kind === 'invalid-response';
    return {
      message: `${config ? 'configuration' : 'upstream'} (${error.kind}${error.status ? ` ${error.status}` : ''}): ${error.message}`.slice(0, 300),
      retryable: error.retryable,
    };
  }
  // Database errors and the like are usually transient here.
  return { message: (error instanceof Error ? error.message : 'unknown error').slice(0, 300), retryable: true };
}

// ── the worker ───────────────────────────────────────────────────────────

export interface RunCounts {
  claimed: number;
  applied: number;
  unchanged: number;
  held: number;
  quarantined: number;
  skipped: number;
  tombstoned: number;
  failed: number;
  enqueued: number;
}

const emptyCounts = (): RunCounts => ({
  claimed: 0,
  applied: 0,
  unchanged: 0,
  held: 0,
  quarantined: 0,
  skipped: 0,
  tombstoned: 0,
  failed: 0,
  enqueued: 0,
});

/** Which tables reference which: a child is re-tried when its parent lands. */
const DEPENDENTS: Record<TableKey, TableKey[]> = {
  cities: ['events', 'projects'],
  events: ['projects'],
  projects: ['credits'],
  credits: [],
};

async function quarantinedRows(db: AnyDatabase, config: BaserowConfig, tables: TableKey[]) {
  const ids = tables.flatMap((t) => tableIdOf(config, t) ?? []);
  if (ids.length === 0) return [];
  const rows = await db
    .select({ tableId: schema.integrationMappings.tableId, rowId: schema.integrationMappings.rowId })
    .from(schema.integrationMappings)
    .where(and(inArray(schema.integrationMappings.tableId, ids), eq(schema.integrationMappings.status, 'quarantined')))
    .limit(200);
  return rows.flatMap((r) => {
    const table = tableKeyFor(config, r.tableId);
    return table ? [{ table, rowId: r.rowId }] : [];
  });
}

async function processJob(db: AnyDatabase, source: RowSource, config: BaserowConfig, job: Job, counts: RunCounts) {
  const table = tableKeyFor(config, job.tableId);
  const now = new Date();
  if (!table || !job.rowId) {
    await fail(db, job, 'configuration: table is not one of the configured tables', false, now);
    counts.failed += 1;
    return;
  }
  try {
    let outcome: ApplyOutcome;
    let followUps: { table: TableKey; rowId: number }[] = [];
    let row: RawRow | null = null;
    try {
      row = (await source.getRow(job.tableId, job.rowId)) as RawRow;
    } catch (error) {
      if (!(error instanceof BaserowError && error.kind === 'not-found')) throw error;
    }
    if (row) {
      const result = await applyRow(db, config, table, row, now);
      outcome = result.outcome;
      followUps = result.followUps ?? [];
    } else {
      // Gone upstream — whichever kind of job noticed it.
      outcome = (await tombstoneRow(db, config, table, job.rowId, now)).outcome;
    }
    counts[outcome] += 1;
    if (outcome === 'applied' && DEPENDENTS[table].length) {
      // A parent that now exists may unblock children quarantined waiting for it.
      followUps.push(...(await quarantinedRows(db, config, DEPENDENTS[table])));
    }
    if (followUps.length) {
      counts.enqueued += await enqueue(
        db,
        config,
        followUps.flatMap((f) => {
          const tableId = tableIdOf(config, f.table);
          return tableId === null ? [] : [{ kind: 'row.sync' as const, tableId, rowId: f.rowId }];
        }),
      );
    }
    await finish(db, job, new Date());
  } catch (error) {
    const { message, retryable } = describe(error);
    await fail(db, job, message, retryable, new Date());
    counts.failed += 1;
  }
}

export interface RunOptions {
  /** Wall-clock budget for this invocation. Keep well under the function limit. */
  budgetMs: number;
  batchSize?: number;
  trigger: 'webhook' | 'reconcile' | 'manual';
}

/** Work the queue until it is empty or the budget is spent. */
export async function runQueue(
  db: AnyDatabase,
  source: RowSource,
  config: BaserowConfig,
  options: RunOptions,
  counts: RunCounts = emptyCounts(),
): Promise<RunCounts> {
  const deadline = Date.now() + options.budgetMs;
  while (Date.now() < deadline - 1_500) {
    const jobs = await claim(db, options.batchSize ?? 5);
    if (jobs.length === 0) break;
    counts.claimed += jobs.length;
    for (const job of jobs) {
      if (Date.now() >= deadline - 500) {
        // Out of time: hand the lease back rather than letting it expire.
        await db
          .update(schema.integrationJobs)
          .set({ status: 'pending', leaseUntil: null, attempts: sql`${schema.integrationJobs.attempts} - 1`, updatedAt: new Date() })
          .where(eq(schema.integrationJobs.id, job.id));
        continue;
      }
      await processJob(db, source, config, job, counts);
    }
  }
  return counts;
}

// ── reconciliation ───────────────────────────────────────────────────────

export interface ReconcileReport {
  tables: { table: TableKey; complete: boolean; rows: number; changed: number; missing: number }[];
  /** False if any table scan was incomplete — nothing was inferred deleted there. */
  complete: boolean;
}

/**
 * Diff each table against its mappings and queue what changed.
 *
 * Queues (does not apply) so the same bounded worker does all the writing.
 * Quarantined rows are always re-queued: their dependency may now exist.
 */
export async function reconcile(
  db: AnyDatabase,
  source: RowSource,
  config: BaserowConfig,
  tables: readonly TableKey[] = configuredTables(config),
): Promise<ReconcileReport> {
  const report: ReconcileReport = { tables: [], complete: true };
  for (const table of tables) {
    const tableId = tableIdOf(config, table);
    if (tableId === null) continue;
    let scan: Awaited<ReturnType<RowSource['listAllRows']>>;
    try {
      scan = await source.listAllRows(tableId, { pageSize: 200 });
    } catch {
      report.complete = false;
      report.tables.push({ table, complete: false, rows: 0, changed: 0, missing: 0 });
      continue;
    }
    const mappings = await db
      .select({
        rowId: schema.integrationMappings.rowId,
        sourceHash: schema.integrationMappings.sourceHash,
        status: schema.integrationMappings.status,
      })
      .from(schema.integrationMappings)
      .where(and(eq(schema.integrationMappings.provider, 'baserow'), eq(schema.integrationMappings.tableId, tableId)));
    const known = new Map(mappings.map((m) => [m.rowId, m]));

    const changed: NewJob[] = [];
    for (const row of scan.rows) {
      const mapping = known.get(row.id);
      if (!mapping || mapping.status === 'quarantined' || mapping.status === 'tombstoned' || mapping.sourceHash !== contentHash(row)) {
        changed.push({ kind: 'row.sync', tableId, rowId: row.id });
      }
    }

    const missing: NewJob[] = [];
    if (scan.complete) {
      const present = new Set(scan.rows.map((r) => r.id));
      for (const m of mappings) {
        if (!present.has(m.rowId) && m.status !== 'tombstoned' && m.status !== 'released') {
          missing.push({ kind: 'row.delete', tableId, rowId: m.rowId });
        }
      }
    } else {
      report.complete = false;
    }

    await enqueue(db, config, [...changed, ...missing]);
    report.tables.push({ table, complete: scan.complete, rows: scan.rows.length, changed: changed.length, missing: missing.length });
    await setState(db, `reconcile:${table}`, {
      at: new Date().toISOString(),
      complete: scan.complete,
      rows: scan.rows.length,
    });
  }
  return report;
}

// ── state and runs ───────────────────────────────────────────────────────

export async function setState(db: AnyDatabase, key: string, value: unknown) {
  await db
    .insert(schema.integrationState)
    .values({ key, value: value as Record<string, unknown> })
    .onConflictDoUpdate({ target: schema.integrationState.key, set: { value: value as Record<string, unknown>, updatedAt: new Date() } });
}

export async function startRun(db: AnyDatabase, trigger: RunOptions['trigger']): Promise<string> {
  const [run] = await db.insert(schema.integrationRuns).values({ provider: 'baserow', trigger }).returning({ id: schema.integrationRuns.id });
  return run.id;
}

export async function endRun(db: AnyDatabase, id: string, counts: RunCounts | Record<string, unknown>, error?: string) {
  const failed = Number((counts as RunCounts).failed ?? 0);
  const status = error ? 'failed' : failed > 0 ? 'partial' : 'ok';
  await db
    .update(schema.integrationRuns)
    .set({ status, counts: counts as Record<string, unknown>, error: error?.slice(0, 300) ?? null, finishedAt: new Date() })
    .where(eq(schema.integrationRuns.id, id));
  if (status === 'ok') await setState(db, 'last-success', { at: new Date().toISOString(), runId: id });
}

/** Re-queue failed and dead jobs — the admin's "Retry". */
export async function retryFailed(db: AnyDatabase): Promise<number> {
  const rows = await db
    .update(schema.integrationJobs)
    .set({ status: 'pending', attempts: 0, runAfter: new Date(), lastError: null, finishedAt: null, updatedAt: new Date() })
    .where(
      and(
        inArray(schema.integrationJobs.status, ['failed', 'dead']),
        // Never resurrect a job whose row already has a newer pending job.
        sql`not exists (select 1 from integration_jobs j2 where j2.dedupe_key = ${schema.integrationJobs.dedupeKey} and j2.status = 'pending')`,
      ),
    )
    .returning({ id: schema.integrationJobs.id });
  return rows.length;
}

/** Diagnostics for the admin. Counts and short reasons only. */
export async function syncStatus(db: AnyDatabase) {
  const [jobCounts, mappingCounts, recentRuns, state, problems, deadJobs] = await Promise.all([
    db
      .select({ status: schema.integrationJobs.status, n: sql<number>`count(*)`.mapWith(Number) })
      .from(schema.integrationJobs)
      .groupBy(schema.integrationJobs.status),
    db
      .select({
        entity: schema.integrationMappings.entityType,
        status: schema.integrationMappings.status,
        n: sql<number>`count(*)`.mapWith(Number),
      })
      .from(schema.integrationMappings)
      .groupBy(schema.integrationMappings.entityType, schema.integrationMappings.status),
    db.select().from(schema.integrationRuns).orderBy(sql`${schema.integrationRuns.startedAt} desc`).limit(10),
    db.select().from(schema.integrationState),
    db
      .select({
        tableId: schema.integrationMappings.tableId,
        rowId: schema.integrationMappings.rowId,
        entity: schema.integrationMappings.entityType,
        status: schema.integrationMappings.status,
        lastError: schema.integrationMappings.lastError,
        updatedAt: schema.integrationMappings.updatedAt,
      })
      .from(schema.integrationMappings)
      .where(
        or(
          eq(schema.integrationMappings.status, 'quarantined'),
          sql`${schema.integrationMappings.lastError} like 'publish held%'`,
        ),
      )
      .orderBy(sql`${schema.integrationMappings.updatedAt} desc`)
      .limit(100),
    db
      .select()
      .from(schema.integrationJobs)
      .where(inArray(schema.integrationJobs.status, ['failed', 'dead']))
      .orderBy(sql`${schema.integrationJobs.updatedAt} desc`)
      .limit(50),
  ]);
  return { jobCounts, mappingCounts, recentRuns, state, problems, deadJobs };
}

/** Old finished jobs are noise; keep two weeks. */
export async function pruneJobs(db: AnyDatabase, now = new Date()) {
  await db
    .delete(schema.integrationJobs)
    .where(and(eq(schema.integrationJobs.status, 'done'), lt(schema.integrationJobs.finishedAt, new Date(now.getTime() - 14 * 86_400_000))));
}
