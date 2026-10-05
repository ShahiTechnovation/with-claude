/**
 * BUILDER PORTRAIT TAKEDOWN — a tombstoned avatar stops being served.
 *
 * `builderImage()` decides whether a builder's uploaded portrait reaches the
 * public builder index and the SSR detail page. It used to gate only on
 * `media.status`, which left a hole: `media.deleted_at` and `media.status` are
 * independent columns, so `UPDATE media SET deleted_at = now()` — the gesture
 * anyone reaching for a soft delete would use — set the tombstone while
 * `status` stayed `published`, and both public readers kept rendering the blob
 * URL.
 *
 * The `deleted_at`-only case is the one that regressed. The `status =
 * 'deleted'` cases are here too, because that is what the moderation endpoint
 * actually writes today and it must keep working.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import * as schema from '../db/schema';
import { builderImage, getPublicBuilderBySlug, getPublicBuilderList } from '../src/server/directory';

let db: TestDatabase;
let cityId: string;

const BLOB_URL = 'https://blob.vercel-storage.com/zz-portrait-abc123.jpg';
const ASSET_KEY = 'builders/zz-curated-portrait.jpg';

beforeAll(async () => {
  db = await createTestDatabase();
  const [city] = await db
    .insert(schema.cities)
    .values({
      slug: 'zz-portrait-city',
      name: 'Portrait City',
      region: 'Portrait Region',
      lat: 23.25,
      lon: 77.41,
      blurb: 'Disposable.',
      status: 'published',
    })
    .returning({ id: schema.cities.id });
  cityId = city.id;
}, 60_000);

afterAll(async () => {
  await db?.$close();
});

beforeEach(async () => {
  await db.delete(schema.builders).catch(() => {});
  await db.delete(schema.media).catch(() => {});
});

/**
 * A public builder with an uploaded portrait.
 *
 * `imagePath` is left null by default so the assertions read unambiguously: if
 * the portrait is withheld, `image` is `undefined` rather than some other
 * image that happens to render. The fallback is exercised on its own below.
 */
async function builderWithPortrait(
  slug: string,
  mediaValues: Partial<typeof schema.media.$inferInsert> = {},
  imagePath: string | null = null,
): Promise<void> {
  const [row] = await db
    .insert(schema.media)
    .values({
      blobUrl: BLOB_URL,
      alt: 'ZZ portrait',
      kind: 'portrait',
      status: 'published',
      provenance: 'upload',
      ...mediaValues,
    })
    .returning({ id: schema.media.id });

  await db.insert(schema.builders).values({
    slug,
    name: 'ZZ Portrait Person',
    cityId,
    role: 'Builder',
    status: 'published',
    moderationState: 'clean',
    imageId: row.id,
    imagePath,
  });
}

// =============================================================================
describe('builderImage(): the unit', () => {
  it('serves a published portrait with no tombstone', () => {
    expect(builderImage(null, { status: 'published', blobUrl: BLOB_URL, deletedAt: null })).toBe(BLOB_URL);
  });

  // THE REGRESSION. Fails against the pre-fix `builderImage()`, which returned
  // the blob URL here because it never looked at `deletedAt`.
  it('withholds a portrait whose media row is tombstoned but still "published"', () => {
    expect(
      builderImage(null, { status: 'published', blobUrl: BLOB_URL, deletedAt: new Date() }),
    ).toBeUndefined();
  });

  it('withholds it for a string timestamp too — the driver can hand back either', () => {
    expect(
      builderImage(null, { status: 'published', blobUrl: BLOB_URL, deletedAt: '2026-10-05T00:00:00.000Z' }),
    ).toBeUndefined();
  });

  it('withholds a portrait whose media row is status-deleted', () => {
    expect(builderImage(null, { status: 'deleted', blobUrl: BLOB_URL, deletedAt: new Date() })).toBeUndefined();
  });

  it('falls back to a scheme-less asset key when the portrait is tombstoned', () => {
    expect(
      builderImage(ASSET_KEY, { status: 'published', blobUrl: BLOB_URL, deletedAt: new Date() }),
    ).toBe(ASSET_KEY);
  });

  it('never falls back to a scheme-bearing imagePath, so a parked blob URL cannot leak', () => {
    expect(
      builderImage(BLOB_URL, { status: 'published', blobUrl: BLOB_URL, deletedAt: new Date() }),
    ).toBeUndefined();
  });
});

// =============================================================================
describe('the builder index reads the tombstone', () => {
  it('serves a live portrait', async () => {
    await builderWithPortrait('zz-portrait-live');
    const list = await getPublicBuilderList(db);
    expect(list.find((b) => b.slug === 'zz-portrait-live')?.image).toBe(BLOB_URL);
  });

  // THE REGRESSION, end to end: tombstone set by hand, `status` untouched.
  it('withholds a portrait soft-deleted with `status` left published', async () => {
    await builderWithPortrait('zz-portrait-tombstoned');
    await db
      .update(schema.media)
      .set({ deletedAt: new Date(), deletionReason: 'takedown request' })
      .where(eq(schema.media.blobUrl, BLOB_URL));

    const list = await getPublicBuilderList(db);
    const builder = list.find((b) => b.slug === 'zz-portrait-tombstoned');
    // The builder is still listed — only the portrait is withheld.
    expect(builder).toBeDefined();
    expect(builder?.image).toBeUndefined();
  });

  it('withholds a portrait the moderation endpoint deleted (status + tombstone)', async () => {
    await builderWithPortrait('zz-portrait-moderated', { status: 'deleted', deletedAt: new Date() });
    const list = await getPublicBuilderList(db);
    expect(list.find((b) => b.slug === 'zz-portrait-moderated')?.image).toBeUndefined();
  });

  it('falls back to the curated asset key once the upload is tombstoned', async () => {
    await builderWithPortrait('zz-portrait-fallback', { deletedAt: new Date() }, ASSET_KEY);
    const list = await getPublicBuilderList(db);
    expect(list.find((b) => b.slug === 'zz-portrait-fallback')?.image).toBe(ASSET_KEY);
  });
});

// =============================================================================
describe('the SSR detail page reads the tombstone', () => {
  it('serves a live portrait', async () => {
    await builderWithPortrait('zz-portrait-detail-live');
    const builder = await getPublicBuilderBySlug('zz-portrait-detail-live', db);
    expect(builder?.image).toBe(BLOB_URL);
  });

  // THE REGRESSION on the second reader. `getPublicBuilderBySlug()` has its own
  // query and its own `builderImage()` call site, so it needs its own test.
  it('withholds a portrait soft-deleted with `status` left published', async () => {
    await builderWithPortrait('zz-portrait-detail-tombstoned');
    await db
      .update(schema.media)
      .set({ deletedAt: new Date(), deletionReason: 'takedown request' })
      .where(eq(schema.media.blobUrl, BLOB_URL));

    const builder = await getPublicBuilderBySlug('zz-portrait-detail-tombstoned', db);
    expect(builder).not.toBeNull();
    expect(builder?.image).toBeUndefined();
  });
});
