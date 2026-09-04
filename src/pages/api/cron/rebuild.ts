/**
 * The nightly rebuild trigger.
 *
 * WHY THIS EXISTS AT ALL.
 *
 * Every event's lifecycle on this site is computed from the clock, not stored:
 * `lifecycleOf()` decides whether a room is upcoming, today, live or past by
 * comparing its date with the current time. On a static site "the current
 * time" is frozen at the moment of the last build — so an event that finished
 * last night goes on saying "Upcoming" on the homepage until somebody happens
 * to push a commit.
 *
 * That is the price of deriving status instead of authoring it, and it is
 * worth paying. The fix is not to store a status; it is to rebuild every day.
 *
 * WHAT THIS DOES.
 *
 * Vercel Cron calls this route once a night. It POSTs to a deploy hook, which
 * starts an ordinary production deployment — the same build a `git push`
 * would trigger, from the same commit. There is no server left running and
 * nothing about the site becomes dynamic; a static site is rebuilt on a
 * schedule, which is exactly what it needs.
 *
 * 04:00 IST is 22:30 UTC the previous day. It is chosen for being the quietest
 * hour in the only timezone this community is in: nobody is looking at the
 * site, and any event that ended the previous evening is past by the time the
 * build runs.
 *
 * SECURITY. Vercel signs cron invocations with `CRON_SECRET`. Without that
 * header this route refuses, because an unauthenticated URL that starts a
 * deployment is a free way to burn somebody's build minutes.
 */
import type { APIRoute } from 'astro';

export const prerender = false;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function trigger(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;

  // No secret configured is a refusal, not a bypass. An open trigger is worse
  // than a broken one.
  if (!secret) {
    console.error('[cron/rebuild] CRON_SECRET is not set. Refusing to trigger a deployment.');
    return json({ error: 'Not configured.' }, 503);
  }

  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return json({ error: 'Not authorised.' }, 401);
  }

  const hook = process.env.VERCEL_DEPLOY_HOOK_URL;
  if (!hook) {
    console.error('[cron/rebuild] VERCEL_DEPLOY_HOOK_URL is not set. Nothing to call.');
    return json({ error: 'No deploy hook configured.' }, 503);
  }

  try {
    const response = await fetch(hook, { method: 'POST' });
    if (!response.ok) {
      console.error(`[cron/rebuild] Deploy hook returned ${response.status}.`);
      return json({ error: 'The deploy hook refused.', status: response.status }, 502);
    }
    console.log('[cron/rebuild] Nightly rebuild triggered.');
    return json({ triggered: true }, 202);
  } catch (error) {
    console.error('[cron/rebuild] Could not reach the deploy hook:', error);
    return json({ error: 'Could not reach the deploy hook.' }, 502);
  }
}

/** Vercel Cron issues a GET. */
export const GET: APIRoute = ({ request }) => trigger(request);

/** Accepted too, so the hook can be exercised by hand during setup. */
export const POST: APIRoute = ({ request }) => trigger(request);
