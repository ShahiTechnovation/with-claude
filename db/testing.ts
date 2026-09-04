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
  const base = drizzle(client, { schema });
  await migrate(base, { migrationsFolder: MIGRATIONS_FOLDER });
  return Object.assign(base, { $close: () => client.close() }) as TestDatabase;
}
