/**
 * PROJECT COVERS — THE ONLY WAY AN IMAGE BECOMES A PROJECT'S COVER.
 *
 * `PUT /api/projects/[id]` used to accept any `imagePath` string, so the
 * ownership check on the upload route could be bypassed by pasting a URL: the
 * cover was whatever the client said it was. Now a cover is a `media` row and
 * nothing else:
 *
 *   upload    browser → Blob, authorised by `/api/media/upload` for ONE project
 *   record    `recordCoverUpload()` — from Blob's completion callback, or from
 *             `/api/media/confirm` after the server has checked the blob exists
 *             (the callback cannot reach `localhost`, and can be dropped)
 *   attach    `attachCover()` — verifies the media row belongs to this project
 *             and is not deleted, then sets `image_id` (and `image_path` to the
 *             same Blob URL, for readers that only know the column)
 *   publish   `publishProjectCover()` — inside the publish transaction; a staged
 *             upload becomes public only when its project does
 *
 * Public readers resolve a blob cover through the media row and require
 * `status = 'published'`; a legacy repository asset key keeps working through
 * `resolveProjectCover()`. An http(s) `image_path` with no media row behind it
 * is not rendered — that is the arbitrary-URL path this module closes.
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../../../db/schema';

type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

/** 5 MB. Enforced by Blob via `maximumSizeInBytes`, and re-checked on confirm. */
export const MAX_COVER_BYTES = 5 * 1024 * 1024;

/** SVG is absent on purpose: it is a document that can carry script. */
export const ALLOWED_COVER_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
] as const;

/** Every member upload for a project lives under this prefix. */
export function coverPathPrefix(projectId: string): string {
  return `projects/${projectId}/`;
}

/** Public Vercel Blob hosts look like `<store>.public.blob.vercel-storage.com`. */
const BLOB_HOST = /^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$/i;

/** Every member portrait lives under this prefix. */
export function avatarPathPrefix(memberId: string): string {
  return `avatars/${memberId}/`;
}

/** Is this URL a Blob object under `prefix`? Pure; no network. */
export function isBlobUrlUnder(url: string, prefix: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || !BLOB_HOST.test(parsed.hostname)) return false;
  if (parsed.search || parsed.hash || parsed.username || parsed.password) return false;
  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname);
  } catch {
    return false;
  }
  return path.startsWith(`/${prefix}`) && !path.includes('/../');
}

/** Is this URL a Blob object under this project's prefix? */
export function isProjectBlobUrl(url: string, projectId: string): boolean {
  return isBlobUrlUnder(url, coverPathPrefix(projectId));
}

export interface BlobFacts {
  url: string;
  pathname: string;
  contentType: string;
  size: number;
}

export type RecordResult =
  | { ok: true; mediaId: string; url: string }
  | { ok: false; status: 403 | 404 | 422; error: string };

/**
 * Record (or find) the media row for an uploaded cover. Idempotent per URL:
 * the Blob callback and the confirm route may both arrive, in either order.
 *
 * `facts` must come from the server — Blob's signed callback, or `head()` —
 * never from the browser's description of what it uploaded.
 */
export async function recordCoverUpload(
  db: AnyDatabase,
  input: { memberId: string; projectId: string; alt: string; facts: BlobFacts },
): Promise<RecordResult> {
  const { facts } = input;
  if (!isProjectBlobUrl(facts.url, input.projectId)) {
    return { ok: false, status: 422, error: 'That upload is not one of this project’s images.' };
  }
  if (!(ALLOWED_COVER_TYPES as readonly string[]).includes(facts.contentType)) {
    return { ok: false, status: 422, error: 'Covers must be JPEG, PNG, WebP, GIF or AVIF.' };
  }
  if (facts.size > MAX_COVER_BYTES) {
    return { ok: false, status: 422, error: 'Covers must be 5 MB or smaller.' };
  }

  return db.transaction(async (tx) => {
    // Serialise the two possible writers for one URL.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${facts.url}))`);
    const [existing] = await tx
      .select({ id: schema.media.id, projectId: schema.media.projectId })
      .from(schema.media)
      .where(eq(schema.media.blobUrl, facts.url));
    if (existing) {
      if (existing.projectId !== input.projectId) {
        return { ok: false as const, status: 403 as const, error: 'That image belongs elsewhere.' };
      }
      return { ok: true as const, mediaId: existing.id, url: facts.url };
    }
    const [row] = await tx
      .insert(schema.media)
      .values({
        ownerMemberId: input.memberId,
        projectId: input.projectId,
        blobUrl: facts.url,
        pathname: facts.pathname,
        mimeType: facts.contentType,
        sizeBytes: facts.size,
        alt: input.alt,
        status: 'staged',
        kind: 'cover',
        // The member uploaded this themselves, which is the narrowest basis
        // there is: it covers this image on this site and says nothing about
        // anyone else in it. Written together with `consent` so the column is
        // never true without a basis beside it.
        consent: true,
        consentBasis: 'self_upload',
      })
      .returning({ id: schema.media.id });
    return { ok: true as const, mediaId: row.id, url: facts.url };
  });
}

export type AttachResult =
  | { ok: true; imageId: string | null; imagePath: string | null }
  | { ok: false; status: 422; error: string };

/**
 * Validate a cover choice for a project. Returns the column values to write.
 *
 * `null` clears the cover. Anything else must be a non-deleted media row that
 * was uploaded FOR THIS PROJECT — the association is what the upload route
 * authorised, so honouring it here is honouring that authorisation.
 */
export async function resolveCoverChoice(
  db: AnyDatabase,
  projectId: string,
  mediaId: string | null,
): Promise<AttachResult> {
  if (mediaId === null) return { ok: true, imageId: null, imagePath: null };
  const [row] = await db
    .select({ id: schema.media.id, blobUrl: schema.media.blobUrl })
    .from(schema.media)
    .where(
      and(
        eq(schema.media.id, mediaId),
        eq(schema.media.projectId, projectId),
        ne(schema.media.status, 'deleted'),
      ),
    );
  if (!row || !row.blobUrl) {
    return { ok: false, status: 422, error: 'Choose an image uploaded for this project.' };
  }
  return { ok: true, imageId: row.id, imagePath: row.blobUrl };
}

/**
 * Make the project's current cover public. Call inside the publish
 * transaction, or right after attaching a cover to an already-public project.
 */
export async function publishProjectCover(tx: AnyDatabase, projectId: string): Promise<void> {
  await tx.execute(sql`
    update media set status = 'published', updated_at = now()
    where id = (select image_id from projects where id = ${projectId})
      and project_id = ${projectId}
      and status = 'staged'
  `);
}

/**
 * Record (or find) a member's uploaded portrait. Same rules as a cover, with
 * the member's own prefix and no project.
 */
export async function recordAvatarUpload(
  db: AnyDatabase,
  input: { memberId: string; alt: string; facts: BlobFacts },
): Promise<RecordResult> {
  const { facts } = input;
  if (!isBlobUrlUnder(facts.url, avatarPathPrefix(input.memberId))) {
    return { ok: false, status: 422, error: 'That upload is not your portrait.' };
  }
  if (!(ALLOWED_COVER_TYPES as readonly string[]).includes(facts.contentType)) {
    return { ok: false, status: 422, error: 'Portraits must be JPEG, PNG, WebP, GIF or AVIF.' };
  }
  if (facts.size > MAX_COVER_BYTES) {
    return { ok: false, status: 422, error: 'Portraits must be 5 MB or smaller.' };
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${facts.url}))`);
    const [existing] = await tx
      .select({ id: schema.media.id, ownerMemberId: schema.media.ownerMemberId })
      .from(schema.media)
      .where(eq(schema.media.blobUrl, facts.url));
    if (existing) {
      if (existing.ownerMemberId !== input.memberId) {
        return { ok: false as const, status: 403 as const, error: 'That image belongs elsewhere.' };
      }
      return { ok: true as const, mediaId: existing.id, url: facts.url };
    }
    const [row] = await tx
      .insert(schema.media)
      .values({
        ownerMemberId: input.memberId,
        projectId: null,
        blobUrl: facts.url,
        pathname: facts.pathname,
        mimeType: facts.contentType,
        sizeBytes: facts.size,
        alt: input.alt,
        status: 'staged',
        kind: 'portrait',
        // A portrait of the member who uploaded it. Same basis as a cover.
        consent: true,
        consentBasis: 'self_upload',
      })
      .returning({ id: schema.media.id });
    return { ok: true as const, mediaId: row.id, url: facts.url };
  });
}
