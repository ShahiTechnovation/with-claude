#!/usr/bin/env tsx
/**
 * npm run baserow:check-schema — does the live Baserow workspace match the
 * spec, through the configured field ids? Read-only. Uses BASEROW_READ_TOKEN
 * (or BASEROW_IMPORT_TOKEN), BASEROW_API_URL and BASEROW_CONFIG.
 *
 * Exit code 0 when every table matches; 1 with a list of problems otherwise.
 * Run it after creating the tables, after any column change in Baserow, and
 * before enabling the sync. The Cities table is optional: without it, each
 * City field must be a text field holding a Neon city slug.
 */
import 'dotenv/config';
import { createBaserowClient } from '../../src/server/integrations/baserow/client';
import { baserowSettings, configuredTables } from '../../src/server/integrations/baserow/config';
import { validateSchema, type LiveField, type TableKey } from '../../src/server/integrations/baserow/spec';

const settings = baserowSettings();
const token = settings.readToken ?? process.env.BASEROW_IMPORT_TOKEN?.trim();
if (!settings.config || !token) {
  console.error(settings.problem ?? 'Set BASEROW_CONFIG and BASEROW_READ_TOKEN first.');
  process.exit(1);
}
const config = settings.config;
const client = createBaserowClient({ baseUrl: settings.apiUrl, token });
const tables = configuredTables(config);
const tableIds = Object.fromEntries(tables.map((t) => [t, config.tables[t]!.tableId])) as Partial<Record<TableKey, number>>;
if (!config.tables.cities) console.log('cities: not configured — City fields must be text holding a Neon city slug');
let problems = 0;
for (const table of tables) {
  const live = (await client.listFields(tableIds[table]!)) as unknown as LiveField[];
  const found = validateSchema(table, live, config.tables[table]!.fields, tableIds);
  console.log(`${table} (table ${tableIds[table]}): ${found.length ? `${found.length} problem(s)` : 'ok'}`);
  for (const p of found) console.log(`  - ${p.field}: ${p.problem}`);
  problems += found.length;
}
process.exit(problems ? 1 : 0);
