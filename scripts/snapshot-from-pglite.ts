/**
 * A dataset snapshot taken from a real PostgreSQL, without a server.
 *
 * `db/snapshot.ts` is the production prebuild: it connects to Neon (or any
 * PostgreSQL over TCP) and writes `.astro/dataset.json`. This is the same
 * thing against PGlite — PostgreSQL compiled to WebAssembly, running in this
 * process — which makes a genuine `DATA_SOURCE=db` build possible on a machine
 * with no database credentials.
 *
 * What it does NOT do is fake anything. The migrations are the committed ones,
 * the importer is the real importer, the reader is the real reader, and the
 * SQL is executed by PostgreSQL's own planner against PostgreSQL's own
 * constraint engine. The only difference from production is the transport.
 *
 * Used for the build-output comparison in the Phase 3 report. Not part of the
 * deployed pipeline — `npm run prebuild` is.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createTestDatabase } from '../db/testing';
import { importRecords, repositoryRecords } from '../db/import';
import { loadRecordSet } from '../src/data/source-db';
import { SNAPSHOT_PATH, SNAPSHOT_VERSION, type Snapshot } from '../src/data/dataset';

const db = await createTestDatabase();

const summary = await importRecords(db as never, repositoryRecords);
console.log('[pglite] imported:', JSON.stringify(summary));

const records = await loadRecordSet(db as never);

const snapshot: Snapshot = {
  version: SNAPSHOT_VERSION,
  source: 'db',
  generatedAt: new Date().toISOString(),
  records,
};

mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot), 'utf8');

console.log(
  '[pglite] wrote',
  SNAPSHOT_PATH,
  Object.entries(records)
    .map(([key, value]) => `${(value as unknown[]).length} ${key}`)
    .join(', '),
);

await db.$close();
