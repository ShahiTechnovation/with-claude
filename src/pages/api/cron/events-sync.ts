/**
 * THE SCHEDULED EVENT SYNC.
 *
 * Vercel Cron calls this once a night, it fetches every configured source, and
 * it reconciles the result into Neon. That is the whole job.
 *
 * ── WHY DAILY, AND NOT HOURLY ────────────────────────────────────────────
 *
 * §20 is explicit: Vercel's Hobby plan runs cron DAILY ONLY, and putting an
 * hourly expression in `vercel.json` on Hobby does not produce hourly runs —
 * it produces a deployment that either refuses the schedule or quietly runs it
 * once a day while the repository claims otherwise. Since this deployment's
 * plan is not confirmed, the schedule is daily, which is correct on every plan.
 *
 * The feed itself asks for no more than that. It advertises
 * `REFRESH-INTERVAL:PT12H` — twelve hours — so polling it hourly would be
 * twenty-three redundant requests a day against somebody else's server.
 *
 * ── THE ORDER MATTERS ────────────────────────────────────────────────────
 *
 * This runs at 21:45 UTC and `/api/cron/rebuild` runs at 22:30 UTC, 45 minutes
 * later. That is deliberate: writing an event into Neon does not put a page on
 * the CDN, because the public event pages are prerendered. The sync makes the
 * data true and the rebuild makes it visible, so the sync has to go first or
 * every new event waits an extra day.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────
 *
 * It is not realtime, and §56 forbids calling it that. `mode` in the response
 * says `ics` and `realtime` says false, both read from configuration rather
 * than written by hand.
 */
import type { APIRoute } from 'astro';
import { pooledDb } from '../../../../db/pool';
import { configuredEventSources, ingestionMode } from '@/server/events/registry';
import { syncAll } from '@/server/events/sync';

export const prerender = false;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/**
 * Vercel signs cron invocations with `CRON_SECRET`.
 *
 * The same refusal shape as `/api/cron/rebuild`: no secret configured is a
 * 503, not a bypass. An unauthenticated endpoint that hammers a third-party
 * feed and writes to the production database is not something to leave open
 * because a variable was forgotten.
 */
function authorised(request: Request): { ok: true } | { ok: false; response: Response } {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('[cron/events-sync] CRON_SECRET is not set. Refusing to run.');
    return { ok: false, response: json({ error: 'Not configured.' }, 503) };
  }
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return { ok: false, response: json({ error: 'Not authorised.' }, 401) };
  }
  return { ok: true };
}

async function run(request: Request): Promise<Response> {
  const auth = authorised(request);
  if (!auth.ok) return auth.response;

  const sources = configuredEventSources();
  const mode = ingestionMode();

  const started = Date.now();
  const results = await syncAll(sources, pooledDb());
  const elapsedMs = Date.now() - started;

  const failed = results.filter((result) => !result.ok);

  return json(
    {
      mode: mode.mode,
      // Never `true`. See §56 and the note in `ingestionMode()`.
      realtime: mode.realtime,
      description: mode.description,
      elapsedMs,
      sources: results,
      // 207 when some sources worked and others did not, so a monitor can tell
      // a partial outage from a total one without parsing the body.
      ok: failed.length === 0,
    },
    failed.length === 0 ? 200 : failed.length === results.length ? 502 : 207,
  );
}

/** Vercel Cron issues a GET. */
export const GET: APIRoute = ({ request }) => run(request);

/** Accepted too, so the sync can be exercised by hand during setup. */
export const POST: APIRoute = ({ request }) => run(request);
