/**
 * POST /api/submit — the only write path the public site has.
 *
 * The pipeline itself lives in `src/server/submissions/handle.ts`, with its
 * database and mailer passed in, so it can be tested against a real PostgreSQL
 * without a network or a mail provider. This file is the wiring: it supplies
 * the real ones.
 *
 * WHAT THIS ROUTE DOES:
 *
 *     validate → rate limit → write one submissions row → acknowledge → 202
 *
 * WHAT IT DOES NOT DO, EVER: publish anything, create a builder or a project
 * or a use case, change any record's status, or accept an id, a slug, an
 * entity reference, a reviewer or an approval state.
 *
 * 202 rather than 201 is the accurate status: the request was accepted for
 * processing, and no resource was created that the caller can go and look at.
 *
 * THERE IS NO GET. There is no public read path to the `submissions` table at
 * all — submitter emails, IP hashes and user agents are private, and the way
 * to guarantee they are never served is to have nothing that serves them.
 */
import type { APIRoute } from 'astro';
import { db } from '../../../db/client';
import { sendAcknowledgement } from '@/server/email/acknowledge';
import { hashAddress } from '@/server/submissions/identity';
import { handleSubmission, json } from '@/server/submissions/handle';

/** This route runs on the server. Every other route on the site is a file. */
export const prerender = false;

export const POST: APIRoute = ({ request, clientAddress }) =>
  handleSubmission(request, {
    // Opened on demand: a malformed request is answered with a 4xx without
    // ever needing a database.
    database: db,
    /**
     * A missing salt must never mean "store the raw address". It means the
     * address-based limit does not apply to this request, which is logged and
     * survivable — the per-email limit still does.
     */
    hashAddress: (address) => {
      try {
        return hashAddress(address);
      } catch (error) {
        console.error('[submit] Could not hash the client address:', error);
        return undefined;
      }
    },
    sendAcknowledgement,
    fallbackAddress: clientAddress,
  });

/**
 * Everything that is not a POST.
 *
 * A GET here would be the first step towards a public read API over a table
 * full of private email addresses, so it is answered with 405 rather than left
 * to a default.
 */
export const ALL: APIRoute = () =>
  json({ error: 'This endpoint only accepts POST.' }, 405, { Allow: 'POST' });
