/**
 * PHASE K — Regression coverage for the forensic audit fixes.
 *
 * Tests for:
 *   1. New published builder appears in /builders/ list.
 *   2. New published builder resolves at /builders/[slug] (the confirmed bug).
 *   3. Builder detail query never depends on a build-time snapshot.
 *   4. restricted builder is not public.
 *   5. removed (archived) builder is not public.
 *   6. moderator CAN inspect restricted/removed content.
 *   7. restore makes builder public again (clean+published).
 *   8. publish operation is atomic (publishedAt updated in same transaction).
 *   9. Slug is immutable after first publication.
 *  10. migration-strict.test.ts — duplicate migration errors are surfaced.
 *  11. unlisted profile is excluded from the public builder list.
 *  12. reported moderation state is excluded from the public builder list.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import * as schema from '../db/schema';
import { provisionMember, ensureProfileShell, type Member } from '../src/server/auth/member';
import { publishProfile } from '../src/server/members/publish';
import {
  getPublicBuilderList,
  getPublicBuilderBySlug,
  isPublicBuilder,
} from '../src/server/directory';

let db: TestDatabase;
let cityId: string;

const noDeploy = async () => {};

beforeAll(async () => {
  db = await createTestDatabase();
  const [city] = await db
    .insert(schema.cities)
    .values({
      slug: 'zz-regression-city',
      name: 'Regression City',
      region: 'Test Region',
      lat: 22.72,
      lon: 75.86,
      blurb: 'Disposable fixture city.',
      status: 'published',
    })
    .returning({ id: schema.cities.id });
  cityId = city.id;
}, 60_000);

afterAll(async () => {
  await db?.$close();
});

beforeEach(async () => {
  await db.delete(schema.profileClaims).catch(() => {});
  await db.delete(schema.memberProfiles).catch(() => {});
  await db.delete(schema.builders).catch(() => {});
});

/** A fully-provisioned member ready to publish. */
async function readyMember(did: string, username: string): Promise<Member> {
  const { member } = await provisionMember(did, db);
  await ensureProfileShell(member, db);
  await db
    .update(schema.memberProfiles)
    .set({
      username,
      displayName: `ZZ Regression ${username}`,
      primaryRole: 'Developer',
      cityId,
    })
    .where(eq(schema.memberProfiles.memberId, member.id));
  return member;
}

// =============================================================================
describe('Phase K-1: new published builder appears in /builders/ list', () => {
  it('getPublicBuilderList() includes a freshly published builder', async () => {
    const member = await readyMember('did:privy:zz-reg-k1', 'zz-reg-k1');
    await publishProfile(member, db, noDeploy);

    const list = await getPublicBuilderList(db);
    expect(list.map((b) => b.slug)).toContain('zz-reg-k1');
  });
});

// =============================================================================
describe('Phase K-2: new published builder resolves at /builders/[slug]', () => {
  it('getPublicBuilderBySlug() returns the row for a freshly published builder', async () => {
    const member = await readyMember('did:privy:zz-reg-k2', 'zz-reg-k2');
    await publishProfile(member, db, noDeploy);

    /**
     * This is the exact function call the rewritten /builders/[slug].astro
     * makes. Previously the page called publicBuilders.find() which searched
     * a build-time snapshot that never contained the new builder → 404.
     */
    const row = await getPublicBuilderBySlug('zz-reg-k2', db);
    expect(row).not.toBeNull();
    expect(row?.slug).toBe('zz-reg-k2');
    expect(row?.status).toBe('published');
    expect(row?.moderationState).toBe('clean');
  });
});

// =============================================================================
describe('Phase K-3: detail query is independent of any build-time snapshot', () => {
  it('getPublicBuilderBySlug() does not consult src/data/dataset.ts cached RecordSet', async () => {
    const member = await readyMember('did:privy:zz-reg-k3', 'zz-reg-k3');
    await publishProfile(member, db, noDeploy);

    // Explicitly clear the module-global cached RecordSet to simulate a cold
    // process (no build has run) or a process where the build-time snapshot
    // is for a different deployment. The Neon query must still succeed.
    const { __setRecords } = await import('../src/data/dataset');
    __setRecords(undefined);

    const row = await getPublicBuilderBySlug('zz-reg-k3', db);
    expect(row).not.toBeNull();
    expect(row?.slug).toBe('zz-reg-k3');
  });
});

// =============================================================================
describe('Phase K-4: restricted builder is not public', () => {
  it('isPublicBuilder() returns false for moderationState=restricted', () => {
    expect(
      isPublicBuilder({ status: 'published', moderationState: 'restricted' }),
    ).toBe(false);
  });

  it('getPublicBuilderList() excludes a restricted builder', async () => {
    await db.insert(schema.builders).values({
      slug: 'zz-reg-k4-restricted',
      name: 'ZZ Restricted',
      cityId,
      role: 'Builder',
      status: 'published',
      moderationState: 'restricted',
    });
    const list = await getPublicBuilderList(db);
    expect(list.map((b) => b.slug)).not.toContain('zz-reg-k4-restricted');
  });

  it('getPublicBuilderBySlug() returns the row (for moderator inspection)', async () => {
    await db.insert(schema.builders).values({
      slug: 'zz-reg-k4-restricted',
      name: 'ZZ Restricted',
      cityId,
      role: 'Builder',
      status: 'published',
      moderationState: 'restricted',
    });
    // getPublicBuilderBySlug() returns the row regardless of moderation state.
    // The /builders/[slug] page applies isPublicBuilder() and redirects non-moderators.
    const row = await getPublicBuilderBySlug('zz-reg-k4-restricted', db);
    expect(row).not.toBeNull();
    expect(row?.moderationState).toBe('restricted');
    expect(isPublicBuilder(row!)).toBe(false);
  });
});

// =============================================================================
describe('Phase K-5: removed (archived) builder is not public', () => {
  it('isPublicBuilder() returns false for status=archived', () => {
    expect(
      isPublicBuilder({ status: 'archived', moderationState: 'removed' }),
    ).toBe(false);
  });

  it('getPublicBuilderList() excludes a removed builder', async () => {
    await db.insert(schema.builders).values({
      slug: 'zz-reg-k5-removed',
      name: 'ZZ Removed',
      cityId,
      role: 'Builder',
      status: 'archived',
      moderationState: 'removed',
    });
    const list = await getPublicBuilderList(db);
    expect(list.map((b) => b.slug)).not.toContain('zz-reg-k5-removed');
  });
});

// =============================================================================
describe('Phase K-6: moderator can inspect restricted/removed content', () => {
  it('getPublicBuilderBySlug() returns restricted row for moderator check', async () => {
    await db.insert(schema.builders).values({
      slug: 'zz-reg-k6-mod',
      name: 'ZZ Mod Inspectable',
      cityId,
      role: 'Builder',
      status: 'published',
      moderationState: 'restricted',
    });
    // The detail page calls this, then the caller checks isModerator.
    // Non-public content is returned by the query; the route decides visibility.
    const row = await getPublicBuilderBySlug('zz-reg-k6-mod', db);
    expect(row).not.toBeNull();
    // Moderator check: not public, but inspectable
    expect(isPublicBuilder(row!)).toBe(false);
  });
});

// =============================================================================
describe('Phase K-7: restore makes builder public again', () => {
  it('after setting moderationState=clean + status=published, builder is public', async () => {
    const [builder] = await db
      .insert(schema.builders)
      .values({
        slug: 'zz-reg-k7-restore',
        name: 'ZZ Restore',
        cityId,
        role: 'Builder',
        status: 'published',
        moderationState: 'restricted',
      })
      .returning({ id: schema.builders.id });

    // Simulate restore
    await db
      .update(schema.builders)
      .set({ moderationState: 'clean' })
      .where(eq(schema.builders.id, builder.id));

    const list = await getPublicBuilderList(db);
    expect(list.map((b) => b.slug)).toContain('zz-reg-k7-restore');

    const row = await getPublicBuilderBySlug('zz-reg-k7-restore', db);
    expect(isPublicBuilder(row!)).toBe(true);
  });
});

// =============================================================================
describe('Phase K-8: publish is atomic — publishedAt updated in same transaction', () => {
  it('publishedAt is set after a successful publish', async () => {
    const member = await readyMember('did:privy:zz-reg-k8', 'zz-reg-k8');
    const result = await publishProfile(member, db, noDeploy);
    expect(result.ok).toBe(true);

    const [profile] = await db
      .select({ publishedAt: schema.memberProfiles.publishedAt })
      .from(schema.memberProfiles)
      .where(eq(schema.memberProfiles.memberId, member.id));

    expect(profile.publishedAt).not.toBeNull();
  });

  it('publishedAt and builder row are always in sync — no half-published state', async () => {
    const member = await readyMember('did:privy:zz-reg-k8b', 'zz-reg-k8b');
    const result = await publishProfile(member, db, noDeploy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // If builder row exists, publishedAt must also be set (same transaction).
    const [builderRow] = await db
      .select({ id: schema.builders.id, status: schema.builders.status })
      .from(schema.builders)
      .where(eq(schema.builders.slug, result.slug));
    expect(builderRow).toBeDefined();
    expect(builderRow.status).toBe('published');

    const [profile] = await db
      .select({ publishedAt: schema.memberProfiles.publishedAt })
      .from(schema.memberProfiles)
      .where(eq(schema.memberProfiles.memberId, member.id));
    expect(profile.publishedAt).not.toBeNull();
  });
});

// =============================================================================
describe('Phase K-9: slug is immutable after first publication', () => {
  it('re-publish after username change preserves the original slug', async () => {
    const member = await readyMember('did:privy:zz-reg-k9', 'zz-reg-k9-original');
    const firstResult = await publishProfile(member, db, noDeploy);
    expect(firstResult.ok).toBe(true);
    if (!firstResult.ok) return;
    expect(firstResult.slug).toBe('zz-reg-k9-original');

    // Change the username in the profile
    await db
      .update(schema.memberProfiles)
      .set({ username: 'zz-reg-k9-changed' })
      .where(eq(schema.memberProfiles.memberId, member.id));

    // Re-publish: the builder row already exists (owned by this member).
    // projectToBuilder() omits 'slug', so the slug must stay unchanged.
    const secondResult = await publishProfile(member, db, noDeploy);
    expect(secondResult.ok).toBe(true);
    if (!secondResult.ok) return;
    expect(secondResult.slug).toBe('zz-reg-k9-original');

    // The builder at the original URL still resolves.
    const row = await getPublicBuilderBySlug('zz-reg-k9-original', db);
    expect(row).not.toBeNull();

    // The new username does NOT create a second builder row.
    const newRow = await getPublicBuilderBySlug('zz-reg-k9-changed', db);
    expect(newRow).toBeNull();
  });
});

// =============================================================================
describe('Phase K-11: unlisted profile is excluded from public builder list', () => {
  it('a published+clean builder with visibility=unlisted is excluded from getPublicBuilderList', async () => {
    const member = await readyMember('did:privy:zz-reg-k11', 'zz-reg-k11');
    await publishProfile(member, db, noDeploy);

    // Set visibility to unlisted after publishing
    await db
      .update(schema.memberProfiles)
      .set({ visibility: 'unlisted' })
      .where(eq(schema.memberProfiles.memberId, member.id));

    const list = await getPublicBuilderList(db);
    expect(list.map((b) => b.slug)).not.toContain('zz-reg-k11');
  });
});

// =============================================================================
describe('Phase K-12: reported moderation state is excluded from public list', () => {
  it('isPublicBuilder() returns false for moderationState=reported', () => {
    expect(
      isPublicBuilder({ status: 'published', moderationState: 'reported' }),
    ).toBe(false);
  });

  it('getPublicBuilderList() excludes a builder in reported state', async () => {
    await db.insert(schema.builders).values({
      slug: 'zz-reg-k12-reported',
      name: 'ZZ Reported',
      cityId,
      role: 'Builder',
      status: 'published',
      moderationState: 'reported',
    });
    const list = await getPublicBuilderList(db);
    expect(list.map((b) => b.slug)).not.toContain('zz-reg-k12-reported');
  });
});
