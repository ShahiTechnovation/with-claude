/**
 * GET /api/cron/baserow-reconcile/ — the safety net for dropped webhooks.
 *
 * Called by Vercel Cron with `Authorization: Bearer $CRON_SECRET`. Scans every
 * synced table in full, queues what changed or disappeared (deletion is only
 * inferred from a COMPLETE scan), then works the queue for a bounded slice.
 *
 * The schedule in vercel.json is DAILY, because that is what the current plan
 * runs; a dropped webhook can therefore take up to a day to repair on its own.
 * The admin's "Reconcile now" runs the same thing on demand. See
 * docs/baserow/setup.md for the freshness this does and does not promise.
 */
import type { APIRoute } from 'astro';
import { json } from '@/server/http/guard';
import { CRON_BUDGET_MS, runSync } from '@/server/integrations/baserow/runtime';
import { secretMatches } from '@/server/integrations/baserow/webhook';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return json({ error: 'Not configured.' }, 503);
  if (!secretMatches(request.headers.get('authorization'), `Bearer ${secret}`)) return json({ error: 'Not authorised.' }, 401);

  const result = await runSync('reconcile', { reconcileFirst: true, budgetMs: CRON_BUDGET_MS });
  return json(result, result.ran || result.reason === 'disabled' ? 200 : 503);
};

export const ALL: APIRoute = () => json({ error: 'Method not allowed' }, 405, { Allow: 'GET' });
