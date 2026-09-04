/**
 * The database connection. Server-side only.
 *
 * Neon over HTTP, which is the right shape for this workload: the only thing
 * that talks to the database at request time is `/api/submit`, one insert at a
 * time, on a serverless function that may be cold. An HTTP round trip beats
 * holding a pool open for traffic measured in submissions per week.
 *
 * The connection is created lazily so that importing this module — which
 * `astro check` and the test suite both do — never requires `DATABASE_URL` to
 * exist. Nothing connects until something asks for a query.
 */
import { neon } from '@neondatabase/serverless';
import { drizzle, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { databaseUrl } from './env';
import * as schema from './schema';

export type Database = NeonHttpDatabase<typeof schema>;

let cached: Database | undefined;

/** The shared connection. Created on first use, reused for the rest of the process. */
export function db(): Database {
  if (!cached) {
    cached = drizzle(neon(databaseUrl()), { schema });
  }
  return cached;
}

export { schema };
