/**
 * BASEROW WEBHOOKS — authenticate, parse, and turn into durable jobs.
 *
 * Baserow sends a configured custom header with every call; it does NOT sign
 * payloads. So authentication is a shared high-entropy secret in that header,
 * compared in constant time, over HTTPS. There is no HMAC check here because
 * Baserow does not send one — inventing one would only look like security.
 *
 * The payload is used for exactly one thing: WHICH rows to look at. Its row
 * contents are ignored — the worker re-reads each row from the API — so a
 * forged or stale payload cannot write content, only cause a re-read.
 */
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { BaserowConfig } from './config';
import { tableKeyFor } from './config';
import type { NewJob } from './sync';

export const WEBHOOK_SECRET_HEADER = 'x-withclaude-webhook-secret';
/** Baserow batches up to 200 rows per call; a bound well above that. */
export const MAX_ROWS_PER_CALL = 500;
export const MAX_BODY_BYTES = 1024 * 1024;

export function secretMatches(presented: string | null, expected: string | null): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // Length is compared first (and leaks only the length), then content in
  // constant time.
  return a.length === b.length && timingSafeEqual(a, b);
}

const Item = z.object({ id: z.number().int().positive() }).passthrough();

const Payload = z
  .object({
    table_id: z.number().int().positive(),
    event_id: z.string().max(100).optional(),
    event_type: z.string().max(60),
    items: z.array(Item).max(MAX_ROWS_PER_CALL).optional(),
    row_ids: z.array(z.number().int().positive()).max(MAX_ROWS_PER_CALL).optional(),
  })
  .passthrough();

export type ParsedWebhook =
  | { ok: true; jobs: NewJob[]; ignored: false }
  | { ok: true; jobs: []; ignored: true; reason: string }
  | { ok: false; status: 400 | 413 | 422; error: string };

/**
 * Map one webhook call to jobs. Unknown tables and event types are
 * acknowledged and ignored (Baserow retries non-2xx answers, and a webhook
 * for a table we do not sync is not an error worth retrying).
 */
export function parseWebhook(body: unknown, config: BaserowConfig): ParsedWebhook {
  const parsed = Payload.safeParse(body);
  if (!parsed.success) return { ok: false, status: 422, error: 'unrecognised webhook payload' };
  const p = parsed.data;
  const table = tableKeyFor(config, p.table_id);
  if (!table) return { ok: true, jobs: [], ignored: true, reason: 'table is not synced' };

  const ids = [...new Set([...(p.items ?? []).map((i) => i.id), ...(p.row_ids ?? [])])];
  if (ids.length > MAX_ROWS_PER_CALL) return { ok: false, status: 413, error: 'too many rows in one call' };

  let kind: NewJob['kind'];
  if (p.event_type === 'rows.created' || p.event_type === 'rows.updated') kind = 'row.sync';
  else if (p.event_type === 'rows.deleted') kind = 'row.delete';
  else return { ok: true, jobs: [], ignored: true, reason: `event ${p.event_type} is not handled` };

  return {
    ok: true,
    ignored: false,
    jobs: ids.map((rowId) => ({ kind, tableId: p.table_id, rowId, sourceEventId: p.event_id ?? null })),
  };
}
