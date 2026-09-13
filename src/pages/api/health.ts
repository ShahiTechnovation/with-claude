/**
 * OPERATIONAL HEALTH, WITHOUT GIVING ANYTHING AWAY.
 *
 * §42 asks for a safe operational check, and the operative word is safe. The
 * temptation with a health endpoint is to make it useful by making it
 * detailed, and detail here means telling an unauthenticated caller which
 * credentials a deployment holds, which database it talks to and what version
 * it is running. So the rule for this file:
 *
 *   EVERY VALUE IS A BOOLEAN, A COUNT, A FIXED CODE OR A TIMESTAMP.
 *
 * Never a connection string, never a key, never a key prefix or length,
 * never an error message from a driver, never a hostname. `configured: true`
 * tells an operator what they need and an attacker nothing they can use.
 *
 * ── WHY IT CHECKS THE DATABASE AT ALL ────────────────────────────────────
 *
 * Because "is the site up" is answered by the site being up, and the thing
 * that actually breaks independently is the connection to Neon from a function
 * in `sin1`. A `select 1` is the cheapest true answer to that, and the reason
 * `db.reachable` is worth a round trip.
 *
 * The event-source rows come from the same query batch because sync freshness
 * is the other thing that fails silently — a feed that stopped parsing three
 * weeks ago looks exactly like a quiet community until someone checks
 * `lastSyncedAt`.
 */
import type { APIRoute } from 'astro';
import { sql } from 'drizzle-orm';
import { pooledDb } from '../../../db/pool';
import { ingestionMode } from '@/server/events/registry';
import { sourceHealth } from '@/server/events/sync';

export const prerender = false;

export const GET: APIRoute = async () => {
  const mode = ingestionMode();

  /**
   * Which capabilities are configured — as booleans only.
   *
   * `privy` is the one worth reading closely: it is true only when BOTH
   * server-side values are present, because that is exactly the condition
   * `privyConfig()` requires before it will verify a token. A deployment
   * missing either one refuses every authenticated request, and this is the
   * endpoint that makes that visible instead of mysterious.
   */
  const configured = {
    database: Boolean(process.env.DATABASE_URL?.trim()),
    dataSource: (process.env.DATA_SOURCE ?? 'ts').trim().toLowerCase() || 'ts',
    privy: Boolean(process.env.PRIVY_APP_ID?.trim() && process.env.PRIVY_VERIFICATION_KEY?.trim()),
    privyPublic: Boolean(process.env.PUBLIC_PRIVY_APP_ID?.trim()),
    /**
     * `BLOB_READ_WRITE_TOKEN` AND NOTHING ELSE.
     *
     * This deliberately does NOT accept `VERCEL_OIDC_TOKEN` as a substitute,
     * which an earlier version did. The two are not interchangeable:
     * `handleUpload()` in `@vercel/blob/client` mints its client upload token
     * from the read-write token specifically, so a deployment with OIDC and no
     * blob token cannot accept an upload.
     *
     * Reporting them as equivalent made this endpoint answer `blob: true` on a
     * deployment where every upload would fail — the exact opposite of what a
     * health check is for. Production currently has `BLOB_STORE_ID` (the store
     * is connected) but no read-write token, so this correctly reads false.
     */
    blob: Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim()),
    resend: Boolean(process.env.RESEND_API_KEY?.trim()),
    cron: Boolean(process.env.CRON_SECRET?.trim()),
    lumaApi: Boolean(process.env.LUMA_API_KEY?.trim()),
    lumaWebhook: Boolean(process.env.LUMA_WEBHOOK_SECRET?.trim()),
  };

  let database: { reachable: boolean; latencyMs?: number } = { reachable: false };
  let sources: Awaited<ReturnType<typeof sourceHealth>> = [];

  try {
    const db = pooledDb();
    const started = Date.now();
    await db.execute(sql`select 1`);
    database = { reachable: true, latencyMs: Date.now() - started };
    sources = await sourceHealth(db);
  } catch {
    // The reason is deliberately dropped. A driver error can name a host, a
    // user and a database, and this response is public.
    database = { reachable: false };
  }

  const healthy = configured.database && database.reachable;

  return new Response(
    JSON.stringify({
      ok: healthy,
      region: process.env.VERCEL_REGION ?? null,
      environment: process.env.VERCEL_ENV ?? 'development',
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
      configured,
      database,
      events: {
        mode: mode.mode,
        // Never true. §56.
        realtime: mode.realtime,
        description: mode.description,
        sources: sources.map((source) => ({
          key: source.key,
          provider: source.provider,
          syncMode: source.syncMode,
          enabled: source.enabled,
          lastSyncedAt: source.lastSyncedAt,
          lastSyncStatus: source.lastSyncStatus,
          seen: source.lastSeenCount,
          promoted: source.lastPromotedCount,
        })),
      },
    }),
    {
      status: healthy ? 200 : 503,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    },
  );
};
