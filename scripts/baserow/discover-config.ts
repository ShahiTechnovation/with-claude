#!/usr/bin/env tsx
/**
 * npm run baserow:discover -- [--tables projects=<id>,events=<id>,credits=<id>] [--out <file>]
 *                             [--fields-file <json>] [--expected <json>]
 *
 * Builds BASEROW_CONFIG for a workspace from its LIVE field lists, by field
 * NAME, once — after which everything addresses fields by id, so organisers
 * can rename columns freely. Read-only against Baserow.
 *
 *   --tables       the three table ids (Cities is optional and not used here:
 *                  each City field is then a text field with a Neon city slug)
 *   --out          where to write the one-line config (default
 *                  .dev-auth/baserow.config.json — git-ignored)
 *   --fields-file  read field lists from a JSON file instead of the API
 *                  ({ projects: [...], events: [...], credits: [...] })
 *   --expected     write the schema this script EXPECTS (existing fields plus
 *                  the ones to create, with placeholder ids) for a local
 *                  rehearsal fixture; nothing is read from the API
 *
 * Matching rules: the primary field (whatever it is called — "Name" in a new
 * table) is the title of an event or project and the display name of a
 * credit. Every other field is matched by its exact label from the spec,
 * case-insensitively. Fields not in the spec ("Notes", "Active") are left
 * alone. A missing REQUIRED field, a wrong type or a missing select option is
 * reported and the config is not written.
 */
import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createBaserowClient } from '../../src/server/integrations/baserow/client';
import { SPEC, type FieldSpec, type LiveField } from '../../src/server/integrations/baserow/spec';
import { LINKS, mapFields, PRIMARY, WORKSPACE_FIELDS, type Table } from './lib/workspace-fields';

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function tableIds(): Record<Table, number> {
  const raw = option('tables') ?? 'projects=1236064,events=1236080,credits=1236082';
  const map = Object.fromEntries(raw.split(',').map((p) => p.split('=').map((x) => x.trim())));
  const out = {} as Record<Table, number>;
  for (const t of ['projects', 'events', 'credits'] as Table[]) {
    const id = Number(map[t]);
    if (!Number.isInteger(id) || id <= 0) throw new Error(`--tables needs ${t}=<table id>`);
    out[t] = id;
  }
  return out;
}

/** The schema this script expects, for a local rehearsal fixture: existing fields plus placeholders. */
async function writeExpected(out: string, ids: Record<Table, number>) {
  const existing = JSON.parse(await readFile('imports/baserow-live/fields.json', 'utf8')) as Record<Table, LiveField[]>;
  let nextField = 990_000;
  let nextOption = 880_000;
  const result = {} as Record<Table, LiveField[]>;
  for (const table of ['events', 'projects', 'credits'] as Table[]) {
    const spec = SPEC[table] as Record<string, FieldSpec>;
    const list: LiveField[] = structuredClone(existing[table] ?? []);
    for (const want of WORKSPACE_FIELDS[table]) {
      if (want.key === PRIMARY[table]) continue;
      const s = spec[want.key];
      if (list.some((f) => f.name.trim().toLowerCase() === s.label.toLowerCase())) continue; // already created
      list.push({
        id: nextField++,
        name: s.label,
        type: want.type,
        ...(want.type === 'link_row' ? { link_row_table_id: ids[LINKS[`${table}.${want.key}`]!] } : {}),
        ...(s.options ? { select_options: s.options.map((value) => ({ id: nextOption++, value })) } : {}),
      });
    }
    result[table] = list;
  }
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(result, null, 2));
  console.log(`Wrote the expected schema to ${out} (placeholder ids — for a local rehearsal only).`);
}

const ids = tableIds();
const expected = option('expected');
if (expected) {
  await writeExpected(expected, ids);
  process.exit(0);
}

let live: Record<Table, LiveField[]>;
const file = option('fields-file');
if (file) {
  live = JSON.parse(await readFile(file, 'utf8')) as Record<Table, LiveField[]>;
} else {
  const token = process.env.BASEROW_READ_TOKEN?.trim() || process.env.BASEROW_IMPORT_TOKEN?.trim();
  if (!token) throw new Error('Set BASEROW_READ_TOKEN (or BASEROW_IMPORT_TOKEN).');
  const client = createBaserowClient({ baseUrl: process.env.BASEROW_API_URL?.trim() || undefined, token });
  live = {} as Record<Table, LiveField[]>;
  for (const t of ['events', 'projects', 'credits'] as Table[]) live[t] = (await client.listFields(ids[t])) as unknown as LiveField[];
  await mkdir('imports/baserow-live', { recursive: true });
  await writeFile('imports/baserow-live/fields.json', JSON.stringify(live, null, 2));
}

const { config, problems, notes } = mapFields(live, ids);
for (const n of notes) console.log(`  · ${n}`);
if (problems.length) {
  console.log(`\n${problems.length} problem(s) — fix these in Baserow, then run this again:`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  process.exit(1);
}
const out = option('out') ?? '.dev-auth/baserow.config.json';
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(config));
const count = Object.values(config.tables).reduce((n, t) => n + Object.keys(t.fields).length, 0);
console.log(`ok — ${count} fields mapped across ${Object.keys(config.tables).length} tables. Wrote ${out}.`);
console.log('Export it before importing:  export BASEROW_CONFIG="$(cat ' + out + ')"');
