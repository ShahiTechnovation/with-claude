/**
 * IMAGE UPLOAD, VIA VERCEL BLOB.
 *
 * The flow is Blob's client-upload handshake, and the shape matters:
 *
 *   browser → THIS ROUTE (authorise)          → short-lived upload token
 *   browser → Vercel Blob (upload, directly)  → the file never touches us
 *   Blob    → THIS ROUTE (`onUploadCompleted`) → the row in Neon
 *
 * The file bypassing our function is the point: a serverless function with a
 * 15-second budget is the wrong place to proxy a 5 MB upload, and doing so
 * would also mean holding a write credential that the browser could provoke
 * into use on anything.
 *
 * ── WHERE AUTHORISATION HAS TO HAPPEN ────────────────────────────────────
 *
 * In `onBeforeGenerateToken`, and ONLY there. By the time `onUploadCompleted`
 * runs, the bytes are already in Blob storage — a check there decides whether
 * to record the upload, not whether to permit it. So every question about who
 * may write what is answered before a token is minted.
 *
 * This is what the route previously got wrong. It authenticated the member,
 * then took the `alt` text and the caller's word for everything else, and
 * recorded a row with no project association at all (§12 requires one). A
 * member could therefore mint an upload token against any project, or none,
 * and nothing connected the resulting image to the thing it was for.
 *
 * Now `clientPayload` names a project, and this route verifies the CALLER owns
 * or collaborates on it — server-side, against the database — before allowing
 * the upload. `canEditProject()` is the same check the edit and publish routes
 * use, so there is one answer to "may this member touch this project".
 *
 * ── WHY `status` IS `staged` ─────────────────────────────────────────────
 *
 * Because an upload is not a publication. The row exists so the editor can
 * show the image back to its owner and so an abandoned blob is identifiable;
 * it becomes part of a public project when the project is published, not when
 * the file arrives.
 */
import type { APIRoute } from 'astro';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { z } from 'zod';
import { pooledDb } from '../../../../db/pool';
import * as schema from '../../../../db/schema';
import { requireMember, statusFor } from '@/server/auth/member';
import { json } from '@/server/http/guard';
import { assertSameOrigin, fetchSiteAllows } from '@/server/http/origin';
import { canEditProject } from '@/server/members/projects';

export const prerender = false;

/** 5 MB. Enforced by Blob itself via `maximumSizeInBytes`, not just here. */
const MAX_SIZE = 5 * 1024 * 1024;

/**
 * Images only, and an explicit list rather than `image/*`.
 *
 * `image/svg+xml` is deliberately absent: an SVG is a document that can carry
 * script, and these files are served from a URL a visitor's browser will
 * render. §12 says not to allow arbitrary files if only images are intended.
 */
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];

/** What the browser may say about an upload. Everything else is server-derived. */
const ClientPayloadSchema = z
  .object({
    projectId: z.string().uuid(),
    /** Required, and required to be meaningful — `media.alt` is NOT NULL. */
    alt: z.string().trim().min(1).max(300),
    caption: z.string().trim().max(300).optional(),
  })
  .strict();

export const POST: APIRoute = async ({ request }) => {
  const db = pooledDb();

  /**
   * CSRF, before anything else.
   *
   * `guardMutation()` cannot be reused here because `handleUpload` insists on
   * parsing the body itself, but the checks it would have run still have to
   * happen — so the two that apply are done explicitly. Omitting them because
   * the helper did not fit is exactly the per-route drift that helper exists to
   * prevent, which is why this comment names what is being substituted for.
   */
  if (!assertSameOrigin(request) || !fetchSiteAllows(request)) {
    return json({ error: 'That request did not come from this site.' }, 403);
  }

  const identity = await requireMember(request, db);
  if (!identity.ok) {
    return json({ error: 'Sign in to upload an image.' }, statusFor(identity.reason));
  }
  const member = identity.member;

  let body: HandleUploadBody;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return json({ error: 'That request body is not JSON.' }, 400);
  }

  try {
    const response = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (_pathname, clientPayload) => {
        const parsed = ClientPayloadSchema.safeParse(
          clientPayload ? JSON.parse(clientPayload) : {},
        );
        if (!parsed.success) {
          // Thrown, because `handleUpload` turns a throw here into a refusal
          // and never mints a token.
          throw new Error(parsed.error.issues[0]?.message ?? 'Describe the image first.');
        }

        // THE AUTHORISATION. Server-side, against the database, before a token
        // exists. §10 and §36.
        if (!(await canEditProject(member.id, parsed.data.projectId, db))) {
          throw new Error('That project is not yours.');
        }

        return {
          allowedContentTypes: ALLOWED_MIME_TYPES,
          maximumSizeInBytes: MAX_SIZE,
          /**
           * Carried through to `onUploadCompleted` and signed by Blob, so the
           * completion callback cannot be forged with a different member or
           * project than the one authorised above.
           */
          tokenPayload: JSON.stringify({
            memberId: member.id,
            projectId: parsed.data.projectId,
            alt: parsed.data.alt,
            caption: parsed.data.caption ?? null,
          }),
        };
      },

      onUploadCompleted: async ({ blob, tokenPayload }) => {
        const payload = tokenPayload ? JSON.parse(tokenPayload) : {};
        if (!payload.memberId || !payload.projectId) {
          throw new Error('Upload completed without an authorised payload.');
        }

        await db.insert(schema.media).values({
          ownerMemberId: payload.memberId,
          projectId: payload.projectId,
          blobUrl: blob.url,
          pathname: blob.pathname,
          mimeType: blob.contentType,
          // Blob reports the real stored size, which is the only trustworthy
          // source for it — a client-declared size is a claim.
          sizeBytes: (blob as { size?: number }).size ?? null,
          alt: payload.alt,
          caption: payload.caption,
          /** An upload is not a publication. See the file header. */
          status: 'staged',
          kind: 'cover',
          // The uploader is the member; consent is theirs to give by uploading
          // their own work, and is recorded as such rather than defaulted true
          // for third-party imagery.
          consent: true,
        });

        console.log(
          `[media.upload] ${JSON.stringify({ project: payload.projectId, bytes: (blob as { size?: number }).size ?? 0, type: blob.contentType })}`,
        );
      },
    });

    return json(response, 200);
  } catch (error) {
    /**
     * The message here is OUR OWN, from the throws above — Blob surfaces them
     * verbatim — so it is safe to return. Anything else is collapsed, because
     * an SDK error can name a store id or a token.
     */
    const message = error instanceof Error ? error.message : '';
    const ours =
      message === 'That project is not yours.' ||
      message === 'Describe the image first.' ||
      message.startsWith('Too big') ||
      message.startsWith('Invalid');
    if (!ours) console.error('[media.upload] failed');
    return json({ error: ours ? message : 'That upload could not be completed.' }, ours ? 403 : 500);
  }
};

export const ALL: APIRoute = () => json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
