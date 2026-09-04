/**
 * THE PREBUILD — read the database once, then get out of the way.
 *
 * `npm run prebuild`, which `npm run build` runs first.
 *
 *     DATA_SOURCE=ts   does nothing at all, and says so
 *     DATA_SOURCE=db   SELECTs the public record and writes .astro/dataset.json
 *
 * This is the only place in the entire public pipeline that opens a database
 * connection. By the time `astro build` starts there is no connection, no
 * driver in the render path, and no possibility of a page issuing a query —
 * which is what makes "the browser never talks to PostgreSQL" a structural
 * fact rather than a rule somebody has to remember.
 *
 * ── READ-ONLY BY PREFERENCE ──────────────────────────────────────────────
 *
 * `DATABASE_URL_READONLY` is used when it is set, and the ordinary
 * `DATABASE_URL` otherwise. The public build only ever needs SELECT, so the
 * credential it runs with should only be able to SELECT: a build cannot
 * corrupt the record it is reading if the role it connects as has no INSERT,
 * UPDATE, DELETE or DDL to give. Setting up that role is a database
 * administration step and is documented in `.env.example`; this file's job is
 * to prefer it when it exists and to say clearly when it does not.
 *
 * Neither variable is `PUBLIC_`-prefixed, and `assertNoPublicSecrets()` would
 * refuse to start if one ever were.
 *
 * ── `.env` ─────────────────────────────────────────────────────────────
 *
 * On Vercel the platform has already populated `process.env` before this
 * runs, so there is no `.env` file to find and this is a no-op — the same
 * reasoning `admin/astro.config.mjs` documents for the same import. Locally,
 * where `npm run build`/`npm run prebuild` are run by hand against a real
 * database, this is what lets `DATABASE_URL` live in a gitignored `.env`
 * rather than needing to be exported into the shell first. `db/migrate.ts`
 * and `db/import/run.ts` — the other two CLI entry points that read
 * `DATABASE_URL` outside of a request — both do the same.
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { drizzle as drizzleNode } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { assertNoPublicSecrets } from './env';
import { isNeonUrl } from './pool';
import * as schema from './schema';
import { loadRecordSet, type ReadDatabase } from '../src/data/source-db';
import { dataSourceName } from '../src/data/source';
import { SNAPSHOT_PATH, SNAPSHOT_VERSION, type Snapshot } from '../src/data/dataset';

/**
 * The connection string the public build reads with.
 *
 * Prefers a read-only role. Falls back to the write-capable one with a warning
 * loud enough to act on, because a build reading through an admin credential
 * works fine and is worth fixing.
 */
export function readUrl(env: NodeJS.ProcessEnv = process.env): string {
  assertNoPublicSecrets(env);

  const readonly = env.DATABASE_URL_READONLY;
  if (readonly) return readonly;

  const fallback = env.DATABASE_URL;
  if (!fallback) {
    throw new Error(
      'DATA_SOURCE=db needs a connection string. Set DATABASE_URL_READONLY (preferred — a ' +
        'role with SELECT and nothing else) or DATABASE_URL. Copy .env.example to .env, or ' +
        "set DATA_SOURCE=ts to build from the TypeScript record.",
    );
  }

  console.warn(
    '[prebuild] DATABASE_URL_READONLY is not set, so the build is reading through the ' +
      'write-capable credential. It will work. A build only needs SELECT, so a read-only ' +
      'role is the safer thing to give it — see .env.example.',
  );
  return fallback;
}

/** A connection for reading. Either driver; the reader does not care which. */
function connect(url: string): { db: ReadDatabase; close: () => Promise<void> } {
  if (isNeonUrl(url)) {
    // HTTP is right here: a finite set of SELECTs, once, from a process that
    // exits. No transaction is needed and no pool is worth holding open.
    return { db: drizzle(neon(url), { schema }) as ReadDatabase, close: async () => {} };
  }
  const pool = new Pool({ connectionString: url });
  return {
    db: drizzleNode(pool, { schema }) as ReadDatabase,
    close: () => pool.end(),
  };
}

export interface SnapshotResult {
  source: 'ts' | 'db';
  written: boolean;
  path?: string;
  counts?: Record<string, number>;
}

/**
 * Take the snapshot, if this build needs one.
 *
 * Returns rather than exits so the tests can call it. The CLI wrapper below is
 * what turns a failure into a non-zero exit code — and it must, because a
 * prebuild that fails quietly hands `astro build` a stale or absent snapshot.
 */
export async function takeSnapshot(): Promise<SnapshotResult> {
  const source = dataSourceName();

  if (source === 'ts') {
    console.log(
      '[prebuild] DATA_SOURCE=ts — building from the TypeScript record. No database read.',
    );
    return { source, written: false };
  }

  const { db, close } = connect(readUrl());
  try {
    const started = Date.now();
    const recordSet = await loadRecordSet(db);

    const snapshot: Snapshot = {
      version: SNAPSHOT_VERSION,
      source: 'db',
      generatedAt: new Date().toISOString(),
      records: recordSet,
    };

    mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
    writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot), 'utf8');

    const counts = Object.fromEntries(
      Object.entries(recordSet).map(([key, value]) => [key, (value as unknown[]).length]),
    );

    console.log(
      `[prebuild] DATA_SOURCE=db — read the public record in ${Date.now() - started}ms: ` +
        Object.entries(counts)
          .map(([key, n]) => `${n} ${key}`)
          .join(', ') +
        '.',
    );

    return { source, written: true, path: SNAPSHOT_PATH, counts };
  } finally {
    await close();
  }
}

/** `npm run prebuild`. */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (invokedDirectly) {
  takeSnapshot().catch((error) => {
    console.error('[prebuild] failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
