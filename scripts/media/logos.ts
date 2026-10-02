/**
 * FAVICON / APP-ICON ENRICHMENT — import-time, never at render time.
 *
 * For each public project whose logo box would otherwise show the directory
 * placeholder, look at the project's ACCEPTED live website and try to find
 * its own icon. What counts as success is strict, because a wrong logo is
 * worse than the honest placeholder:
 *
 *   · only the stored, accepted `url` of a public project; nothing typed by a
 *     visitor, nothing from a request
 *   · only through `safeFetch()` (validated DNS, pinned sockets, bounded
 *     redirects, time and size limits)
 *   · the page is read as TEXT and searched for `<link rel=icon>` tags; no
 *     script ever runs. Candidates: declared icons (largest first), then
 *     `/favicon.ico`
 *   · raster formats only — SVG is refused outright (it can carry script),
 *     as is anything whose bytes are not the image type they claim
 *   · decoded and RE-ENCODED to PNG by sharp, metadata stripped; smaller than
 *     32×32 is "unusable", not upscaled
 *   · an icon that is a hosting platform's or framework's default is not the
 *     project's brand: hosts whose icon is the platform's are skipped, a
 *     known-default list is honoured, and an identical icon on two unrelated
 *     projects is treated as a default for both
 *   · stored in the site's own media store with its source URL and
 *     `provenance = 'favicon'`, so pages never hotlink a participant's site
 *
 * Without a media store (no Blob token) nothing is written and every project
 * is reported as deferred — the placeholder is already correct.
 */
import { createHash } from 'node:crypto';
import { and, eq, isNull, isNotNull, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import sharp from 'sharp';
import * as schema from '../../db/schema';
import { publicProjectWhere } from '../../src/server/projects/lifecycle';
import { safeFetch, UnsafeTarget, type SafeFetchOptions } from '../import/lib/safe-fetch';

type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

/** Hosts whose icon is the PLATFORM's, not the project's. */
const PLATFORM_ICON_HOSTS = [
  /(^|\.)github\.com$/,
  /(^|\.)githubusercontent\.com$/,
  /(^|\.)google\.com$/,
  /(^|\.)youtube\.com$/,
  /(^|\.)youtu\.be$/,
  /(^|\.)vercel\.com$/,
  /(^|\.)claude\.ai$/,
  /(^|\.)huggingface\.co$/,
  /(^|\.)streamlit\.app$/,
  /(^|\.)replit\.app$/,
  /(^|\.)canva\.(com|link)$/,
  /(^|\.)loom\.com$/,
  /(^|\.)dropbox\.com$/,
  /(^|\.)linkedin\.com$/,
  /(^|\.)x\.com$/,
];

export function isPlatformIconHost(host: string): boolean {
  return PLATFORM_ICON_HOSTS.some((re) => re.test(host.toLowerCase()));
}

export interface IconCandidate {
  url: string;
  declaredSize: number;
}

/** `<link rel="icon" …>` tags in a page, resolved against it. Text only. */
export function iconCandidates(html: string, pageUrl: string): IconCandidate[] {
  const out: IconCandidate[] = [];
  // Only real markup counts: a tag inside a script, a style or a comment is
  // text, not a declaration (and nothing here ever executes it).
  const head = html
    .slice(0, 200_000)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, '');
  for (const tag of head.match(/<link\b[^>]*>/gi) ?? []) {
    const attr = (name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
    const rel = (attr('rel')?.slice(2).find(Boolean) ?? '').toLowerCase();
    if (!/(^|\s)(icon|apple-touch-icon|apple-touch-icon-precomposed)(\s|$)/.test(rel)) continue;
    const href = attr('href')?.slice(2).find(Boolean);
    if (!href || /^(data|javascript|blob):/i.test(href.trim())) continue;
    const type = (attr('type')?.slice(2).find(Boolean) ?? '').toLowerCase();
    if (type.includes('svg') || /\.svg(\?|#|$)/i.test(href)) continue;
    const sizes = attr('sizes')?.slice(2).find(Boolean) ?? '';
    const declared = Math.max(0, ...[...sizes.matchAll(/(\d+)x\d+/gi)].map((m) => Number(m[1])));
    try {
      out.push({ url: new URL(href.trim(), pageUrl).toString(), declaredSize: declared || (rel.includes('apple') ? 180 : 0) });
    } catch {
      /* unparseable href: ignore */
    }
  }
  out.sort((a, b) => b.declaredSize - a.declaredSize);
  const fallback = new URL('/favicon.ico', pageUrl).toString();
  if (!out.some((c) => c.url === fallback)) out.push({ url: fallback, declaredSize: 0 });
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true))).slice(0, 4);
}

/** The largest usable image inside an ICO container, as PNG or raw RGBA. */
export function readIco(bytes: Buffer): { png: Buffer } | { raw: Buffer; width: number; height: number } | null {
  if (bytes.length < 22 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) return null;
  const count = bytes.readUInt16LE(4);
  if (count === 0 || count > 64) return null;
  let best: { offset: number; size: number; px: number } | null = null;
  for (let i = 0; i < count; i += 1) {
    const e = 6 + i * 16;
    if (e + 16 > bytes.length) return null;
    const px = bytes[e] || 256;
    const size = bytes.readUInt32LE(e + 8);
    const offset = bytes.readUInt32LE(e + 12);
    if (offset + size > bytes.length || size < 8) continue;
    if (!best || px > best.px) best = { offset, size, px };
  }
  if (!best) return null;
  const data = bytes.subarray(best.offset, best.offset + best.size);
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { png: data };
  // A DIB: only uncompressed 32-bit BGRA is supported (anything else is rare and small).
  if (data.length < 40 || data.readUInt32LE(0) !== 40) return null;
  const width = data.readInt32LE(4);
  const height = Math.abs(data.readInt32LE(8)) / 2;
  const bpp = data.readUInt16LE(14);
  const compression = data.readUInt32LE(16);
  if (bpp !== 32 || compression !== 0 || width <= 0 || height <= 0 || width > 512 || height > 512) return null;
  const rowBytes = width * 4;
  if (40 + rowBytes * height > data.length) return null;
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const src = 40 + (height - 1 - y) * rowBytes; // bottom-up
    for (let x = 0; x < width; x += 1) {
      const s = src + x * 4;
      const d = (y * width + x) * 4;
      raw[d] = data[s + 2]!;
      raw[d + 1] = data[s + 1]!;
      raw[d + 2] = data[s]!;
      raw[d + 3] = data[s + 3]!;
    }
  }
  return { raw, width, height };
}

export interface DecodedIcon {
  png: Buffer;
  width: number;
  height: number;
  /** Hash of the decoded pixels — the same icon served twice hashes the same. */
  pixelHash: string;
}

export type DecodeFailure = 'svg' | 'not-an-image' | 'too-small' | 'too-large' | 'unsupported';

const RASTER_TYPES = /^image\/(png|x-icon|vnd\.microsoft\.icon|ico|jpeg|jpg|webp|gif)$/i;

/** Bytes → a clean PNG, or why not. Never trusts the declared content type alone. */
export async function decodeIcon(bytes: Buffer, contentType: string | undefined): Promise<DecodedIcon | DecodeFailure> {
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  const head = bytes.subarray(0, 256).toString('latin1').trimStart().toLowerCase();
  if (type.includes('svg') || head.startsWith('<svg') || head.startsWith('<?xml') || head.includes('<svg')) return 'svg';
  if (head.startsWith('<!doctype') || head.startsWith('<html')) return 'not-an-image';
  if (type && !RASTER_TYPES.test(type) && type !== 'application/octet-stream') return 'not-an-image';
  if (bytes.length > 256 * 1024) return 'too-large';
  try {
    let input: sharp.Sharp;
    const ico = readIco(bytes);
    if (ico && 'png' in ico) input = sharp(ico.png, { limitInputPixels: 1024 * 1024 });
    else if (ico) input = sharp(ico.raw, { raw: { width: ico.width, height: ico.height, channels: 4 } });
    else {
      const meta = await sharp(bytes, { limitInputPixels: 4096 * 4096 }).metadata();
      if (!meta.format || !['png', 'jpeg', 'webp', 'gif'].includes(meta.format)) return 'unsupported';
      input = sharp(bytes, { limitInputPixels: 4096 * 4096, animated: false });
    }
    const meta = await input.metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width < 32 || height < 32) return 'too-small';
    if (width > 2048 || height > 2048) return 'too-large';
    const normalised = input.clone().resize({ width: 256, height: 256, fit: 'inside', withoutEnlargement: true });
    const png = await normalised.clone().png({ compressionLevel: 9 }).toBuffer();
    const raw = await normalised.clone().ensureAlpha().raw().toBuffer();
    const outMeta = await sharp(png).metadata();
    return {
      png,
      width: outMeta.width ?? width,
      height: outMeta.height ?? height,
      pixelHash: createHash('sha256').update(raw).digest('hex'),
    };
  } catch {
    return 'not-an-image';
  }
}

export type LogoOutcome =
  | { slug: string; result: 'stored'; source: string; width: number; height: number }
  | { slug: string; result: 'found-not-stored'; source: string; width: number; height: number; pixelHash: string }
  | { slug: string; result: 'skipped'; reason: string }
  | { slug: string; result: 'no-icon'; reason: string };

export interface LogoStore {
  put(pathname: string, png: Buffer): Promise<{ url: string; pathname: string }>;
}

export async function enrichLogos(input: {
  db: AnyDatabase;
  /** Absent → probe only; nothing is written. */
  store: LogoStore | null;
  knownGeneric?: Set<string>;
  limit?: number;
  fetchOptions?: Pick<SafeFetchOptions, 'resolve' | 'transport'>;
}): Promise<{ outcomes: LogoOutcome[]; deferred: boolean }> {
  const { db, store } = input;
  const rows = await db
    .select({ id: schema.projects.id, slug: schema.projects.slug, title: schema.projects.title, url: schema.projects.url })
    .from(schema.projects)
    .where(
      and(
        publicProjectWhere(),
        isNotNull(schema.projects.url),
        isNull(schema.projects.logoMediaId),
        isNull(schema.projects.logoPath),
        // A cover outranks a favicon in the logo box; do not fetch for nothing.
        isNull(schema.projects.imageId),
        sql`(${schema.projects.imagePath} IS NULL OR ${schema.projects.imagePath} ~* '^[a-z][a-z0-9+.-]*:')`,
      ),
    )
    .orderBy(schema.projects.slug)
    .limit(input.limit ?? 200);

  const found: { row: (typeof rows)[number]; source: string; icon: DecodedIcon; host: string }[] = [];
  const outcomes: LogoOutcome[] = [];
  for (const row of rows) {
    let page: URL;
    try {
      page = new URL(row.url!);
    } catch {
      outcomes.push({ slug: row.slug, result: 'skipped', reason: 'not a URL' });
      continue;
    }
    if (isPlatformIconHost(page.hostname)) {
      outcomes.push({ slug: row.slug, result: 'skipped', reason: `${page.hostname} serves the platform's icon, not the project's` });
      continue;
    }
    let candidates: IconCandidate[] = [{ url: new URL('/favicon.ico', page).toString(), declaredSize: 0 }];
    try {
      const html = await safeFetch(page.toString(), { accept: 'text/html', maxBytes: 512 * 1024, ...input.fetchOptions });
      const type = String(html.headers['content-type'] ?? '');
      if (html.status < 400 && type.includes('html')) candidates = iconCandidates(html.body.toString('utf8'), html.finalUrl);
    } catch (error) {
      if (error instanceof UnsafeTarget) {
        outcomes.push({ slug: row.slug, result: 'skipped', reason: `unsafe target: ${error.reason}` });
        continue;
      }
      // Unreachable page: /favicon.ico may still answer.
    }
    let done = false;
    const failures: string[] = [];
    for (const candidate of candidates) {
      const host = new URL(candidate.url).hostname;
      if (isPlatformIconHost(host)) {
        failures.push('platform icon host');
        continue;
      }
      try {
        const res = await safeFetch(candidate.url, { accept: 'image/*', maxBytes: 256 * 1024, ...input.fetchOptions });
        if (res.status >= 400 || res.truncated) {
          failures.push(res.truncated ? 'too large' : `HTTP ${res.status}`);
          continue;
        }
        const icon = await decodeIcon(res.body, String(res.headers['content-type'] ?? ''));
        if (typeof icon === 'string') {
          failures.push(icon);
          continue;
        }
        if (input.knownGeneric?.has(icon.pixelHash)) {
          failures.push('a known default icon');
          continue;
        }
        found.push({ row, source: res.finalUrl, icon, host: page.hostname });
        done = true;
        break;
      } catch (error) {
        failures.push(error instanceof UnsafeTarget ? `unsafe: ${error.reason}` : 'unreachable');
      }
    }
    if (!done) outcomes.push({ slug: row.slug, result: 'no-icon', reason: [...new Set(failures)].join(', ') || 'none found' });
  }

  // The same pixels on two unrelated sites is a framework or platform default.
  const hosts = new Map<string, Set<string>>();
  for (const f of found) hosts.set(f.icon.pixelHash, (hosts.get(f.icon.pixelHash) ?? new Set()).add(f.host));
  for (const f of found) {
    if ((hosts.get(f.icon.pixelHash)?.size ?? 0) > 1) {
      outcomes.push({ slug: f.row.slug, result: 'no-icon', reason: 'identical icon on unrelated projects — a default, not a brand' });
      continue;
    }
    if (!store) {
      outcomes.push({ slug: f.row.slug, result: 'found-not-stored', source: f.source, width: f.icon.width, height: f.icon.height, pixelHash: f.icon.pixelHash });
      continue;
    }
    const pathname = `logos/${f.row.slug}-${f.icon.pixelHash.slice(0, 12)}.png`;
    const blob = await store.put(pathname, f.icon.png);
    await db.transaction(async (tx) => {
      const [media] = await tx
        .insert(schema.media)
        .values({
          projectId: f.row.id,
          blobUrl: blob.url,
          pathname: blob.pathname,
          mimeType: 'image/png',
          sizeBytes: f.icon.png.length,
          alt: `${f.row.title} icon`,
          credit: `Icon from the project's website (${new URL(f.source).hostname})`,
          provenance: 'favicon',
          sourceUrl: f.source,
          status: 'published',
          kind: 'logo',
          width: f.icon.width,
          height: f.icon.height,
        })
        .returning({ id: schema.media.id });
      // Only if nobody set a logo meanwhile.
      await tx
        .update(schema.projects)
        .set({ logoMediaId: media!.id })
        .where(and(eq(schema.projects.id, f.row.id), isNull(schema.projects.logoMediaId)));
    });
    outcomes.push({ slug: f.row.slug, result: 'stored', source: f.source, width: f.icon.width, height: f.icon.height });
  }
  return { outcomes, deferred: !store };
}
