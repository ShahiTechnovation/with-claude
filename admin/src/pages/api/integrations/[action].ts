/**
 * POST /api/integrations/<action> — operate the Baserow sync by hand.
 *
 *   process    work the pending queue for one bounded slice
 *   reconcile  full scan of every synced table, then process
 *   retry      re-queue failed and dead jobs, then process
 *
 * Editors and admins only; same-origin form posts; redirects back.
 */
import type { APIRoute } from 'astro';
import { pooledDb } from '@db/pool';
import { assertSameOrigin } from '@/server/session';
import { runSync, CRON_BUDGET_MS } from '../../../../../src/server/integrations/baserow/runtime';
import { retryFailed } from '../../../../../src/server/integrations/baserow/sync';

export const prerender = false;

export const POST: APIRoute = async ({ request, params, locals }) => {
  const user = locals.user;
  if (!user || (user.role !== 'admin' && user.role !== 'editor')) {
    return new Response('Editors only.', { status: 403 });
  }
  if (!assertSameOrigin(request))
    return new Response('Cross-origin request refused.', { status: 403 });

  const action = params.action;
  if (action !== 'process' && action !== 'reconcile' && action !== 'retry') {
    return new Response('Unknown action.', { status: 400 });
  }
  let note = '';
  let key = 'error';
  try {
    if (action === 'retry') note = `${await retryFailed(pooledDb())} job(s) re-queued. `;
    const result = await runSync('manual', {
      reconcileFirst: action === 'reconcile',
      budgetMs: CRON_BUDGET_MS,
    });
    if (result.ran) {
      note += 'Run finished.';
      key = 'note';
    } else {
      // A run that started and failed keeps its message on the run row, which the page lists.
      note += result.started ? 'The run failed. See Recent runs.' : `Not run: ${result.reason}.`;
    }
  } catch (error) {
    // Reached before a run starts, and after one when recording its failure fails too.
    console.error(`sync ${action} failed`, error);
    note += 'The sync failed. See the server log.';
  }
  return new Response(null, {
    status: 303,
    headers: {
      Location: `/integrations?${key}=${encodeURIComponent(note)}`,
      'Cache-Control': 'no-store',
    },
  });
};
