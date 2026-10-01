/**
 * THE PROJECTION — one validated Baserow row into Neon, or a reason not to.
 *
 * Rules this file exists to keep:
 *
 *   ONE WRITER PER ROW. A row is written here only if its content authority is
 *   `baserow`. A member-created project, or an imported one somebody has
 *   successfully claimed (`member`), is never touched: its mapping is marked
 *   `released` and the Baserow edit is ignored. A curated event or project is
 *   touched only when a Baserow row explicitly ADOPTS it by `neonId`, which
 *   moves its authority to `baserow`.
 *
 *   IDENTITY IS THE ROW ID. `(provider, table, row)` → entity, through
 *   `integration_mappings`. Never a title, never a slug, never a position.
 *
 *   NEVER MODERATION. Nothing here writes `moderation_state`; the public
 *   predicate requires `clean`, so a moderator's hold outranks any
 *   publication intent in Baserow, immediately and permanently.
 *
 *   INVALID IS QUARANTINED, NOT APPLIED. The last valid version keeps serving.
 *
 *   DELETION IS ARCHIVAL. A deleted Baserow row unpublishes its projection
 *   and tombstones the mapping; nothing is erased, nothing cascades.
 *
 *   SERIALISED AND IDEMPOTENT. Each row is applied inside a transaction that
 *   holds an advisory lock on its identity, and an unchanged content hash is a
 *   no-op — so duplicate or out-of-order webhooks converge on the current row.
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../../../../db/schema';
import { legacyStatusFor, type PublicationStatus } from '../../projects/lifecycle';
import { nextAvailableSlug, slugifyTitle } from '../../members/projects';
import type { BaserowConfig } from './config';
import {
  contentHash,
  parseCity,
  parseCredit,
  parseEvent,
  parseProject,
  type CreditDTO,
  type EventDTO,
  type ProjectDTO,
  type RawRow,
} from './dto';
import type { TableKey } from './spec';

type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

export type ApplyOutcome = 'applied' | 'unchanged' | 'quarantined' | 'held' | 'skipped' | 'tombstoned';

export interface ApplyResult {
  outcome: ApplyOutcome;
  entityId?: string | null;
  detail?: string;
  /** Rows whose projection depends on this one and should be re-applied. */
  followUps?: { table: TableKey; rowId: number }[];
}

const ACTOR = 'system:baserow';
const ENTITY: Record<TableKey, (typeof schema.integrationEntity.enumValues)[number]> = {
  cities: 'city',
  events: 'event',
  projects: 'project',
  credits: 'project_credit',
};

// ── mapping helpers ──────────────────────────────────────────────────────

async function lockRow(tx: AnyDatabase, tableId: number, rowId: number) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`baserow:${tableId}:${rowId}`}))`);
}

async function mappingOf(tx: AnyDatabase, tableId: number, rowId: number) {
  const [row] = await tx
    .select()
    .from(schema.integrationMappings)
    .where(
      and(
        eq(schema.integrationMappings.provider, 'baserow'),
        eq(schema.integrationMappings.tableId, tableId),
        eq(schema.integrationMappings.rowId, rowId),
      ),
    );
  return row ?? null;
}

type MappingWrite = {
  entityId?: string | null;
  contentHash?: string | null;
  status: (typeof schema.integrationMappingStatus.enumValues)[number];
  lastError?: string | null;
  applied?: boolean;
};

async function writeMapping(
  tx: AnyDatabase,
  table: TableKey,
  tableId: number,
  rowId: number,
  write: MappingWrite,
  now: Date,
) {
  const values = {
    status: write.status,
    lastError: write.lastError ? write.lastError.slice(0, 500) : null,
    lastSeenAt: now,
    updatedAt: now,
    ...(write.entityId !== undefined ? { entityId: write.entityId } : {}),
    ...(write.contentHash !== undefined ? { contentHash: write.contentHash } : {}),
    ...(write.applied ? { lastAppliedAt: now } : {}),
  };
  await tx
    .insert(schema.integrationMappings)
    .values({ provider: 'baserow', tableId, rowId, entityType: ENTITY[table], ...values })
    .onConflictDoUpdate({
      target: [schema.integrationMappings.provider, schema.integrationMappings.tableId, schema.integrationMappings.rowId],
      set: values,
    });
}

/** The Neon entity a row in another table resolved to, if it has been applied. */
async function resolved(tx: AnyDatabase, tableId: number, rowId: number | null): Promise<string | null> {
  if (!rowId) return null;
  const mapping = await mappingOf(tx, tableId, rowId);
  return mapping && mapping.status !== 'tombstoned' ? (mapping.entityId ?? null) : null;
}

/** Is some OTHER row already mapped to this entity? Adoption must be one-to-one. */
async function mappedElsewhere(
  tx: AnyDatabase,
  entityType: (typeof schema.integrationEntity.enumValues)[number],
  entityId: string,
  tableId: number,
  rowId: number,
): Promise<boolean> {
  const rows = await tx
    .select({ rowId: schema.integrationMappings.rowId, tableId: schema.integrationMappings.tableId })
    .from(schema.integrationMappings)
    .where(
      and(
        eq(schema.integrationMappings.entityType, entityType),
        eq(schema.integrationMappings.entityId, entityId),
        ne(schema.integrationMappings.status, 'tombstoned'),
      ),
    );
  return rows.some((r) => r.tableId !== tableId || r.rowId !== rowId);
}

async function audit(
  tx: AnyDatabase,
  action: string,
  entityType: string,
  entityId: string,
  before: unknown,
  after: unknown,
  note: string,
) {
  await tx.insert(schema.auditLog).values({
    actorEmail: ACTOR,
    action,
    entityType,
    entityId,
    before: before as Record<string, unknown> | null,
    after: after as Record<string, unknown> | null,
    note,
  });
}

const editorialToContent = (s: string): (typeof schema.contentStatus.enumValues)[number] =>
  s === 'published' ? 'published' : s === 'archived' ? 'archived' : 'draft';

// ── cities (reference) ───────────────────────────────────────────────────

async function applyCity(tx: AnyDatabase, config: BaserowConfig, row: RawRow, now: Date): Promise<ApplyResult> {
  const tableId = config.tables.cities.tableId;
  const parsed = parseCity(row, config);
  if (!parsed.ok) {
    await writeMapping(tx, 'cities', tableId, row.id, { status: 'quarantined', lastError: parsed.problems.join('; ') }, now);
    return { outcome: 'quarantined', detail: parsed.problems.join('; ') };
  }
  const [city] = await tx
    .select({ id: schema.cities.id })
    .from(schema.cities)
    .where(eq(schema.cities.slug, parsed.dto.slug));
  if (!city) {
    // NOTHING HERE CREATES A CITY. A city is a governance fact, reconciled by
    // a person in Neon, not conjured by a spreadsheet row.
    const detail = `unknown city "${parsed.dto.slug}" — add it in Neon, or fix the slug`;
    await writeMapping(tx, 'cities', tableId, row.id, { status: 'quarantined', lastError: detail }, now);
    return { outcome: 'quarantined', detail };
  }
  await writeMapping(tx, 'cities', tableId, row.id, { status: 'active', entityId: city.id, contentHash: contentHash(parsed.dto), applied: true }, now);
  return { outcome: 'applied', entityId: city.id };
}

// ── events ───────────────────────────────────────────────────────────────

async function uniqueEventSlug(tx: AnyDatabase, base: string): Promise<string> {
  const clean = slugifyTitle(base);
  const taken = await tx
    .select({ slug: schema.events.slug })
    .from(schema.events)
    .where(sql`${schema.events.slug} = ${clean} OR ${schema.events.slug} LIKE ${`${clean}-%`}`);
  const set = new Set(taken.map((r) => r.slug));
  if (!set.has(clean)) return clean;
  let n = 2;
  while (set.has(`${clean}-${n}`)) n += 1;
  return `${clean}-${n}`;
}

function eventValues(dto: EventDTO, cityId: string, now: Date) {
  return {
    title: dto.title,
    summary: dto.summary,
    description: dto.description,
    cityId,
    venueName: dto.venueName,
    venueAddress: dto.venueAddress,
    venuePrivate: dto.venuePrivate,
    date: dto.date,
    // Wall-clock local time in `timezone`. Never shifted to UTC.
    startTime: `${dto.startTime}:00`,
    endTime: dto.endTime ? `${dto.endTime}:00` : null,
    timezone: dto.timezone,
    format: dto.format,
    registrationUrl: dto.registrationUrl,
    coverImagePath: dto.coverRef,
    statusOverride: dto.lifecycle === 'scheduled' ? null : dto.lifecycle,
    status: editorialToContent(dto.editorialStatus),
    featured: dto.featured,
    contentAuthority: 'baserow' as const,
    updatedAt: now,
  };
}

async function applyEvent(tx: AnyDatabase, config: BaserowConfig, row: RawRow, now: Date): Promise<ApplyResult> {
  const tableId = config.tables.events.tableId;
  const quarantine = async (detail: string) => {
    await writeMapping(tx, 'events', tableId, row.id, { status: 'quarantined', lastError: detail }, now);
    return { outcome: 'quarantined' as const, detail };
  };
  const parsed = parseEvent(row, config);
  if (!parsed.ok) return quarantine(parsed.problems.join('; '));
  const dto = parsed.dto;

  const cityId = await resolved(tx, config.tables.cities.tableId, dto.cityRowId);
  if (!cityId) return quarantine(`city row ${dto.cityRowId} is not mapped to a Neon city yet`);

  const mapping = await mappingOf(tx, tableId, row.id);
  const hash = contentHash({ dto, cityId });
  if (mapping?.status === 'active' && mapping.entityId && mapping.contentHash === hash) {
    await writeMapping(tx, 'events', tableId, row.id, { status: 'active' }, now);
    return { outcome: 'unchanged', entityId: mapping.entityId };
  }

  let targetId = mapping?.entityId ?? null;
  if (!targetId && dto.neonId) {
    const [existing] = await tx
      .select({ id: schema.events.id, authority: schema.events.contentAuthority })
      .from(schema.events)
      .where(eq(schema.events.id, dto.neonId));
    if (!existing) return quarantine(`neonId ${dto.neonId} is not an event`);
    if (await mappedElsewhere(tx, 'event', existing.id, tableId, row.id)) {
      return quarantine(`event ${dto.neonId} is already adopted by another Baserow row`);
    }
    targetId = existing.id;
  }

  if (targetId) {
    const [before] = await tx.select().from(schema.events).where(eq(schema.events.id, targetId));
    if (!before) return quarantine(`mapped event ${targetId} no longer exists`);
    const values = eventValues(dto, cityId, now);
    // A slug that has been public is a URL people hold. It changes only while
    // the event has never been published, and only to a free value.
    let slug = before.slug;
    if (dto.slug && dto.slug !== before.slug && before.status !== 'published') {
      const [clash] = await tx.select({ id: schema.events.id }).from(schema.events).where(eq(schema.events.slug, dto.slug));
      if (!clash) slug = dto.slug;
    }
    await tx.update(schema.events).set({ ...values, slug }).where(eq(schema.events.id, targetId));
    await audit(
      tx,
      before.contentAuthority === 'baserow' ? 'baserow.event.applied' : 'baserow.event.adopted',
      'event',
      targetId,
      { status: before.status, title: before.title, authority: before.contentAuthority },
      { status: values.status, title: values.title, authority: 'baserow' },
      `baserow row ${tableId}:${row.id}`,
    );
    await writeMapping(tx, 'events', tableId, row.id, { status: 'active', entityId: targetId, contentHash: hash, applied: true }, now);
    return { outcome: 'applied', entityId: targetId };
  }

  const slug = dto.slug
    ? ((await tx.select({ id: schema.events.id }).from(schema.events).where(eq(schema.events.slug, dto.slug)))[0]
        ? await uniqueEventSlug(tx, dto.slug)
        : dto.slug)
    : await uniqueEventSlug(tx, `${dto.title}-${dto.date}`);
  const [created] = await tx
    .insert(schema.events)
    .values({ ...eventValues(dto, cityId, now), slug, createdAt: now })
    .returning({ id: schema.events.id });
  await audit(tx, 'baserow.event.created', 'event', created.id, null, { slug, status: editorialToContent(dto.editorialStatus) }, `baserow row ${tableId}:${row.id}`);
  await writeMapping(tx, 'events', tableId, row.id, { status: 'active', entityId: created.id, contentHash: hash, applied: true }, now);
  return { outcome: 'applied', entityId: created.id };
}

// ── projects ─────────────────────────────────────────────────────────────

/**
 * THE HISTORICAL-ARCHIVE CONTRACT — what an imported project needs to be
 * published. Deliberately different from a member's publish gate (which also
 * requires a description and Claude usage): an archive entry may be thin, but
 * it must be TRUE — a meaningful summary, the event it came from (which is
 * what establishes its relevance to WITH CLAUDE), a public team credit, and
 * at least one real artifact. Missing Claude usage renders as "Not documented".
 */
export function archiveContractBlockers(dto: ProjectDTO, eventId: string | null, creditCount: number): string[] {
  return [
    !eventId && 'linked to an event (its relevance cannot be established otherwise)',
    dto.summary.trim().length < 5 && 'a meaningful summary',
    !dto.teamName && creditCount === 0 && 'a public team credit',
    !dto.liveUrl && !dto.repoUrl && !dto.videoUrl && 'at least one artifact link (live, repo or video)',
  ].filter(Boolean) as string[];
}

async function syncTeamCredit(tx: AnyDatabase, projectId: string, tableId: number, rowId: number, teamName: string | null) {
  const sourceKey = `baserow:${tableId}:${rowId}:team`;
  if (!teamName) {
    await tx.delete(schema.projectCredits).where(eq(schema.projectCredits.sourceKey, sourceKey));
    return;
  }
  await tx
    .insert(schema.projectCredits)
    .values({ projectId, displayName: teamName, role: 'Team', position: 0, sourceKey })
    .onConflictDoUpdate({
      target: schema.projectCredits.sourceKey,
      targetWhere: sql`${schema.projectCredits.sourceKey} IS NOT NULL`,
      set: { displayName: teamName, projectId, updatedAt: new Date() },
    });
}

async function applyProject(tx: AnyDatabase, config: BaserowConfig, row: RawRow, now: Date): Promise<ApplyResult> {
  const tableId = config.tables.projects.tableId;
  const quarantine = async (detail: string) => {
    await writeMapping(tx, 'projects', tableId, row.id, { status: 'quarantined', lastError: detail }, now);
    return { outcome: 'quarantined' as const, detail };
  };
  const parsed = parseProject(row, config);
  if (!parsed.ok) return quarantine(parsed.problems.join('; '));
  const dto = parsed.dto;

  const eventId = await resolved(tx, config.tables.events.tableId, dto.eventRowId);
  if (dto.eventRowId && !eventId) return quarantine(`event row ${dto.eventRowId} is not mapped yet`);
  let cityId = await resolved(tx, config.tables.cities.tableId, dto.cityRowId);
  if (dto.cityRowId && !cityId) return quarantine(`city row ${dto.cityRowId} is not mapped yet`);
  if (!cityId && eventId) {
    const [event] = await tx.select({ cityId: schema.events.cityId }).from(schema.events).where(eq(schema.events.id, eventId));
    cityId = event?.cityId ?? null;
  }

  const mapping = await mappingOf(tx, tableId, row.id);
  let targetId = mapping?.entityId ?? null;
  if (!targetId && dto.neonId) {
    const [existing] = await tx
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.id, dto.neonId));
    if (!existing) return quarantine(`neonId ${dto.neonId} is not a project`);
    if (await mappedElsewhere(tx, 'project', existing.id, tableId, row.id)) {
      return quarantine(`project ${dto.neonId} is already adopted by another Baserow row`);
    }
    targetId = existing.id;
  }

  const before = targetId
    ? ((await tx.select().from(schema.projects).where(eq(schema.projects.id, targetId)))[0] ?? null)
    : null;
  if (targetId && !before) return quarantine(`mapped project ${targetId} no longer exists`);

  // ONE WRITER. A member's project — created on the site or claimed — is the
  // website's; this row is released and its edits are no longer applied.
  if (before && before.contentAuthority === 'member') {
    await writeMapping(tx, 'projects', tableId, row.id, { status: 'released', entityId: before.id, lastError: 'claimed: the website owns this project now' }, now);
    return { outcome: 'skipped', entityId: before.id, detail: 'claimed by a member' };
  }

  const [{ n: creditCount }] = targetId
    ? await tx
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(schema.projectCredits)
        .where(and(eq(schema.projectCredits.projectId, targetId), sql`${schema.projectCredits.sourceKey} NOT LIKE '%:team'`))
    : [{ n: 0 }];

  const blockers = dto.editorialStatus === 'published' ? archiveContractBlockers(dto, eventId, creditCount) : [];
  const publication: PublicationStatus =
    dto.editorialStatus === 'archived'
      ? 'archived'
      : dto.editorialStatus === 'published' && blockers.length === 0
        ? 'published'
        : 'draft';

  const hash = contentHash({ dto, eventId, cityId, creditCount });
  if (mapping?.status === 'active' && targetId && mapping.contentHash === hash) {
    await writeMapping(tx, 'projects', tableId, row.id, { status: 'active' }, now);
    return { outcome: 'unchanged', entityId: targetId };
  }

  const values = {
    title: dto.title,
    summary: dto.summary,
    description: dto.description,
    category: dto.category,
    tags: dto.tags,
    url: dto.liveUrl,
    repoUrl: dto.repoUrl,
    videoUrl: dto.videoUrl,
    // A repository asset key, or nothing. Remote images are a review item —
    // this projection never fetches a participant URL.
    imagePath: dto.coverRef,
    imageId: null,
    claudeUsage: dto.claudeUsage,
    builtAtEventId: eventId,
    cityId,
    featured: dto.featured,
    featuredOrder: dto.featuredOrder === null ? null : Math.trunc(dto.featuredOrder),
    publicationStatus: publication,
    status: legacyStatusFor(publication),
    contentAuthority: 'baserow' as const,
    updatedAt: now,
  };

  let projectId: string;
  if (before) {
    let slug = before.slug;
    if (dto.slug && dto.slug !== before.slug && !before.publishedAt) {
      const [clash] = await tx.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.slug, dto.slug));
      if (!clash) slug = dto.slug;
    }
    await tx
      .update(schema.projects)
      .set({
        ...values,
        slug,
        ...(publication === 'published' && !before.publishedAt ? { publishedAt: now } : {}),
      })
      .where(and(eq(schema.projects.id, before.id), ne(schema.projects.contentAuthority, 'member')));
    projectId = before.id;
    await audit(
      tx,
      before.contentAuthority === 'baserow' ? 'baserow.project.applied' : 'baserow.project.adopted',
      'project',
      projectId,
      { publicationStatus: before.publicationStatus, title: before.title, authority: before.contentAuthority },
      { publicationStatus: publication, title: values.title, authority: 'baserow' },
      `baserow row ${tableId}:${row.id}`,
    );
  } else {
    const slug =
      dto.slug && !(await tx.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.slug, dto.slug)))[0]
        ? dto.slug
        : await nextAvailableSlug(dto.title, tx);
    const [created] = await tx
      .insert(schema.projects)
      .values({
        ...values,
        slug,
        ownerMemberId: null,
        moderationState: 'clean',
        createdAt: now,
        ...(publication === 'published' ? { publishedAt: now } : {}),
      })
      .returning({ id: schema.projects.id });
    projectId = created.id;
    await audit(tx, 'baserow.project.created', 'project', projectId, null, { slug, publicationStatus: publication }, `baserow row ${tableId}:${row.id}`);
  }

  await syncTeamCredit(tx, projectId, tableId, row.id, dto.teamName);

  const held = blockers.length > 0;
  await writeMapping(
    tx,
    'projects',
    tableId,
    row.id,
    {
      status: 'active',
      entityId: projectId,
      contentHash: hash,
      applied: true,
      lastError: held ? `publish held — needs ${blockers.join(', ')}` : null,
    },
    now,
  );
  return held
    ? { outcome: 'held', entityId: projectId, detail: `needs ${blockers.join(', ')}` }
    : { outcome: 'applied', entityId: projectId };
}

// ── credits ──────────────────────────────────────────────────────────────

async function applyCredit(tx: AnyDatabase, config: BaserowConfig, row: RawRow, now: Date): Promise<ApplyResult> {
  const tableId = config.tables.credits.tableId;
  const parsed = parseCredit(row, config);
  if (!parsed.ok) {
    await writeMapping(tx, 'credits', tableId, row.id, { status: 'quarantined', lastError: parsed.problems.join('; ') }, now);
    return { outcome: 'quarantined', detail: parsed.problems.join('; ') };
  }
  const dto: CreditDTO = parsed.dto;
  const projectId = await resolved(tx, config.tables.projects.tableId, dto.projectRowId);
  if (!projectId) {
    const detail = `project row ${dto.projectRowId} is not mapped yet`;
    await writeMapping(tx, 'credits', tableId, row.id, { status: 'quarantined', lastError: detail }, now);
    return { outcome: 'quarantined', detail };
  }
  const [project] = await tx
    .select({ authority: schema.projects.contentAuthority })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId));
  if (project?.authority !== 'baserow') {
    await writeMapping(tx, 'credits', tableId, row.id, { status: 'released', lastError: 'project is owned by the website' }, now);
    return { outcome: 'skipped', detail: 'project owned by the website' };
  }

  const hash = contentHash(dto);
  const mapping = await mappingOf(tx, tableId, row.id);
  if (mapping?.status === 'active' && mapping.contentHash === hash && mapping.entityId) {
    await writeMapping(tx, 'credits', tableId, row.id, { status: 'active' }, now);
    return { outcome: 'unchanged', entityId: mapping.entityId };
  }

  // A display name from an organiser's record. It creates no account and is
  // never matched to one by name — `builder_id` is not set here.
  const sourceKey = `baserow:${tableId}:${row.id}`;
  const [credit] = await tx
    .insert(schema.projectCredits)
    .values({
      projectId,
      displayName: dto.displayName,
      role: dto.role,
      publicUrl: dto.publicUrl,
      position: dto.displayOrder + 1,
      sourceKey,
    })
    .onConflictDoUpdate({
      target: schema.projectCredits.sourceKey,
      targetWhere: sql`${schema.projectCredits.sourceKey} IS NOT NULL`,
      set: {
        projectId,
        displayName: dto.displayName,
        role: dto.role,
        publicUrl: dto.publicUrl,
        position: dto.displayOrder + 1,
        updatedAt: now,
      },
    })
    .returning({ id: schema.projectCredits.id });
  await writeMapping(tx, 'credits', tableId, row.id, { status: 'active', entityId: credit.id, contentHash: hash, applied: true }, now);
  // A new credit can satisfy the parent's publication contract.
  return { outcome: 'applied', entityId: credit.id, followUps: [{ table: 'projects', rowId: dto.projectRowId }] };
}

// ── entry points ─────────────────────────────────────────────────────────

export async function applyRow(
  db: AnyDatabase,
  config: BaserowConfig,
  table: TableKey,
  row: RawRow,
  now: Date = new Date(),
): Promise<ApplyResult> {
  const tableId = config.tables[table].tableId;
  return db.transaction(async (tx) => {
    const t = tx as unknown as AnyDatabase;
    await lockRow(t, tableId, row.id);
    const apply = { cities: applyCity, events: applyEvent, projects: applyProject, credits: applyCredit }[table];
    const result = await apply(t, config, row, now);
    // Whatever the outcome, remember the raw row we judged, so reconciliation
    // re-queues it only when the upstream row actually changes.
    await t
      .update(schema.integrationMappings)
      .set({ sourceHash: contentHash(row) })
      .where(
        and(
          eq(schema.integrationMappings.provider, 'baserow'),
          eq(schema.integrationMappings.tableId, tableId),
          eq(schema.integrationMappings.rowId, row.id),
        ),
      );
    return result;
  });
}

/**
 * The upstream row is gone. Unpublish its projection and keep everything —
 * never a hard delete, never a cascade, never a member's record.
 */
export async function tombstoneRow(
  db: AnyDatabase,
  config: BaserowConfig,
  table: TableKey,
  rowId: number,
  now: Date = new Date(),
): Promise<ApplyResult> {
  const tableId = config.tables[table].tableId;
  return db.transaction(async (tx) => {
    const t = tx as unknown as AnyDatabase;
    await lockRow(t, tableId, rowId);
    const mapping = await mappingOf(t, tableId, rowId);
    if (!mapping || mapping.status === 'tombstoned') return { outcome: 'skipped' as const, detail: 'not mapped' };
    if (mapping.status === 'released') return { outcome: 'skipped' as const, detail: 'owned by the website' };

    const id = mapping.entityId;
    if (id && table === 'events') {
      const [before] = await t.select({ status: schema.events.status }).from(schema.events).where(eq(schema.events.id, id));
      const updated = await t
        .update(schema.events)
        .set({ status: 'archived', updatedAt: now })
        .where(and(eq(schema.events.id, id), eq(schema.events.contentAuthority, 'baserow')))
        .returning({ id: schema.events.id });
      if (updated.length) await audit(t, 'baserow.event.tombstoned', 'event', id, before ?? null, { status: 'archived' }, `baserow row ${tableId}:${rowId} deleted`);
    } else if (id && table === 'projects') {
      const [before] = await t
        .select({ publicationStatus: schema.projects.publicationStatus })
        .from(schema.projects)
        .where(eq(schema.projects.id, id));
      const updated = await t
        .update(schema.projects)
        .set({ publicationStatus: 'archived', status: 'archived', updatedAt: now })
        .where(and(eq(schema.projects.id, id), eq(schema.projects.contentAuthority, 'baserow')))
        .returning({ id: schema.projects.id });
      if (updated.length) {
        await audit(t, 'baserow.project.tombstoned', 'project', id, before ?? null, { publicationStatus: 'archived' }, `baserow row ${tableId}:${rowId} deleted`);
      }
    } else if (table === 'credits') {
      await t.delete(schema.projectCredits).where(eq(schema.projectCredits.sourceKey, `baserow:${tableId}:${rowId}`));
    }
    await writeMapping(t, table, tableId, rowId, { status: 'tombstoned', lastError: 'deleted upstream' }, now);
    return { outcome: 'tombstoned' as const, entityId: id };
  });
}
