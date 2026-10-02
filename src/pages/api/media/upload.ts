/**
 * IMAGE UPLOAD, VIA VERCEL BLOB — authorisation for one upload.
 *
 *   browser → THIS ROUTE (authorise)           → short-lived upload token
 *   browser → Vercel Blob (upload, directly)   → the file never touches us
 *   Blob    → THIS ROUTE (`onUploadCompleted`) → the media row, when Blob can
 *                                                reach us (never on localhost)
 *   browser → `/api/media/confirm`             → the media row, verified with
 *                                                `head()`, whenever the
 *                                                callback did not arrive
 *
 * ── WHERE AUTHORISATION HAPPENS ──────────────────────────────────────────
 *
 * In `onBeforeGenerateToken`, before a token exists. Two purposes:
 *
 *   cover   the caller must be allowed `upload_media` on the project —
 *           owner or collaborator, on a project the website's workflow owns
 *           (`memberCan()` in `src/server/projects/lifecycle.ts`)
 *   avatar  the caller's own portrait
 *
 * The PATHNAME is part of the authorisation: a cover must be uploaded under
 * `projects/<projectId>/`, a portrait under `avatars/<memberId>/`. The media
 * row is only ever recorded for a URL under the prefix this route authorised,
 * and a cover is only ever attached from a media row — so there is no longer
 * any way to make an arbitrary URL a project's cover.
 *
 * ── WHY `status` IS `staged` ─────────────────────────────────────────────
 *
 * An upload is not a publication. It becomes public when its project (or the
 * member's profile) is published.
 */
import type { APIRoute } from 'astro';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { z } from 'zod';
import { pooledDb } from '../../../../db/pool';
import { requireMember, statusFor } from '@/server/auth/member';
import { json } from '@/server/http/guard';
import { assertSameOrigin, fetchSiteAllows } from '@/server/http/origin';
import { memberCan } from '@/server/projects/lifecycle';
import {
  ALLOWED_COVER_TYPES,
  MAX_COVER_BYTES,
  avatarPathPrefix,
  coverPathPrefix,
  recordAvatarUpload,
  recordCoverUpload,
} from '@/server/media/covers';

export const prerender = false;

/** What the browser may say about an upload. Everything else is server-derived. */
const ClientPayloadSchema = z.union([
  z
    .object({
      purpose: z.literal('cover').optional(),
      projectId: z.string().uuid(),
      /** Required, and required to be meaningful — `media.alt` is NOT NULL. */
      alt: z.string().trim().min(1).max(300),
      caption: z.string().trim().max(300).optional(),
    })
    .strict(),
  z
    .object({
      purpose: z.literal('avatar'),
      alt: z.string().trim().min(1).max(300),
    })
    .strict(),
]);

class Refusal extends Error {}

export const POST: APIRoute = async ({ request }) => {
  const db = pooledDb();

  const text = await request.text();
  if (text.length > 64 * 1024) return json({ error: 'That request is too large.' }, 413);
  let body: HandleUploadBody;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: 'That request body is not JSON.' }, 400);
  }

  /**
   * TWO CALLERS.
   *
   * The completion callback comes from Blob's servers: no Origin, no member
   * cookie. `handleUpload` verifies its `x-vercel-signature` (an HMAC over the
   * body with the store token) before `onUploadCompleted` runs, and the
   * payload it carries is the one THIS route signed into the token. The old
   * route ran the browser checks first, so every callback was refused and no
   * media row was ever recorded from one.
   *
   * Everything else is a browser asking for a token: CSRF and identity first.
   */
  const isCallback = (body as { type?: string }).type === 'blob.upload-completed';
  let memberId: string | null = null;
  if (!isCallback) {
    if (!assertSameOrigin(request) || !fetchSiteAllows(request)) {
      return json({ error: 'That request did not come from this site.' }, 403);
    }
    const identity = await requireMember(request, db);
    if (!identity.ok) {
      return json({ error: 'Sign in to upload an image.' }, statusFor(identity.reason));
    }
    if (identity.member.status !== 'active') {
      return json({ error: 'This account cannot upload right now.' }, 403);
    }
    memberId = identity.member.id;
  }

  try {
    const response = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        if (!memberId) throw new Refusal('Sign in to upload an image.');
        let raw: unknown = {};
        try {
          raw = clientPayload ? JSON.parse(clientPayload) : {};
        } catch {
          throw new Refusal('Describe the image first.');
        }
        const parsed = ClientPayloadSchema.safeParse(raw);
        if (!parsed.success) throw new Refusal('Describe the image first.');

        const payload = parsed.data;
        let prefix: string;
        let tokenPayload: Record<string, unknown>;
        if (payload.purpose === 'avatar') {
          prefix = avatarPathPrefix(memberId);
          tokenPayload = { purpose: 'avatar', memberId, alt: payload.alt };
        } else {
          // THE AUTHORISATION. Server-side, against the database.
          if (!(await memberCan(memberId, payload.projectId, 'upload_media', db))) {
            throw new Refusal('That project is not yours.');
          }
          prefix = coverPathPrefix(payload.projectId);
          tokenPayload = { purpose: 'cover', memberId, projectId: payload.projectId, alt: payload.alt };
        }
        if (!pathname.startsWith(prefix) || pathname.includes('..')) {
          throw new Refusal('Invalid upload location.');
        }

        return {
          allowedContentTypes: [...ALLOWED_COVER_TYPES],
          maximumSizeInBytes: MAX_COVER_BYTES,
          addRandomSuffix: true,
          // Signed by Blob and handed back to `onUploadCompleted`, so the
          // callback cannot be forged for a different member or project.
          tokenPayload: JSON.stringify(tokenPayload),
        };
      },

      onUploadCompleted: async ({ blob, tokenPayload }) => {
        const payload = tokenPayload ? JSON.parse(tokenPayload) : {};
        if (!payload.memberId) throw new Error('Upload completed without an authorised payload.');
        const facts = {
          url: blob.url,
          pathname: blob.pathname,
          contentType: blob.contentType,
          size: (blob as { size?: number }).size ?? 0,
        };
        const result =
          payload.purpose === 'avatar'
            ? await recordAvatarUpload(db, { memberId: payload.memberId, alt: payload.alt, facts })
            : await recordCoverUpload(db, {
                memberId: payload.memberId,
                projectId: payload.projectId,
                alt: payload.alt,
                facts,
              });
        console.log(
          `[media.upload] ${JSON.stringify({ purpose: payload.purpose ?? 'cover', ok: result.ok, type: blob.contentType })}`,
        );
      },
    });

    return json(response, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const tokenFailure =
      message.includes('Failed to retrieve the client token') ||
      message.includes('BLOB_READ_WRITE_TOKEN') ||
      message.includes('No token found');

    if (tokenFailure) {
      console.error('[media.upload] Blob token unavailable — check BLOB_READ_WRITE_TOKEN');
      return json(
        {
          error:
            'Image uploads are temporarily unavailable. You can save or publish without an image.',
        },
        503,
      );
    }

    // Our own refusals are safe to show; anything else is collapsed, because
    // an SDK error can name a store id or a token.
    const ours = error instanceof Refusal || message.startsWith('Too big') || message.startsWith('Invalid');
    if (!ours) console.error('[media.upload] failed', message);
    return json({ error: ours ? message : 'That upload could not be completed.' }, ours ? 403 : 500);
  }
};

export const ALL: APIRoute = () => json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
