/**
 * BUILDER LISTING — SSR query correctness.
 *
 * Verifies that `getPublicBuilderList()` applies the canonical visibility
 * predicate — `isPublic()` in `src/data/index.ts` — which allows
 * `status IN ('published', 'featured')` and bars `archived` and others.
 *
 * Also verifies: a newly published member appears without any rebuild, and
 * private/archived/moderated builders are correctly excluded.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import * as schema from '../db/schema';
import { provisionMember, ensureProfileShell, type Member } from '../src/server/auth/member';
import { publishProfile } from '../src/server/members/publish';
import { getPublicBuilderList } from '../src/server/directory';

let db: TestDatabase;
let cityId: string;

const noDeploy = async () => {};

beforeAll(async () => {
  db = await createTestDatabase();
  const [city] = await db
    .insert(schema.cities)
    .values({
      slug: 'zz-listing-city',
      name: 'Listing City',
      region: 'Listing Region',
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
  await db.delete(schema.memberProfiles).catch(() => {});
  await db.delete(schema.builders).catch(() => {});
});

/** Member with a fully-filled passport, ready to publish. */
async function publishedMember(did: string, username: string): Promise<Member> {
  const { member } = await provisionMember(did, db);
  await ensureProfileShell(member, db);
  await db
    .update(schema.memberProfiles)
    .set({ username, displayName: 'ZZ Listing Person', primaryRole: 'Developer', cityId })
    .where(eq(schema.memberProfiles.memberId, member.id));
  await publishProfile(member, db, noDeploy);
  return member;
}

// =============================================================================
describe('canonical visibility: published builders appear', () => {
  it('includes a newly published member builder without any rebuild', async () => {
    await publishedMember('did:privy:zz-list-pub', 'zz-list-pub');

    // getPublicBuilderList() queries the live database — this is exactly the
    // function the SSR /builders/ route calls.
    const list = await getPublicBuilderList(db);
    const slugs = list.map((b) => b.slug);
    expect(slugs).toContain('zz-list-pub');
  });

  it('includes a featured builder', async () => {
    /**
     * `'featured'` is not a `content_status` value — the enum is
     * `draft | pending | ... | published | rejected | archived`. Featured is
     * its own boolean column layered on top of `published`, the same
     * `status` + `featured` pair `moderationOf()` combines into the
     * `ModerationStatus` string `'featured'` for the public record. See
     * `db/schema.ts`'s `builders` table.
     */
    await db.insert(schema.builders).values({
      slug: 'zz-list-featured',
      name: 'ZZ Featured',
      cityId,
      role: 'Builder',
      status: 'published',
      featured: true,
      moderationState: 'clean',
    });
    const list = await getPublicBuilderList(db);
    expect(list.map((b) => b.slug)).toContain('zz-list-featured');
  });
});

// =============================================================================
describe('canonical visibility: non-public builders are excluded', () => {
  it('excludes an archived builder', async () => {
    await db.insert(schema.builders).values({
      slug: 'zz-list-archived',
      name: 'ZZ Archived',
      cityId,
      role: 'Builder',
      status: 'archived',
      moderationState: 'clean',
    });
    const list = await getPublicBuilderList(db);
    expect(list.map((b) => b.slug)).not.toContain('zz-list-archived');
  });

  it('excludes a pending (non-published) builder', async () => {
    await db.insert(schema.builders).values({
      slug: 'zz-list-pending',
      name: 'ZZ Pending',
      cityId,
      role: 'Builder',
      status: 'pending',
      moderationState: 'clean',
    });
    const list = await getPublicBuilderList(db);
    expect(list.map((b) => b.slug)).not.toContain('zz-list-pending');
  });

  it('excludes a published builder in "restricted" moderation state', async () => {
    await db.insert(schema.builders).values({
      slug: 'zz-list-restricted',
      name: 'ZZ Restricted',
      cityId,
      role: 'Builder',
      status: 'published',
      moderationState: 'restricted',
    });
    const list = await getPublicBuilderList(db);
    expect(list.map((b) => b.slug)).not.toContain('zz-list-restricted');
  });
});

// =============================================================================
describe('unlisted visibility semantics', () => {
  it('excludes an explicitly unlisted member from directory indexing', async () => {
    const member = await publishedMember('did:privy:zz-list-unlisted', 'zz-list-unlisted');
    
    // Set member profile to unlisted
    await db
      .update(schema.memberProfiles)
      .set({ visibility: 'unlisted' })
      .where(eq(schema.memberProfiles.memberId, member.id));

    const list = await getPublicBuilderList(db);
    expect(list.map((b) => b.slug)).not.toContain('zz-list-unlisted');
  });
  
  it('includes a member whose visibility is public (the default)', async () => {
    const member = await publishedMember('did:privy:zz-list-public', 'zz-list-public');
    
    await db
      .update(schema.memberProfiles)
      .set({ visibility: 'public' })
      .where(eq(schema.memberProfiles.memberId, member.id));

    const list = await getPublicBuilderList(db);
    expect(list.map((b) => b.slug)).toContain('zz-list-public');
  });
});

// =============================================================================
describe('city slug resolution', () => {
  it('resolves the city slug for a builder with a city', async () => {
    await publishedMember('did:privy:zz-list-city', 'zz-list-city');
    const list = await getPublicBuilderList(db);
    const builder = list.find((b) => b.slug === 'zz-list-city');
    expect(builder?.citySlug).toBe('zz-listing-city');
  });
});

// =============================================================================
describe('no rebuild required for new public builders', () => {
  it('a second publish after profile update reflects the new data', async () => {
    const member = await publishedMember('did:privy:zz-list-update', 'zz-list-update');

    // Update the profile.
    await db
      .update(schema.memberProfiles)
      .set({ displayName: 'ZZ Updated Name' })
      .where(eq(schema.memberProfiles.memberId, member.id));

    // Re-publish.
    await publishProfile(member, db, noDeploy);

    const list = await getPublicBuilderList(db);
    const builder = list.find((b) => b.slug === 'zz-list-update');
    expect(builder?.name).toBe('ZZ Updated Name');
  });
});
