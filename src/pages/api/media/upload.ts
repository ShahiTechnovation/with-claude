import type { APIRoute } from 'astro';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { pooledDb } from '../../../../db/pool';
import * as schema from '../../../../db/schema';
import { requireMember } from '@/server/auth/member';
import { json } from '@/server/http/guard';

export const prerender = false;

// 5MB limit
const MAX_SIZE = 5 * 1024 * 1024;
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export const POST: APIRoute = async ({ request }) => {
  const db = pooledDb();
  
  // Custom authentication check since handleUpload does its own body parsing
  const identity = await requireMember(request, db);
  if (!identity.ok) {
    return json({ error: 'Unauthorized' }, 401);
  }
  const member = identity.member;

  let body: HandleUploadBody;
  try {
    const text = await request.text();
    body = JSON.parse(text);
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        // Validate MIME type is loosely inferred or enforced by client, but blob handles it.
        // We could extract the intended MIME or alt text from clientPayload.
        let altText = 'Image';
        let consent = false;
        
        if (clientPayload) {
          const payload = JSON.parse(clientPayload);
          if (payload.alt) altText = String(payload.alt);
          if (payload.consent) consent = Boolean(payload.consent);
        }

        return {
          allowedContentTypes: ALLOWED_MIME_TYPES,
          maximumSizeInBytes: MAX_SIZE,
          tokenPayload: JSON.stringify({
            memberId: member.id,
            alt: altText,
            consent,
          }),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        const payload = tokenPayload ? JSON.parse(tokenPayload) : {};
        const memberId = payload.memberId;
        const alt = payload.alt || 'Uploaded image';
        const consent = payload.consent || false;

        if (!memberId) throw new Error('Missing member ID in token payload');

        await db.insert(schema.media).values({
          ownerMemberId: memberId,
          blobUrl: blob.url,
          pathname: blob.pathname,
          mimeType: blob.contentType,
          alt,
          consent,
          status: 'staged',
          kind: 'other',
        });
      },
    });

    return new Response(JSON.stringify(jsonResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return json({ error: msg }, 500);
  }
};

export const ALL: APIRoute = () => json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
