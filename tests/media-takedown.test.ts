/**
 * A TAKEDOWN HAS TO TAKE SOMETHING DOWN.
 *
 * Before this suite, marking a media row `deleted` did not reliably stop the
 * public site rendering it. Three separate holes, all of which are asserted
 * closed here because there was nothing asserting it before — the suite's
 * only `status: 'deleted'` test was about a member, not an image:
 *
 *   1. `publicCover()` checked `status` inside the blob arm only. A cover
 *      that resolved through `imagePath` was ungoverned, and `deleted_at`
 *      was not read on either arm — so `UPDATE media SET deleted_at = now()`,
 *      the obvious gesture for a soft delete, hid nothing.
 *   2. `toCard()` gated the logo on `status` and not `deleted_at`, so the
 *      same row could be hidden as a cover and shown as a logo.
 *   3. `loadRecordSet()` read `media` with no predicate at all, so every
 *      event photograph reached the prebuilt snapshot regardless of status.
 *      That is the one that shipped to the public site.
 *
 * And one that undid the other three: `restore` in the moderation route
 * wrote `status` back to `published` and left the tombstone, so once the
 * readers honoured `deleted_at`, a moderator could take an image down and
 * never put it back. The round trip at the bottom is the test for that, and
 * it is the one that keeps the fix true after somebody next edits the route.
 *
 * None of these predicates changes what the site renders today — checked
 * before building. The archive's 80 asset-key covers carry no media row at
 * all, and all 41 event photographs are `published` with no tombstone.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import * as schema from '../db/schema';
import { listPublicProjects, publicCover } from '../src/server/public/projects';
import { loadRecordSet } from '../src/data/source-db';
import { mediaModerationPatch, type MediaModerationPatch } from '../admin/src/server/moderation';

const BLOB = 'https://abc.public.blob.vercel-storage.com';

let db: TestDatabase;
let cityId: string;
let eventId: string;
let n = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  const [city] = await db
    .insert(schema.cities)
    .values({
      slug: 'zz-takedown-city',
      name: 'Takedown City',
      region: 'Test',
      lat: 23,
      lon: 77,
      blurb: 'Fixture.',
      status: 'published',
    })
    .returning({ id: schema.cities.id });
  cityId = city.id;

  const [event] = await db
    .insert(schema.events)
    .values({
      slug: 'zz-takedown-buildday',
      title: 'Takedown Build Day',
      format: 'hackathon',
      cityId,
      date: '2026-03-14',
      startTime: '10:00',
      venueName: 'Somewhere',
      summary: 'A build day with photographs.',
      status: 'published',
    })
    .returning({ id: schema.events.id });
  eventId = event.id;
}, 60_000);

afterAll(async () => {
  await db?.$close();
});

beforeEach(async () => {
  await db.delete(schema.eventPhotos);
  await db.delete(schema.projects);
  await db.delete(schema.media);
});

/** A media row, published and untombstoned unless the caller says otherwise. */
async function mediaRow(
  overrides: Partial<typeof schema.media.$inferInsert> = {},
): Promise<string> {
  n += 1;
  const [row] = await db
    .insert(schema.media)
    .values({ alt: `Photograph ${n}`, kind: 'photo', ...overrides })
    .returning({ id: schema.media.id });
  return row.id;
}

async function publicProject(
  overrides: Partial<typeof schema.projects.$inferInsert> = {},
): Promise<string> {
  n += 1;
  const [row] = await db
    .insert(schema.projects)
    .values({
      slug: `zz-takedown-${n}`,
      title: `Takedown ${n}`,
      summary: 'A complete tagline.',
      description: 'What it does.',
      claudeUsage: 'Claude wrote the parser.',
      category: 'product',
      cityId,
      contentAuthority: 'curated',
      publicationStatus: 'published',
      moderationState: 'clean',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    })
    .returning({ id: schema.projects.id });
  return row.id;
}

/** The one card a single-project fixture produces. */
async function onlyCard() {
  const { items } = await listPublicProjects(db as never);
  expect(items).toHaveLength(1);
  return items[0];
}

/**
 * The columns the moderation route writes, for an action it owns. `null`
 * here would mean the route has stopped handling a takedown at all, so it is
 * a thrown error rather than a silently skipped update.
 */
function patch(action: 'delete' | 'restore'): MediaModerationPatch {
  const columns = mediaModerationPatch(action, null);
  if (!columns) throw new Error(`mediaModerationPatch() no longer handles "${action}"`);
  return columns;
}

/** The photographs the public record carries for the fixture event. */
async function publicPhotos(): Promise<string[]> {
  const set = await loadRecordSet(db as never);
  const event = set.events.find((e) => e.slug === 'zz-takedown-buildday');
  return (event?.photos ?? []).map((photo) => photo.src);
}

// ── 1. the resolver, as a pure function ─────────────────────────────────

describe('publicCover()', () => {
  /**
   * The regression floor — the five cases this function already had — stays
   * where it was, in `tests/project-lifecycle.test.ts` under "public readers
   * never render an arbitrary URL or a staged upload". Nothing here may
   * break it, and the point of case five there is that the archive's 80
   * asset-key covers must keep rendering.
   */
  it('leaves an asset key no media row governs alone', () => {
    // `media.status` is NOT NULL, so a null status means the left join found
    // nothing. There is no takedown to honour and the cover keeps rendering.
    expect(
      publicCover({
        imagePath: 'projects/nyaya.jpg',
        mediaUrl: null,
        mediaStatus: null,
        mediaDeletedAt: null,
      }),
    ).toBe('projects/nyaya.jpg');
  });

  it('hides a cover whose media row was taken down, whichever arm it came from', () => {
    // The asset arm — the hole this issue was opened for.
    expect(
      publicCover({
        imagePath: 'projects/nyaya.jpg',
        mediaUrl: null,
        mediaStatus: 'deleted',
        mediaDeletedAt: null,
      }),
    ).toBeUndefined();
    expect(
      publicCover({
        imagePath: 'projects/nyaya.jpg',
        mediaUrl: null,
        mediaStatus: 'published',
        mediaDeletedAt: new Date(),
      }),
    ).toBeUndefined();
    expect(
      publicCover({
        imagePath: 'projects/nyaya.jpg',
        mediaUrl: null,
        mediaStatus: 'staged',
        mediaDeletedAt: null,
      }),
    ).toBeUndefined();

    // The blob arm — which checked `status` but never the tombstone, so this
    // second case rendered a deleted image until now.
    expect(
      publicCover({
        imagePath: null,
        mediaUrl: `${BLOB}/a.png`,
        mediaStatus: 'deleted',
        mediaDeletedAt: null,
      }),
    ).toBeUndefined();
    expect(
      publicCover({
        imagePath: null,
        mediaUrl: `${BLOB}/a.png`,
        mediaStatus: 'published',
        mediaDeletedAt: new Date(),
      }),
    ).toBeUndefined();
  });
});

// ── 2. the project card, through the real query ─────────────────────────

describe('a taken-down image on a project card', () => {
  it('stops rendering as a cover', async () => {
    const mediaId = await mediaRow({ blobUrl: `${BLOB}/cover.png`, kind: 'cover' });
    await publicProject({ imageId: mediaId, imagePath: `${BLOB}/cover.png` });

    expect((await onlyCard()).image).toBe(`${BLOB}/cover.png`);

    await db.update(schema.media).set({ status: 'deleted' }).where(eq(schema.media.id, mediaId));
    expect((await onlyCard()).image).toBeUndefined();

    // And by the tombstone alone, with the status left `published` — the
    // state a hand-written soft delete produces.
    await db
      .update(schema.media)
      .set({ status: 'published', deletedAt: new Date() })
      .where(eq(schema.media.id, mediaId));
    expect((await onlyCard()).image).toBeUndefined();
  });

  it('stops rendering as a logo', async () => {
    const logoId = await mediaRow({
      blobUrl: `${BLOB}/logo.png`,
      kind: 'logo',
      provenance: 'upload',
    });
    await publicProject({ logoMediaId: logoId });

    expect((await onlyCard()).logo).toMatchObject({ kind: 'logo', src: `${BLOB}/logo.png` });

    // The gap this closes: a row hidden as a cover but shown as a logo is
    // the partial promise the whole issue exists to end.
    //
    // Asserted as the positive outcome rather than `not.toMatchObject({ src })`,
    // which would also pass for a malformed shape. This project carries no
    // cover and no `logoPath`, so once the media row is tombstoned
    // `resolveLogoSource()` has nothing to fall back to and must land on the
    // placeholder.
    await db.update(schema.media).set({ deletedAt: new Date() }).where(eq(schema.media.id, logoId));
    expect((await onlyCard()).logo).toMatchObject({ kind: 'placeholder' });
  });

  it('keeps rendering a committed asset key, which no media row governs', async () => {
    // 80 of the archive's 121 covers are this shape. A predicate that blanks
    // them has misread the data, not fixed a defect.
    await publicProject({ imagePath: 'projects/nyaya.jpg' });
    expect((await onlyCard()).image).toBe('projects/nyaya.jpg');
  });
});

// ── 3. the public record, which is what actually ships ──────────────────

describe('a taken-down event photograph', () => {
  it('never reaches the public record', async () => {
    const keptId = await mediaRow({ path: 'events/zz-kept.jpg' });
    const pulledId = await mediaRow({ path: 'events/zz-pulled.jpg' });
    await db.insert(schema.eventPhotos).values([
      { eventId, mediaId: keptId, position: 1 },
      { eventId, mediaId: pulledId, position: 2 },
    ]);

    expect(await publicPhotos()).toEqual(['events/zz-kept.jpg', 'events/zz-pulled.jpg']);

    await db.update(schema.media).set({ status: 'deleted' }).where(eq(schema.media.id, pulledId));
    expect(await publicPhotos()).toEqual(['events/zz-kept.jpg']);

    // The tombstone on its own, status untouched.
    await db
      .update(schema.media)
      .set({ status: 'published', deletedAt: new Date() })
      .where(eq(schema.media.id, pulledId));
    expect(await publicPhotos()).toEqual(['events/zz-kept.jpg']);

    // Nothing was destroyed — the row is still there, just not public. Same
    // property the event takedown path has.
    const [still] = await db.select().from(schema.media).where(eq(schema.media.id, pulledId));
    expect(still.path).toBe('events/zz-pulled.jpg');
  });
});

// ── 4. and the takedown has to be reversible ────────────────────────────

describe('the moderation round trip', () => {
  it('delete then restore puts the photograph back', async () => {
    const mediaId = await mediaRow({ path: 'events/zz-round-trip.jpg' });
    await db.insert(schema.eventPhotos).values({ eventId, mediaId, position: 1 });
    expect(await publicPhotos()).toEqual(['events/zz-round-trip.jpg']);

    await db.update(schema.media).set(patch('delete')).where(eq(schema.media.id, mediaId));
    expect(await publicPhotos()).toEqual([]);

    /**
     * THE ONE-WAY DOOR. `restore` used to write `status` back and leave
     * `deleted_at` set, which was harmless only for as long as no reader
     * honoured the tombstone. The moment they did — this pull request — a
     * moderator could take an image down and never put it back.
     */
    await db.update(schema.media).set(patch('restore')).where(eq(schema.media.id, mediaId));
    expect(await publicPhotos()).toEqual(['events/zz-round-trip.jpg']);

    const [row] = await db.select().from(schema.media).where(eq(schema.media.id, mediaId));
    expect(row).toMatchObject({
      status: 'published',
      deletedAt: null,
      deletedBy: null,
      deletionReason: null,
    });
  });

  it('restores a cover the same way', async () => {
    const mediaId = await mediaRow({ blobUrl: `${BLOB}/cover.png`, kind: 'cover' });
    await publicProject({ imageId: mediaId, imagePath: `${BLOB}/cover.png` });

    await db.update(schema.media).set(patch('delete')).where(eq(schema.media.id, mediaId));
    expect((await onlyCard()).image).toBeUndefined();

    await db.update(schema.media).set(patch('restore')).where(eq(schema.media.id, mediaId));
    expect((await onlyCard()).image).toBe(`${BLOB}/cover.png`);
  });

  it('writes a hold without a tombstone, and says nothing about actions it does not own', () => {
    // `restrict` is a hold rather than a removal; it did not write the
    // tombstone before and does not now.
    expect(mediaModerationPatch('restrict', 'actor-1')).toMatchObject({ status: 'deleted' });
    expect(mediaModerationPatch('restrict', 'actor-1')).not.toHaveProperty('deletedAt');

    // `archive` is accepted by the route and mapped by no branch — a
    // pre-existing defect being fixed on its own issue. Returning null is
    // how this module declines to paper over it here.
    expect(mediaModerationPatch('archive', 'actor-1')).toBeNull();
  });
});
