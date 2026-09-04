/**
 * The transactional database connection. Server-side only.
 *
 * ── WHY THERE ARE TWO CLIENTS ────────────────────────────────────────────
 *
 * `db/client.ts` talks to Neon over HTTP, which is the right shape for
 * `/api/submit`: one insert, on a function that is usually cold, where a round
 * trip beats holding a pool open for traffic measured in submissions per week.
 * What HTTP cannot do is a transaction — the driver says so outright, and
 * `db.transaction()` throws.
 *
 * The admin needs transactions and cannot fake them. Every review action has
 * to write an audit entry and change a status together or do neither: an audit
 * log with a gap in it is not an audit log, and a status change nobody can
 * account for is exactly what the log exists to make impossible. So the admin
 * connects over a pooled protocol, where BEGIN/COMMIT/ROLLBACK are real.
 *
 * Kept in a separate module so importing it is a decision. The public site
 * imports `client.ts` and never reaches this file, which keeps both pooled
 * drivers out of a bundle that has no use for either.
 *
 * ── WHY THE DRIVER IS CHOSEN AT RUNTIME ──────────────────────────────────
 *
 * Neon's serverless driver reaches the database through Neon's own WebSocket
 * proxy, so it cannot talk to a PostgreSQL running on `localhost`. That would
 * make the admin — the one part of this project that genuinely needs a
 * database to do anything at all — impossible to run without a cloud account
 * and a network connection.
 *
 * So the connection string decides: a Neon host gets the serverless driver, and
 * anything else gets node-postgres over TCP. Both are first-party Drizzle
 * adapters presenting the same interface, and both support real transactions,
 * so nothing downstream knows or cares which one it got.
 */
import { Pool as NeonPool } from '@neondatabase/serverless';
import { drizzle as drizzleNeon, type NeonDatabase } from 'drizzle-orm/neon-serverless';
import { drizzle as drizzleNode, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool as NodePool } from 'pg';
import { databaseUrl } from './env';
import * as schema from './schema';

/**
 * Either driver, as far as callers are concerned.
 *
 * Both extend the same `PgDatabase`, and every module that takes a connection
 * types it structurally rather than by driver — so this union never leaks into
 * a signature anywhere else.
 */
export type PooledDatabase = NeonDatabase<typeof schema> | NodePgDatabase<typeof schema>;

let cached: PooledDatabase | undefined;

/** True for a Neon connection string. Everything else is a plain PostgreSQL. */
export function isNeonUrl(url: string): boolean {
  try {
    return /(^|\.)neon\.(tech|build)$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * The shared pooled connection.
 *
 * Created on first use so that importing this module — which `astro check` and
 * the test suite both do — never requires `DATABASE_URL` to exist. Nothing
 * connects until something asks for a query.
 */
export function pooledDb(): PooledDatabase {
  if (cached) return cached;

  const url = databaseUrl();

  cached = isNeonUrl(url)
    ? // Production. Neon's pooled endpoint, over its WebSocket proxy.
      drizzleNeon(new NeonPool({ connectionString: url }), { schema })
    : // Local development, or any self-hosted PostgreSQL, over TCP.
      drizzleNode(new NodePool({ connectionString: url }), { schema });

  return cached;
}

export { schema };
