/**
 * PROJECT COVER — centralized image resolution.
 *
 * A project's `image` field (mapped from `imagePath` in the DB) has two
 * possible values:
 *
 *   1. A repository-relative asset key, e.g. `projects/my-project.jpg`.
 *      These are files in `src/assets/`, processed by the Astro Image
 *      pipeline at build time. `asset()` resolves them to `ImageMetadata`.
 *      The `<Image>` component uses this metadata for optimised output.
 *
 *   2. An absolute Blob URL, e.g. `https://xyz.blob.vercel-storage.com/...`.
 *      Uploaded by members via the Vercel Blob client upload flow. These
 *      were never processed at build time — `asset()` returns `undefined`
 *      for them because they are not in the registry — so they must be
 *      rendered as a plain `<img src>` instead.
 *
 * An absolute URL counts only when it is a public Vercel Blob URL. Any other
 * host (a stock-photo service, a hotlink) is not a cover anyone uploaded, so
 * it resolves to none and the card shows its honest placeholder.
 * A relative path (no `://`) is a repository asset key.
 *
 * Without this module, every template that renders a project cover had to
 * duplicate the `if (startsWith('http'))` branch, or silently show no image
 * for member-uploaded covers (which is what was happening before this fix).
 * This is the ONE place that decides.
 */

import type { ImageMetadata } from 'astro';
import { asset } from '@/lib/images';

// The same host rule as src/server/media/covers.ts, which isn't imported here
// because it pulls in the database.
const BLOB_HOST = /^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$/i;

function isBlobUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && BLOB_HOST.test(parsed.hostname);
  } catch {
    return false;
  }
}

export type CoverKind = 'blob' | 'asset' | 'none';

export interface ResolvedCover {
  kind: CoverKind;
  /** Present when kind = 'blob'. The absolute URL for a plain <img src>. */
  blobUrl?: string;
  /** Present when kind = 'asset'. The ImageMetadata for <Image>. */
  imageMetadata?: ImageMetadata;
}

/**
 * Resolve a project's image field to a renderable cover.
 *
 * Returns `{ kind: 'none' }` when:
 *   - `image` is null, undefined or empty
 *   - `image` is a relative key but `asset()` cannot find it in the registry
 *
 * Never throws.
 */
export function resolveProjectCover(image: string | null | undefined): ResolvedCover {
  if (!image) return { kind: 'none' };

  // Absolute URL → a member's Blob upload, rendered as a plain <img>.
  if (/^https?:\/\//i.test(image)) {
    return isBlobUrl(image) ? { kind: 'blob', blobUrl: image } : { kind: 'none' };
  }

  // Relative key → repo asset. Run through the Astro image pipeline.
  const metadata = asset(image);
  if (!metadata) return { kind: 'none' };

  return { kind: 'asset', imageMetadata: metadata };
}
