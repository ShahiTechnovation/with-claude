/**
 * Upload one image and get back the MEDIA ID the server recorded for it.
 *
 *   1. client checks (type, size) for fast feedback — the server re-checks
 *   2. `upload()` — the browser sends the file straight to Vercel Blob, after
 *      `/api/media/upload/` authorised this member for this purpose and path
 *   3. `/api/media/confirm/` — the server reads the object's real metadata
 *      with `head()` and records the media row
 *
 * The editors then send the media id (`coverMediaId` / `avatarMediaId`),
 * never a URL — that is what stops a cover from being an arbitrary link.
 */
import { upload } from '@vercel/blob/client';
import type { AccountApi } from './account-context';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];

export type UploadTarget =
  | { purpose: 'cover'; projectId: string; alt: string }
  | { purpose: 'avatar'; prefix: string; alt: string };

export class UploadProblem extends Error {}

function safeFileName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (cleaned || 'image').slice(-60);
}

export async function uploadImage(
  account: AccountApi,
  file: File,
  target: UploadTarget,
): Promise<{ mediaId: string; url: string }> {
  if (!IMAGE_TYPES.includes(file.type)) {
    throw new UploadProblem('Choose a JPEG, PNG, WebP, GIF or AVIF image.');
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new UploadProblem('That image is larger than 5 MB.');
  }

  const prefix = target.purpose === 'cover' ? `projects/${target.projectId}/` : target.prefix;
  const clientPayload =
    target.purpose === 'cover'
      ? { purpose: 'cover', projectId: target.projectId, alt: target.alt }
      : { purpose: 'avatar', alt: target.alt };

  let url: string;
  try {
    const blob = await upload(`${prefix}${safeFileName(file.name)}`, file, {
      access: 'public',
      handleUploadUrl: '/api/media/upload/',
      clientPayload: JSON.stringify(clientPayload),
      headers: await account.authHeaders(),
    });
    url = blob.url;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    throw new UploadProblem(
      /unavailable|token/i.test(message)
        ? 'Image uploads are unavailable right now. You can save without an image.'
        : message.replace(/^Vercel Blob:\s*/i, '') || 'The upload did not finish.',
    );
  }

  const confirmed = await account.fetch('/api/media/confirm/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...clientPayload, url }),
  });
  const body = (await confirmed.json().catch(() => ({}))) as { mediaId?: string; error?: string };
  if (!confirmed.ok || !body.mediaId) {
    throw new UploadProblem(body.error ?? 'The upload finished but could not be recorded.');
  }
  return { mediaId: body.mediaId, url };
}
