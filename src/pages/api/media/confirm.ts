/**
 * CONFIRM AN UPLOAD — turn a finished Blob upload into a media row.
 *
 * Blob's completion callback cannot reach `localhost`, and in production a
 * callback can simply be dropped. So after `upload()` resolves the editor
 * calls this with the URL it got back, and the server:
 *
 *   1. checks the caller may upload for that purpose (owner/collaborator of
 *      the project, or their own portrait)
 *   2. checks the URL is a Blob object under the prefix that authorisation
 *      covers — `projects/<id>/` or `avatars/<memberId>/`
 *   3. asks Blob for the object's real metadata with `head()` — the size and
 *      type recorded are Blob's, never the browser's
 *   4. records the media row, idempotently with the callback
 *
 * The response is the media id the editor then sends as `coverMediaId` or
 * `avatarMediaId`. Nothing becomes public here.
 */
import type { APIRoute } from 'astro';
import { head } from '@vercel/blob';
import { z } from 'zod';
import { pooledDb } from '../../../../db/pool';
import { guardMutation, json } from '@/server/http/guard';
import { memberCan } from '@/server/projects/lifecycle';
import {
  avatarPathPrefix,
  coverPathPrefix,
  isBlobUrlUnder,
  recordAvatarUpload,
  recordCoverUpload,
} from '@/server/media/covers';

export const prerender = false;

const ConfirmSchema = z.union([
  z
    .object({
      purpose: z.literal('cover'),
      projectId: z.string().uuid(),
      url: z.string().url().max(500),
      alt: z.string().trim().min(1).max(300),
    })
    .strict(),
  z
    .object({
      purpose: z.literal('avatar'),
      url: z.string().url().max(500),
      alt: z.string().trim().min(1).max(300),
    })
    .strict(),
]);

export const POST: APIRoute = async ({ request }) => {
  const db = pooledDb();
  const guard = await guardMutation(request, db, { schema: ConfirmSchema });
  if (!guard.ok) return guard.response;
  const { member, body } = guard;

  const prefix =
    body.purpose === 'avatar' ? avatarPathPrefix(member.id) : coverPathPrefix(body.projectId);
  if (body.purpose === 'cover' && !(await memberCan(member.id, body.projectId, 'upload_media', db))) {
    return json({ error: 'Project not found.' }, 404);
  }
  if (!isBlobUrlUnder(body.url, prefix)) {
    return json({ error: 'That upload is not one this account was allowed to make.' }, 422);
  }

  let facts;
  try {
    const meta = await head(body.url);
    facts = { url: meta.url, pathname: meta.pathname, contentType: meta.contentType, size: meta.size };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('token') || message.includes('BLOB_READ_WRITE_TOKEN')) {
      return json({ error: 'Image uploads are temporarily unavailable.' }, 503);
    }
    return json({ error: 'That upload could not be found.' }, 404);
  }

  const result =
    body.purpose === 'avatar'
      ? await recordAvatarUpload(db, { memberId: member.id, alt: body.alt, facts })
      : await recordCoverUpload(db, { memberId: member.id, projectId: body.projectId, alt: body.alt, facts });

  if (!result.ok) return json({ error: result.error }, result.status);
  return json({ mediaId: result.mediaId, url: result.url }, 200);
};

export const ALL: APIRoute = () => json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
