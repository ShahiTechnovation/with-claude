/**
 * The event-photograph backfill, against a real PostgreSQL rewound to the
 * state production is actually in.
 *
 * The seed is not invented. `importRecords` builds the whole graph from the
 * current record, and then the six paths commit `81fe1e7` added are kept and
 * the thirty-five commit `2322e4c` added are removed — which is production,
 * file for file, because the live set is the initial-commit set and nothing
 * filters (VIS-3 `gap-baseline` §11.1).
 *
 * So the delta these tests measure is the delta the dry run will print against
 * Neon, and the gallery assertion is the same derivation `gallery.astro:28`
 * renders rather than a restatement of the insert.
 */
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import { importRecords } from '../db/import';
import * as schema from '../db/schema';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import { galleryRooms } from '../src/server/public/pages';
import { emitReceipt, receiptPath, type ReceiptSink } from '../scripts/backfill/emit-receipt';
import {
  applyBackfill,
  ASSET_EXTENSIONS,
  assetRegistryKeys,
  buildBackfillPlan,
  isApplicable,
  LIVE_SIX,
  measure,
  renderPlan,
  renderPlannedRollbackSql,
  rollbackBackfill,
  wantedPhotos,
} from '../scripts/backfill/event-photos';

let db: TestDatabase;

const photoCount = async () => {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.eventPhotos);
  return row.n;
};

const mediaPhotoCount = async () => {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.media)
    .where(eq(schema.media.kind, 'photo'));
  return row.n;
};

const nullDimensionCount = async () => {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.media)
    .where(and(eq(schema.media.kind, 'photo'), or(isNull(schema.media.width), isNull(schema.media.height))));
  return row.n;
};

beforeEach(async () => {
  db = await createTestDatabase();
  await importRecords(db as never);
  // Rewind to the live state: drop the thirty-five `2322e4c` added.
  const stale = await db
    .select({ id: schema.media.id })
    .from(schema.media)
    .where(and(eq(schema.media.kind, 'photo'), notInArray(schema.media.path, LIVE_SIX)));
  const staleIds = stale.map((row) => row.id);
  if (staleIds.length) {
    await db.delete(schema.eventPhotos).where(inArray(schema.eventPhotos.mediaId, staleIds));
    await db.delete(schema.media).where(inArray(schema.media.id, staleIds));
  }
}, 180_000);

afterEach(async () => {
  await db?.$close();
});

describe('the seed reproduces production', () => {
  it('serves six plates in two rooms, and db:import left every dimension null', async () => {
    expect(await mediaPhotoCount()).toBe(6);
    expect(await photoCount()).toBe(6);
    // `db/import/index.ts:324` writes only { path, alt, kind } — the reason
    // this script measures the files rather than leaving a later backfill.
    expect(await nullDimensionCount()).toBe(6);

    const rooms = await galleryRooms(db as never);
    expect(rooms).toHaveLength(2);
    expect(rooms.reduce((sum, room) => sum + room.plates.length, 0)).toBe(6);
  });
});

describe('the dry run', () => {
  it('prints a +35 / +35 delta with no deletes and no refusals', async () => {
    const plan = await buildBackfillPlan(db as never);

    expect(plan.mediaInserts).toHaveLength(35);
    expect(plan.photoInserts).toHaveLength(35);
    // Pure-insert by default: the one statement that touches existing rows is
    // reported as a candidate and not written without --with-dimensions.
    expect(plan.dimensionUpdates).toEqual([]);
    expect(plan.dimensionCandidates).toHaveLength(6);
    expect(plan.withDimensions).toBe(false);
    expect(plan.photosAlreadyPresent).toBe(6);
    expect(plan.unknownEventSlugs).toEqual([]);
    expect(plan.photosSkippedForMissingEvent).toBe(0);
    expect(plan.positionCollisions).toEqual([]);
    expect(plan.unresolvableAssetPaths).toEqual([]);
    expect(plan.positionDrift).toEqual([]);
    expect(plan.undescribedLiveRows).toBe(0);
    expect(isApplicable(plan)).toBe(true);

    // Every insert appends, which is what makes the operation additive.
    expect(plan.photoInserts.every((row) => row.position >= 0)).toBe(true);
    for (const row of plan.photoInserts.filter((r) => r.eventSlug === 'claude-meetup')) {
      expect(row.position).toBeGreaterThanOrEqual(3);
    }

    // The 35 carry measured dimensions, not nulls.
    for (const row of plan.mediaInserts) {
      expect(row.width, row.path).toBeGreaterThan(0);
      expect(row.height, row.path).toBeGreaterThan(0);
      expect(row.alt.trim(), row.path).not.toBe('');
    }

    // The dry run carries its own undo, keyed on path so it needs no receipt.
    const undo = renderPlannedRollbackSql(plan);
    expect(undo.match(/'events\//g) ?? []).toHaveLength(70); // the 35 paths, in both deletes
    expect(undo).toContain('DELETE FROM event_photos');
    expect(undo).toContain('DELETE FROM media');
    expect(undo).toContain('COMMIT;');
    for (const live of LIVE_SIX) expect(undo, live).not.toContain(live);

    // The counts the CLI prints as "expect N" are derived from these two.
    expect(plan.mediaAlreadyPresent + plan.mediaInserts.length).toBe(41);
    expect(plan.photosAlreadyPresent + plan.photoInserts.length).toBe(41);

    const printed = renderPlan(plan);
    expect(printed).toContain('media             +35 inserted, 0 updated');
    expect(printed).toContain('NOT writing them');
    expect(printed).toContain('event_photos      +35');
    expect(printed).toContain('deletes           0');
    expect(printed).toContain('APPLICABLE');
  });

  it('writes nothing', async () => {
    await buildBackfillPlan(db as never);
    expect(await mediaPhotoCount()).toBe(6);
    expect(await photoCount()).toBe(6);
  });
});

describe('apply', () => {
  it('brings the gallery to twelve rooms and 41 photographs', async () => {
    const plan = await buildBackfillPlan(db as never);
    const receipt = await applyBackfill(db as never, plan, { databaseHost: 'pglite', databaseName: 'memory' });

    expect(receipt.insertedMedia).toHaveLength(35);
    expect(receipt.insertedPhotos).toHaveLength(35);
    // Pure insert by default — no existing row modified at all.
    expect(receipt.dimensionsUpdated).toEqual([]);

    expect(await mediaPhotoCount()).toBe(41);
    expect(await photoCount()).toBe(41);
    // The 35 new rows carry measured dimensions; the 6 that were already there
    // keep their nulls until somebody asks for --with-dimensions.
    expect(await nullDimensionCount()).toBe(6);
    expect(wantedPhotos()).toHaveLength(41);

    // The real check: what the page derives from what rendered.
    const rooms = await galleryRooms(db as never);
    expect(rooms).toHaveLength(12);
    expect(rooms.reduce((sum, room) => sum + room.plates.length, 0)).toBe(41);
    for (const plate of rooms.flatMap((room) => room.plates)) {
      expect(plate.image, plate.src).toBeTruthy();
      expect(plate.alt.trim(), plate.src).not.toBe('');
    }
  });

  const liveRows = () => db.select().from(schema.media).where(inArray(schema.media.path, LIVE_SIX));

  it('leaves the six live rows byte-for-byte untouched by default', async () => {
    const before = await liveRows();
    await applyBackfill(db as never, await buildBackfillPlan(db as never), { databaseHost: 'pglite', databaseName: 'memory' });
    expect(await liveRows()).toEqual(before);
  });

  it('writes width/height and nothing else to them under --with-dimensions', async () => {
    const before = await liveRows();
    const plan = await buildBackfillPlan(db as never, { withDimensions: true });
    expect(plan.dimensionUpdates).toHaveLength(6);

    const receipt = await applyBackfill(db as never, plan, { databaseHost: 'pglite', databaseName: 'memory' });
    expect(receipt.dimensionsUpdated).toHaveLength(6);
    expect(await nullDimensionCount()).toBe(0);

    const after = await liveRows();
    expect(after).toHaveLength(6);
    for (const row of after) {
      const was = before.find((b) => b.id === row.id)!;
      // Every column but the two, compared whole.
      expect({ ...row, width: null, height: null }).toEqual({ ...was, width: null, height: null });
      // `media.updated_at` has no trigger, so the dimension write does not move it.
      expect(row.updatedAt).toEqual(was.updatedAt);
      expect(row.width).toBeGreaterThan(0);
      expect(row.height).toBeGreaterThan(0);
    }
  });

  it('is idempotent — a second run inserts nothing', async () => {
    await applyBackfill(db as never, await buildBackfillPlan(db as never), { databaseHost: 'pglite', databaseName: 'memory' });

    const second = await buildBackfillPlan(db as never);
    expect(second.mediaInserts).toEqual([]);
    expect(second.photoInserts).toEqual([]);
    expect(second.dimensionUpdates).toEqual([]);
    expect(second.photosAlreadyPresent).toBe(41);

    const receipt = await applyBackfill(db as never, second, { databaseHost: 'pglite', databaseName: 'memory' });
    expect(receipt.insertedMedia).toEqual([]);
    expect(receipt.insertedPhotos).toEqual([]);
    expect(await photoCount()).toBe(41);
    expect(await mediaPhotoCount()).toBe(41);
  });

  it('rolls the whole transaction back when the database moved since the dry run', async () => {
    const plan = await buildBackfillPlan(db as never);

    // Somebody else inserts one of the 35 between the dry run and the write.
    const [raced] = plan.mediaInserts;
    await db.insert(schema.media).values({ path: raced.path, alt: raced.alt, kind: 'photo' });

    await expect(applyBackfill(db as never, plan, { databaseHost: 'pglite', databaseName: 'memory' })).rejects.toThrow(
      /target database changed since the dry run/,
    );

    // Nothing from the aborted attempt survived: the one raced row, and the
    // six live ones. No event_photos row, and no dimension written.
    expect(await mediaPhotoCount()).toBe(7);
    expect(await photoCount()).toBe(6);
    expect(await nullDimensionCount()).toBe(7);
  });

  /**
   * `rolls the whole transaction back when the database moved since the dry
   * run` aborts at the FIRST count check, before the dimension `UPDATE` has
   * run — so it cannot tell you whether that update rolls back. Found by
   * `reviewer` on [VIS-9]: an assertion that cannot fail is worse than none.
   *
   * This squats a wanted `(event_id, position)` with a media row that is not
   * one of the 35, so the media insert still returns 35, the `UPDATE` runs,
   * and the `event_photos` insert is the statement that comes back short.
   */
  it('rolls the dimension update back too, when the abort comes after it', async () => {
    const plan = await buildBackfillPlan(db as never, { withDimensions: true });
    expect(plan.dimensionUpdates).toHaveLength(6);
    expect(await nullDimensionCount()).toBe(6);

    const [event] = await db
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(eq(schema.events.slug, 'claude-meetup'));
    const [squatter] = await db
      .insert(schema.media)
      .values({ path: 'events/not-on-the-record.jpg', alt: 'Not on the record', kind: 'photo', width: 1, height: 1 })
      .returning({ id: schema.media.id });
    await db.insert(schema.eventPhotos).values({ eventId: event.id, mediaId: squatter.id, position: 3 });

    await expect(applyBackfill(db as never, plan, { databaseHost: 'pglite', databaseName: 'memory' })).rejects.toThrow(
      /event_photos rows but inserted/,
    );

    // The update ran inside the transaction and went back with it.
    expect(await nullDimensionCount()).toBe(6);
    expect(await mediaPhotoCount()).toBe(7);
    expect(await photoCount()).toBe(7);
  });
});

describe('refusals', () => {
  it('declines when a wanted position is held by a different media row', async () => {
    const [event] = await db
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(eq(schema.events.slug, 'claude-meetup'));
    const [squatter] = await db
      .insert(schema.media)
      .values({ path: 'events/not-on-the-record.jpg', alt: 'A plate the record does not describe', kind: 'photo' })
      .returning({ id: schema.media.id });
    await db.insert(schema.eventPhotos).values({ eventId: event.id, mediaId: squatter.id, position: 3 });

    const plan = await buildBackfillPlan(db as never);

    expect(plan.positionCollisions).toHaveLength(1);
    expect(plan.positionCollisions[0]).toMatchObject({
      eventSlug: 'claude-meetup',
      position: 3,
      wantedPath: 'events/vol02-4.jpg',
    });
    expect(plan.undescribedLiveRows).toBe(1);
    expect(isApplicable(plan)).toBe(false);
    expect(renderPlan(plan)).toContain('REFUSING');

    await expect(applyBackfill(db as never, plan, { databaseHost: 'pglite', databaseName: 'memory' })).rejects.toThrow(/not applicable/);
    expect(await photoCount()).toBe(7);
  });

  it('refuses a path the asset registry would not resolve, rather than 503ing the gallery', async () => {
    // Every file but one, so the odd path out is unresolvable the way a
    // case-mismatched or wrong-extension `media.path` would be.
    const assetsDir = await mkdtemp(join(tmpdir(), 'vis7-assets-'));
    await mkdir(join(assetsDir, 'events'));
    const absent = 'events/vol07-1.jpg';
    for (const { path } of wantedPhotos()) {
      if (path === absent) continue;
      await symlink(join(process.cwd(), 'src/assets', path), join(assetsDir, path)).catch(() => {});
    }

    const plan = await buildBackfillPlan(db as never, { assetsDir });

    expect(plan.unresolvableAssetPaths).toEqual([absent]);
    expect(isApplicable(plan)).toBe(false);
    expect(renderPlan(plan)).toContain('REFUSING — the asset registry would not resolve');
    // Not planned at all, so a refusal that someone overrode could not write it.
    expect(plan.mediaInserts.map((row) => row.path)).not.toContain(absent);
    expect(plan.photoInserts.map((row) => row.path)).not.toContain(absent);
    await expect(applyBackfill(db as never, plan, { databaseHost: 'pglite', databaseName: 'memory' })).rejects.toThrow(/not applicable/);
  });
});

describe('the asset registry check', () => {
  it('derives the same keys src/lib/images.ts globs', async () => {
    const keys = await assetRegistryKeys();
    for (const { path } of wantedPhotos()) expect(keys.has(path), path).toBe(true);
    // Case-sensitive, like the glob: the filesystem may open it, the bundle will not.
    expect(keys.has('events/VOL02-1.jpg')).toBe(false);
  });

  it('globs the extensions the registry globs', async () => {
    const images = await readFile('src/lib/images.ts', 'utf8');
    const braces = images.match(/\*\.\{([a-z,]+)\}/)?.[1];
    expect(braces, 'the glob in src/lib/images.ts moved').toBeDefined();
    expect(braces!.split(',').map((ext) => `.${ext}`).sort()).toEqual([...ASSET_EXTENSIONS].sort());
  });
});

describe('an event the record photographs but the target has not got', () => {
  // `src/data/events.ts` declared 11 events at 81fe1e7 and declares 17 now, so
  // a target behind on events is expected. Skip and report; never fail, never
  // insert the event row — that is `db:import`'s job and carries its hazard.
  const orphanSlug = 'claude-for-businesses';

  /** Remove the event row, keeping it so the re-run test can put it back verbatim. */
  const drop = async () => {
    const [row] = await db.select().from(schema.events).where(eq(schema.events.slug, orphanSlug));
    await db.delete(schema.eventPhotos).where(eq(schema.eventPhotos.eventId, row.id));
    await db.delete(schema.events).where(eq(schema.events.id, row.id));
    return row;
  };

  it('skips its photographs, reports the slug, and still applies the rest', async () => {
    await drop();
    const photos = wantedPhotos().filter((p) => p.eventSlug === orphanSlug).length;
    expect(photos).toBe(3);

    const plan = await buildBackfillPlan(db as never);

    expect(plan.unknownEventSlugs).toEqual([orphanSlug]);
    expect(plan.photosSkippedForMissingEvent).toBe(photos);
    // media is still +35 — the files are real. event_photos is 35 less those.
    expect(plan.mediaInserts).toHaveLength(35);
    expect(plan.photoInserts).toHaveLength(35 - photos);
    expect(plan.mediaAlreadyPresent + plan.mediaInserts.length).toBe(41);
    expect(plan.photosAlreadyPresent + plan.photoInserts.length).toBe(41 - photos);
    expect(isApplicable(plan)).toBe(true);

    const printed = renderPlan(plan);
    expect(printed).toContain('MISSING EVENTS');
    expect(printed).toContain(orphanSlug);
    expect(printed).toContain('APPLICABLE');
    expect(printed).not.toContain('REFUSING');

    const receipt = await applyBackfill(db as never, plan, { databaseHost: 'pglite', databaseName: 'memory' });
    expect(receipt.insertedMedia).toHaveLength(35);
    expect(receipt.insertedPhotos).toHaveLength(35 - photos);
    expect(await mediaPhotoCount()).toBe(41);
    expect(await photoCount()).toBe(41 - photos);

    const rooms = await galleryRooms(db as never);
    expect(rooms).toHaveLength(11);
  });

  it('joins the skipped photographs on a re-run once the event row exists', async () => {
    const dropped = await drop();
    await applyBackfill(db as never, await buildBackfillPlan(db as never), { databaseHost: 'pglite', databaseName: 'memory' });
    expect(await photoCount()).toBe(38);

    // Whoever owns that decision inserts the event; this script then completes.
    await db.insert(schema.events).values(dropped);

    const second = await buildBackfillPlan(db as never);
    expect(second.unknownEventSlugs).toEqual([]);
    expect(second.mediaInserts).toEqual([]); // the media rows already landed
    expect(second.photoInserts).toHaveLength(3);

    await applyBackfill(db as never, second, { databaseHost: 'pglite', databaseName: 'memory' });
    expect(await photoCount()).toBe(41);
    expect(await mediaPhotoCount()).toBe(41);
  });
});

describe('rollback', () => {
  it('returns the database to the six live plates without a restore', async () => {
    const receipt = await applyBackfill(
      db as never,
      await buildBackfillPlan(db as never, { withDimensions: true }),
      { databaseHost: 'pglite', databaseName: 'memory' },
    );
    expect(await photoCount()).toBe(41);

    const result = await rollbackBackfill(db as never, receipt);

    expect(result.photosDeleted).toBe(35);
    expect(result.mediaDeleted).toBe(35);
    expect(result.mediaRetained).toEqual([]);
    expect(result.mediaAlreadyGone).toBe(0);
    expect(await photoCount()).toBe(6);
    expect(await mediaPhotoCount()).toBe(6);

    const rooms = await galleryRooms(db as never);
    expect(rooms).toHaveLength(2);
    expect(rooms.reduce((sum, room) => sum + room.plates.length, 0)).toBe(6);

    // The dimension update is not reverted — see `BackfillReceipt`.
    expect(await nullDimensionCount()).toBe(0);
    for (const row of receipt.dimensionsUpdated) {
      expect(row.was).toEqual({ width: null, height: null });
    }
  });

  it('keeps a media row something else adopted, and says which column', async () => {
    const receipt = await applyBackfill(db as never, await buildBackfillPlan(db as never), {
      databaseHost: 'pglite',
      databaseName: 'memory',
    });

    const adopted = receipt.insertedMedia.find((row) => row.path === 'events/vol07-1.jpg')!;
    await db.update(schema.cities).set({ imageId: adopted.id }).where(eq(schema.cities.slug, 'bhopal'));

    const result = await rollbackBackfill(db as never, receipt);

    expect(result.photosDeleted).toBe(35);
    expect(result.mediaDeleted).toBe(34);
    expect(result.mediaRetained).toEqual([{ path: 'events/vol07-1.jpg', reason: 'adopted as cities.image_id' }]);

    // The city still points at a row that exists, rather than at a blanked null.
    const [city] = await db
      .select({ imageId: schema.cities.imageId })
      .from(schema.cities)
      .where(eq(schema.cities.slug, 'bhopal'));
    expect(city.imageId).toBe(adopted.id);
  });

  it('prints its own inverse as SQL', async () => {
    const receipt = await applyBackfill(db as never, await buildBackfillPlan(db as never), {
      databaseHost: 'pglite',
      databaseName: 'memory',
    });
    expect(receipt.rollbackSql).toContain('DELETE FROM event_photos');
    expect(receipt.rollbackSql).toContain('DELETE FROM media');
    expect(receipt.rollbackSql).toContain('events/vol02-4.jpg');
    expect(receipt.rollbackSql).toContain('COMMIT;');
  });
});

/**
 * The printed SQL, which is the undo a human in a hurry actually copies.
 *
 * `reviewer` demonstrated on [VIS-9] that rev 2's version blanked
 * `cities.image_id` — the command protected the adopted row and the SQL it
 * printed did not. Both now emit guards from `MEDIA_ADOPTERS`.
 */
describe('the rollback SQL it prints', () => {
  it('guards the media delete against every column that could adopt a row', async () => {
    const plan = await buildBackfillPlan(db as never);
    const receipt = await applyBackfill(db as never, plan, { databaseHost: 'pglite', databaseName: 'memory' });

    for (const sqlText of [receipt.rollbackSql, renderPlannedRollbackSql(plan)]) {
      expect(sqlText).toContain('AND id NOT IN (SELECT media_id FROM event_photos)');
      for (const [table, column] of [
        ['events', 'cover_image_id'],
        ['cities', 'image_id'],
        ['builders', 'image_id'],
        ['ambassadors', 'image_id'],
        ['projects', 'image_id'],
        ['projects', 'logo_media_id'],
        ['member_profiles', 'avatar_media_id'],
        ['stories', 'image_id'],
        ['use_cases', 'image_id'],
        ['guides', 'image_id'],
      ] as const) {
        expect(sqlText, `${table}.${column}`).toContain(
          `AND id NOT IN (SELECT ${column} FROM ${table} WHERE ${column} IS NOT NULL)`,
        );
      }
      expect(sqlText).toContain('Prefer `npm run backfill:photos -- rollback');
    }
  });

  it('actually leaves an adopted row alone when executed', async () => {
    const receipt = await applyBackfill(db as never, await buildBackfillPlan(db as never), {
      databaseHost: 'pglite',
      databaseName: 'memory',
    });
    const adopted = receipt.insertedMedia.find((row) => row.path === 'events/vol07-1.jpg')!;
    await db.update(schema.cities).set({ imageId: adopted.id }).where(eq(schema.cities.slug, 'bhopal'));

    // The printed SQL, run as a human would run it. Statement by statement,
    // because the extended protocol parses one at a time; BEGIN/COMMIT are the
    // transaction a psql session would give it and add nothing here.
    const statements = receipt.rollbackSql
      .replace(/^\s*--.*$/gm, '')
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part && !/^(BEGIN|COMMIT)$/i.test(part));
    expect(statements).toHaveLength(2);
    for (const statement of statements) await db.execute(sql.raw(statement));

    const [city] = await db
      .select({ imageId: schema.cities.imageId })
      .from(schema.cities)
      .where(eq(schema.cities.slug, 'bhopal'));
    expect(city.imageId, 'the printed SQL blanked a human-chosen cover').toBe(adopted.id);
    expect(await mediaPhotoCount()).toBe(7); // the 6 live + the one it rightly kept
    expect(await photoCount()).toBe(6);
  });

  it('deletes only the join rows the backfill would write, not every row for those media', async () => {
    const plan = await buildBackfillPlan(db as never);
    // vol07-1 shown by a second event too — the planned SQL must not touch it.
    expect(renderPlannedRollbackSql(plan)).toContain('AND ep.media_id = m.id');
    expect(renderPlannedRollbackSql(plan)).not.toContain('WHERE media_id IN (SELECT id FROM media');
  });
});

/**
 * The window with no second chance: after the COMMIT, before the undo is
 * anywhere a human can read it. `reviewer` raised it on [VIS-17].
 */
describe('reporting a committed backfill', () => {
  const collect = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      sink: (writeFile: ReceiptSink['writeFile']): ReceiptSink => ({
        log: (m) => out.push(m),
        error: (m) => err.push(m),
        mkdir: async () => undefined,
        writeFile,
      }),
    };
  };

  it('prints the undo before it writes the receipt, so a failing disk cannot take both', async () => {
    const receipt = await applyBackfill(db as never, await buildBackfillPlan(db as never), {
      databaseHost: 'pglite',
      databaseName: 'memory',
    });
    const { out, err, sink } = collect();
    const order: string[] = [];

    const code = await emitReceipt(receipt, {
      ...sink(async (path, body) => {
        order.push('write');
        return [path, body.length];
      }),
      log: (m) => {
        if (m.includes('DELETE FROM media')) order.push('printed the undo');
        out.push(m);
      },
    });

    expect(code).toBe(0);
    expect(order).toEqual(['printed the undo', 'write']);
    expect(err).toEqual([]);
    expect(out.join('\n')).toContain(`Receipt: ${receiptPath(receipt)}`);
  });

  it('exits 3 with the whole receipt on stdout when the receipt cannot be written', async () => {
    const receipt = await applyBackfill(db as never, await buildBackfillPlan(db as never), {
      databaseHost: 'pglite',
      databaseName: 'memory',
    });
    const { out, err, sink } = collect();

    const code = await emitReceipt(
      receipt,
      sink(async () => {
        throw new Error('EROFS: read-only file system');
      }),
    );

    // Non-zero, and distinct from `fail`'s 1 — the write happened, only the
    // receipt did not.
    expect(code).toBe(3);

    // The undo reached stdout regardless. This is the assertion the whole
    // reordering exists for: it used to throw before this line ran.
    const printed = out.join('\n');
    expect(printed).toContain('DELETE FROM event_photos');
    expect(printed).toContain('DELETE FROM media');
    expect(printed).toContain('events/vol02-4.jpg');

    // And the receipt itself is recoverable from the scrollback, with the
    // reason and the path to save it to.
    const reported = err.join('\n');
    expect(reported).toContain('COMMITTED');
    expect(reported).toContain('EROFS: read-only file system');
    expect(reported).toContain(receiptPath(receipt));
    const recovered = JSON.parse(err[err.length - 1]) as typeof receipt;
    expect(recovered.insertedMedia).toHaveLength(35);
    expect(recovered.insertedPhotos).toHaveLength(35);
    expect(recovered.rollbackSql).toBe(receipt.rollbackSql);
  });
});

describe('rollback when a receipt row has vanished', () => {
  it('reports it and still undoes the rest', async () => {
    const receipt = await applyBackfill(db as never, await buildBackfillPlan(db as never), {
      databaseHost: 'pglite',
      databaseName: 'memory',
    });
    const gone = receipt.insertedMedia[0];
    await db.delete(schema.eventPhotos).where(eq(schema.eventPhotos.mediaId, gone.id));
    await db.delete(schema.media).where(eq(schema.media.id, gone.id));

    const result = await rollbackBackfill(db as never, receipt);

    expect(result.mediaAlreadyGone).toBe(1);
    expect(result.mediaDeleted).toBe(34);
    expect(result.photosDeleted).toBe(34);
    // The whole undo completed rather than wedging on the one missing row.
    expect(await photoCount()).toBe(6);
    expect(await mediaPhotoCount()).toBe(6);
  });

  /**
   * The difference between "the DELETE returned nothing because the row is
   * gone" and "...because something stopped it". Only the first is an
   * `mediaAlreadyGone`, and until [VIS-17] the accounting guard that was
   * supposed to tell them apart was an identity that could never fire.
   */
  it('refuses when a row it counted as already gone is still there', async () => {
    const receipt = await applyBackfill(db as never, await buildBackfillPlan(db as never), {
      databaseHost: 'pglite',
      databaseName: 'memory',
    });
    const survivor = receipt.insertedMedia.find((row) => row.path === 'events/vol02-4.jpg')!;

    // A BEFORE DELETE trigger returning NULL: no error, no returned row, the
    // row still present. Exactly what the dry run warns it cannot see.
    await db.execute(
      sql.raw(`CREATE FUNCTION veto_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`),
    );
    await db.execute(
      sql.raw(
        `CREATE TRIGGER veto_delete BEFORE DELETE ON media FOR EACH ROW ` +
          `WHEN (OLD.id = '${survivor.id}') EXECUTE FUNCTION veto_delete()`,
      ),
    );

    await expect(rollbackBackfill(db as never, receipt)).rejects.toThrow(/still exist/);

    // Rolled back whole: nothing half-undone, and the operator can fix the
    // trigger and re-run the same receipt.
    expect(await photoCount()).toBe(41);
    expect(await mediaPhotoCount()).toBe(41);
    const [still] = await db.select({ id: schema.media.id }).from(schema.media).where(eq(schema.media.id, survivor.id));
    expect(still.id).toBe(survivor.id);
  });

  /**
   * The other way `mediaAlreadyGone` can be a lie, and the trigger check above
   * cannot catch it: the row really was deleted, by this very run, and the
   * receipt listed it twice. Found on [VIS-19] by comparing the two separate
   * implementations of this fix — each caught one case and neither caught both.
   */
  it('refuses a receipt that lists a media id twice, instead of misreporting the count', async () => {
    const receipt = await applyBackfill(db as never, await buildBackfillPlan(db as never), {
      databaseHost: 'pglite',
      databaseName: 'memory',
    });

    // A receipt is a file and a file can be edited. Without the shape check
    // this undoes all 35 and then reports one of them as "already deleted by
    // something else", which is the opposite of what happened.
    const duplicated = { ...receipt, insertedMedia: [...receipt.insertedMedia, { ...receipt.insertedMedia[0] }] };

    await expect(rollbackBackfill(db as never, duplicated)).rejects.toThrow(/more than once/);
    // Refused before the transaction opened, so nothing was undone.
    expect(await photoCount()).toBe(41);
    expect(await mediaPhotoCount()).toBe(41);
  });
});

/**
 * The EXIF branch, which none of the 41 files exercises. Written by `reviewer`
 * on [VIS-9] — it was three lines no suite had ever run.
 *
 * `metadata()` reports the stored pixels. Orientations 5–8 rotate the image a
 * quarter turn on display, and a browser applies that rotation itself
 * (`image-orientation: from-image` is the CSS default), so the dimensions the
 * database records have to be the displayed ones.
 */
describe('measure', () => {
  const plate = async (dir: string, name: string, orientation?: number) => {
    let image = sharp({ create: { width: 4, height: 2, channels: 3, background: '#000' } }).jpeg();
    if (orientation !== undefined) image = image.withMetadata({ orientation });
    await writeFile(join(dir, name), await image.toBuffer());
  };

  it('swaps width and height for the quarter-turn orientations and only those', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'backfill-measure-'));
    await plate(dir, 'none.jpg');
    for (const o of [1, 2, 3, 4, 5, 6, 7, 8]) await plate(dir, `o${o}.jpg`, o);

    const measured = await measure(['none.jpg', ...[1, 2, 3, 4, 5, 6, 7, 8].map((o) => `o${o}.jpg`)], dir);

    // Stored 4x2. Upright and the 180° flips keep it; 5–8 are the quarter turns.
    for (const name of ['none.jpg', 'o1.jpg', 'o2.jpg', 'o3.jpg', 'o4.jpg']) {
      expect(measured.get(name), name).toEqual({ width: 4, height: 2 });
    }
    for (const name of ['o5.jpg', 'o6.jpg', 'o7.jpg', 'o8.jpg']) {
      expect(measured.get(name), name).toEqual({ width: 2, height: 4 });
    }
  });

  it('throws rather than writing a media row for a file nobody can open', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'backfill-measure-'));
    await expect(measure(['missing.jpg'], dir)).rejects.toThrow();
  });
});
