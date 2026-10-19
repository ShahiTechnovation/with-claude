/**
 * Package T-B: the backfill CLI and a Baserow run say what happened.
 *
 * `rollbackReport` and `planOutcome` are what `rollback`, `plan` and `apply`
 * print and exit with, and `exitWith` puts a non-zero outcome on stderr. The
 * rollback cases feed `rollbackReport` the real `rollbackBackfill` result, from
 * PGlite with the committed migrations. `planOutcome` gets a real plan;
 * `nothingToDo` reads five plan fields, so it gets literals. `runSync` is the
 * one path the cron, the webhook and the admin's sync buttons record a Baserow
 * run through.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { importRecords } from '../db/import';
import * as schema from '../db/schema';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import { exitWith, nothingToDo, planOutcome, rollbackReport } from '../scripts/backfill/cli';
import {
  buildBackfillPlan,
  isApplicable,
  renderPlan,
  rollbackBackfill,
  wantedPhotos,
  type BackfillPlan,
  type BackfillReceipt,
} from '../scripts/backfill/event-photos';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('rollback', () => {
  let db: TestDatabase;
  let receipt: BackfillReceipt;

  // One event with two plates, and the receipt an apply that inserted them would write.
  beforeEach(async () => {
    db = await createTestDatabase();
    const [city] = await db
      .insert(schema.cities)
      .values({
        slug: 'backfill-city',
        name: 'Backfill City',
        region: 'Test Region',
        lat: 0,
        lon: 0,
        blurb: 'A city.',
      })
      .returning({ id: schema.cities.id });
    const [event] = await db
      .insert(schema.events)
      .values({
        slug: 'backfill-event',
        title: 'Backfill event',
        format: 'meetup',
        cityId: city.id,
        date: '2026-10-11',
        startTime: '10:00',
        venueName: 'Somewhere',
        summary: 'A room.',
      })
      .returning({ id: schema.events.id });
    const media = await db
      .insert(schema.media)
      .values([
        { path: 'events/backfill-1.jpg', alt: 'One', kind: 'photo' },
        { path: 'events/backfill-2.jpg', alt: 'Two', kind: 'photo' },
      ])
      .returning({ id: schema.media.id, path: schema.media.path });
    const photos = media.map((row, position) => ({
      eventId: event.id,
      eventSlug: 'backfill-event',
      mediaId: row.id,
      path: row.path!,
      position,
    }));
    await db
      .insert(schema.eventPhotos)
      .values(photos.map(({ eventId, mediaId, position }) => ({ eventId, mediaId, position })));
    receipt = {
      appliedAt: '2026-10-16T00:00:00.000Z',
      databaseHost: 'pglite',
      databaseName: 'memory',
      insertedMedia: media.map((row) => ({ id: row.id, path: row.path! })),
      insertedPhotos: photos,
      dimensionsUpdated: [],
      rollbackSql: '',
    };
  });

  afterEach(async () => {
    await db?.$close();
  });

  const roll = async () =>
    rollbackReport(receipt, await rollbackBackfill(db as never, receipt), 'memory');

  it('says "Rolled back" and exits 0 when it deleted the rows', async () => {
    expect(await roll()).toEqual({ lines: ['Rolled back: event_photos -2, media -2.'], code: 0 });
  });

  it('exits 2 with "Nothing was undone" for a receipt whose rows are already gone', async () => {
    await roll();
    const again = await roll();

    expect(again.code).toBe(2);
    expect(again.lines).toEqual([
      'Nothing was undone: none of the 4 rows this receipt lists are in memory any more. ' +
        'If the photographs are still there, a later apply inserted them: use its receipt (ls imports/).',
      '  2 media row(s) in the receipt had already been deleted by something else.',
      '  2 event_photos row(s) in the receipt were already gone.',
    ]);
    expect(again.lines.join('\n')).not.toContain('Rolled back');
  });

  it('reports the event_photos rows that were already gone and undoes the rest', async () => {
    const [first] = receipt.insertedPhotos;
    await db
      .delete(schema.eventPhotos)
      .where(
        and(
          eq(schema.eventPhotos.eventId, first.eventId),
          eq(schema.eventPhotos.mediaId, first.mediaId),
        ),
      );

    expect(await roll()).toEqual({
      lines: [
        'Rolled back: event_photos -1, media -2.',
        '  1 event_photos row(s) in the receipt were already gone.',
      ],
      code: 0,
    });
  });

  it('exits 2 without calling kept rows gone when it deleted nothing because it kept them', async () => {
    await db.delete(schema.eventPhotos);
    const [one, two] = receipt.insertedMedia;
    await db.update(schema.cities).set({ imageId: one.id });
    await db.update(schema.events).set({ coverImageId: two.id });

    expect(await roll()).toEqual({
      lines: [
        'Nothing was undone: this receipt lists 4 row(s), and none was deleted from memory.',
        '  kept events/backfill-1.jpg — adopted as cities.image_id',
        '  kept events/backfill-2.jpg — adopted as events.cover_image_id',
        '  2 event_photos row(s) in the receipt were already gone.',
      ],
      code: 2,
    });
  });

  it('exits 2 for a receipt that lists no rows', () => {
    const empty = { ...receipt, insertedMedia: [], insertedPhotos: [] };
    const none = { photosDeleted: 0, mediaDeleted: 0, mediaRetained: [], mediaAlreadyGone: 0 };

    expect(rollbackReport(empty, none, 'memory')).toEqual({
      lines: ['Nothing was undone: this receipt lists 0 row(s), and none was deleted from memory.'],
      code: 2,
    });
  });
});

describe('apply with nothing to write', () => {
  const idle = {
    mediaInserts: [],
    photoInserts: [],
    dimensionUpdates: [],
    positionDrift: [],
    photosSkippedForMissingEvent: 0,
  };
  const drift = {
    eventSlug: 'backfill-event',
    path: 'events/backfill-2.jpg',
    recordPosition: 1,
    livePosition: 0,
  };

  it('exits 0 with "Nothing to do" when the order matches too', () => {
    expect(nothingToDo(idle)).toEqual({
      lines: ['Nothing to do — this database already holds every photograph the record describes.'],
      code: 0,
    });
  });

  it('exits 2 instead while plates are out of order', () => {
    expect(nothingToDo({ ...idle, positionDrift: [drift] })).toEqual({
      lines: [
        '1 plate(s) are in a different order here than in the record, and a plain apply cannot move them. ' +
          'Roll back the receipt that inserted them, then apply again.',
      ],
      code: 2,
    });
  });

  it('exits 0 but names the photographs still waiting for their events', () => {
    expect(nothingToDo({ ...idle, photosSkippedForMissingEvent: 3 })).toEqual({
      lines: [
        'Nothing to write yet: 3 photograph(s) wait for event rows this database lacks ' +
          '(MISSING EVENTS above). Apply again once they exist.',
      ],
      code: 0,
    });
    // Out of order as well: the drift is the one a re-run cannot fix.
    expect(
      nothingToDo({ ...idle, photosSkippedForMissingEvent: 3, positionDrift: [drift] })?.code,
    ).toBe(2);
  });

  it('steps aside when there is something to write', () => {
    const insert = { path: 'events/backfill-3.jpg', alt: 'Three', width: 4, height: 2 };
    expect(nothingToDo({ ...idle, mediaInserts: [insert], positionDrift: [drift] })).toBeNull();
  });
});

describe('planOutcome on a real plan', () => {
  // The record imported, so each case starts with nothing to write.
  let db: TestDatabase;
  beforeEach(async () => {
    db = await createTestDatabase();
    await importRecords(db as never);
  }, 180_000);
  afterEach(async () => {
    await db?.$close();
  });

  /** The record's first plate, as ids in this database. */
  async function firstPlate() {
    const [photo] = wantedPhotos();
    const [event] = await db
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(eq(schema.events.slug, photo.eventSlug));
    const [media] = await db
      .select({ id: schema.media.id })
      .from(schema.media)
      .where(eq(schema.media.path, photo.path));
    return { eventId: event.id, mediaId: media.id };
  }

  /** `renderPlan`'s last line, its verdict. */
  const verdict = (plan: BackfillPlan) => renderPlan(plan).split('\n').pop();

  it('refuses a plan that also has nothing to write, instead of calling it done', async () => {
    // A live row the record does not describe, at a file that is not on disk.
    const { eventId } = await firstPlate();
    const [media] = await db
      .insert(schema.media)
      .values({ path: 'events/not-on-disk.jpg', alt: 'A removed photograph', kind: 'photo' })
      .returning({ id: schema.media.id });
    await db.insert(schema.eventPhotos).values({ eventId, mediaId: media.id, position: 99 });

    const plan = await buildBackfillPlan(db as never);

    expect(isApplicable(plan)).toBe(false);
    // On its own, the idle check would call this database done.
    expect(nothingToDo(plan)?.lines[0]).toMatch(/^Nothing to do/);
    expect(planOutcome(plan)).toEqual({
      lines: ['Refusing to apply: see the refusals above.'],
      code: 2,
    });
  });

  // "Would a plain apply write anything?" is written twice: `nothingToDo` in
  // cli.ts and `writes` in renderPlan. Each kind of write, on its own, has to
  // make both say yes.
  it('writes when a join row is the only thing missing', async () => {
    // The media row is there and its join is not, as when the event row came late.
    const { eventId, mediaId } = await firstPlate();
    await db
      .delete(schema.eventPhotos)
      .where(and(eq(schema.eventPhotos.eventId, eventId), eq(schema.eventPhotos.mediaId, mediaId)));

    const plan = await buildBackfillPlan(db as never);

    expect([
      plan.mediaInserts.length,
      plan.photoInserts.length,
      plan.dimensionUpdates.length,
    ]).toEqual([0, 1, 0]);
    expect(planOutcome(plan)).toBeNull();
    expect(verdict(plan)).toMatch(/^APPLICABLE/);
  });

  it('writes when width and height are the only change (--with-dimensions)', async () => {
    const { mediaId } = await firstPlate();
    await db
      .update(schema.media)
      .set({ width: null, height: null })
      .where(eq(schema.media.id, mediaId));

    const plan = await buildBackfillPlan(db as never, { withDimensions: true });

    expect([plan.mediaInserts.length, plan.photoInserts.length]).toEqual([0, 0]);
    expect(plan.dimensionUpdates.length).toBeGreaterThan(0);
    expect(planOutcome(plan)).toBeNull();
    expect(verdict(plan)).toMatch(/^APPLICABLE/);
  });
});

describe('plan and apply', () => {
  it('both end on planOutcome, and apply reaches it before it writes', () => {
    const source = readFileSync('scripts/backfill/cli.ts', 'utf8');
    const body = (name: string) => {
      const start = source.indexOf(`async function ${name}()`);
      return start < 0 ? '' : source.slice(start, source.indexOf('\n}\n', start));
    };
    expect(body('plan')).toContain('planOutcome(built)');
    const apply = body('apply');
    expect(apply.indexOf('planOutcome(built)')).toBeGreaterThan(-1);
    expect(apply.indexOf('planOutcome(built)')).toBeLessThan(
      apply.indexOf('applyBackfill(db, built'),
    );
    expect(apply).not.toContain('nothingToDo(');
  });
});

describe('exitWith', () => {
  it('prints a non-zero outcome on stderr and exits with its code', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => exitWith({ lines: ['Nothing was undone: x'], code: 2 })).toThrow('exit 2');
    expect(error).toHaveBeenCalledWith('Nothing was undone: x');
    expect(log).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(2);
  });
});

describe('runSync (src/server/integrations/baserow/runtime.ts)', () => {
  // A run that starts, then fails in the queue with a Baserow error.
  const order: string[] = [];
  const endRun = vi.fn();
  let runSync: typeof import('../src/server/integrations/baserow/runtime').runSync;

  beforeAll(async () => {
    vi.doMock('../db/pool', () => ({ pooledDb: () => ({}) }));
    vi.doMock('../src/server/integrations/baserow/config', () => ({
      baserowSettings: () => ({
        enabled: true,
        problem: null,
        config: {},
        readToken: 'token',
        apiUrl: 'https://baserow.invalid',
      }),
    }));
    vi.doMock('../src/server/integrations/baserow/sync', () => ({
      startRun: async () => 'run-1',
      reconcile: async () => ({}),
      runQueue: async () => {
        throw new Error('Baserow answered 401');
      },
      endRun: (...args: unknown[]) => endRun(...args),
      pruneJobs: async () => {},
    }));
    ({ runSync } = await import('../src/server/integrations/baserow/runtime'));
  });

  beforeEach(() => {
    order.length = 0;
    // `cli.ts` loads `.env`. Blank, so a mock that stopped applying throws
    // instead of reaching the dev database.
    vi.stubEnv('DATABASE_URL', '');
    vi.spyOn(console, 'error').mockImplementation((label: string, cause: Error) => {
      order.push(`${label}: ${cause.message}`);
    });
    endRun.mockImplementation(
      async (_db: unknown, _id: string, _counts: unknown, message: string) => {
        order.push(`endRun: ${message}`);
      },
    );
  });

  it('logs why a run failed, records it, and says the run started', async () => {
    expect(await runSync('manual', { reconcileFirst: false, budgetMs: 1_000 })).toEqual({
      ran: false,
      started: true,
      reason: 'run failed',
    });
    expect(order).toEqual([
      '[baserow] manual run failed: Baserow answered 401',
      'endRun: Baserow answered 401',
    ]);
  });

  it('logs the cause before endRun, so it survives an endRun that fails too', async () => {
    endRun.mockImplementationOnce(
      async (_db: unknown, _id: string, _counts: unknown, message: string) => {
        order.push(`endRun: ${message}`);
        throw new Error('connection reset');
      },
    );
    await expect(runSync('manual', { reconcileFirst: false, budgetMs: 1_000 })).rejects.toThrow(
      'connection reset',
    );
    expect(order).toEqual([
      '[baserow] manual run failed: Baserow answered 401',
      'endRun: Baserow answered 401',
    ]);
  });
});
