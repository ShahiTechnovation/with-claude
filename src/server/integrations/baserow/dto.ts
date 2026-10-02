/**
 * BASEROW ROWS → VALIDATED DTOs.
 *
 * Every value from Baserow is UNTRUSTED: an organiser's spreadsheet-like
 * table can hold anything, and a token leak would let anybody write there.
 * So each row is read by FIELD ID through the configuration, coerced from
 * Baserow's wire shapes (select objects, link arrays, number strings), and
 * validated — lengths, URL schemes, enums, dates, times, time zones.
 *
 * What a DTO deliberately cannot carry: an owner, a member, a role, a
 * moderation state, a "verified" flag. Even `neonId` is only a request to
 * ADOPT an existing record, which the projection checks against content
 * authority before honouring.
 *
 * A row that fails validation produces a list of problems, and the projection
 * quarantines it: the last valid version stays live.
 */
import { createHash } from 'node:crypto';
import type { BaserowConfig } from './config';
import {
  BUILD_STATUSES,
  EDITORIAL_STATUSES,
  EVENT_FORMATS,
  EVENT_LIFECYCLES,
  PROJECT_CATEGORIES,
  type EditorialStatus,
  type TableKey,
} from './spec';

export type RawRow = Record<string, unknown> & { id: number };

export type Parsed<T> = { ok: true; dto: T } | { ok: false; problems: string[] };

// ── coercion helpers ─────────────────────────────────────────────────────

const SLUG = /^[a-z0-9][a-z0-9-]{1,79}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Asset keys are repository paths: no scheme, no traversal. */
const ASSET_KEY = /^[a-z0-9][a-z0-9/_.-]{0,199}$/i;

class Reader {
  problems: string[] = [];
  constructor(
    private row: RawRow,
    private fields: Record<string, number>,
  ) {}

  private raw(key: string): unknown {
    const id = this.fields[key];
    return id === undefined ? undefined : this.row[`field_${id}`];
  }

  text(key: string, max: number, required = false): string | null {
    const v = this.raw(key);
    const s = typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim() : v == null ? '' : String(v).trim();
    if (!s) {
      if (required) this.problems.push(`${key} is required`);
      return null;
    }
    if (s.length > max) {
      this.problems.push(`${key} is longer than ${max} characters`);
      return null;
    }
    // Control characters other than newline/tab never belong in public text.
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) {
      this.problems.push(`${key} contains control characters`);
      return null;
    }
    return s;
  }

  url(key: string): string | null {
    const s = this.text(key, 500);
    if (!s) return null;
    try {
      const u = new URL(s);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
      if (u.username || u.password) throw new Error('credentials');
      return u.toString();
    } catch {
      this.problems.push(`${key} is not a valid http(s) link`);
      return null;
    }
  }

  bool(key: string): boolean {
    return this.raw(key) === true;
  }

  number(key: string): number | null {
    const v = this.raw(key);
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n) || Math.abs(n) > 1e6) {
      this.problems.push(`${key} is not a number`);
      return null;
    }
    return n;
  }

  date(key: string, required = false): string | null {
    const s = this.text(key, 40, required);
    if (!s) return null;
    const day = s.slice(0, 10);
    if (!DATE.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
      this.problems.push(`${key} is not a date (YYYY-MM-DD)`);
      return null;
    }
    return day;
  }

  clock(key: string, required = false): string | null {
    const s = this.text(key, 10, required);
    if (!s) return null;
    if (!CLOCK.test(s)) {
      this.problems.push(`${key} must be a 24-hour time like 18:30`);
      return null;
    }
    return s;
  }

  select<T extends string>(key: string, allowed: readonly T[], required = false): T | null {
    const v = this.raw(key);
    const value =
      v && typeof v === 'object' && 'value' in (v as object)
        ? String((v as { value: unknown }).value)
        : typeof v === 'string'
          ? v
          : '';
    const norm = value.trim().toLowerCase().replace(/\s+/g, '-');
    if (!norm) {
      if (required) this.problems.push(`${key} is required`);
      return null;
    }
    if (!(allowed as readonly string[]).includes(norm)) {
      this.problems.push(`${key} "${value}" is not one of ${allowed.join(', ')}`);
      return null;
    }
    return norm as T;
  }

  tags(key: string): string[] {
    const v = this.raw(key);
    const list = Array.isArray(v)
      ? v.map((o) => (o && typeof o === 'object' && 'value' in o ? String((o as { value: unknown }).value) : String(o)))
      : typeof v === 'string'
        ? v.split(',')
        : [];
    const tags = [...new Set(list.map((t) => t.trim()).filter(Boolean))];
    if (tags.some((t) => t.length > 32)) this.problems.push(`${key} has a tag longer than 32 characters`);
    return tags.slice(0, 12).filter((t) => t.length <= 32);
  }

  /**
   * A city reference: a link to the Cities table (`[{ id, value }]`), or a
   * text field holding a Neon city slug. Never both; never a city name.
   */
  cityRef(key: string, required = false): { rowId: number | null; slug: string | null } {
    const v = this.raw(key);
    if (Array.isArray(v)) {
      const [rowId] = this.links(key, required);
      return { rowId: rowId ?? null, slug: null };
    }
    const slug = this.text(key, 80, required);
    if (slug && !SLUG.test(slug)) {
      this.problems.push(`${key} "${slug.slice(0, 40)}" is not a city slug (lower-case, e.g. bhopal)`);
      return { rowId: null, slug: null };
    }
    return { rowId: null, slug };
  }

  links(key: string, required = false): number[] {
    const v = this.raw(key);
    const ids = Array.isArray(v)
      ? v
          .map((o) => (o && typeof o === 'object' && 'id' in o ? Number((o as { id: unknown }).id) : NaN))
          .filter((n) => Number.isInteger(n) && n > 0)
      : [];
    if (required && ids.length === 0) this.problems.push(`${key} is required`);
    return ids;
  }
}

// ── DTOs ─────────────────────────────────────────────────────────────────

export interface CityRefDTO {
  rowId: number;
  slug: string;
}

export interface EventDTO {
  rowId: number;
  key: string;
  neonId: string | null;
  title: string;
  slug: string | null;
  summary: string;
  description: string | null;
  /** Exactly one of these is set: a Cities-table link, or a Neon city slug. */
  cityRowId: number | null;
  citySlug: string | null;
  venueName: string;
  venueAddress: string | null;
  venuePrivate: boolean;
  date: string;
  rescheduledFrom: string | null;
  shortTitle: string | null;
  startTime: string;
  endTime: string | null;
  timezone: string;
  format: (typeof EVENT_FORMATS)[number];
  registrationUrl: string | null;
  coverRef: string | null;
  lifecycle: (typeof EVENT_LIFECYCLES)[number];
  editorialStatus: EditorialStatus;
  featured: boolean;
  lumaId: string | null;
}

export interface ProjectDTO {
  rowId: number;
  key: string;
  neonId: string | null;
  title: string;
  slug: string | null;
  summary: string;
  description: string | null;
  category: (typeof PROJECT_CATEGORIES)[number];
  tags: string[];
  liveUrl: string | null;
  repoUrl: string | null;
  videoUrl: string | null;
  coverRef: string | null;
  claudeUsage: string | null;
  problem: string | null;
  solution: string | null;
  builtWith: string | null;
  buildStatus: (typeof BUILD_STATUSES)[number] | null;
  downloadUrl: string | null;
  artifactUrl: string | null;
  altVideoUrl: string | null;
  logoRef: string | null;
  eventRowId: number | null;
  cityRowId: number | null;
  citySlug: string | null;
  teamName: string | null;
  editorialStatus: EditorialStatus;
  featured: boolean;
  featuredOrder: number | null;
}

export interface CreditDTO {
  rowId: number;
  projectRowId: number;
  displayName: string;
  role: string | null;
  publicUrl: string | null;
  displayOrder: number;
}

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function fieldsOf(config: BaserowConfig, table: TableKey): Record<string, number> {
  return config.tables[table]?.fields ?? {};
}

export function parseCity(row: RawRow, config: BaserowConfig): Parsed<CityRefDTO> {
  const r = new Reader(row, fieldsOf(config, 'cities'));
  const slug = r.text('slug', 80, true);
  if (slug && !SLUG.test(slug)) r.problems.push('slug is not a valid city slug');
  return r.problems.length ? { ok: false, problems: r.problems } : { ok: true, dto: { rowId: row.id, slug: slug! } };
}

export function parseEvent(row: RawRow, config: BaserowConfig): Parsed<EventDTO> {
  const r = new Reader(row, fieldsOf(config, 'events'));
  const key = r.text('key', 120, true);
  const neonId = r.text('neonId', 40);
  if (neonId && !UUID.test(neonId)) r.problems.push('neonId is not a UUID');
  const slug = r.text('slug', 80);
  if (slug && !SLUG.test(slug)) r.problems.push('slug must be lower-case letters, numbers and dashes');
  const city = r.cityRef('city', true);
  const startTime = r.clock('startTime', true);
  const endTime = r.clock('endTime');
  if (startTime && endTime && endTime <= startTime) r.problems.push('endTime must be after startTime');
  const timezone = r.text('timezone', 60) ?? 'Asia/Kolkata';
  if (!isTimeZone(timezone)) r.problems.push(`timezone "${timezone}" is not an IANA zone`);
  const coverRef = r.text('coverRef', 200);
  if (coverRef && (!ASSET_KEY.test(coverRef) || coverRef.includes('..'))) {
    r.problems.push('coverRef must be a repository asset key, not a URL');
  }
  const dto: EventDTO = {
    rowId: row.id,
    key: key ?? '',
    neonId,
    title: r.text('title', 160, true) ?? '',
    slug,
    summary: r.text('summary', 600, true) ?? '',
    description: r.text('description', 10_000),
    cityRowId: city.rowId,
    citySlug: city.slug,
    venueName: r.text('venueName', 200, true) ?? '',
    venueAddress: r.text('venueAddress', 400),
    venuePrivate: r.bool('venuePrivate'),
    date: r.date('date', true) ?? '',
    rescheduledFrom: r.date('rescheduledFrom'),
    shortTitle: r.text('shortTitle', 60),
    startTime: startTime ?? '',
    endTime,
    timezone,
    format: r.select('format', EVENT_FORMATS, true) ?? 'other',
    registrationUrl: r.url('registrationUrl'),
    coverRef,
    lifecycle: r.select('lifecycle', EVENT_LIFECYCLES) ?? 'scheduled',
    editorialStatus: r.select('editorialStatus', EDITORIAL_STATUSES, true) ?? 'draft',
    featured: r.bool('featured'),
    lumaId: r.text('lumaId', 80),
  };
  return r.problems.length ? { ok: false, problems: r.problems } : { ok: true, dto };
}

export function parseProject(row: RawRow, config: BaserowConfig): Parsed<ProjectDTO> {
  const r = new Reader(row, fieldsOf(config, 'projects'));
  const neonId = r.text('neonId', 40);
  if (neonId && !UUID.test(neonId)) r.problems.push('neonId is not a UUID');
  const slug = r.text('slug', 80);
  if (slug && !SLUG.test(slug)) r.problems.push('slug must be lower-case letters, numbers and dashes');
  const coverRef = r.text('coverRef', 200);
  if (coverRef && (!ASSET_KEY.test(coverRef) || coverRef.includes('..'))) {
    r.problems.push('coverRef must be a repository asset key, not a URL');
  }
  const logoRef = r.text('logoRef', 200);
  if (logoRef && (!ASSET_KEY.test(logoRef) || logoRef.includes('..'))) {
    r.problems.push('logoRef must be a repository asset key, not a URL');
  }
  const summary = r.text('summary', 300, true);
  if (summary && summary.length < 5) r.problems.push('summary needs at least five characters');
  const city = r.cityRef('city');
  const dto: ProjectDTO = {
    rowId: row.id,
    key: r.text('key', 160, true) ?? '',
    neonId,
    title: r.text('title', 100, true) ?? '',
    slug,
    summary: summary ?? '',
    description: r.text('description', 10_000),
    category: r.select('category', PROJECT_CATEGORIES, true) ?? 'experiment',
    tags: r.tags('tags'),
    liveUrl: r.url('liveUrl'),
    repoUrl: r.url('repoUrl'),
    videoUrl: r.url('videoUrl'),
    coverRef,
    claudeUsage: r.text('claudeUsage', 1_000),
    problem: r.text('problem', 12_000),
    solution: r.text('solution', 12_000),
    builtWith: r.text('builtWith', 2_000),
    buildStatus: r.select('buildStatus', BUILD_STATUSES),
    downloadUrl: r.url('downloadUrl'),
    artifactUrl: r.url('artifactUrl'),
    altVideoUrl: r.url('altVideoUrl'),
    logoRef,
    eventRowId: r.links('event')[0] ?? null,
    cityRowId: city.rowId,
    citySlug: city.slug,
    teamName: r.text('teamName', 120),
    editorialStatus: r.select('editorialStatus', EDITORIAL_STATUSES, true) ?? 'draft',
    featured: r.bool('featured'),
    featuredOrder: r.number('featuredOrder'),
  };
  if (dto.title && dto.title.length < 2) r.problems.push('title needs at least two characters');
  return r.problems.length ? { ok: false, problems: r.problems } : { ok: true, dto };
}

export function parseCredit(row: RawRow, config: BaserowConfig): Parsed<CreditDTO> {
  const r = new Reader(row, fieldsOf(config, 'credits'));
  const [projectRowId] = r.links('project', true);
  const dto: CreditDTO = {
    rowId: row.id,
    projectRowId: projectRowId ?? 0,
    displayName: r.text('displayName', 120, true) ?? '',
    role: r.text('role', 80),
    publicUrl: r.url('publicUrl'),
    displayOrder: Math.max(0, Math.min(999, Math.trunc(r.number('displayOrder') ?? 0))),
  };
  return r.problems.length ? { ok: false, problems: r.problems } : { ok: true, dto };
}

/**
 * Stable content hash of a DTO and the references it resolved to. Key order
 * is normalised so the same content always hashes the same.
 */
export function contentHash(value: unknown): string {
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
          )
        : v;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
