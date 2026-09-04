/**
 * PostgreSQL, as a data source.
 *
 * Reconstructs the public record from the normalised schema into exactly the
 * shapes `src/data/types.ts` defines, so that everything above this file — the
 * selectors, the pages, the components, the search index, the sitemap — cannot
 * tell which source it was handed.
 *
 * ── WHAT THIS FILE IS ALLOWED TO DECIDE ──────────────────────────────────
 *
 * Only what the records ARE. It does not decide what is public in the sense
 * the site means it (that is `isPublic()`), it does not derive a city's state,
 * and it does not compute an event's lifecycle. Those are domain questions
 * with one answer each, living in `src/lib/`, and a second implementation of
 * any of them in SQL would be a second answer waiting to disagree.
 *
 * What it does do is refuse to load rows the public build has no business
 * seeing. See PUBLICATION PREDICATE below.
 *
 * ── PUBLICATION PREDICATE ────────────────────────────────────────────────
 *
 *     status = 'published'
 *
 * and nothing else. Not `approved`, which means an editor said this belongs in
 * the record — a different act from putting it on the website, and the reason
 * the two words exist. Not `draft`, `pending`, `in_review`,
 * `changes_requested`, `rejected` or `archived`. `archived` in particular is
 * the takedown path: an archived record simply stops being loaded here, and is
 * gone from the site on the next build without anything being deleted.
 *
 * `featured` is a boolean on the row, never a status. A featured record is one
 * that is `published` AND `featured`, which is how a display decision and a
 * review decision stay separable.
 *
 * ── THE PENDING-BUILDER EXCEPTION ────────────────────────────────────────
 *
 * `builders` is the one table read past the predicate, and the reason is a
 * governance rule rather than a convenience. The Impact Lab cohort are
 * `pending`: they get no profile page, but their names must still appear on
 * the project cards they are credited on, because dropping a credit silently
 * is worse than showing a name without a link. `builderNamesOf()` resolves
 * against ALL builders for exactly this, so the source must supply them and
 * `isPublic()` filters them back out of everything that renders a profile.
 *
 * This is not a loophole: a pending builder's row is loaded, and the selector
 * layer then admits it to precisely one surface. That is the same behaviour
 * the TypeScript source has always had.
 *
 * ── NO N+1 ───────────────────────────────────────────────────────────────
 *
 * Every table is read exactly once, whole, and the relationships are stitched
 * together in memory. A build renders around ninety pages off this dataset; if
 * this file queried per record the build would issue thousands of round trips
 * to Neon for data it already had. There are about twenty queries here in
 * total, they are issued in parallel batches, and they run once per build —
 * see `loadRecordSet()`. The visitor pays for none of it, because none of it
 * happens at request time.
 */
import { eq, inArray } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../../db/schema';
import type { RecordSet } from './source';
import type {
  AgendaItem,
  Ambassador,
  Authorship,
  Builder,
  BuilderRole,
  City,
  CommunityEvent,
  EventPhoto,
  Guide,
  IsoDate,
  ModerationStatus,
  Project,
  SocialLink,
  Source,
  Story,
  UseCase,
  WorkflowStep,
} from './types';

/** Any Drizzle connection over this schema. The reader is driver-agnostic. */
export type ReadDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * The one publication predicate.
 *
 * Exported so the tests can assert against the same list the reader uses,
 * rather than a copy of it that could be updated on its own.
 */
export const PUBLIC_CONTENT_STATUS = 'published' as const;

/** Statuses that are explicitly NOT public. Asserted in the tests. */
export const NON_PUBLIC_CONTENT_STATUSES = [
  'draft',
  'pending',
  'in_review',
  'changes_requested',
  'approved',
  'rejected',
  'archived',
] as const;

// =========================================================================
// SHAPE HELPERS
// =========================================================================

/**
 * The database's `(status, featured)` pair, back to the record's single value.
 *
 * The exact inverse of `moderation()` in `db/import/index.ts`. The record
 * folds "featured" into its status enum; the database keeps them apart because
 * being featured is a display decision and being published is a review one.
 * Reading back, the pair collapses to the record's vocabulary — which is
 * lossless in the direction that matters, because only `published` rows are
 * ever loaded.
 */
function moderationOf(row: { status: string; featured?: boolean }): ModerationStatus {
  return row.featured ? 'featured' : 'published';
}

/**
 * A `timestamptz` back to the `YYYY-MM-DD` the record uses.
 *
 * The record's `createdAt` is a calendar date, and the importer stored it as an
 * instant in IST — an event created at 10:00 IST on the 23rd is
 * `2026-08-23T04:30:00Z`. Formatting that in UTC would print the 22nd for
 * anything before 05:30 IST, which would move records between months in the
 * timeline. So the instant is shifted back into IST before the date is taken.
 *
 * Null stays null. The record leaves an unknown date undefined rather than
 * guessing one, and so does this.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function isoDate(value: Date | string | null | undefined): IsoDate | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    // `date` columns arrive as `YYYY-MM-DD` already.
    return value.slice(0, 10) as IsoDate;
  }
  return new Date(value.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10) as IsoDate;
}

/** A `date` column, which is always present where the record requires one. */
function requiredDate(value: Date | string): IsoDate {
  return isoDate(value)!;
}

/**
 * A `time` column back to `HH:MM`.
 *
 * PostgreSQL returns `10:00:00`; the record holds `10:00`. Trailing seconds
 * would render as `10:00:00` on every event card, so they are dropped rather
 * than tolerated.
 */
function clockTime(value: string | null | undefined): `${number}:${number}` | undefined {
  if (!value) return undefined;
  return value.slice(0, 5) as `${number}:${number}`;
}

/**
 * Drop keys whose value is undefined, so shapes match the record exactly.
 *
 * This is load-bearing for equivalence, not tidiness. The record omits an
 * absent optional field; an object literal that sets it to `undefined` has the
 * key. `{ a: 1 }` and `{ a: 1, b: undefined }` render identically and compare
 * as different, so every optional field goes through here and the equivalence
 * suite can use a plain deep-equal.
 */
function compact<T extends object>(object: T): T {
  for (const key of Object.keys(object) as (keyof T)[]) {
    if (object[key] === undefined) delete object[key];
  }
  return object;
}

/**
 * An optional array field.
 *
 * The record omits an empty list rather than storing `[]` — a builder with no
 * projects has no `projectSlugs` key at all. The database cannot express that
 * distinction for a join table, so an empty result becomes an absent field,
 * which is what the record would have held.
 */
function optionalList<T>(list: T[]): T[] | undefined {
  return list.length > 0 ? list : undefined;
}

/** Group rows by a parent id, preserving the order the query returned them. */
function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = out.get(k);
    if (bucket) bucket.push(row);
    else out.set(k, [row]);
  }
  return out;
}

// =========================================================================
// THE LOAD
// =========================================================================

/**
 * Read the whole public record.
 *
 * ── LOAD ORDER ───────────────────────────────────────────────────────────
 *
 * Three waves, each issued in parallel:
 *
 *   1. the entity tables, plus the lookup tables ids resolve through
 *   2. the child and join tables, keyed by the ids wave 1 returned
 *   3. nothing — everything else is assembled in memory
 *
 * Wave 2 has to wait for wave 1 only because its `WHERE id IN (…)` needs the
 * ids. Within each wave nothing depends on anything else, so both waves are a
 * single `Promise.all` rather than a sequence of awaits.
 */
export async function loadRecordSet(db: ReadDatabase): Promise<RecordSet> {
  const published = PUBLIC_CONTENT_STATUS;

  // ── Wave 1 — entities and lookups ────────────────────────────────────
  //
  // `builders` is the exception described in the file header: it is read
  // whole, because a `pending` builder's NAME is still a credit the record
  // owes them. Everything else is filtered to `published` in SQL, so an
  // unpublished row never leaves the database at all.
  const [
    cityRows,
    builderRows,
    ambassadorRows,
    eventRows,
    projectRows,
    storyRows,
    useCaseRows,
    guideRows,
    organizationRows,
    mediaRows,
  ] = await Promise.all([
    db.select().from(schema.cities).where(eq(schema.cities.status, published)),
    db.select().from(schema.builders),
    db.select().from(schema.ambassadors).where(eq(schema.ambassadors.status, published)),
    db.select().from(schema.events).where(eq(schema.events.status, published)),
    db.select().from(schema.projects).where(eq(schema.projects.status, published)),
    db.select().from(schema.stories).where(eq(schema.stories.status, published)),
    db.select().from(schema.useCases).where(eq(schema.useCases.status, published)),
    db.select().from(schema.guides).where(eq(schema.guides.status, published)),
    db.select().from(schema.organizations),
    db.select().from(schema.media),
  ]);

  // Id → slug, so relationships can be expressed the way the record expresses
  // them. The record is a graph of slugs; the database is a graph of uuids.
  // This is the whole translation.
  const citySlug = new Map(cityRows.map((r) => [r.id, r.slug]));
  const builderSlug = new Map(builderRows.map((r) => [r.id, r.slug]));
  const ambassadorSlug = new Map(ambassadorRows.map((r) => [r.id, r.slug]));
  const eventSlug = new Map(eventRows.map((r) => [r.id, r.slug]));
  const projectSlug = new Map(projectRows.map((r) => [r.id, r.slug]));
  const orgName = new Map(organizationRows.map((r) => [r.id, r.name]));
  const orgById = new Map(organizationRows.map((r) => [r.id, r]));
  const mediaById = new Map(mediaRows.map((r) => [r.id, r]));

  const eventIds = eventRows.map((r) => r.id);
  const projectIds = projectRows.map((r) => r.id);
  const storyIds = storyRows.map((r) => r.id);
  const useCaseIds = useCaseRows.map((r) => r.id);
  const guideIds = guideRows.map((r) => r.id);

  /**
   * `IN ()` is not valid SQL and Drizzle will not emit it, so an empty id list
   * short-circuits to an empty result rather than a query. This is what makes
   * the reader work against a database with no published events in it.
   */
  const whenAny = async <T>(ids: string[], query: () => Promise<T[]>): Promise<T[]> =>
    ids.length === 0 ? [] : query();

  // ── Wave 2 — children and joins ──────────────────────────────────────
  const [
    coHostRows,
    speakerRows,
    attendeeRows,
    eventOrgRows,
    agendaRows,
    outcomeRows,
    photoRows,
    projectBuilderRows,
    storyBuilderRows,
    workflowRows,
    artifactRows,
    guideSectionRows,
    sourceRows,
    linkRows,
  ] = await Promise.all([
    whenAny(eventIds, () =>
      db.select().from(schema.eventCoHosts).where(inArray(schema.eventCoHosts.eventId, eventIds)),
    ),
    whenAny(eventIds, () =>
      db.select().from(schema.eventSpeakers).where(inArray(schema.eventSpeakers.eventId, eventIds)),
    ),
    whenAny(eventIds, () =>
      db
        .select()
        .from(schema.eventAttendees)
        .where(inArray(schema.eventAttendees.eventId, eventIds)),
    ),
    whenAny(eventIds, () =>
      db
        .select()
        .from(schema.eventOrganizations)
        .where(inArray(schema.eventOrganizations.eventId, eventIds)),
    ),
    whenAny(eventIds, () =>
      db
        .select()
        .from(schema.eventAgendaItems)
        .where(inArray(schema.eventAgendaItems.eventId, eventIds)),
    ),
    whenAny(eventIds, () =>
      db.select().from(schema.eventOutcomes).where(inArray(schema.eventOutcomes.eventId, eventIds)),
    ),
    whenAny(eventIds, () =>
      db.select().from(schema.eventPhotos).where(inArray(schema.eventPhotos.eventId, eventIds)),
    ),
    whenAny(projectIds, () =>
      db
        .select()
        .from(schema.projectBuilders)
        .where(inArray(schema.projectBuilders.projectId, projectIds)),
    ),
    whenAny(storyIds, () =>
      db.select().from(schema.storyBuilders).where(inArray(schema.storyBuilders.storyId, storyIds)),
    ),
    whenAny(useCaseIds, () =>
      db
        .select()
        .from(schema.useCaseWorkflowSteps)
        .where(inArray(schema.useCaseWorkflowSteps.useCaseId, useCaseIds)),
    ),
    whenAny(useCaseIds, () =>
      db
        .select()
        .from(schema.useCaseArtifacts)
        .where(inArray(schema.useCaseArtifacts.useCaseId, useCaseIds)),
    ),
    whenAny(guideIds, () =>
      db
        .select()
        .from(schema.guideSections)
        .where(inArray(schema.guideSections.guideId, guideIds)),
    ),
    // Sources and links are polymorphic, so they are read whole and bucketed
    // in memory. Both are small — a few hundred rows across the whole record.
    db.select().from(schema.sources),
    db.select().from(schema.socialLinks),
  ]);

  // ── Ordered children, by position ────────────────────────────────────
  //
  // `position` is the record's array order, so every ordered child list is
  // sorted by it here rather than relying on whatever order the rows arrived
  // in. An unsorted agenda would render an event's day out of sequence.
  const byPosition = <T extends { position: number }>(rows: T[]): T[] =>
    [...rows].sort((a, b) => a.position - b.position);

  const agendaByEvent = groupBy(byPosition(agendaRows), (r) => r.eventId);
  const outcomesByEvent = groupBy(byPosition(outcomeRows), (r) => r.eventId);
  const photosByEvent = groupBy(byPosition(photoRows), (r) => r.eventId);
  const coHostsByEvent = groupBy(coHostRows, (r) => r.eventId);
  const speakersByEvent = groupBy(speakerRows, (r) => r.eventId);
  /**
   * The reverse index for a builder's declared rooms.
   *
   * `builders.eventSlugs` in the record is "rooms this person was on the record
   * in", which is the union of the three credits. Rebuilt here in the order the
   * record writes it — co-hosted, spoke, attended — deduplicated, because
   * somebody who both ran a room and talked in it is on the record for it once.
   */
  const eventsByBuilder = new Map<string, Set<string>>();
  const noteCredit = (builderId: string, eventId: string) => {
    const bucket = eventsByBuilder.get(builderId);
    if (bucket) bucket.add(eventId);
    else eventsByBuilder.set(builderId, new Set([eventId]));
  };
  for (const row of coHostRows) noteCredit(row.builderId, row.eventId);
  for (const row of speakerRows) noteCredit(row.builderId, row.eventId);
  for (const row of attendeeRows) noteCredit(row.builderId, row.eventId);
  const orgsByEvent = groupBy(eventOrgRows, (r) => r.eventId);
  const buildersByProject = groupBy(byPosition(projectBuilderRows), (r) => r.projectId);
  const buildersByStory = groupBy(storyBuilderRows, (r) => r.storyId);
  const workflowByUseCase = groupBy(byPosition(workflowRows), (r) => r.useCaseId);
  const artifactsByUseCase = groupBy(byPosition(artifactRows), (r) => r.useCaseId);
  const sectionsByGuide = groupBy(byPosition(guideSectionRows), (r) => r.guideId);
  const sourcesByOwner = groupBy(byPosition(sourceRows), (r) => `${r.ownerType}:${r.ownerId}`);
  const linksByOwner = groupBy(byPosition(linkRows), (r) => `${r.ownerType}:${r.ownerId}`);

  const linksOf = (ownerType: string, ownerId: string): SocialLink[] | undefined =>
    optionalList(
      (linksByOwner.get(`${ownerType}:${ownerId}`) ?? []).map(({ label, url }) => ({ label, url })),
    );

  const sourcesOf = (ownerType: string, ownerId: string): Source[] | undefined =>
    optionalList(
      (sourcesByOwner.get(`${ownerType}:${ownerId}`) ?? []).map((row) =>
        compact({
          label: row.label,
          url: row.url ?? undefined,
          retrieved: isoDate(row.retrieved),
        } as Source),
      ),
    );

  /**
   * Resolve a set of builder ids to slugs, dropping any that did not load.
   *
   * Nothing should be dropped in practice — `builders` is read whole — but a
   * credit pointing at a row that is not there must not become the string
   * `undefined` in a URL.
   */
  const slugsOf = <T>(rows: T[], id: (row: T) => string, map: Map<string, string>): string[] =>
    rows.map(id).map((value) => map.get(value)).filter((slug): slug is string => Boolean(slug));

  // =======================================================================
  // ASSEMBLY
  // =======================================================================

  const cities: City[] = cityRows.map((row) =>
    compact({
      id: row.id,
      slug: row.slug,
      status: moderationOf(row),
      createdAt: isoDate(row.createdAt),
      updatedAt: isoDate(row.updatedAt),
      name: row.name,
      // `region` is the Indian state. The record calls the same field `state`,
      // and the database renamed it precisely so it could never be confused
      // with the derived `CityState`. This is that rename, undone on the way
      // out.
      state: row.region,
      lat: row.lat,
      lon: row.lon,
      blurb: row.blurb,
      // Both halves or neither — the CHECK on the table guarantees it, so a
      // count without a source cannot arrive here.
      interest:
        row.interestCount !== null && row.interestSource !== null
          ? { count: row.interestCount, source: row.interestSource }
          : undefined,
      reported:
        row.reportedSource !== null &&
        (row.reportedMembers !== null || row.reportedPrototypes !== null)
          ? compact({
              members: row.reportedMembers ?? undefined,
              prototypes: row.reportedPrototypes ?? undefined,
              source: row.reportedSource,
            })
          : undefined,
      organiser: row.organiserId
        ? compact({
            name: orgById.get(row.organiserId)?.name ?? '',
            url: orgById.get(row.organiserId)?.url ?? undefined,
          })
        : undefined,
      image: row.imagePath ?? undefined,
      links: linksOf('city', row.id),
    } as City),
  );

  const builders: Builder[] = builderRows.map((row) =>
    compact({
      id: row.id,
      slug: row.slug,
      // A builder may be `pending` here — see the file header. Its own status
      // is reported honestly so `isPublic()` can keep it off every surface
      // except an attribution.
      status: (row.status === published ? moderationOf(row) : row.status) as ModerationStatus,
      createdAt: isoDate(row.createdAt),
      updatedAt: isoDate(row.updatedAt),
      name: row.name,
      citySlug: citySlug.get(row.cityId) ?? '',
      role: row.role,
      // The database refuses to store `ambassador` here — see the CHECK on
      // `builders.roles`. Nothing needs stripping on the way out because
      // nothing could have got in.
      roles: row.roles as BuilderRole[],
      bio: row.bio ?? undefined,
      building: row.building ?? undefined,
      claudeTools: optionalList(row.claudeTools),
      image: row.imagePath ?? undefined,
      links: linksOf('builder', row.id),
      /**
       * `projectSlugs` is left absent, and that is not a gap.
       *
       * In the record it is a declared list which `projectsOf()` unions with
       * the projects that credit the builder — and every declared entry in the
       * repository is also a credit, so the union is the credits. The
       * equivalence suite asserts that (`projectsOf` is compared per builder),
       * and a declared project that nobody credited would be an attribution
       * the project itself does not make.
       */
      eventSlugs: optionalList(
        [...(eventsByBuilder.get(row.id) ?? [])]
          .map((id) => eventSlug.get(id))
          .filter((slug): slug is string => Boolean(slug)),
      ),
    } as Builder),
  );

  const ambassadors: Ambassador[] = ambassadorRows.map((row) =>
    compact({
      id: row.id,
      slug: row.slug,
      status: moderationOf({ status: row.status, featured: false }),
      createdAt: isoDate(row.createdAt),
      updatedAt: isoDate(row.updatedAt),
      name: row.name,
      citySlug: citySlug.get(row.cityId) ?? '',
      title: row.title as 'Claude Community Ambassador',
      verifiedVia: row.verifiedVia,
      builderSlug: row.builderId ? builderSlug.get(row.builderId) : undefined,
      since: isoDate(row.since),
      bio: row.bio ?? undefined,
      image: row.imagePath ?? undefined,
      links: linksOf('ambassador', row.id),
    } as Ambassador),
  );

  const events: CommunityEvent[] = eventRows.map((row) => {
    const photos = (photosByEvent.get(row.id) ?? [])
      .map((photo) => {
        const asset = mediaById.get(photo.mediaId);
        return asset ? ({ src: asset.path, alt: asset.alt } satisfies EventPhoto) : undefined;
      })
      .filter((photo): photo is EventPhoto => Boolean(photo));

    return compact({
      id: row.id,
      slug: row.slug,
      status: moderationOf(row),
      createdAt: isoDate(row.createdAt),
      updatedAt: isoDate(row.updatedAt),
      title: row.title,
      format: row.format,
      volume: row.volume ?? undefined,
      citySlug: citySlug.get(row.cityId) ?? '',
      host: compact({
        ambassadorSlug: row.ambassadorId ? ambassadorSlug.get(row.ambassadorId) : undefined,
        builderSlugs: optionalList(
          slugsOf(coHostsByEvent.get(row.id) ?? [], (r) => r.builderId, builderSlug),
        ),
        organisations: optionalList(
          (orgsByEvent.get(row.id) ?? [])
            .map((r) => orgName.get(r.organizationId))
            .filter((name): name is string => Boolean(name)),
        ),
      }),
      date: requiredDate(row.date),
      startTime: clockTime(row.startTime)!,
      endTime: clockTime(row.endTime),
      venue: compact({
        name: row.venueName,
        address: row.venueAddress ?? undefined,
        // The record omits `private` when it is false rather than storing it.
        private: row.venuePrivate ? true : undefined,
      }),
      summary: row.summary,
      description: row.description ?? undefined,
      registrationUrl: row.registrationUrl ?? undefined,
      statusOverride: row.statusOverride ?? undefined,
      free: row.free,
      coverImage: row.coverImagePath ?? undefined,
      photos: optionalList(photos),
      speakerSlugs: optionalList(
        slugsOf(speakersByEvent.get(row.id) ?? [], (r) => r.builderId, builderSlug),
      ),
      agenda: optionalList(
        (agendaByEvent.get(row.id) ?? []).map((item) =>
          compact({
            time: clockTime(item.time),
            title: item.title,
            detail: item.detail ?? undefined,
          } as AgendaItem),
        ),
      ),
      outcomes: optionalList((outcomesByEvent.get(row.id) ?? []).map((o) => o.text)),
      /**
       * Rebuilt from `projects.built_at_event_id`, which is the authoritative
       * edge — the record's `projectSlugs` on an event is a hand-declared
       * mirror of it. Ordered by the projects' own order so the list is
       * stable, and absent rather than empty for a room that produced nothing.
       */
      projectSlugs: optionalList(
        projectRows
          .filter((project) => project.builtAtEventId === row.id)
          .map((project) => project.slug),
      ),
    } as CommunityEvent);
  });

  /**
   * `src/data/projects.ts` is one flat array with a real, deliberate order —
   * the record's own comments say so ("Homepage preview candidates first").
   * PostgreSQL has no notion of that order for a table with no `ORDER BY`,
   * and the id cannot substitute for one: it is a random `gen_random_uuid()`,
   * confirmed against real Neon data to reproduce nothing resembling the
   * authored order. `position` (migration 0005) is what the importer writes
   * to carry it, and this is where the order is restored — once, here, so
   * every consumer of `RecordSet.projects` (the array itself,
   * `projectsInCity()`, `projectsFromEvent()`) inherits it for free rather
   * than each needing its own sort.
   *
   * A row imported before 0005 has `position: null` and sorts after every
   * positioned row, alphabetically by slug — a stable order rather than an
   * authored one, which is the honest fallback for data this migration has
   * not reached yet.
   */
  const orderedProjectRows = [...projectRows].sort((a, b) => {
    if (a.position !== null && b.position !== null) return a.position - b.position;
    if (a.position !== null) return -1;
    if (b.position !== null) return 1;
    return a.slug.localeCompare(b.slug);
  });

  const projects: Project[] = orderedProjectRows.map((row) =>
    compact({
      id: row.id,
      slug: row.slug,
      status: moderationOf(row),
      createdAt: isoDate(row.createdAt),
      updatedAt: isoDate(row.updatedAt),
      title: row.title,
      builderSlugs: slugsOf(
        buildersByProject.get(row.id) ?? [],
        (r) => r.builderId,
        builderSlug,
      ),
      citySlug: citySlug.get(row.cityId) ?? '',
      summary: row.summary,
      description: row.description ?? undefined,
      category: row.category,
      url: row.url ?? undefined,
      repoUrl: row.repoUrl ?? undefined,
      videoUrl: row.videoUrl ?? undefined,
      image: row.imagePath ?? undefined,
      tags: optionalList(row.tags),
      claudeUsage: row.claudeUsage ?? undefined,
      builtAtEventSlug: row.builtAtEventId ? eventSlug.get(row.builtAtEventId) : undefined,
    } as Project),
  );

  const stories: Story[] = storyRows.map((row) =>
    compact({
      id: row.id,
      slug: row.slug,
      status: moderationOf(row),
      createdAt: isoDate(row.createdAt),
      updatedAt: isoDate(row.updatedAt),
      title: row.title,
      standfirst: row.standfirst,
      kind: row.kind,
      date: requiredDate(row.date),
      citySlug: row.cityId ? citySlug.get(row.cityId) : undefined,
      author: row.author ?? undefined,
      image: row.imagePath ?? undefined,
      eventSlug: row.eventId ? eventSlug.get(row.eventId) : undefined,
      builderSlugs: optionalList(
        slugsOf(buildersByStory.get(row.id) ?? [], (r) => r.builderId, builderSlug),
      ),
      readingMinutes: row.readingMinutes ?? undefined,
      body: optionalList(row.body),
    } as Story),
  );

  /**
   * A byline, reassembled.
   *
   * The credential is NOT NULL in the database and required by the record, so
   * there is no case here where authority goes unattributed.
   */
  const authorshipOf = (row: {
    authorBuilderId: string | null;
    authorName: string | null;
    authorCredential: string;
  }): Authorship =>
    compact({
      builderSlug: row.authorBuilderId ? builderSlug.get(row.authorBuilderId) : undefined,
      name: row.authorName ?? undefined,
      credential: row.authorCredential,
    } as Authorship);

  const useCases: UseCase[] = useCaseRows.map((row) =>
    compact({
      id: row.id,
      slug: row.slug,
      status: moderationOf(row),
      createdAt: isoDate(row.createdAt),
      updatedAt: isoDate(row.updatedAt),
      title: row.title,
      summary: row.summary,
      category: row.category,
      author: authorshipOf(row),
      citySlug: row.cityId ? citySlug.get(row.cityId) : undefined,
      date: requiredDate(row.date),
      problem: row.problem,
      context: row.context,
      workflow: (workflowByUseCase.get(row.id) ?? []).map(
        (step) =>
          ({ title: step.title, detail: step.detail, by: step.by }) satisfies WorkflowStep,
      ),
      claudeDid: row.claudeDid,
      humanDid: row.humanDid,
      tools: row.tools,
      artifacts: optionalList(
        (artifactsByUseCase.get(row.id) ?? []).map(({ label, body }) => ({ label, body })),
      ),
      result: row.result,
      image: row.imagePath ?? undefined,
      projectSlug: row.projectId ? projectSlug.get(row.projectId) : undefined,
      eventSlug: row.eventId ? eventSlug.get(row.eventId) : undefined,
      sources: sourcesOf('use_case', row.id),
    } as UseCase),
  );

  const guides: Guide[] = guideRows.map((row) =>
    compact({
      id: row.id,
      slug: row.slug,
      status: moderationOf(row),
      createdAt: isoDate(row.createdAt),
      updatedAt: isoDate(row.updatedAt),
      title: row.title,
      question: row.question,
      standfirst: row.standfirst,
      author: authorshipOf(row),
      published: requiredDate(row.published),
      modified: isoDate(row.modified),
      readingMinutes: row.readingMinutes ?? undefined,
      image: row.imagePath ?? undefined,
      body: optionalList(
        (sectionsByGuide.get(row.id) ?? []).map((section) =>
          compact({
            heading: section.heading ?? undefined,
            paragraphs: section.paragraphs,
          }),
        ),
      ),
      sources: sourcesOf('guide', row.id),
      // A guide's related-record lists are declared associations with no join
      // table behind them, so they are absent rather than invented. Only
      // `eventSlugs` is read by a selector (`guidesForEvent`), and the
      // equivalence suite covers it.
    } as Guide),
  );

  return { ambassadors, builders, cities, events, guides, projects, stories, useCases };
}
