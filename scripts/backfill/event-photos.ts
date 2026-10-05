/**
 * The event-photograph backfill: strictly additive, one transaction, reversible.
 *
 * `src/assets/events/` holds 41 photographs and `src/data/events.ts` references
 * all 41. Six are live, the ones the initial commit added; `2322e4c` added the
 * other 35 and nothing copied them into the database, because `db:import` runs
 * nowhere automatically. This closes that gap and nothing else.
 *
 * ── WHY THIS IS NOT `npm run db:import` ──────────────────────────────────
 *
 * `db:import` would produce the right photograph delta and three things we do
 * not want (VIS-3 `gap-baseline` §11.2):
 *
 *  1. It has no transaction, and thirteen `replaceOrdered` sites that delete
 *     every child of a parent and then insert. A dropped connection between
 *     those two statements leaves a room empty until somebody re-runs it.
 *  2. It is authority-blind. It references `contentAuthority` zero times, while
 *     its `events` and `projects` upserts conflict on slug and overwrite title,
 *     summary, links, dates and `publication_status` — whether or not an
 *     organiser adopted that event into Baserow or a member claimed that
 *     project. Whether that fires depends on live data we cannot read.
 *  3. It has no inverse. No ledger, no batch id, no `rollback` verb; the only
 *     undo is a database restore.
 *
 * ── WHAT THIS DOES INSTEAD ───────────────────────────────────────────────
 *
 * Two inserts and one targeted update, inside one transaction:
 *
 *  - `media`, `ON CONFLICT (path) DO NOTHING` — DO NOTHING, not DO UPDATE, so
 *    the six rows that are already there are not touched.
 *  - `event_photos`, `ON CONFLICT DO NOTHING`. Every row appends: the live
 *    plates sit at positions 0, 1, 2 and the new entries start at 3, so
 *    nothing collides with the unique `(event_id, position)` index and no
 *    existing row has to move. `plan` verifies that against the target
 *    database rather than trusting it, because `DO NOTHING` would otherwise
 *    swallow a collision silently.
 *
 *    This count is **not reliably 35**. The record declared 11 events at
 *    `81fe1e7` and declares 17 now; a photo-bearing event with no row in the
 *    target is skipped and reported rather than treated as an error, because a
 *    database behind on events is an expected state. The dry run is what
 *    produces the real number.
 *  - `media.width` / `media.height` for the rows that lack them, measured off
 *    the files in git. `db/import/index.ts:324` writes only `{ path, alt, kind }`,
 *    so all 41 rows would carry nulls, and a null dimension makes a plate
 *    non-renderable once photographs are served from object storage. This is
 *    the one update worth making: it writes no field a human owns, and it
 *    deliberately leaves `updated_at` alone.
 *
 * Nothing here touches a row with a `content_authority` column, so hazard 2
 * cannot fire. `apply` writes a receipt, and `rollback` deletes exactly what
 * that receipt records — reversible without a restore.
 *
 * `media.consent` is left at its `false` default, deliberately. A script
 * asserting consent for photographs of real people, on no evidence beyond the
 * file being in git, would be worse than a column that is honestly empty. An
 * asset plate does not need one to render; whether subject consent should be
 * tracked at all is a question for a human, not for this insert.
 *
 * Before any of it, every path is checked against the asset registry the
 * reader resolves through — see `assetRegistryKeys`.
 *
 * `src/data/events.ts` is the authority for curated archive content. The alt
 * text and the ordering are copied from it; this script invents neither.
 */
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray, or } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import sharp from 'sharp';

import { events } from '../../src/data/events';
import * as schema from '../../db/schema';

/** Either pooled driver, or PGlite in the tests. Needs real transactions. */
export type BackfillDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

/** `media.path` is relative to this directory — see `src/lib/images.ts`. */
export const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../src/assets');

/**
 * The six plates commit `81fe1e7` added, and the six production serves.
 *
 * A measured fact, not a configuration: `git log --diff-filter=A --name-only
 * -- src/assets/events/` returns two commits, and the live set is the
 * initial-commit set file for file. Used to seed a rehearsal to the state the
 * real target is in — nothing reads it on the way to a write.
 */
export const LIVE_SIX = [
  'events/vol02-1.jpg',
  'events/vol02-2.jpg',
  'events/vol02-3.jpg',
  'events/vol06-1.jpg',
  'events/vol06-2.jpg',
  'events/vol06-3.jpg',
];

export interface WantedPhoto {
  eventSlug: string;
  /** Path relative to `src/assets`, e.g. `events/vol02-1.jpg`. */
  path: string;
  alt: string;
  /** The index in the event's `photos` array — what the gallery orders by. */
  position: number;
}

export interface Dimensions {
  width: number;
  height: number;
}

export interface MediaInsert extends Dimensions {
  path: string;
  alt: string;
}

export interface DimensionUpdate extends Dimensions {
  id: string;
  path: string;
  was: { width: number | null; height: number | null };
}

export interface PhotoInsert {
  eventSlug: string;
  eventId: string;
  path: string;
  position: number;
}

export interface PositionCollision {
  eventSlug: string;
  position: number;
  wantedPath: string;
  occupiedByMediaId: string;
}

export interface PositionDrift {
  eventSlug: string;
  path: string;
  recordPosition: number;
  livePosition: number;
}

export interface BackfillPlan {
  /** `media` rows to insert, with dimensions measured off disk. */
  mediaInserts: MediaInsert[];
  /**
   * `width`/`height` to write to `media` rows that already exist.
   *
   * **Empty unless `withDimensions` is set.** This is the only statement in the
   * operation that modifies a row the target database already has, and nothing
   * that renders today reads those two columns for an event photograph:
   * `src/data/source-db.ts:619` maps a plate to `{ src, alt }`, and the
   * gallery's dimensions come from `requireAsset`, which is Astro's own asset
   * import. The columns are read only on the project-logo path
   * (`src/lib/project-logo.ts:67,71`, `src/server/public/projects.ts:156`).
   *
   * So the run worth approving is pure-insert, and this is opt-in. See
   * `dimensionCandidates` for what the flag would write.
   */
  dimensionUpdates: DimensionUpdate[];
  /**
   * Existing `media` rows whose stored dimensions are null **or disagree with
   * the file**. What `--with-dimensions` would write; reported either way.
   */
  dimensionCandidates: DimensionUpdate[];
  /** Whether this plan intends to write `dimensionCandidates`. */
  withDimensions: boolean;
  /** `event_photos` rows to insert. */
  photoInserts: PhotoInsert[];
  /** Wanted plates already joined to their event. Nothing to do for these. */
  photosAlreadyPresent: number;
  /** Record paths that already have a `media` row. */
  mediaAlreadyPresent: number;
  /**
   * Photo-bearing events the record describes that have no row in the target.
   *
   * Reported and skipped, not fatal. `src/data/events.ts` declared 11 events at
   * `81fe1e7` and declares 17 now, and two of the twelve photo-bearing ones
   * (`claude-for-businesses`, `claude-code-build-day-fable`) are not among the
   * original 11 — so a target database behind on events is an expected state,
   * not a broken one. A photograph cannot join to an event row that does not
   * exist; inserting the event here would be `db:import`'s job and would carry
   * the authority hazard this script exists to avoid. So its `media` row still
   * lands (the file is real) and its `event_photos` row waits for a re-run.
   *
   * This is why the dry run is load-bearing rather than ceremonial: it is what
   * tells us the real `event_photos` number.
   */
  unknownEventSlugs: string[];
  /** Photographs not inserted because their event has no row. */
  photosSkippedForMissingEvent: number;
  /**
   * Refusals. Either one means the operation would not do what it says, so
   * `apply` declines rather than writing a partial result or letting
   * `ON CONFLICT DO NOTHING` hide the difference.
   */
  positionCollisions: PositionCollision[];
  unresolvableAssetPaths: string[];
  /** Reported, never corrected — this script does not move existing rows. */
  positionDrift: PositionDrift[];
  /** `event_photos` rows on these events that the record does not describe. */
  undescribedLiveRows: number;
}

/**
 * True when applying the plan would do exactly what the plan says.
 *
 * A missing event is deliberately **not** a refusal — its photographs are
 * skipped and reported, and the rest still land. A position collision and an
 * unresolvable asset path are, because the first would make the script claim
 * 35 while writing fewer, and the second would take `/gallery` down.
 */
export function isApplicable(plan: BackfillPlan): boolean {
  return plan.positionCollisions.length === 0 && plan.unresolvableAssetPaths.length === 0;
}

/**
 * Every photograph the record describes, in record order.
 *
 * The position is the array index, which is exactly what `replaceOrdered`
 * writes in `db/import/index.ts:760` — so a row this script inserts is
 * indistinguishable from one the importer would have written.
 */
export function wantedPhotos(): WantedPhoto[] {
  return events.flatMap((event) =>
    (event.photos ?? []).map((photo, position) => ({
      eventSlug: event.slug,
      path: photo.src,
      alt: photo.alt,
      position,
    })),
  );
}

/**
 * The distinct paths, with the alt text the record gives each one.
 *
 * `media.path` is unique, so one file is one row however many events show it.
 * Two events describing the same file differently is ambiguous rather than
 * additive, so it throws instead of picking a winner.
 */
export function distinctPaths(wanted: WantedPhoto[]): { path: string; alt: string }[] {
  const byPath = new Map<string, string>();
  for (const photo of wanted) {
    const seen = byPath.get(photo.path);
    if (seen === undefined) byPath.set(photo.path, photo.alt);
    else if (seen !== photo.alt) {
      throw new Error(
        `${photo.path} is described two different ways in src/data/events.ts. ` +
          `media.path is unique, so one of the two descriptions would be lost. Reconcile the record first.`,
      );
    }
  }
  return [...byPath].map(([path, alt]) => ({ path, alt }));
}

/**
 * The extensions `src/lib/images.ts:12` globs. Keep the two in step — the test
 * reads that line and fails if they drift.
 *
 * Case-sensitive, because the glob is: a file named `.JPG` does not reach the
 * registry however happily the filesystem opens it.
 */
export const ASSET_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.avif'];

/**
 * The keys `requireAsset` will answer to, derived the way the registry derives
 * them: every file under `src/assets` with a globbed extension, keyed by its
 * path relative to that directory.
 *
 * **Why this is not "the file exists".** `galleryRooms()` calls
 * `requireAsset(plate.src)` (`src/server/public/pages.ts:63`), which throws on
 * a key it cannot resolve (`src/lib/images.ts:30-38`), and
 * `src/pages/gallery.astro:17-24` turns that throw into a **503 for the whole
 * page** — every room, not just the bad plate. So one `media.path` that opens
 * on disk but keys differently in the bundle takes the gallery down. On a
 * case-insensitive filesystem `sharp` will read `events/VOL02-1.jpg` quite
 * happily; the registry, built from the real directory entries, will not.
 * Checking the key set rather than `existsSync` is the difference between a
 * failed dry run and a dead page.
 *
 * `import.meta.glob` is a Vite transform and does not exist in a tsx script,
 * so this walks the directory instead. Same inputs, same keys.
 */
export async function assetRegistryKeys(assetsDir = ASSETS_DIR): Promise<Set<string>> {
  const keys = new Set<string>();
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), key);
      else if (ASSET_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) keys.add(key);
    }
  };
  await walk(assetsDir, '');
  return keys;
}

/**
 * Measure the files in git.
 *
 * A missing or unreadable file throws: a `media` row for a file nobody can
 * open is the silently-broken graph `db/import/index.ts` refuses to write.
 */
export async function measure(paths: string[], assetsDir = ASSETS_DIR): Promise<Map<string, Dimensions>> {
  const measured = new Map<string, Dimensions>();
  for (const path of paths) {
    const { width, height, orientation } = await sharp(join(assetsDir, path)).metadata();
    if (!width || !height) throw new Error(`Could not read the dimensions of src/assets/${path}.`);
    // `metadata()` reports the stored pixels. EXIF orientation 5–8 rotates the
    // image a quarter turn on display, which is how the site shows it, so the
    // dimensions the database records have to be the displayed ones.
    const quarterTurn = orientation !== undefined && orientation >= 5 && orientation <= 8;
    measured.set(path, quarterTurn ? { width: height, height: width } : { width, height });
  }
  return measured;
}

/**
 * The dry run. Reads the target database, writes nothing, and returns the
 * exact delta `apply` would produce against the state it just read.
 */
export async function buildBackfillPlan(
  db: BackfillDatabase,
  options: { assetsDir?: string; withDimensions?: boolean } = {},
): Promise<BackfillPlan> {
  const withDimensions = options.withDimensions ?? false;
  const wanted = wantedPhotos();
  const declared = distinctPaths(wanted);

  // Before anything else, and before the write: would the reader resolve these?
  const registry = await assetRegistryKeys(options.assetsDir);
  const unresolvableAssetPaths = declared.filter((p) => !registry.has(p.path)).map((p) => p.path);
  const unresolvable = new Set(unresolvableAssetPaths);
  const paths = declared.filter((p) => !unresolvable.has(p.path));

  const measured = await measure(
    paths.map((p) => p.path),
    options.assetsDir,
  );

  const slugs = [...new Set(wanted.map((photo) => photo.eventSlug))];
  const eventRows = await db
    .select({ id: schema.events.id, slug: schema.events.slug })
    .from(schema.events)
    .where(inArray(schema.events.slug, slugs));
  const eventIdBySlug = new Map(eventRows.map((row) => [row.slug, row.id]));
  const unknownEventSlugs = slugs.filter((slug) => !eventIdBySlug.has(slug));

  const mediaRows = await db
    .select({
      id: schema.media.id,
      path: schema.media.path,
      width: schema.media.width,
      height: schema.media.height,
    })
    .from(schema.media)
    .where(inArray(schema.media.path, paths.map((p) => p.path)));
  const mediaByPath = new Map(mediaRows.map((row) => [row.path as string, row]));

  const eventIds = eventRows.map((row) => row.id);
  const liveRows = eventIds.length
    ? await db
        .select({
          eventId: schema.eventPhotos.eventId,
          mediaId: schema.eventPhotos.mediaId,
          position: schema.eventPhotos.position,
        })
        .from(schema.eventPhotos)
        .where(inArray(schema.eventPhotos.eventId, eventIds))
    : [];
  const livePositionOwner = new Map(liveRows.map((row) => [`${row.eventId}:${row.position}`, row.mediaId]));
  const livePositionByPair = new Map(liveRows.map((row) => [`${row.eventId}:${row.mediaId}`, row.position]));

  const mediaInserts: MediaInsert[] = [];
  for (const { path, alt } of paths) {
    if (mediaByPath.has(path)) continue;
    mediaInserts.push({ path, alt, ...measured.get(path)! });
  }

  const dimensionCandidates: DimensionUpdate[] = [];
  for (const { path } of paths) {
    const row = mediaByPath.get(path);
    if (!row) continue;
    const want = measured.get(path)!;
    if (row.width === want.width && row.height === want.height) continue;
    dimensionCandidates.push({ id: row.id, path, ...want, was: { width: row.width, height: row.height } });
  }

  const photoInserts: PhotoInsert[] = [];
  const positionCollisions: PositionCollision[] = [];
  const positionDrift: PositionDrift[] = [];
  let photosAlreadyPresent = 0;

  let photosSkippedForMissingEvent = 0;

  for (const photo of wanted) {
    if (unresolvable.has(photo.path)) continue; // Already refused; nothing to plan.
    const eventId = eventIdBySlug.get(photo.eventSlug);
    if (!eventId) {
      // Reported, not fatal. The media row still lands; the join waits for the
      // event row to exist. See `unknownEventSlugs`.
      photosSkippedForMissingEvent += 1;
      continue;
    }
    const mediaId = mediaByPath.get(photo.path)?.id;

    if (mediaId !== undefined) {
      const livePosition = livePositionByPair.get(`${eventId}:${mediaId}`);
      if (livePosition !== undefined) {
        photosAlreadyPresent += 1;
        // Additive only: a plate the record has moved stays where it is. The
        // reorder is a different operation and belongs to whoever wants it.
        if (livePosition !== photo.position) {
          positionDrift.push({
            eventSlug: photo.eventSlug,
            path: photo.path,
            recordPosition: photo.position,
            livePosition,
          });
        }
        continue;
      }
    }

    // The slot this plate wants. If something else holds it, `ON CONFLICT DO
    // NOTHING` would skip the insert without a word — so refuse instead.
    const occupant = livePositionOwner.get(`${eventId}:${photo.position}`);
    if (occupant !== undefined) {
      positionCollisions.push({
        eventSlug: photo.eventSlug,
        position: photo.position,
        wantedPath: photo.path,
        occupiedByMediaId: occupant,
      });
      continue;
    }

    photoInserts.push({ eventSlug: photo.eventSlug, eventId, path: photo.path, position: photo.position });
  }

  const wantedPairs = new Set(
    wanted.flatMap((photo) => {
      const eventId = eventIdBySlug.get(photo.eventSlug);
      const mediaId = mediaByPath.get(photo.path)?.id;
      return eventId && mediaId ? [`${eventId}:${mediaId}`] : [];
    }),
  );
  const undescribedLiveRows = liveRows.filter((row) => !wantedPairs.has(`${row.eventId}:${row.mediaId}`)).length;

  return {
    mediaInserts,
    dimensionUpdates: withDimensions ? dimensionCandidates : [],
    dimensionCandidates,
    withDimensions,
    photoInserts,
    photosAlreadyPresent,
    mediaAlreadyPresent: paths.length - mediaInserts.length,
    unknownEventSlugs,
    photosSkippedForMissingEvent,
    positionCollisions,
    unresolvableAssetPaths,
    positionDrift,
    undescribedLiveRows,
  };
}

export interface BackfillReceipt {
  appliedAt: string;
  /**
   * Host and database name — never the connection string, which carries a
   * password, and a receipt is a file.
   *
   * The name is here because the host alone does not identify a database: for
   * local work every database is `localhost`, so a host-only check would let a
   * receipt be replayed against the wrong one. It fails safe either way — the
   * keys are UUIDs, so a cross-database rollback matches nothing — but a rail
   * should match its description.
   */
  databaseHost: string;
  databaseName: string;
  insertedMedia: { id: string; path: string }[];
  insertedPhotos: { eventId: string; eventSlug: string; mediaId: string; path: string; position: number }[];
  /**
   * The dimension update, with the values it replaced.
   *
   * `rollback` does not revert these. Putting a null back would restore the
   * defect rather than the state, and no reader or editor can see the
   * difference. The previous values are recorded so a human who disagrees can
   * reverse it by hand.
   */
  dimensionsUpdated: { id: string; path: string; width: number; height: number; was: { width: number | null; height: number | null } }[];
  /** The inverse, as SQL, so the undo is readable without running anything. */
  rollbackSql: string;
}

/**
 * Apply the plan in one transaction.
 *
 * Both inserts count their returned rows against the plan and throw on a
 * difference, which rolls the whole thing back. That is what makes `DO NOTHING`
 * safe here: a target database that moved since the dry run aborts loudly
 * instead of writing a partial delta.
 */
export async function applyBackfill(
  db: BackfillDatabase,
  plan: BackfillPlan,
  context: { databaseHost: string; databaseName: string },
): Promise<BackfillReceipt> {
  if (!isApplicable(plan)) {
    throw new Error('This plan is not applicable — re-run the dry run and resolve its refusals first.');
  }

  return db.transaction(async (tx) => {
    const returned = plan.mediaInserts.length
      ? await tx
          .insert(schema.media)
          .values(
            plan.mediaInserts.map((row) => ({
              path: row.path,
              alt: row.alt,
              kind: 'photo' as const,
              width: row.width,
              height: row.height,
            })),
          )
          .onConflictDoNothing({ target: schema.media.path })
          .returning({ id: schema.media.id, path: schema.media.path })
      : [];
    if (returned.length !== plan.mediaInserts.length) {
      throw new Error(
        `Expected to insert ${plan.mediaInserts.length} media rows but inserted ${returned.length}. ` +
          `The target database changed since the dry run. Rolled back; re-run the dry run.`,
      );
    }
    // `media.path` is nullable — an uploaded blob has a `pathname`, not an
    // asset path. Every row here was given one, and the receipt is the undo,
    // so a null would make this run unrollbackable rather than merely odd.
    const insertedMedia = returned.map((row) => {
      if (row.path === null) throw new Error('A media row came back with no path. Rolled back.');
      return { id: row.id, path: row.path };
    });

    // `media.updated_at` has no trigger and no `$onUpdate`, so writing the two
    // dimension columns leaves it alone. That is deliberate: these six rows
    // did not change in any way a reader or an editor would recognise.
    for (const update of plan.dimensionUpdates) {
      await tx
        .update(schema.media)
        .set({ width: update.width, height: update.height })
        .where(eq(schema.media.id, update.id));
    }

    // The join on `media.path`, materialised. The rows inserted above are
    // already visible inside this transaction.
    const mediaRows = await tx
      .select({ id: schema.media.id, path: schema.media.path })
      .from(schema.media)
      .where(inArray(schema.media.path, plan.photoInserts.map((row) => row.path)));
    const mediaIdByPath = new Map(mediaRows.map((row) => [row.path as string, row.id]));

    const photoValues = plan.photoInserts.map((row) => {
      const mediaId = mediaIdByPath.get(row.path);
      if (!mediaId) throw new Error(`No media row for ${row.path} after the insert. Rolled back.`);
      return { ...row, mediaId };
    });

    const insertedPhotos = photoValues.length
      ? await tx
          .insert(schema.eventPhotos)
          .values(
            photoValues.map((row) => ({ eventId: row.eventId, mediaId: row.mediaId, position: row.position })),
          )
          .onConflictDoNothing()
          .returning({ eventId: schema.eventPhotos.eventId, mediaId: schema.eventPhotos.mediaId })
      : [];
    if (insertedPhotos.length !== photoValues.length) {
      throw new Error(
        `Expected to insert ${photoValues.length} event_photos rows but inserted ${insertedPhotos.length}. ` +
          `The target database changed since the dry run. Rolled back; re-run the dry run.`,
      );
    }

    const receipt: BackfillReceipt = {
      appliedAt: new Date().toISOString(),
      databaseHost: context.databaseHost,
      databaseName: context.databaseName,
      insertedMedia,
      insertedPhotos: photoValues.map((row) => ({
        eventId: row.eventId,
        eventSlug: row.eventSlug,
        mediaId: row.mediaId,
        path: row.path,
        position: row.position,
      })),
      dimensionsUpdated: plan.dimensionUpdates.map(({ id, path, width, height, was }) => ({ id, path, width, height, was })),
      rollbackSql: '',
    };
    receipt.rollbackSql = renderRollbackSql(receipt);
    return receipt;
  });
}

/**
 * Undo exactly what a receipt records.
 *
 * Driven by the receipt rather than recomputed from the record, because "the
 * 35 the record describes" and "the 35 this run inserted" stop being the same
 * set the moment anything else writes. A `media` row that something else has
 * since adopted is left alone and reported.
 */
export async function rollbackBackfill(
  db: BackfillDatabase,
  receipt: BackfillReceipt,
): Promise<{
  photosDeleted: number;
  mediaDeleted: number;
  mediaRetained: { path: string; reason: string }[];
  /** Receipt rows something else had already deleted. Reported, not an error. */
  mediaAlreadyGone: number;
}> {
  // A receipt is a file, and a file can be edited. Listing a media id twice
  // makes the undo lie rather than fail: `inArray` de-duplicates, so the DELETE
  // comes back one row short of `deletable.length` and the run reports "1 media
  // row had already been deleted by something else" about a row it deleted
  // itself. Nothing downstream can tell the difference, so refuse here, before
  // the transaction opens. [VIS-17]
  //
  // Only `insertedMedia` is checked. A duplicated `insertedPhotos` pair makes
  // `photosDeleted` one short of the number the receipt lists, which is a total
  // the CLI prints without explaining — it does not attribute the difference to
  // another actor, so it states nothing false.
  const seen = new Set<string>();
  const duplicated: string[] = [];
  for (const row of receipt.insertedMedia) {
    if (seen.has(row.id)) duplicated.push(row.id);
    seen.add(row.id);
  }
  if (duplicated.length) {
    throw new Error(
      `This receipt lists ${duplicated.length} media id(s) more than once (${duplicated.join(', ')}). ` +
        `Refusing: the counts it reports would be wrong. Nothing was deleted.`,
    );
  }

  return db.transaction(async (tx) => {
    const photosDeleted = receipt.insertedPhotos.length
      ? (
          await tx
            .delete(schema.eventPhotos)
            .where(
              or(
                ...receipt.insertedPhotos.map((row) =>
                  and(eq(schema.eventPhotos.eventId, row.eventId), eq(schema.eventPhotos.mediaId, row.mediaId)),
                ),
              ),
            )
            .returning({ mediaId: schema.eventPhotos.mediaId })
        ).length
      : 0;

    const mediaIds = receipt.insertedMedia.map((row) => row.id);
    const mediaRetained: { path: string; reason: string }[] = [];
    const deletable: string[] = [];

    for (const row of receipt.insertedMedia) {
      // `event_photos.media_id` is ON DELETE RESTRICT, so a row some other
      // event now shows would abort the whole transaction. Every other
      // reference to `media` is ON DELETE SET NULL, which would quietly blank
      // a cover, a logo or an avatar a human chose. Neither is an undo.
      const [stillUsed] = await tx
        .select({ eventId: schema.eventPhotos.eventId })
        .from(schema.eventPhotos)
        .where(eq(schema.eventPhotos.mediaId, row.id))
        .limit(1);
      if (stillUsed) {
        mediaRetained.push({ path: row.path, reason: 'another event_photos row references it' });
        continue;
      }
      const adopted = await adoptedElsewhere(tx, row.id);
      if (adopted) {
        mediaRetained.push({ path: row.path, reason: `adopted as ${adopted}` });
        continue;
      }
      deletable.push(row.id);
    }

    const mediaDeleted = deletable.length
      ? (await tx.delete(schema.media).where(inArray(schema.media.id, deletable)).returning({ id: schema.media.id }))
          .length
      : 0;

    // A row somebody else already deleted is neither retained nor deleted by
    // us. Counting it as a failure used to abort the transaction and take the
    // other 34 join-row deletes down with it, leaving nothing undone and no
    // way forward but editing the receipt. One missing row is not a reason to
    // refuse the whole undo — it is a reason to say so.
    const mediaAlreadyGone = deletable.length - mediaDeleted;

    // Verify the claim `mediaAlreadyGone` makes about the database, rather
    // than the arithmetic that produced it. The three buckets are exhaustive
    // by construction — the loop above puts every receipt row in exactly one
    // of `mediaRetained` or `deletable` — so `mediaDeleted +
    // mediaRetained.length + mediaAlreadyGone === mediaIds.length` is an
    // identity, and the throw that used to check it could not fire. [VIS-17]
    //
    // What can actually be false is "a row the DELETE did not return is gone".
    // A `BEFORE DELETE` trigger returning NULL suppresses a delete silently:
    // no error, no returned row, the row still there. Not hypothetical here —
    // the dry run tells the operator to check `pg_trigger` precisely because
    // an uncommitted trigger on `media` is the one thing this repo cannot see.
    // Reporting a surviving row as "already deleted by something else" would
    // undercount the undo, which is the one thing this function must not do.
    //
    // This is the second of two guards and neither subsumes the other: the
    // duplicate check above validates the receipt before the deletes, this one
    // validates the database after them. With duplicates already refused,
    // `mediaAlreadyGone` has two causes left — a genuine prior delete and a
    // suppressed one — and this query is what separates them.
    if (mediaAlreadyGone) {
      const stillThere = await tx
        .select({ id: schema.media.id })
        .from(schema.media)
        .where(inArray(schema.media.id, deletable));
      if (stillThere.length) {
        throw new Error(
          `${stillThere.length} of the ${mediaIds.length} media rows the receipt lists were neither deleted ` +
            `nor retained, and still exist — something is suppressing the delete. Look for a BEFORE DELETE ` +
            `trigger on media: SELECT tgname FROM pg_trigger WHERE tgrelid = 'media'::regclass AND NOT ` +
            `tgisinternal. Rolled back.`,
        );
      }
    }

    return { photosDeleted, mediaDeleted, mediaRetained, mediaAlreadyGone };
  });
}

/**
 * Every foreign key to `media.id` outside `event_photos`.
 *
 * `db/schema.ts` has eleven references to `media.id`. One is
 * `event_photos.media_id`, which is ON DELETE RESTRICT and handled on its own;
 * these are the other ten, and every one is ON DELETE **SET NULL**. So
 * deleting a `media` row that any of them points at does not fail — it quietly
 * blanks a cover, a logo or an avatar a human chose. That is not an undo.
 *
 * ONE list, deliberately. `rollbackBackfill` runs `present` to decide what to
 * keep, and the rollback SQL the dry run prints emits a guard clause from
 * `table`/`column`. They were two lists once and they disagreed: the command
 * protected an adopted row and the SQL it printed did not. Add a column here
 * and both paths learn about it at the same time.
 *
 * `present` goes through Drizzle's builder, so nothing on the execution path is
 * assembled from a string. `table`/`column` are for the printed SQL only.
 */
const MEDIA_ADOPTERS: {
  table: string;
  column: string;
  present: (tx: BackfillDatabase, mediaId: string) => Promise<boolean>;
}[] = [
  {
    table: 'events',
    column: 'cover_image_id',
    present: async (tx, id) =>
      (await tx.select({ k: schema.events.id }).from(schema.events).where(eq(schema.events.coverImageId, id)).limit(1)).length > 0,
  },
  {
    table: 'cities',
    column: 'image_id',
    present: async (tx, id) =>
      (await tx.select({ k: schema.cities.id }).from(schema.cities).where(eq(schema.cities.imageId, id)).limit(1)).length > 0,
  },
  {
    table: 'builders',
    column: 'image_id',
    present: async (tx, id) =>
      (await tx.select({ k: schema.builders.id }).from(schema.builders).where(eq(schema.builders.imageId, id)).limit(1)).length > 0,
  },
  {
    table: 'ambassadors',
    column: 'image_id',
    present: async (tx, id) =>
      (await tx.select({ k: schema.ambassadors.id }).from(schema.ambassadors).where(eq(schema.ambassadors.imageId, id)).limit(1)).length > 0,
  },
  {
    table: 'projects',
    column: 'image_id',
    present: async (tx, id) =>
      (await tx.select({ k: schema.projects.id }).from(schema.projects).where(eq(schema.projects.imageId, id)).limit(1)).length > 0,
  },
  {
    table: 'projects',
    column: 'logo_media_id',
    present: async (tx, id) =>
      (await tx.select({ k: schema.projects.id }).from(schema.projects).where(eq(schema.projects.logoMediaId, id)).limit(1)).length > 0,
  },
  {
    table: 'member_profiles',
    column: 'avatar_media_id',
    present: async (tx, id) =>
      (await tx.select({ k: schema.memberProfiles.memberId }).from(schema.memberProfiles).where(eq(schema.memberProfiles.avatarMediaId, id)).limit(1)).length > 0,
  },
  {
    table: 'stories',
    column: 'image_id',
    present: async (tx, id) =>
      (await tx.select({ k: schema.stories.id }).from(schema.stories).where(eq(schema.stories.imageId, id)).limit(1)).length > 0,
  },
  {
    table: 'use_cases',
    column: 'image_id',
    present: async (tx, id) =>
      (await tx.select({ k: schema.useCases.id }).from(schema.useCases).where(eq(schema.useCases.imageId, id)).limit(1)).length > 0,
  },
  {
    table: 'guides',
    column: 'image_id',
    present: async (tx, id) =>
      (await tx.select({ k: schema.guides.id }).from(schema.guides).where(eq(schema.guides.imageId, id)).limit(1)).length > 0,
  },
];

/** Which column has adopted this media row, if any. */
async function adoptedElsewhere(tx: BackfillDatabase, mediaId: string): Promise<string | null> {
  for (const adopter of MEDIA_ADOPTERS) {
    if (await adopter.present(tx, mediaId)) return `${adopter.table}.${adopter.column}`;
  }
  return null;
}

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
const list = (values: string[], indent: string) => values.map((v) => `${indent}${quote(v)}`).join(',\n');

/**
 * The guard clauses that keep a `DELETE FROM media` from blanking somebody's
 * cover. Generated from `MEDIA_ADOPTERS`, so the printed SQL cannot protect
 * less than `rollback --receipt` does.
 */
function mediaDeleteGuards(): string {
  return [
    '   AND id NOT IN (SELECT media_id FROM event_photos)',
    ...MEDIA_ADOPTERS.map(
      (a) => `   AND id NOT IN (SELECT ${a.column} FROM ${a.table} WHERE ${a.column} IS NOT NULL)`,
    ),
  ].join('\n');
}

const PREFER_THE_COMMAND = [
  '-- Prefer `npm run backfill:photos -- rollback --receipt <file> --yes` to this file.',
  '-- The command does the same two deletes and reports what it kept and why.',
  '-- This SQL is here so the undo is readable, and so it exists if the receipt',
  '-- does not. The guards below are what stop a DELETE FROM media blanking a',
  '-- cover, logo or avatar that something has pointed at since the backfill.',
].join('\n');

/** The inverse of a receipt, as SQL. Printed, never executed. */
export function renderRollbackSql(receipt: BackfillReceipt): string {
  if (!receipt.insertedMedia.length && !receipt.insertedPhotos.length) return '-- Nothing was inserted; nothing to undo.';
  const pairs = receipt.insertedPhotos.map((row) => `  (${quote(row.eventId)}, ${quote(row.mediaId)})`).join(',\n');
  const paths = list(receipt.insertedMedia.map((row) => row.path), '  ');
  return [
    PREFER_THE_COMMAND,
    '',
    'BEGIN;',
    '',
    '-- 1. the join rows this backfill wrote, and only those',
    'DELETE FROM event_photos',
    ` WHERE (event_id, media_id) IN (\n${pairs}\n );`,
    '',
    '-- 2. the media rows, which exist only because of this backfill',
    'DELETE FROM media',
    ` WHERE path IN (\n${paths}\n )`,
    mediaDeleteGuards(),
    ' ;',
    '',
    'COMMIT;',
  ].join('\n');
}

/**
 * The inverse of a *plan*, as SQL — keyed on path, because no id exists yet.
 *
 * `renderRollbackSql` is exact: a receipt knows the ids it wrote. This one is
 * printed by the dry run, before the write, so it has only paths to go on.
 *
 * Narrowed on purpose. `DELETE FROM event_photos WHERE media_id IN (SELECT id
 * FROM media WHERE path IN (…))` would take **every** join row for those media
 * across every event, not only the rows this backfill would write. So the
 * `event_photos` delete is restricted to the exact `(event slug, path)` pairs
 * the plan would insert, and the `media` delete carries the same adoption
 * guards the command applies.
 */
export function renderPlannedRollbackSql(plan: BackfillPlan): string {
  if (!plan.mediaInserts.length && !plan.photoInserts.length) return '-- Nothing would be inserted; nothing to undo.';
  const pairs = plan.photoInserts
    .map((row) => `    (${quote(row.eventSlug)}, ${quote(row.path)})`)
    .join(',\n');
  const paths = list(plan.mediaInserts.map((row) => row.path), '    ');
  const lines = [PREFER_THE_COMMAND, '', 'BEGIN;', ''];
  if (plan.photoInserts.length) {
    lines.push(
      '-- 1. only the join rows this backfill would write, matched the way it',
      '--    matched them: event by slug, media by path.',
      'DELETE FROM event_photos ep',
      ' USING events e, media m',
      ' WHERE ep.event_id = e.id',
      '   AND ep.media_id = m.id',
      `   AND (e.slug, m.path) IN (\n${pairs}\n   );`,
      '',
    );
  }
  if (plan.mediaInserts.length) {
    lines.push(
      '-- 2. the media rows, which would exist only because of this backfill',
      'DELETE FROM media',
      ` WHERE path IN (\n${paths}\n )`,
      mediaDeleteGuards(),
      ' ;',
      '',
    );
  }
  lines.push('COMMIT;');
  return lines.join('\n');
}

/** The dry run, as text. */
export function renderPlan(plan: BackfillPlan): string {
  const lines: string[] = [];
  const byEvent = new Map<string, PhotoInsert[]>();
  for (const row of plan.photoInserts) {
    const list = byEvent.get(row.eventSlug) ?? [];
    list.push(row);
    byEvent.set(row.eventSlug, list);
  }

  lines.push('DELTA');
  lines.push(
    `  media             +${plan.mediaInserts.length} inserted` +
      (plan.dimensionUpdates.length ? `, ${plan.dimensionUpdates.length} updated (width/height only)` : ', 0 updated'),
  );
  lines.push(
    `  event_photos      +${plan.photoInserts.length} inserted` +
      (plan.photosSkippedForMissingEvent ? `  (${plan.photosSkippedForMissingEvent} skipped — see MISSING EVENTS)` : ''),
  );
  lines.push('  deletes           0');
  lines.push('  other tables      untouched');
  lines.push('');

  if (plan.photoInserts.length) {
    lines.push(`event_photos — ${plan.photoInserts.length} rows across ${byEvent.size} events`);
    for (const [slug, rows] of byEvent) {
      lines.push(`  ${slug}`);
      for (const row of rows.sort((a, b) => a.position - b.position)) {
        const size = plan.mediaInserts.find((m) => m.path === row.path);
        lines.push(`    position ${String(row.position).padStart(2)}  ${row.path}${size ? `  ${size.width}x${size.height}` : ''}`);
      }
    }
    lines.push('');
  }

  if (plan.dimensionCandidates.length) {
    lines.push(
      plan.withDimensions
        ? `media — WRITING width/height to ${plan.dimensionCandidates.length} EXISTING rows (no other column, no updated_at)`
        : `media — ${plan.dimensionCandidates.length} existing row(s) have no or stale width/height. NOT writing them:`,
    );
    for (const row of plan.dimensionCandidates) {
      const was = row.was.width === null && row.was.height === null ? 'null' : `${row.was.width}x${row.was.height}`;
      lines.push(`  ${row.path}  ${was} -> ${row.width}x${row.height}`);
    }
    lines.push(
      plan.withDimensions
        ? '  This is the only statement here that modifies a row the database already has. Nothing'
        : '  Pass --with-dimensions to write them. Left off by default because this is the only',
    );
    lines.push(
      plan.withDimensions
        ? '  rendering today reads these two columns for an event photograph.'
        : '  statement that would modify a row the database already has, and nothing rendering today',
    );
    if (!plan.withDimensions) lines.push('  reads these two columns for an event photograph.');
    lines.push('');
  }

  lines.push('ALREADY IN PLACE');
  lines.push(`  ${plan.photosAlreadyPresent} of ${wantedPhotos().length} plates the record describes are already joined to their event.`);
  if (plan.undescribedLiveRows) {
    lines.push(`  ${plan.undescribedLiveRows} event_photos row(s) on these events are not in the record. Left alone — this operation never deletes.`);
  }
  lines.push('');

  if (plan.positionDrift.length) {
    lines.push('DRIFT — reported, not corrected');
    for (const row of plan.positionDrift) {
      lines.push(`  ${row.eventSlug} ${row.path}: record says position ${row.recordPosition}, database has ${row.livePosition}`);
    }
    lines.push('  Reordering existing plates is a different operation. This one only appends.');
    lines.push('');
  }

  if (plan.unknownEventSlugs.length) {
    lines.push(`MISSING EVENTS — ${plan.photosSkippedForMissingEvent} photograph(s) skipped, not an error:`);
    for (const slug of plan.unknownEventSlugs) lines.push(`  ${slug}`);
    lines.push('  These events are in the record and have no row in the target, so their photographs');
    lines.push('  have nothing to join to. Their media rows still land; the joins appear on a re-run');
    lines.push('  once the event rows exist. Creating an event row is `db:import`\'s job, not this');
    lines.push('  script\'s — report these slugs rather than folding them in.');
    lines.push('');
  }

  if (plan.unresolvableAssetPaths.length) {
    lines.push('REFUSING — the asset registry would not resolve these paths:');
    for (const path of plan.unresolvableAssetPaths) lines.push(`  ${path}`);
    lines.push('  `requireAsset` throws on an unresolved key and `/gallery` answers 503 for the whole');
    lines.push('  page, so one of these in `media.path` takes every room down. Fix the path or the file.');
    lines.push('');
  }

  if (plan.positionCollisions.length) {
    lines.push('REFUSING — these positions are already held by a different media row:');
    for (const row of plan.positionCollisions) {
      lines.push(`  ${row.eventSlug} position ${row.position} wanted by ${row.wantedPath}, held by media ${row.occupiedByMediaId}`);
    }
    lines.push('  ON CONFLICT DO NOTHING would skip these without a word, so apply declines instead.');
    lines.push('');
  }

  lines.push(isApplicable(plan) ? 'APPLICABLE — re-run with `apply --yes` to write it.' : 'NOT APPLICABLE — resolve the refusals above first.');
  return lines.join('\n');
}
