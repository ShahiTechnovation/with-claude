#!/usr/bin/env tsx
/**
 * LOCAL ONLY — a file-backed stand-in that MIRRORS the real Baserow
 * workspace, for a dress rehearsal of the import before touching it:
 *
 *   npx tsx scripts/dev/make-mirror-fixture.ts <fields.json> <snapshot.json> <out under imports/>
 *
 *   fields.json    live field lists per table ({ events, projects, credits }),
 *                  from `baserow:discover` (real) or `--expected` (planned)
 *   snapshot.json  the existing rows, from an `archive-plan` snapshot or
 *                  imports/baserow-live/snapshot-before-*.json
 *
 * Table ids, field ids, select option ids, the primary field and the rows
 * already there (blank or not) are copied exactly, so the rehearsal sends
 * the same requests the real run will. BASEROW_CONFIG must be the config
 * derived from the same fields.json.
 */
import { readFile } from 'node:fs/promises';
import { baserowSettings } from '../../src/server/integrations/baserow/config';
import type { LiveField } from '../../src/server/integrations/baserow/spec';
import { FileBaserow } from '../import/lib/file-baserow';

const [fieldsPath, snapshotPath, out] = process.argv.slice(2);
if (!fieldsPath || !snapshotPath || !out) throw new Error('usage: make-mirror-fixture <fields.json> <snapshot.json> <imports/out.json>');
if (!out.replace(/\\/g, '/').startsWith('imports/')) throw new Error('the fixture must live under imports/ (git-ignored)');
const config = baserowSettings().config;
if (!config) throw new Error('BASEROW_CONFIG must be set (the config derived from the same fields.json)');

const fields = JSON.parse(await readFile(fieldsPath, 'utf8')) as Record<'events' | 'projects' | 'credits', LiveField[]>;
const snap = JSON.parse(await readFile(snapshotPath, 'utf8')) as {
  tables: Record<string, { tableId: number; rows: ({ id: number } & Record<string, unknown>)[] }>;
};
const tables: Record<number, { fields: LiveField[]; rows: ({ id: number } & Record<string, unknown>)[] }> = {};
for (const t of ['events', 'projects', 'credits'] as const) {
  const tableId = config.tables[t].tableId;
  const rows = Object.values(snap.tables).find((s) => s.tableId === tableId)?.rows ?? [];
  tables[tableId] = { fields: fields[t], rows };
}
FileBaserow.mirror(out, config, tables);
console.log(`Wrote ${out}: ${Object.entries(tables).map(([id, t]) => `table ${id} ${t.fields.length} fields / ${t.rows.length} rows`).join('; ')}`);
