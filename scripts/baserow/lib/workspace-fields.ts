/**
 * The field set THIS workspace needs, and the name → id mapping that turns
 * a live Baserow schema into BASEROW_CONFIG. Pure: no I/O. Used by
 * `scripts/baserow/discover-config.ts`.
 */
import { ConfigSchema } from '../../../src/server/integrations/baserow/config';
import { SPEC, validateSchema, type FieldSpec, type LiveField, type TableKey } from '../../../src/server/integrations/baserow/spec';

export type Table = Exclude<TableKey, 'cities'>;

/**
 * What THIS workspace must have for the event-archive import and the sync to
 * be lossless. `required` here is stricter than the spec's: an adopted event
 * is overwritten from its Baserow row, so every column the projection writes
 * must exist, or adoption would blank it in Neon.
 */
export const WORKSPACE_FIELDS: Record<Table, { key: string; required: boolean; type: string; note?: string }[]> = {
  events: [
    { key: 'title', required: true, type: 'primary', note: 'the existing primary field ("Name")' },
    { key: 'key', required: true, type: 'text' },
    { key: 'neonId', required: true, type: 'text' },
    { key: 'slug', required: true, type: 'text' },
    { key: 'summary', required: true, type: 'long_text' },
    { key: 'description', required: true, type: 'long_text' },
    { key: 'city', required: true, type: 'text', note: 'Neon city slug, e.g. bhopal' },
    { key: 'venueName', required: true, type: 'text' },
    { key: 'venueAddress', required: true, type: 'long_text' },
    { key: 'venuePrivate', required: true, type: 'boolean' },
    { key: 'date', required: true, type: 'date' },
    { key: 'rescheduledFrom', required: true, type: 'date' },
    { key: 'shortTitle', required: true, type: 'text' },
    { key: 'startTime', required: true, type: 'text' },
    { key: 'endTime', required: true, type: 'text' },
    { key: 'timezone', required: true, type: 'text' },
    { key: 'format', required: true, type: 'single_select' },
    { key: 'registrationUrl', required: true, type: 'url' },
    { key: 'coverRef', required: true, type: 'text' },
    { key: 'lifecycle', required: true, type: 'single_select' },
    { key: 'editorialStatus', required: true, type: 'single_select' },
    { key: 'featured', required: true, type: 'boolean' },
    { key: 'lumaId', required: false, type: 'text' },
  ],
  projects: [
    { key: 'title', required: true, type: 'primary', note: 'the existing primary field ("Name")' },
    { key: 'key', required: true, type: 'text' },
    { key: 'slug', required: true, type: 'text' },
    { key: 'summary', required: true, type: 'long_text' },
    { key: 'category', required: true, type: 'single_select' },
    { key: 'event', required: true, type: 'link_row' },
    { key: 'teamName', required: true, type: 'text' },
    { key: 'problem', required: true, type: 'long_text' },
    { key: 'solution', required: true, type: 'long_text' },
    { key: 'builtWith', required: true, type: 'long_text' },
    { key: 'claudeUsage', required: true, type: 'long_text' },
    { key: 'buildStatus', required: true, type: 'single_select' },
    { key: 'liveUrl', required: true, type: 'url' },
    { key: 'repoUrl', required: true, type: 'url' },
    { key: 'videoUrl', required: true, type: 'url' },
    { key: 'altVideoUrl', required: true, type: 'url' },
    { key: 'downloadUrl', required: true, type: 'url' },
    { key: 'artifactUrl', required: true, type: 'url' },
    { key: 'editorialStatus', required: true, type: 'single_select' },
    { key: 'sourceBatch', required: true, type: 'text' },
    { key: 'sourceKey', required: true, type: 'text' },
    { key: 'sourceRows', required: true, type: 'text' },
    { key: 'reviewNotes', required: true, type: 'long_text' },
    { key: 'featured', required: false, type: 'boolean' },
    { key: 'featuredOrder', required: false, type: 'number' },
    { key: 'description', required: false, type: 'long_text' },
    { key: 'coverRef', required: false, type: 'text' },
    { key: 'logoRef', required: false, type: 'text' },
    { key: 'tags', required: false, type: 'text' },
    { key: 'neonId', required: false, type: 'text' },
  ],
  credits: [
    { key: 'displayName', required: true, type: 'primary', note: 'the existing primary field ("Name")' },
    { key: 'project', required: true, type: 'link_row' },
    { key: 'role', required: true, type: 'text' },
    { key: 'publicUrl', required: true, type: 'url' },
    { key: 'displayOrder', required: true, type: 'number' },
  ],
};

export const PRIMARY: Record<Table, string> = { events: 'title', projects: 'title', credits: 'displayName' };
export const LINKS: Record<string, Table> = { 'projects.event': 'events', 'credits.project': 'projects' };

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
/** "Short title (badges)" may be created as just "Short title". */
const bare = (s: string) => norm(s.replace(/\s*\([^)]*\)\s*$/, ''));
const named = (f: LiveField, label: string) => norm(f.name) === norm(label) || norm(f.name) === bare(label);

export function mapFields(live: Record<Table, LiveField[]>, ids: Record<Table, number>) {
  const problems: string[] = [];
  const notes: string[] = [];
  const config = { tables: {} as Record<Table, { tableId: number; fields: Record<string, number> }> };
  for (const table of ['events', 'projects', 'credits'] as Table[]) {
    const fields: Record<string, number> = {};
    const spec = SPEC[table] as Record<string, FieldSpec>;
    const list = live[table] ?? [];
    for (const want of WORKSPACE_FIELDS[table]) {
      const s = spec[want.key];
      const hit =
        want.key === PRIMARY[table]
          ? list.find((f) => (f as LiveField & { primary?: boolean }).primary)
          : list.find((f) => named(f, s.label));
      if (!hit) {
        (want.required ? problems : notes).push(`${table}: no field named "${s.label}"${want.required ? '' : ' (optional — skipped)'}`);
        continue;
      }
      // Rich text would store the teams' answers as escaped markdown.
      if ((hit as LiveField & { long_text_enable_rich_text?: boolean }).long_text_enable_rich_text) {
        problems.push(`${table}: "${hit.name}" has rich text formatting on — turn it off (plain long text)`);
      }
      fields[want.key] = hit.id;
    }
    config.tables[table] = { tableId: ids[table], fields };
    for (const p of validateSchema(table, list, fields, ids)) problems.push(`${table}.${p.field}: ${p.problem}`);
    for (const [path, target] of Object.entries(LINKS)) {
      const [t, k] = path.split('.') as [Table, string];
      if (t !== table || !fields[k]) continue;
      const f = list.find((x) => x.id === fields[k]);
      if (f?.link_row_table_id !== ids[target]) problems.push(`${table}.${k}: must link to the ${target} table (${ids[target]})`);
    }
  }
  return { config: ConfigSchema.parse(config), problems, notes };
}

