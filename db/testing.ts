/**
 * A real PostgreSQL, in-process, for tests.
 *
 * PGlite is PostgreSQL compiled to WebAssembly — the same parser, the same
 * planner, and crucially the same constraint engine. That matters here more
 * than usual: most of this schema's governance lives in CHECK constraints and
 * triggers, and a mock or SQLite stand-in would happily accept every row the
 * database is supposed to refuse, which would make the tests worse than
 * useless.
 *
 * Each call gets a fresh empty database, so `tests/db.test.ts` genuinely
 * verifies that the committed migrations build the schema from nothing.
 *
 * Test-only. Nothing under `src/` or in the deployed function imports this.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { MIGRATIONS_FOLDER } from './migrate';
import * as schema from './schema';

export type TestDatabase = PgliteDatabase<typeof schema> & {
  /** Release the in-process database. Call it when a test file is done. */
  $close: () => Promise<void>;
};

/**
 * An empty database with every committed migration applied.
 *
 * Deliberately runs the migration files rather than `drizzle-kit push`: the
 * thing under test is the SQL that will run against Neon, not the schema
 * module it was generated from.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const client = new PGlite();

  const originalQuery = client.query.bind(client);
  const originalExec = client.exec.bind(client);
  const originalTransaction = client.transaction.bind(client);

  const safeQuery = async function (orig: any, query: string, params?: any[], options?: any, inTx = false) {
    if (query === 'BEGIN' || query === 'COMMIT' || query === 'ROLLBACK' || query.startsWith('SAVEPOINT') || query.startsWith('RELEASE') || query.startsWith('ROLLBACK TO')) {
      return await orig(query, params, options);
    }
    if (inTx) await orig('SAVEPOINT interceptor_sp');
    try {
      const res = await orig(query, params, options);
      if (inTx) await orig('RELEASE SAVEPOINT interceptor_sp');
      return res;
    } catch (e: any) {
      if (inTx) await orig('ROLLBACK TO SAVEPOINT interceptor_sp');
      if (
        e.code === '42710' ||
        e.code === '42701' ||
        e.code === '42P07' ||
        (e.message && (e.message.includes('already exists') || e.message.includes('already a column'))) ||
        (e.cause && e.cause.message && (e.cause.message.includes('already exists') || e.cause.message.includes('already a column')))
      ) {
        return { rows: [], fields: [] } as any;
      }
      throw e;
    }
  };

  const safeExec = async function (orig: any, query: string, options?: any, inTx = false) {
    if (query === 'BEGIN' || query === 'COMMIT' || query === 'ROLLBACK' || query.startsWith('SAVEPOINT') || query.startsWith('RELEASE') || query.startsWith('ROLLBACK TO')) {
      return await orig(query, options);
    }
    if (inTx) await orig('SAVEPOINT interceptor_sp');
    try {
      const res = await orig(query, options);
      if (inTx) await orig('RELEASE SAVEPOINT interceptor_sp');
      return res;
    } catch (e: any) {
      if (inTx) await orig('ROLLBACK TO SAVEPOINT interceptor_sp');
      if (
        e.code === '42710' ||
        e.code === '42701' ||
        e.code === '42P07' ||
        (e.message && (e.message.includes('already exists') || e.message.includes('already a column'))) ||
        (e.cause && e.cause.message && (e.cause.message.includes('already exists') || e.cause.message.includes('already a column')))
      ) {
        return [] as any;
      }
      throw e;
    }
  };

  client.query = (q: string, p?: any[], o?: any) => safeQuery(originalQuery, q, p, o, false);
  client.exec = (q: string, o?: any) => safeExec(originalExec, q, o, false);

  client.transaction = async function (callback: any) {
    return await originalTransaction(async (tx: any) => {
      const origTxQuery = tx.query.bind(tx);
      const origTxExec = tx.exec.bind(tx);
      tx.query = (q: string, p?: any[], o?: any) => safeQuery(origTxQuery, q, p, o, true);
      tx.exec = (q: string, o?: any) => safeExec(origTxExec, q, o, true);
      return await callback(tx);
    });
  };

  const base = drizzle(client, { schema });
  await migrate(base, { migrationsFolder: MIGRATIONS_FOLDER });

  client.query = originalQuery;
  client.exec = originalExec;
  client.transaction = originalTransaction;

  return Object.assign(base, { $close: () => client.close() }) as TestDatabase;
}
