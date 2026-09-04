/**
 * Apply migrations to the real database.
 *
 * `npm run db:migrate`. Reads `DATABASE_URL`, applies everything in
 * `db/migrations` that has not run yet, and stops. There is no `push`, no
 * schema diffing against production, and no path that changes the database
 * without a committed SQL file — which is what makes the schema reproducible
 * from empty.
 *
 * The driver is chosen from the connection string for the same reason
 * `db/pool.ts` chooses one: a developer with a PostgreSQL on `localhost`
 * should be able to build the schema without a Neon account. See the note
 * there.
 */
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-http';
import { migrate as migrateNeon } from 'drizzle-orm/neon-http/migrator';
import { drizzle as drizzleNode } from 'drizzle-orm/node-postgres';
import { migrate as migrateNode } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { fileURLToPath } from 'node:url';
import { databaseUrl } from './env';
import { isNeonUrl } from './pool';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('./migrations', import.meta.url));

export async function runMigrations(): Promise<void> {
  const url = databaseUrl();

  if (isNeonUrl(url)) {
    await migrateNeon(drizzleNeon(neon(url)), { migrationsFolder: MIGRATIONS_FOLDER });
    return;
  }

  // A local or self-hosted PostgreSQL. The pool is closed explicitly so the
  // command exits rather than hanging on an open socket.
  const pool = new Pool({ connectionString: url });
  try {
    await migrateNode(drizzleNode(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}

// Only when invoked directly, so importing this module for its path is free.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runMigrations().then(
    () => {
      console.log('Migrations applied.');
      process.exit(0);
    },
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}
