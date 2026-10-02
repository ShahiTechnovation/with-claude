/**
 * Reading a whole Baserow workspace safely, for the importer's dry run,
 * snapshot, read-back verification and manifest. Read-only, except
 * `writeManifest`, which writes a local file under `imports/`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../../../db/schema';
import { configuredTables, type BaserowConfig } from '../../../src/server/integrations/baserow/config';
import type { LiveField, TableKey } from '../../../src/server/integrations/baserow/spec';
import { isPrivateHost } from './links';
import { looksPrivate } from './normalise';
import type { Writer } from './apply';

type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;
type Row = { id: number } & Record<string, unknown>;

/** Every row of a table — or an error. A partial table is never returned as the whole. */
export async function readTable(reader: Pick<Writer, 'listAllRows'>, tableId: number): Promise<Row[]> {
  const scan = await reader.listAllRows(tableId, { pageSize: 200 });
  if (!scan.complete) throw new Error(`could not read every row of table ${tableId}; refusing to continue on a partial picture`);
  return scan.rows;
}

export interface Snapshot {
  takenAt: string;
  tables: Partial<Record<TableKey, { tableId: number; count: number; rows: Row[] }>>;
}

/** A local copy of every row the import could touch — taken before any write. */
export async function snapshot(reader: Pick<Writer, 'listAllRows'>, config: BaserowConfig): Promise<Snapshot> {
  const out: Snapshot = { takenAt: new Date().toISOString(), tables: {} };
  for (const table of configuredTables(config)) {
    const tableId = config.tables[table]!.tableId;
    const rows = await readTable(reader, tableId);
    out.tables[table] = { tableId, count: rows.length, rows };
  }
  return out;
}

/** field id → (normalised option value → option id), from the live schema. */
export function optionIds(fields: LiveField[]): Map<number, Map<string, number>> {
  const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, '-');
  return new Map(fields.map((f) => [f.id, new Map((f.select_options ?? []).map((o) => [norm(o.value), o.id]))]));
}

/** A row with no value in any field: Baserow's default blank row. */
export function isBlankRow(row: Row): boolean {
  return Object.entries(row).every(([k, v]) => {
    if (k === 'id' || k === 'order') return true;
    return v === null || v === '' || v === false || (Array.isArray(v) && v.length === 0);
  });
}

const CREDENTIAL_QUERY = /[?&](key|apikey|api[_-]?key|token|access[_-]?token|auth|secret|password|sig|signature|session|code|_vercel_share)=/i;
const TUNNEL = /(trycloudflare\.com|ngrok-free\.(dev|app)|ngrok\.(io|app)|loca\.lt|serveo\.net)/i;

/**
 * Privacy problems in a stored value — the categories only, never the value.
 * `forbidden` are exact private strings held in memory (emails, the withheld
 * credential URL, member names); a hit reports which category, not what.
 */
export function privacyProblems(value: string, forbidden: { label: string; values: Set<string> }[] = []): string[] {
  const problems: string[] = [];
  if (looksPrivate(value)) problems.push('looks like an email address or phone number');
  for (const m of value.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
    const url = m[0];
    if (CREDENTIAL_QUERY.test(url)) problems.push('URL carries a credential-like or access parameter');
    if (TUNNEL.test(url)) problems.push('URL is a temporary tunnel');
    try {
      const u = new URL(url);
      if (u.username || u.password) problems.push('URL carries credentials');
      if (isPrivateHost(u.hostname)) problems.push('URL points at a local or private host');
      if (/\/admin(\/|$)/i.test(u.pathname)) problems.push('URL is an admin route');
    } catch {
      /* not a URL after all */
    }
  }
  if (/^\s*(javascript|data|file|vbscript):/i.test(value)) problems.push('unsafe URL scheme');
  const lower = value.toLowerCase();
  for (const f of forbidden) {
    for (const v of f.values) {
      if (v && lower.includes(v)) {
        problems.push(f.label);
        break;
      }
    }
  }
  return [...new Set(problems)];
}

/**
 * The recoverable manifest of one batch: every write, with the Baserow row
 * it touched, what was there before (null = created by this batch) and the
 * hash of what was written. Rebuilt from the ledger, so it is current after
 * a resumed run too. This is the rollback manifest — nothing reads it
 * automatically, and nothing deletes rows because of it.
 */
export async function writeManifest(db: AnyDatabase, batchId: string, dir: string, extra: Record<string, unknown> = {}) {
  const entries = await db
    .select()
    .from(schema.importLedger)
    .where(eq(schema.importLedger.batchId, batchId))
    .orderBy(asc(schema.importLedger.createdAt));
  const manifest = {
    batchId,
    writtenAt: new Date().toISOString(),
    ...extra,
    counts: entries.reduce<Record<string, number>>((m, e) => {
      const k = `${e.before === null ? 'created' : 'updated'}:${e.status}`;
      return { ...m, [k]: (m[k] ?? 0) + 1 };
    }, {}),
    entries: entries.map((e) => ({
      candidateKey: e.candidateKey,
      action: e.action,
      tableId: e.tableId,
      rowId: e.rowId,
      kind: e.before === null ? 'created' : 'updated',
      status: e.status,
      before: e.before,
      afterHash: e.afterHash,
      appliedAt: e.appliedAt,
      error: e.error,
    })),
  };
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'apply-manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}
