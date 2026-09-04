import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit.
 *
 * `generate` writes SQL into `db/migrations`, which is committed. `migrate`
 * applies it. Nothing pushes a schema straight at a database — the production
 * database only ever changes through a migration that is in this repository,
 * so the schema can always be rebuilt from empty.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './db/schema.ts',
  out: './db/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
});
