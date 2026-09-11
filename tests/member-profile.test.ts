/**
 * PHASE A — profiles, publishing, and the user-owned / source-owned split.
 *
 * The suite that has to be right. Everything here is a variation on one
 * question: can a member change something that is not theirs to change?
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import * as schema from '../db/schema';
import { ensureProfileShell, provisionMember, type Member } from '../src/server/auth/member';
import {
  PROTECTED_ROLE_WORDS,
  USER_OWNED_FIELDS,
  claimsProtectedStanding,
  profilePatchSchema,
  projectToBuilder,
  sanitiseProfileInput,
  updateProfile,
  readProfile,
} from '../src/server/members/profile';
import { missingForPublish, publishProfile } from '../src/server/members/publish';

let db: TestDatabase;
let cityId: string;

const noDeploy = async () => {};

beforeAll(async () => {
  db = await createTestDatabase();
  const [city] = await db
    .insert(schema.cities)
    .values({
      slug: 'zz-test-city',
      name: 'Test City',
      region: 'Test Region',
      lat: 23.25,
      lon: 77.41,
      blurb: 'A disposable fixture.',
      status: 'published',
    })
    .returning({ id: schema.cities.id });
  cityId = city.id;
});

afterAll(async () => {
  await db.$close();
});

beforeEach(async () => {
  // NOT `audit_log`: migration 0001 makes it append-only with a trigger that
  // refuses DELETE, which is exactly the guarantee it exists to give. Audit
  // assertions below therefore scope to the entity under test rather than
  // assuming an empty table.
  await db.delete(schema.profileClaims);
  await db.delete(schema.memberProfiles);
  await db.delete(schema.builders);
  // NOT `members` either. `audit_log.actor_member_id` is ON DELETE SET NULL,
  // nulling it is an UPDATE, and the append-only trigger refuses UPDATEs — so
  // a member who has acted cannot be hard-deleted. That is the intended
  // behaviour (§12: retire by status, never by removing the row), so each test
  // uses its own DID rather than expecting an empty table.
});

/** A disposable member with a usable passport. */
async function fixtureMember(did: string, username: string): Promise<Member> {
  const { member } = await provisionMember(did, db);
  await ensureProfileShell(member, db);
  await db
    .update(schema.memberProfiles)
    .set({
      username,
      displayName: 'ZZ Test Person',
      primaryRole: 'Developer',
      cityId,
      bio: 'A disposable fixture.',
    })
    .where(eq(schema.memberProfiles.memberId, member.id));
  return member;
}

// =========================================================================
describe('the patch schema refuses what it is not given', () => {
  /**
   * THE CENTRAL SECURITY ASSERTION OF THE PHASE.
   *
   * `.strict()` means an unknown key is an ERROR rather than a dropped value.
   * Silently ignoring these would look like success to whoever sent them.
   */
  it.each([
    'memberId',
    'member_id',
    'ownerMemberId',
    'owner_member_id',
    'status',
    'verified',
    'featured',
    'roles',
    'source',
    'publishedAt',
    'id',
    'slug',
  ])('rejects a body carrying %s', (field) => {
    const result = profilePatchSchema.safeParse({ bio: 'hello', [field]: 'anything' });
    expect(result.success).toBe(false);
  });

  it('accepts an ordinary patch', () => {
    const result = profilePatchSchema.safeParse({ bio: 'hello', headline: 'Building things' });
    expect(result.success).toBe(true);
  });

  it('enforces HTTPS on the website', () => {
    expect(profilePatchSchema.safeParse({ website: 'http://example.com' }).success).toBe(false);
    expect(profilePatchSchema.safeParse({ website: 'javascript:alert(1)' }).success).toBe(false);
    expect(profilePatchSchema.safeParse({ website: 'not a url' }).success).toBe(false);
    expect(profilePatchSchema.safeParse({ website: 'https://example.com' }).success).toBe(true);
  });

  it('refuses a role outside the selectable list', () => {
    expect(profilePatchSchema.safeParse({ primaryRole: 'Ambassador' }).success).toBe(false);
    expect(profilePatchSchema.safeParse({ primaryRole: 'Developer' }).success).toBe(true);
  });
});

// =========================================================================
describe('protected standing', () => {
  it.each(PROTECTED_ROLE_WORDS)('catches "%s" in a headline', (word) => {
    expect(claimsProtectedStanding(`Claude ${word} for India`)).toBe(word);
  });

  it('is word-boundary matched, so ordinary words survive', () => {
    // "administrator" contains "admin"; a boundary match must not fire on
    // "administrative assistant".
    expect(claimsProtectedStanding('Administrative assistant')).toBeNull();
    expect(claimsProtectedStanding('Partnership manager')).toBeNull();
  });

  it('rejects a headline claiming standing', () => {
    expect(profilePatchSchema.safeParse({ headline: 'Claude Ambassador, Bhopal' }).success).toBe(
      false,
    );
  });

  /** A bio is prose. "I met an ambassador" is a sentence, not a claim. */
  it('allows the words in a bio', () => {
    expect(
      profilePatchSchema.safeParse({ bio: 'I met an ambassador at a meetup last year.' }).success,
    ).toBe(true);
  });
});

// =========================================================================
describe('the sanitiser is a whitelist', () => {
  it('keeps only user-owned fields', () => {
    const out = sanitiseProfileInput({ bio: 'x', headline: 'y' } as never);
    expect(Object.keys(out).sort()).toEqual(['bio', 'headline']);
  });

  it('never emits a field outside the declared list', () => {
    const out = sanitiseProfileInput({
      bio: 'x',
      displayName: 'y',
      country: 'India',
      visibility: 'unlisted',
    } as never);
    for (const key of Object.keys(out)) {
      expect(USER_OWNED_FIELDS).toContain(key as never);
    }
  });

  it('does not carry a username through — that has its own path', () => {
    const out = sanitiseProfileInput({ username: 'someone-else' } as never);
    expect(out).not.toHaveProperty('username');
  });
});

// =========================================================================
describe('editing your own profile', () => {
  it('updates the fields it is given', async () => {
    const member = await fixtureMember('did:privy:zz-edit', 'zz-edit');
    const result = await updateProfile(member, { bio: 'Updated bio' }, db);

    expect(result.ok).toBe(true);
    const profile = await readProfile(member.id, db);
    expect(profile?.bio).toBe('Updated bio');
  });

  it('leaves untouched fields alone — a PATCH does not blank things', async () => {
    const member = await fixtureMember('did:privy:zz-patch', 'zz-patch');
    await updateProfile(member, { headline: 'A headline' }, db);
    await updateProfile(member, { bio: 'Only the bio' }, db);

    const profile = await readProfile(member.id, db);
    expect(profile?.headline).toBe('A headline');
    expect(profile?.bio).toBe('Only the bio');
  });

  /**
   * CANNOT EDIT ANOTHER MEMBER.
   *
   * Not asserted by trying and being refused — asserted by there being no way
   * to try. `updateProfile` takes the member as its subject and builds its
   * WHERE clause from it, so the "attack" is structurally unavailable. What
   * this test proves is that one member's write does not reach the other's row.
   */
  it('cannot reach another member\'s row', async () => {
    const alice = await fixtureMember('did:privy:zz-alice', 'zz-alice');
    const bob = await fixtureMember('did:privy:zz-bob', 'zz-bob');

    await updateProfile(alice, { bio: 'Alice wrote this' }, db);

    const bobProfile = await readProfile(bob.id, db);
    expect(bobProfile?.bio).toBe('A disposable fixture.');
  });

  it('refuses a username somebody else holds', async () => {
    await fixtureMember('did:privy:zz-first', 'zz-wanted');
    const second = await fixtureMember('did:privy:zz-second', 'zz-second');

    const result = await updateProfile(second, { username: 'zz-wanted' }, db);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(409);
  });

  it('refuses a reserved username', async () => {
    const member = await fixtureMember('did:privy:zz-reserved', 'zz-reserved');
    const result = await updateProfile(member, { username: 'moderation' }, db);
    expect(result.ok).toBe(false);
  });

  it('refuses a city that is not on the atlas', async () => {
    const member = await fixtureMember('did:privy:zz-city', 'zz-city');
    const result = await updateProfile(member, { citySlug: 'not-a-real-city' }, db);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('citySlug');
  });

  /** NOTHING HERE CREATES A CITY. An auto-created city is an auto-created chapter. */
  it('does not create a city it could not find', async () => {
    const member = await fixtureMember('did:privy:zz-nocity', 'zz-nocity');
    await updateProfile(member, { citySlug: 'jaipur' }, db);

    const cities = await db.select().from(schema.cities);
    expect(cities).toHaveLength(1);
  });
});

// =========================================================================
describe('the projection into builders', () => {
  const profile = {
    memberId: 'x',
    username: 'zz-proj',
    displayName: 'ZZ Projected',
    firstName: null,
    lastName: null,
    headline: 'A headline',
    bio: 'A bio',
    cityId: 'city-uuid',
    country: null,
    website: 'https://example.com',
    primaryRole: 'Developer',
    claudeSince: null,
    publicEmail: false,
    visibility: 'public' as const,
    publishedAt: null,
  };

  /**
   * THE CLAIM SAFETY PROPERTY, AS A UNIT TEST.
   *
   * A claimed legacy record keeps the name a human editor verified. The
   * projection simply does not return the key, so there is nothing to forget.
   */
  it('does not write the name of a legacy record', () => {
    const patch = projectToBuilder(profile, 'legacy');
    expect(patch).not.toHaveProperty('name');
    expect(patch).not.toHaveProperty('cityId');
  });

  it('does write the name of a record the member created', () => {
    const patch = projectToBuilder(profile, 'user');
    expect(patch.name).toBe('ZZ Projected');
    expect(patch.cityId).toBe('city-uuid');
  });

  it.each(['roles', 'status', 'featured', 'ambassadorId', 'imagePath', 'ownerMemberId', 'source', 'slug'])(
    'never writes %s for either source',
    (column) => {
      expect(projectToBuilder(profile, 'legacy')).not.toHaveProperty(column);
      expect(projectToBuilder(profile, 'user')).not.toHaveProperty(column);
    },
  );
});

// =========================================================================
describe('publishing', () => {
  it('says what is missing rather than publishing something incomplete', async () => {
    const { member } = await provisionMember('did:privy:zz-thin', db);
    await ensureProfileShell(member, db);

    const profile = await readProfile(member.id, db);
    expect(missingForPublish(profile!)).toContain('a username');

    const result = await publishProfile(member, db, noDeploy);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(422);
  });

  it('creates a builder row the member owns', async () => {
    const member = await fixtureMember('did:privy:zz-pub', 'zz-pub');
    const result = await publishProfile(member, db, noDeploy);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.slug).toBe('zz-pub');

    const [builder] = await db
      .select()
      .from(schema.builders)
      .where(eq(schema.builders.slug, 'zz-pub'));
    expect(builder.ownerMemberId).toBe(member.id);
    expect(builder.source).toBe('user');
    expect(builder.status).toBe('published');
  });

  /** SELF-SERVICE. No approval, no queue, no editor. §72. */
  it('reaches published without any editorial approval', async () => {
    const member = await fixtureMember('did:privy:zz-noqueue', 'zz-noqueue');
    await publishProfile(member, db, noDeploy);

    const [builder] = await db
      .select({ status: schema.builders.status })
      .from(schema.builders)
      .where(eq(schema.builders.slug, 'zz-noqueue'));
    expect(builder.status).toBe('published');

    // And nothing landed in the editorial inbox.
    const submissions = await db.select().from(schema.submissions);
    expect(submissions).toHaveLength(0);
  });

  it('never assigns roles — standing does not come from a form', async () => {
    const member = await fixtureMember('did:privy:zz-roles', 'zz-roles');
    await publishProfile(member, db, noDeploy);

    const [builder] = await db
      .select({ roles: schema.builders.roles })
      .from(schema.builders)
      .where(eq(schema.builders.slug, 'zz-roles'));
    expect(builder.roles).toEqual([]);
  });

  it('writes exactly one audit row, attributed to the member and not a moderator', async () => {
    const member = await fixtureMember('did:privy:zz-audit', 'zz-audit');
    await publishProfile(member, db, noDeploy);

    const [builder] = await db
      .select({ id: schema.builders.id })
      .from(schema.builders)
      .where(eq(schema.builders.slug, 'zz-audit'));

    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entityId, builder.id));

    expect(audit).toHaveLength(1);
    expect(audit[0].actorMemberId).toBe(member.id);
    expect(audit[0].actorId).toBeNull();
    expect(audit[0].action).toBe('member.profile.published');
  });

  it('updates rather than duplicating on a second publish', async () => {
    const member = await fixtureMember('did:privy:zz-again', 'zz-again');
    await publishProfile(member, db, noDeploy);
    await updateProfile(member, { bio: 'A revised bio' }, db);
    const second = await publishProfile(member, db, noDeploy);

    expect(second.ok).toBe(true);
    if (second.ok) expect(second.created).toBe(false);

    const builders = await db.select().from(schema.builders);
    expect(builders).toHaveLength(1);
    expect(builders[0].bio).toBe('A revised bio');
  });

  it('refuses a suspended member', async () => {
    const member = await fixtureMember('did:privy:zz-susp', 'zz-susp');
    const result = await publishProfile({ ...member, status: 'suspended' }, db, noDeploy);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  /** A deploy hook that throws must not un-publish anything. */
  it('publishes even when the deploy hook fails', async () => {
    const member = await fixtureMember('did:privy:zz-hook', 'zz-hook');
    const result = await publishProfile(member, db, async () => {
      throw new Error('Vercel is down');
    });

    expect(result.ok).toBe(true);
    const builders = await db.select().from(schema.builders);
    expect(builders).toHaveLength(1);
  });
});
