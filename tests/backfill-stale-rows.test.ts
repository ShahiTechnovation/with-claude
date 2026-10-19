/**
 * Three things the backfill dry run has to say out loud.
 *
 * A stale live row. A photograph leaves the record and its file is deleted, but
 * its `event_photos` row stays and its `media` row is still published. The
 * reader serves that row, `requireAsset` throws on its path, and `/gallery`
 * goes down. The registry check covers only the paths the record declares, so
 * the dry run used to print APPLICABLE over a dead gallery. Now it refuses, on
 * any event, and `apply` agrees with it. A photograph taken down in the admin,
 * or on an unpublished event, is not served, so it does not refuse.
 *
 * Consent past the last confirmation. New media rows get `consent = true`. The
 * dry run names any event held after `CONSENT_CONFIRMED_THROUGH`. It is a
 * warning only: whether `apply` should refuse those is still an open call.
 *
 * The verdict. The last line says APPLICABLE only when a plain `apply` would
 * write something, the same call `plan` and `apply` exit on in `cli.ts`.
 */
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importRecords } from '../db/import';
import * as schema from '../db/schema';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import {
  applyBackfill,
  buildBackfillPlan,
  CONSENT_CONFIRMED_THROUGH,
  eventsPastConsent,
  isApplicable,
  renderPlan,
  wantedPhotos,
} from '../scripts/backfill/event-photos';

let db: TestDatabase;
const target = { databaseHost: 'pglite', databaseName: 'memory' };

beforeEach(async () => {
  db = await createTestDatabase();
  await importRecords(db as never);
}, 180_000);

afterEach(async () => {
  await db?.$close();
});

async function eventId(slug: string): Promise<string> {
  const [row] = await db
    .select({ id: schema.events.id })
    .from(schema.events)
    .where(eq(schema.events.slug, slug));
  return row.id;
}

/** A live row the record does not describe: `media` joined to `slug` at `position`. */
async function joinUndescribed(
  slug: string,
  position: number,
  media: typeof schema.media.$inferInsert,
): Promise<void> {
  const [row] = await db.insert(schema.media).values(media).returning({ id: schema.media.id });
  await db
    .insert(schema.eventPhotos)
    .values({ eventId: await eventId(slug), mediaId: row.id, position });
}

describe('stale live rows', () => {
  it('finds none in a fully imported record', async () => {
    const plan = await buildBackfillPlan(db as never);
    expect(plan.staleLiveRows).toEqual([]);
    expect(isApplicable(plan)).toBe(true);
  });

  it('refuses a stale row on an event the record shows no photos for', async () => {
    // Published, and no photos in the record: the planner reads nothing else
    // of this event, as after a whole room is taken out of the record.
    await joinUndescribed('claude-meetup-indore', 0, {
      path: 'events/room-taken-out.jpg',
      alt: 'A photograph from a room the record no longer shows',
      kind: 'photo',
    });

    const plan = await buildBackfillPlan(db as never);

    expect(plan.staleLiveRows).toEqual(['events/room-taken-out.jpg']);
    expect(isApplicable(plan)).toBe(false);
  });

  // The reader serves a published, untombstoned media row on a published event
  // (src/data/source-db.ts). A Restrict sets only the status and a Delete also
  // sets deleted_at, so each column gets its own case.
  it.each<[string, Partial<typeof schema.media.$inferInsert>]>([
    ['restricted (status deleted, no tombstone)', { status: 'deleted' }],
    ['tombstoned (deleted_at set, status still published)', { deletedAt: new Date() }],
  ])('does not refuse a row taken down in the admin: %s', async (_, hold) => {
    await joinUndescribed('claude-meetup', 4, {
      path: 'events/not-on-disk.jpg',
      alt: 'A photograph taken down in the admin',
      kind: 'photo',
      ...hold,
    });

    const plan = await buildBackfillPlan(db as never);

    expect(plan.staleLiveRows).toEqual([]);
    expect(isApplicable(plan)).toBe(true);
  });

  it('does not refuse a row on an event the reader does not publish', async () => {
    await db
      .update(schema.events)
      .set({ status: 'draft' })
      .where(eq(schema.events.slug, 'claude-meetup'));
    await joinUndescribed('claude-meetup', 4, {
      path: 'events/not-on-disk.jpg',
      alt: 'A photograph on an unpublished event',
      kind: 'photo',
    });

    const plan = await buildBackfillPlan(db as never);

    expect(plan.staleLiveRows).toEqual([]);
    expect(isApplicable(plan)).toBe(true);
  });

  it('refuses a live row whose file is gone, and says which', async () => {
    // claude-meetup holds positions 0-3, so 4 collides with nothing.
    await joinUndescribed('claude-meetup', 4, {
      path: 'events/not-on-disk.jpg',
      alt: 'A photograph whose file was removed',
      kind: 'photo',
    });

    const plan = await buildBackfillPlan(db as never);

    expect(plan.undescribedLiveRows).toBe(1);
    expect(plan.staleLiveRows).toEqual(['events/not-on-disk.jpg']);
    // The only refusal is the stale row.
    expect(plan.positionCollisions).toEqual([]);
    expect(plan.unresolvableAssetPaths).toEqual([]);
    expect(isApplicable(plan)).toBe(false);

    const printed = renderPlan(plan);
    expect(printed).toContain('REFUSING — STALE');
    expect(printed).toContain('\n  events/not-on-disk.jpg\n');
    expect(printed).toContain('rollback --receipt');
    expect(printed).toContain('NOT APPLICABLE');

    await expect(applyBackfill(db as never, plan, target)).rejects.toThrow(/not applicable/);
  });

  it('reports a missing file the record still names once, as unresolvable', async () => {
    // Every record photograph but one, so that one is live and unresolvable.
    const assetsDir = await mkdtemp(join(tmpdir(), 'stale-rows-assets-'));
    const absent = 'events/vol02-1.jpg';
    try {
      for (const path of new Set(wantedPhotos().map((photo) => photo.path))) {
        if (path === absent) continue;
        await mkdir(dirname(join(assetsDir, path)), { recursive: true });
        await symlink(join(process.cwd(), 'src/assets', path), join(assetsDir, path));
      }

      const plan = await buildBackfillPlan(db as never, { assetsDir });

      expect(plan.unresolvableAssetPaths).toEqual([absent]);
      expect(plan.staleLiveRows).toEqual([]);
      expect(isApplicable(plan)).toBe(false);
    } finally {
      await rm(assetsDir, { recursive: true, force: true });
    }
  });

  it('leaves alone an undescribed row whose file exists, and one with no path', async () => {
    // A real file the record shows on another event, joined here as well.
    const [vol02] = await db
      .select({ id: schema.media.id })
      .from(schema.media)
      .where(eq(schema.media.path, 'events/vol02-1.jpg'));
    await db.insert(schema.eventPhotos).values({
      eventId: await eventId('claude-community-conversation'),
      mediaId: vol02.id,
      position: 3,
    });
    // An uploaded blob: no asset path, so the reader skips it.
    await joinUndescribed('claude-meetup', 4, {
      alt: 'An uploaded photograph',
      kind: 'photo',
      blobUrl: 'https://example.invalid/upload.jpg',
      pathname: 'uploads/upload.jpg',
    });

    const plan = await buildBackfillPlan(db as never);

    expect(plan.undescribedLiveRows).toBe(2);
    expect(plan.staleLiveRows).toEqual([]);
    expect(isApplicable(plan)).toBe(true);
    expect(renderPlan(plan)).not.toContain('STALE');
  });
});

describe('consent past the last confirmation', () => {
  it('names only the events after the cutoff that show a new photograph', () => {
    const photo = (src: string) => [{ src, alt: src }];
    const record: Parameters<typeof eventsPastConsent>[1] = [
      { slug: 'on-the-cutoff', date: CONSENT_CONFIRMED_THROUGH, photos: photo('events/a.jpg') },
      { slug: 'after-it', date: '2026-10-12', photos: photo('events/a.jpg') },
      { slug: 'after-it-but-nothing-new', date: '2026-10-13', photos: photo('events/b.jpg') },
      { slug: 'after-it-with-no-photos', date: '2026-10-14' },
    ];
    expect(eventsPastConsent(['events/a.jpg'], record)).toEqual(['after-it']);
  });

  it('prints both confirmations, and a warning that does not stop apply', async () => {
    // Remove one photograph from 11 October so the plan inserts its media row.
    const [{ path }] = wantedPhotos().filter(
      (p) => p.eventSlug === 'claude-code-impact-lab-october',
    );
    const [media] = await db
      .select({ id: schema.media.id })
      .from(schema.media)
      .where(eq(schema.media.path, path));
    await db.delete(schema.eventPhotos).where(eq(schema.eventPhotos.mediaId, media.id));
    await db.delete(schema.media).where(eq(schema.media.id, media.id));

    const plan = await buildBackfillPlan(db as never);
    expect(plan.mediaInserts.map((row) => row.path)).toEqual([path]);
    // 11 October is covered.
    expect(plan.consentUnconfirmed).toEqual([]);

    const printed = renderPlan(plan);
    expect(printed.split('\n').at(-1)).toBe('APPLICABLE — re-run with `apply --yes` to write it.');
    expect(printed).toContain('confirmed by Vishal 2026-10-05 (VIS-14) for the events up to');
    expect(printed).toContain('confirmed by Vishal 2026-10-16 for 10 and 11 October.');
    expect(printed).not.toContain('WARNING');

    const later = { ...plan, consentUnconfirmed: ['a-later-event'] };
    expect(renderPlan(later)).toContain(
      `WARNING: 1 event(s) here were held after ${CONSENT_CONFIRMED_THROUGH}`,
    );
    expect(renderPlan(later)).toContain('a confirmation covers: a-later-event.');
    // A warning, not a refusal.
    expect(isApplicable(later)).toBe(true);
  });
});

describe('the verdict line', () => {
  const verdict = (plan: Parameters<typeof renderPlan>[0]) => renderPlan(plan).split('\n').at(-1);

  it('says there is nothing to do when the target already matches the record', async () => {
    expect(verdict(await buildBackfillPlan(db as never))).toBe(
      'NOTHING TO DO — a plain apply would write nothing.',
    );
  });

  it('does not say APPLICABLE when the only difference is plate order', async () => {
    // One plate moved: nothing to insert, and an append-only apply cannot move it.
    const meetup = await eventId('claude-meetup');
    await db
      .update(schema.eventPhotos)
      .set({ position: 99 })
      .where(and(eq(schema.eventPhotos.eventId, meetup), eq(schema.eventPhotos.position, 0)));

    const plan = await buildBackfillPlan(db as never);

    expect(plan.positionDrift).toHaveLength(1);
    expect(plan.mediaInserts).toEqual([]);
    expect(plan.photoInserts).toEqual([]);
    expect(verdict(plan)).toBe(
      'DRIFT ONLY — a plain apply would write nothing, and it cannot move the plates above.',
    );
  });
});
