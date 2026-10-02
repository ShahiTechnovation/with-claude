/**
 * What already exists — in Baserow and in Neon — for the planner to compare
 * candidates against. Read-only.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../../../db/schema';
import type { BaserowConfig } from '../../../src/server/integrations/baserow/config';
import { DIFF_FIELDS, type ExistingBaserowProject, type ExistingNeonProject, type DiffField, type LastWritten } from './plan';
import type { FieldOptions, Writer } from './apply';
import { comparable } from './apply';

type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

const text = (v: unknown): string => {
  if (Array.isArray(v)) return v.map((o) => (o && typeof o === 'object' && 'value' in o ? String((o as { value: unknown }).value) : String(o))).join(', ');
  if (v && typeof v === 'object' && 'value' in (v as object)) return String((v as { value: unknown }).value);
  return v === null || v === undefined ? '' : String(v);
};

export async function loadBaserowProjects(
  reader: Pick<Writer, 'listAllRows'>,
  config: BaserowConfig,
): Promise<ExistingBaserowProject[]> {
  const f = config.tables.projects.fields;
  const c = config.tables.credits.fields;
  const [projects, credits] = await Promise.all([
    reader.listAllRows(config.tables.projects.tableId, { pageSize: 200 }),
    reader.listAllRows(config.tables.credits.tableId, { pageSize: 200 }),
  ]);
  if (!projects.complete || !credits.complete) {
    throw new Error('Could not read every Baserow row; refusing to plan against a partial picture.');
  }
  const creditNames = new Map<number, string[]>();
  for (const row of credits.rows) {
    const ids = comparable(row[`field_${c.project}`]);
    for (const id of Array.isArray(ids) ? (ids as number[]) : []) {
      creditNames.set(id, [...(creditNames.get(id) ?? []), text(row[`field_${c.displayName}`])]);
    }
  }
  const pick = (row: Record<string, unknown>, key: DiffField) => (f[key] ? text(row[`field_${f[key]}`]) : '');
  return projects.rows.map((row) => ({
    rowId: row.id,
    key: f.key ? text(row[`field_${f.key}`]) || null : null,
    values: Object.fromEntries(
      (DIFF_FIELDS as readonly DiffField[]).map((k) => [
        k,
        k === 'category' || k === 'buildStatus' ? pick(row, k).toLowerCase().replace(/\s+/g, '-') : pick(row, k),
      ]),
    ),
    creditNames: creditNames.get(row.id) ?? [],
  }));
}

export async function loadNeonProjects(db: AnyDatabase): Promise<ExistingNeonProject[]> {
  const rows = await db
    .select({
      slug: schema.projects.slug,
      title: schema.projects.title,
      url: schema.projects.url,
      repoUrl: schema.projects.repoUrl,
      videoUrl: schema.projects.videoUrl,
      contentAuthority: schema.projects.contentAuthority,
      mappedTable: schema.integrationMappings.tableId,
      mappedRow: schema.integrationMappings.rowId,
    })
    .from(schema.projects)
    .leftJoin(
      schema.integrationMappings,
      and(eq(schema.integrationMappings.entityId, schema.projects.id), eq(schema.integrationMappings.entityType, 'project')),
    );
  // Which candidate each (table, row) was written for, by ANY batch — the
  // file-backed rehearsal and the real Baserow alike. This is how a project
  // that is an earlier import of the same submission is recognised as a match.
  const ledger = await db
    .select({ key: schema.importLedger.candidateKey, tableId: schema.importLedger.tableId, rowId: schema.importLedger.rowId })
    .from(schema.importLedger)
    .where(and(eq(schema.importLedger.action, 'project'), eq(schema.importLedger.status, 'applied')));
  const keyOf = new Map(ledger.filter((l) => l.rowId).map((l) => [`${l.tableId}:${l.rowId}`, l.key]));
  return rows.map((r) => ({
    slug: r.slug,
    title: r.title,
    artifacts: [r.repoUrl, r.url, r.videoUrl],
    baserowRowId: r.mappedRow ?? null,
    baserowTableId: r.mappedTable ?? null,
    candidateKey: r.mappedRow ? (keyOf.get(`${r.mappedTable}:${r.mappedRow}`) ?? null) : null,
    contentAuthority: r.contentAuthority,
  }));
}

/** Candidate key → the slug its earlier projection has in this database. */
export async function loadProjectedSlugs(db: AnyDatabase): Promise<Map<string, string>> {
  const projects = await loadNeonProjects(db);
  return new Map(projects.filter((p) => p.candidateKey).map((p) => [p.candidateKey!, p.slug]));
}

/**
 * What this importer last wrote to each row of the configured Projects
 * table, folded over every applied ledger entry in order, in the planner's
 * vocabulary. The three-way comparison in `buildPlan` uses it to tell "still
 * the imported value" from "an organiser changed it".
 */
export async function loadLastWritten(db: AnyDatabase, config: BaserowConfig, options: FieldOptions): Promise<LastWritten> {
  const tableId = config.tables.projects.tableId;
  const f = config.tables.projects.fields;
  const entries = await db
    .select({ rowId: schema.importLedger.rowId, after: schema.importLedger.after })
    .from(schema.importLedger)
    .where(and(eq(schema.importLedger.tableId, tableId), eq(schema.importLedger.action, 'project'), eq(schema.importLedger.status, 'applied')))
    .orderBy(asc(schema.importLedger.appliedAt));
  const invert = (m?: Map<string, number>) => new Map([...(m ?? new Map<string, number>()).entries()].map(([v, id]) => [id, v]));
  const selects: Partial<Record<DiffField, Map<number, string>>> = {
    category: invert(options.category),
    buildStatus: invert(options.buildStatus),
  };
  const out: LastWritten = new Map();
  for (const entry of entries) {
    if (!entry.rowId) continue;
    const after = (entry.after ?? {}) as Record<string, unknown>;
    const values = out.get(entry.rowId) ?? {};
    for (const key of DIFF_FIELDS as readonly DiffField[]) {
      const id = f[key];
      if (id === undefined || !(`field_${id}` in after)) continue;
      const v = after[`field_${id}`];
      const select = selects[key];
      values[key] = select && typeof v === 'number' ? (select.get(v) ?? '') : text(v);
    }
    out.set(entry.rowId, values);
  }
  return out;
}

export async function loadCrosswalk(db: AnyDatabase): Promise<Map<string, number | null>> {
  const rows = await db.select().from(schema.importCrosswalk);
  return new Map(rows.map((r) => [r.candidateKey, r.baserowRowId]));
}

/** Select option ids from the live field list, for writing. */
export function fieldOptionsFrom(
  fields: { id: number; type: string; select_options?: { id: number; value: string }[] }[],
  config: BaserowConfig,
): FieldOptions {
  const f = config.tables.projects.fields;
  const byId = new Map(fields.map((x) => [x.id, x]));
  const options = (id: number | undefined) =>
    new Map((id ? byId.get(id)?.select_options ?? [] : []).map((o) => [o.value.trim().toLowerCase().replace(/\s+/g, '-'), o.id]));
  const tagOptions = new Map((f.tags ? byId.get(f.tags)?.select_options ?? [] : []).map((o) => [o.value.trim().toLowerCase(), o.id]));
  return {
    category: options(f.category),
    editorialStatus: options(f.editorialStatus),
    buildStatus: options(f.buildStatus),
    tags: tagOptions,
    tagsAreText: f.tags ? byId.get(f.tags)?.type === 'text' : false,
  };
}
