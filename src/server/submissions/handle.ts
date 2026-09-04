/**
 * The submission pipeline, with its dependencies passed in.
 *
 *     validate → rate limit → write one submissions row → acknowledge → 202
 *
 * The route in `src/pages/api/submit.ts` is a five-line wrapper that supplies
 * the real database and the real mailer. Everything that decides anything
 * lives here, so the whole pipeline can be tested against a real PostgreSQL
 * without a network, a mail provider or a running server — which is the only
 * way the rejection rules get tested properly rather than by inspection.
 *
 * WHAT THIS NEVER DOES: publish anything, create a builder or a project or a
 * use case, change a record's status, or accept an id, slug, entity reference,
 * reviewer or approval state. A submission is an inbox item. What becomes of
 * it is an editorial decision made later, by a person, somewhere else.
 */
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../../../db/schema';
import { communityChannel, site } from '@/data/site';
import type { AcknowledgementResult } from '@/server/email/acknowledge';
import { clientAddress, normaliseEmail, userAgent } from './identity';
import { checkElapsed, checkRateLimit } from './rate-limit';
import { LIMITS, validateSubmission } from './validate';

type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface SubmissionDependencies {
  /**
   * Opened on demand, not up front.
   *
   * Validation runs first and needs no database, so a malformed request gets
   * a straight 4xx even when the database is unreachable — rather than a 503
   * that tells somebody to try again with a body that will never be accepted.
   * Throwing here is treated as "temporarily unavailable".
   */
  database: () => AnyDatabase;
  /**
   * Hashes the caller's address, or returns undefined when it cannot.
   *
   * Injected rather than called directly so a test never needs the salt, and
   * so a missing salt degrades to "no address-based limit" instead of
   * storing a raw address.
   */
  hashAddress: (address: string) => string | undefined;
  sendAcknowledgement: (message: {
    to: string;
    kind: string;
    name?: string;
    wordmark: string;
    channelLabel: string;
    channelUrl: string;
  }) => Promise<AcknowledgementResult>;
  /** The platform's view of the caller, when the headers do not carry one. */
  fallbackAddress?: string;
}

export function json(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // Nothing about a submission response is cacheable or shareable.
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

export async function handleSubmission(
  request: Request,
  deps: SubmissionDependencies,
): Promise<Response> {
  // ── Body size, before parsing ─────────────────────────────────────────
  //
  // The declared length is checked first because it is free, then what
  // actually arrived is checked too — a declared length is a claim, not a
  // fact.
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > LIMITS.bodyBytes) {
    return json({ error: 'That submission is too large.' }, 413);
  }

  let raw: unknown;
  try {
    const text = await request.text();
    if (text.length > LIMITS.bodyBytes) {
      return json({ error: 'That submission is too large.' }, 413);
    }
    raw = JSON.parse(text);
  } catch {
    return json({ error: 'Could not read that as JSON.' }, 400);
  }

  // ── Validate ──────────────────────────────────────────────────────────
  const result = validateSubmission(raw);
  if (!result.ok) {
    return json({ error: result.error, issues: result.issues }, result.status);
  }

  // ── Anti-abuse ────────────────────────────────────────────────────────
  const timing = checkElapsed(result.elapsedMs);
  if (!timing.allowed) {
    return json({ error: timing.reason }, timing.status);
  }

  const address = clientAddress(request, deps.fallbackAddress);
  const email = normaliseEmail(result.email);
  const ipHash = address ? deps.hashAddress(address) : undefined;

  // Everything past this point needs the database.
  let database: AnyDatabase;
  try {
    database = deps.database();
  } catch (error) {
    console.error('[submit] No database connection:', error);
    // The client falls back to the clipboard path on a non-2xx, so the
    // person's work is not lost.
    return json({ error: 'Submissions are temporarily unavailable.' }, 503);
  }

  const verdict = await checkRateLimit(database, { ipHash, email });
  if (!verdict.allowed) {
    return json(
      { error: verdict.reason },
      verdict.status,
      verdict.retryAfterSeconds ? { 'Retry-After': String(verdict.retryAfterSeconds) } : {},
    );
  }

  // ── Write exactly one row ─────────────────────────────────────────────
  //
  // `status` is left at its default of `received`. `entity_type`, `entity_id`,
  // `reviewer_id` and `reviewed_at` are not written here and cannot be: they
  // hold what a reviewer decides later, and this code path has no reviewer.
  let submissionId: string;
  try {
    const [row] = await database
      .insert(schema.submissions)
      .values({
        kind: result.validator.kind,
        // The raw validated payload, retained as sent.
        payload: result.payload,
        submitterName: result.name ?? null,
        submitterEmail: email,
        ipHash: ipHash ?? null,
        userAgent: userAgent(request) ?? null,
      })
      .returning({ id: schema.submissions.id });
    submissionId = row.id;
  } catch (error) {
    console.error('[submit] Could not store the submission:', error);
    return json({ error: 'Submissions are temporarily unavailable.' }, 503);
  }

  // ── City interest ─────────────────────────────────────────────────────
  //
  // A city signal is the one kind with a second home, because the interest
  // count a city's derived state reads has to come from somewhere. It still
  // goes through the inbox first — this row is written alongside, carries
  // `submission_id`, and arrives UNVERIFIED. Unverified rows count for
  // nothing, so a form still cannot conjure a chapter: a person has to
  // confirm the signal before it contributes to anything at all.
  if (result.validator.kind === 'city-interest') {
    const cityName = result.payload.city?.trim();
    if (cityName) {
      try {
        await database
          .insert(schema.cityInterest)
          .values({
            cityName,
            email,
            doing: result.payload.doing ?? null,
            helping: result.payload.helping ?? null,
            submissionId,
          })
          .onConflictDoUpdate({
            // One signal per person per city. Sending it twice updates what
            // they said rather than inflating the count.
            target: [schema.cityInterest.email, schema.cityInterest.cityName],
            set: {
              doing: result.payload.doing ?? null,
              helping: result.payload.helping ?? null,
              submissionId,
            },
          });
      } catch (error) {
        // The inbox row is already safe, which is what matters. This is a
        // convenience index over it, so a failure here is logged, not fatal.
        console.error('[submit] Could not record the city interest signal:', error);
      }
    }
  }

  // ── Acknowledge ───────────────────────────────────────────────────────
  const acknowledgement = await deps.sendAcknowledgement({
    to: email,
    kind: result.validator.kind,
    name: result.name,
    wordmark: site.wordmark,
    channelLabel: communityChannel.label,
    channelUrl: communityChannel.url,
  });

  return json(
    {
      // Deliberately not the submission's id: there is nothing the caller can
      // do with it, and echoing a database key into a public response is a
      // habit worth not starting.
      received: true,
      message: 'Received. A person will read it before anything is published.',
      // Honest about the email rather than silent: if the acknowledgement did
      // not go out, the panel says so instead of promising a message that is
      // never going to arrive.
      acknowledgementSent: acknowledgement.delivered,
    },
    202,
  );
}
