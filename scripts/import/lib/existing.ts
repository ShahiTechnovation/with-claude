/**
 * What already exists — in Baserow and in Neon — for the planner to compare
 * candidates against. Read-only.
 */
import { eq } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../../../db/schema';
import type { BaserowConfig } from '../../../src/server/integrations/baserow/config';
import type { ExistingBaserowProject, ExistingNeonProject, DiffField } from './plan';
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
      (['title', 'summary', 'description', 'category', 'tags', 'liveUrl', 'repoUrl', 'videoUrl', 'claudeUsage', 'teamName'] as DiffField[]).map(
        (k) => [k, k === 'category' ? pick(row, k).toLowerCase() : pick(row, k)],
      ),
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
      mappedRow: schema.integrationMappings.rowId,
    })
    .from(schema.projects)
    .leftJoin(
      schema.integrationMappings,
      eq(schema.integrationMappings.entityId, schema.projects.id),
    );
  return rows.map((r) => ({
    slug: r.slug,
    title: r.title,
    artifacts: [r.repoUrl, r.url, r.videoUrl],
    baserowRowId: r.mappedRow ?? null,
    contentAuthority: r.contentAuthority,
  }));
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
    tags: tagOptions,
    tagsAreText: f.tags ? byId.get(f.tags)?.type === 'text' : false,
  };
}
