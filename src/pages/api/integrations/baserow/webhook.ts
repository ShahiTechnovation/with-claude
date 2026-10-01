/**
 * POST /api/integrations/baserow/webhook/ — Baserow row events.
 *
 *   1. bounded body, then the shared secret header (constant time)
 *   2. parse to row ids — payload CONTENT is never trusted or applied
 *   3. persist jobs in Neon BEFORE answering
 *   4. work the queue for a bounded slice of this request (no
 *      fire-and-forget: a Vercel function is frozen after it responds)
 *   5. answer 200 — the work is durable whether or not the slice finished
 *
 * With the feature flag off the call is acknowledged and ignored (a non-2xx
 * would make Baserow retry and eventually disable the webhook), and nothing
 * in Neon changes. See docs/baserow/setup.md.
 */
import type { APIRoute } from 'astro';
import { pooledDb } from '../../../../../db/pool';
import { json } from '@/server/http/guard';
import { baserowSettings } from '@/server/integrations/baserow/config';
import { runSync, WEBHOOK_BUDGET_MS } from '@/server/integrations/baserow/runtime';
import { enqueue } from '@/server/integrations/baserow/sync';
import {
  MAX_BODY_BYTES,
  parseWebhook,
  secretMatches,
  WEBHOOK_SECRET_HEADER,
} from '@/server/integrations/baserow/webhook';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const settings = baserowSettings();
  if (!settings.enabled) return json({ ok: true, ignored: 'sync disabled' }, 200);
  if (settings.problem || !settings.config) return json({ error: 'Not configured.' }, 503);

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return json({ error: 'Too large.' }, 413);

  // Authenticate before reading or parsing anything an attacker controls.
  if (!secretMatches(request.headers.get(WEBHOOK_SECRET_HEADER), settings.webhookSecret)) {
    return json({ error: 'Not authorised.' }, 401);
  }

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return json({ error: 'Too large.' }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: 'Not JSON.' }, 400);
  }

  const parsed = parseWebhook(body, settings.config);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  if (parsed.ignored) return json({ ok: true, ignored: parsed.reason }, 200);

  // Durable first. If anything after this fails, the jobs are still there.
  const accepted = await enqueue(pooledDb(), settings.config, parsed.jobs);
  const run = await runSync('webhook', { reconcileFirst: false, budgetMs: WEBHOOK_BUDGET_MS });
  return json({ ok: true, received: parsed.jobs.length, accepted, processed: run.counts ?? null }, 200);
};

export const ALL: APIRoute = () => json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
