/**
 * THE LOGO BOX — what a project's square image shows, and why.
 *
 * A project has two different images, and they are not interchangeable:
 *
 *   logo    the project's own mark (`projects.logo_media_id` / `logo_path`)
 *   cover   a screenshot or other project image (`image_id` / `image_path`)
 *
 * The logo box prefers, in order:
 *
 *   1. a logo an owner or organiser supplied (uploaded media, or a repository
 *      asset key an organiser set in Baserow)
 *   2. the project's own cover/screenshot, cropped to the square
 *   3. a favicon or app icon enriched from the project's ACCEPTED public
 *      website (`media.provenance = 'favicon'`) — ranked below real imagery,
 *      because a 32-pixel icon makes a poor picture of a project
 *   4. the directory's placeholder artwork — a WITH CLAUDE illustration, with
 *      a deterministic background so the same project always looks the same
 *
 * Nothing here ever returns a remote URL that was not stored as published
 * media first. The placeholder is directory artwork: it is labelled as such,
 * and is never presented as the project's logo or as an Anthropic mark.
 */

export type LogoSource =
  | {
      kind: 'logo';
      /** A published Blob URL or a repository asset key. */
      src: string;
      origin: 'upload' | 'organiser' | 'favicon';
      width?: number | null;
      height?: number | null;
    }
  | { kind: 'cover'; src: string }
  | { kind: 'placeholder'; variant: number };

/** Retained for callers that only need a stable bucket number (none left in
 * this codebase as of the category-motif redesign — `ProjectLogo.astro` now
 * derives its look from `resolveMotif()` using the project's category and
 * slug instead of this fixed count). Kept so `variant` on `LogoSource`
 * still means something if a caller re-introduces a fixed-variant use. */
export const PLACEHOLDER_VARIANTS = 6;

/** A stable small hash, so the same slug always gets the same placeholder. */
export function stableHash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const ASSET_KEY = /^[a-z0-9][a-z0-9/_.-]{0,199}$/i;
const isAssetKey = (v: string | null | undefined): v is string => Boolean(v && ASSET_KEY.test(v) && !v.includes('..'));
const isHttps = (v: string | null | undefined): v is string => Boolean(v && /^https:\/\//i.test(v));

export function resolveLogoSource(input: {
  slug: string;
  logoPath: string | null;
  /** Only a PUBLISHED, untombstoned media row; the caller has checked. */
  logoMedia: { url: string; provenance: string | null; width?: number | null; height?: number | null } | null;
  cover: string | null;
}): LogoSource {
  const media = input.logoMedia && isHttps(input.logoMedia.url) ? input.logoMedia : null;
  if (media && media.provenance !== 'favicon') {
    return { kind: 'logo', src: media.url, origin: media.provenance === 'organiser' ? 'organiser' : 'upload', width: media.width, height: media.height };
  }
  if (isAssetKey(input.logoPath)) return { kind: 'logo', src: input.logoPath, origin: 'organiser' };
  if (input.cover && (isHttps(input.cover) || isAssetKey(input.cover))) return { kind: 'cover', src: input.cover };
  if (media) return { kind: 'logo', src: media.url, origin: 'favicon', width: media.width, height: media.height };
  return { kind: 'placeholder', variant: stableHash(input.slug) % PLACEHOLDER_VARIANTS };
}
