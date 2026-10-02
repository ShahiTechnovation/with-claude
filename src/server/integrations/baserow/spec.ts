/**
 * THE BASEROW CONTENT SCHEMA — what the organisers' tables must contain.
 *
 * Names here are LOGICAL keys and human labels. The adapter never addresses a
 * Baserow field by its name (organisers rename columns); it addresses it by
 * field id, through the configuration in `config.ts`. This file says which
 * logical fields exist, what Baserow field type each must be, and whether the
 * projection can run without it. `validateSchema()` compares a live table's
 * field list against it before any sync, so a renamed or retyped column is a
 * configuration error with a clear message — not a silent data loss.
 *
 * Kept deliberately small: the four core tables. Featured collections,
 * recaps and media come later, when a page actually renders them.
 */

export type BaserowFieldType =
  | 'text'
  | 'long_text'
  | 'url'
  | 'number'
  | 'boolean'
  | 'date'
  | 'single_select'
  | 'multiple_select'
  | 'link_row';

export interface FieldSpec {
  label: string;
  /** Acceptable Baserow types. The first is what the setup guide creates. */
  types: readonly BaserowFieldType[];
  required: boolean;
  /** For selects: the option values the projection understands. */
  options?: readonly string[];
  /** For link_row: which logical table it must point at. */
  linksTo?: TableKey;
  /**
   * Written by the importer for organisers and never projected into Neon
   * (provenance and review notes). The DTO layer does not read it.
   */
  organiserOnly?: boolean;
}

export type TableKey = 'cities' | 'events' | 'projects' | 'credits';

export const EDITORIAL_STATUSES = ['draft', 'ready', 'published', 'archived'] as const;
export type EditorialStatus = (typeof EDITORIAL_STATUSES)[number];

export const EVENT_LIFECYCLES = ['scheduled', 'cancelled', 'sold-out', 'registration-closed'] as const;

export const EVENT_FORMATS = [
  'conversation',
  'workshop',
  'impact-lab',
  'campus',
  'hackathon',
  'demo',
  'meetup',
  'other',
] as const;

/** The team's own answer to "is it working?" — self-reported, never inferred. */
export const BUILD_STATUSES = ['functional', 'partial', 'prototype'] as const;

export const PROJECT_CATEGORIES = [
  'product',
  'agent',
  'developer-tool',
  'research',
  'creative',
  'campus',
  'experiment',
  'startup',
] as const;

export const SPEC = {
  /**
   * A REFERENCE table: one row per Neon city, seeded by the setup step and
   * read-only by convention. Rows here are matched to Neon by slug; an
   * unknown slug is quarantined, never auto-created — a city's existence is a
   * governance fact, not an edit.
   */
  cities: {
    slug: { label: 'Neon slug', types: ['text'], required: true },
    name: { label: 'Name', types: ['text'], required: false },
  },
  events: {
    key: { label: 'Key', types: ['text'], required: true },
    neonId: { label: 'Neon ID', types: ['text'], required: false },
    title: { label: 'Title', types: ['text'], required: true },
    slug: { label: 'Slug', types: ['text'], required: false },
    summary: { label: 'Summary', types: ['long_text', 'text'], required: true },
    description: { label: 'Description', types: ['long_text'], required: false },
    /**
     * Either a link to the Cities table, or — for a workspace without one — a
     * text field holding the Neon city slug (e.g. `bhopal`). Both resolve to an
     * EXISTING Neon city; an unknown slug is quarantined, never created.
     */
    city: { label: 'City', types: ['link_row', 'text'], required: true, linksTo: 'cities' },
    venueName: { label: 'Venue', types: ['text'], required: true },
    venueAddress: { label: 'Public address', types: ['long_text', 'text'], required: false },
    venuePrivate: { label: 'Address for registrants only', types: ['boolean'], required: false },
    date: { label: 'Date', types: ['date'], required: true },
    /** The originally announced date, when the event moved. Display-only. */
    rescheduledFrom: { label: 'Rescheduled from', types: ['date'], required: false },
    shortTitle: { label: 'Short title (badges)', types: ['text'], required: false },
    startTime: { label: 'Start time', types: ['text'], required: true },
    endTime: { label: 'End time', types: ['text'], required: false },
    timezone: { label: 'Timezone', types: ['text'], required: false },
    format: { label: 'Format', types: ['single_select'], required: true, options: EVENT_FORMATS },
    registrationUrl: { label: 'Registration URL', types: ['url'], required: false },
    coverRef: { label: 'Cover', types: ['text'], required: false },
    lifecycle: { label: 'Lifecycle', types: ['single_select'], required: false, options: EVENT_LIFECYCLES },
    editorialStatus: {
      label: 'Editorial status',
      types: ['single_select'],
      required: true,
      options: EDITORIAL_STATUSES,
    },
    featured: { label: 'Featured', types: ['boolean'], required: false },
    featuredOrder: { label: 'Featured order', types: ['number'], required: false },
    organiserLabels: { label: 'Organisers (public)', types: ['text'], required: false },
    sourceUrl: { label: 'Source URL', types: ['url'], required: false },
    lumaId: { label: 'Luma event id', types: ['text'], required: false },
    recapUrl: { label: 'Recap URL', types: ['url'], required: false },
  },
  projects: {
    key: { label: 'Key', types: ['text'], required: true },
    neonId: { label: 'Neon ID', types: ['text'], required: false },
    title: { label: 'Title', types: ['text'], required: true },
    slug: { label: 'Slug', types: ['text'], required: false },
    summary: { label: 'Summary', types: ['long_text', 'text'], required: true },
    description: { label: 'Description', types: ['long_text'], required: false },
    category: { label: 'Category', types: ['single_select'], required: true, options: PROJECT_CATEGORIES },
    tags: { label: 'Tags / tech', types: ['multiple_select', 'text'], required: false },
    liveUrl: { label: 'Live URL', types: ['url'], required: false },
    repoUrl: { label: 'Repo URL', types: ['url'], required: false },
    videoUrl: { label: 'Video URL', types: ['url'], required: false },
    coverRef: { label: 'Cover', types: ['text'], required: false },
    claudeUsage: { label: 'How Claude was used', types: ['long_text'], required: false },
    problem: { label: 'The problem', types: ['long_text'], required: false },
    solution: { label: 'The solution', types: ['long_text'], required: false },
    builtWith: { label: 'Built with (as stated)', types: ['long_text', 'text'], required: false },
    buildStatus: {
      label: 'Build status (self-reported)',
      types: ['single_select'],
      required: false,
      options: BUILD_STATUSES,
    },
    downloadUrl: { label: 'Download URL', types: ['url'], required: false },
    artifactUrl: { label: 'Other artifact URL', types: ['url'], required: false },
    altVideoUrl: { label: 'Second demo video URL', types: ['url'], required: false },
    logoRef: { label: 'Logo', types: ['text'], required: false },
    event: { label: 'Event', types: ['link_row'], required: false, linksTo: 'events' },
    city: { label: 'City', types: ['link_row', 'text'], required: false, linksTo: 'cities' },
    teamName: { label: 'Team name', types: ['text'], required: false },
    editorialStatus: {
      label: 'Editorial status',
      types: ['single_select'],
      required: true,
      options: EDITORIAL_STATUSES,
    },
    featured: { label: 'Featured', types: ['boolean'], required: false },
    featuredOrder: { label: 'Featured order', types: ['number'], required: false },
    sourceBatch: { label: 'Source batch', types: ['text'], required: false },
    sourceKey: { label: 'Source key', types: ['text'], required: false },
    /** Original worksheet rows, e.g. `Fable 5.1 Build Day: Form responses 1 rows 12, 75`. */
    sourceRows: { label: 'Source rows', types: ['text', 'long_text'], required: false, organiserOnly: true },
    /** Why a record or field is held, and what an organiser must decide. Privacy-safe text only. */
    reviewNotes: { label: 'Review notes', types: ['long_text'], required: false, organiserOnly: true },
  },
  credits: {
    project: { label: 'Project', types: ['link_row'], required: true, linksTo: 'projects' },
    displayName: { label: 'Display name', types: ['text'], required: true },
    role: { label: 'Role', types: ['text'], required: false },
    publicUrl: { label: 'Public profile URL', types: ['url'], required: false },
    displayOrder: { label: 'Display order', types: ['number'], required: false },
  },
} as const satisfies Record<TableKey, Record<string, FieldSpec>>;

export type LogicalField<T extends TableKey> = keyof (typeof SPEC)[T] & string;

/**
 * Dependency order for a full sync: a project needs its event and city. The
 * Cities table is optional (see `city` above); `configuredTables()` in
 * config.ts is this order restricted to what a workspace actually has.
 */
export const TABLE_ORDER: readonly TableKey[] = ['cities', 'events', 'projects', 'credits'];

export interface LiveField {
  id: number;
  name: string;
  type: string;
  link_row_table_id?: number;
  select_options?: { id: number; value: string }[];
}

export interface SchemaProblem {
  table: TableKey;
  field: string;
  problem: string;
}

/**
 * Compare a live table's fields with the spec, through the configured ids.
 *
 * Checks: every configured id exists; its type is acceptable; required fields
 * are configured; link fields point at the configured table; select fields
 * offer every option the projection understands (extra options are allowed
 * and reported by the DTO layer when used).
 */
export function validateSchema(
  table: TableKey,
  live: LiveField[],
  fieldIds: Record<string, number | undefined>,
  tableIds: Partial<Record<TableKey, number>>,
): SchemaProblem[] {
  const problems: SchemaProblem[] = [];
  const byId = new Map(live.map((f) => [f.id, f]));
  const spec = SPEC[table] as Record<string, FieldSpec>;

  for (const [key, field] of Object.entries(spec)) {
    const id = fieldIds[key];
    if (id === undefined) {
      if (field.required) problems.push({ table, field: key, problem: 'not configured (required)' });
      continue;
    }
    const liveField = byId.get(id);
    if (!liveField) {
      problems.push({ table, field: key, problem: `field_${id} does not exist in the table` });
      continue;
    }
    if (!field.types.includes(liveField.type as BaserowFieldType)) {
      problems.push({
        table,
        field: key,
        problem: `field_${id} ("${liveField.name}") is ${liveField.type}; expected ${field.types.join(' or ')}`,
      });
      continue;
    }
    if (field.linksTo && liveField.type === 'link_row' && tableIds[field.linksTo] === undefined) {
      problems.push({
        table,
        field: key,
        problem: `field_${id} links to a ${field.linksTo} table, but no ${field.linksTo} table is configured — configure it, or use a text field`,
      });
      continue;
    }
    if (field.linksTo && liveField.link_row_table_id !== undefined) {
      if (liveField.link_row_table_id !== tableIds[field.linksTo]) {
        problems.push({ table, field: key, problem: `links to table ${liveField.link_row_table_id}, expected ${field.linksTo}` });
      }
    }
    if (field.options && liveField.select_options) {
      const offered = new Set(liveField.select_options.map((o) => o.value.trim().toLowerCase()));
      const missing = field.options.filter((o) => !offered.has(o));
      if (missing.length) problems.push({ table, field: key, problem: `missing options: ${missing.join(', ')}` });
    }
  }
  return problems;
}
