/**
 * THE LUMA WEBHOOK. OFF, AND HONEST ABOUT IT.
 *
 * ── READ THIS BEFORE BELIEVING ANYTHING ABOUT REALTIME ───────────────────
 *
 * This endpoint is NOT ACTIVE. We do not administer the Claude Community Luma
 * calendar and hold no webhook secret for it, so `LUMA_WEBHOOK_SECRET` is
 * unset and every request here is refused with 503.
 *
 * §18 permits webhook mode only with authorised access to the calendar, and
 * §56 forbids describing the system as near-real-time on the strength of a
 * route existing. So the route exists, is wired, is verified — and is
 * disabled, which is the accurate state of affairs rather than a flattering
 * one.
 *
 * What it is for: the day somebody grants webhook access, setting the secret
 * turns this on and the sync becomes near-real-time WITH the nightly ICS run
 * still reconciling behind it. That combination matters, and is the reason the
 * handler below sets `complete: false` — see the note there.
 *
 * ── WHY IT REFUSES RATHER THAN ACCEPTS-AND-IGNORES ───────────────────────
 *
 * A 200 from an endpoint that does nothing is how a provider concludes
 * delivery is working. Refusing with 503 means that if this is ever pointed at
 * without being configured, the failure is visible in Luma's own delivery log
 * instead of silent here.
 */
import type { APIRoute } from 'astro';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { pooledDb } from '../../../../db/pool';
import { ManualEventSource } from '@/server/events/registry';
import { normalizeLumaApiEntry } from '@/server/events/luma';
import { syncSource } from '@/server/events/sync';

export const prerender = false;

/** A webhook body is one event, not a calendar. 64 KB is already generous. */
const MAX_BODY_BYTES = 64 * 1024;

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

/**
 * Constant-time signature comparison.
 *
 * `timingSafeEqual` throws on length mismatch, so the lengths are compared
 * first — and that comparison is safe to short-circuit because the length of a
 * hex digest is not secret.
 */
export function signatureMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const POST: APIRoute = async ({ request }) => {
  const secret = process.env.LUMA_WEBHOOK_SECRET?.trim();

  // THE HONEST DEFAULT. See the file header.
  if (!secret) {
    return json(
      {
        error: 'Webhook ingestion is not enabled on this deployment.',
        mode: 'ics',
        realtime: false,
      },
      503,
    );
  }

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return json({ error: 'That request is too large.' }, 413);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: 'That request is too large.' }, 413);

  // Signature over the RAW body, before parsing. Verifying a re-serialised
  // object verifies our serialiser, not their signature.
  const provided = request.headers.get('x-luma-signature') ?? '';
  const expected = createHmac('sha256', secret).update(raw).digest('hex');
  if (!provided || !signatureMatches(expected, provided)) {
    console.warn('[webhooks/luma] rejected: signature mismatch');
    return json({ error: 'Not authorised.' }, 401);
  }

  let payload: { event?: unknown; type?: unknown };
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    return json({ error: 'That request body is not JSON.' }, 400);
  }

  const normalized = normalizeLumaApiEntry(payload.event ?? payload);
  if (!normalized) return json({ error: 'Unrecognised event payload.' }, 422);

  /**
   * `complete: false` — AND THIS IS THE IMPORTANT LINE IN THE FILE.
   *
   * A webhook delivers ONE event. `sync.ts` treats absence from a COMPLETE
   * fetch as cancellation, so claiming completeness here would withdraw every
   * other event on the calendar on the first delivery. The nightly ICS run is
   * what carries the complete view; this only ever upserts what it was told
   * about.
   */
  const source = new ManualEventSource([normalized], {
    key: 'luma:webhook',
    label: 'Claude Community (Luma webhook)',
    complete: false,
  });

  // Idempotent by construction: the same delivery retried lands on the same
  // `(source_id, external_id)` and updates rather than duplicates. §43.
  const summary = await syncSource(source, pooledDb());

  const type = typeof payload.type === 'string' ? payload.type : 'unknown';
  console.log(`[webhooks/luma] ${JSON.stringify({ type, promoted: summary.promoted, review: summary.review })}`);

  return json({ ok: summary.ok, promoted: summary.promoted, review: summary.review }, 200);
};

export const ALL: APIRoute = () => json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
