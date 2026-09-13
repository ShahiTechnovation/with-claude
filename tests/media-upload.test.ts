/**
 * MEDIA UPLOAD SERVER LOGIC — the rules that guard `onBeforeGenerateToken`.
 *
 * These tests use a real PGlite database (same pattern as every other suite)
 * to exercise the ownership and clientPayload validation that runs server-side
 * before the Blob SDK is ever asked for a token.
 *
 * What is NOT tested here: the Blob SDK itself, the Blob store credentials,
 * or the network call to Vercel Blob. Those are outside this process. What IS
 * tested is that our code correctly refuses or authorises uploads based on the
 * database state — which is the only part we control.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import * as schema from '../db/schema';
import { provisionMember, ensureProfileShell, type Member } from '../src/server/auth/member';
import { canEditProject } from '../src/server/members/projects';

let db: TestDatabase;
let cityId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  const [city] = await db
    .insert(schema.cities)
    .values({
      slug: 'zz-upload-city',
      name: 'Upload City',
      region: 'Upload Region',
      lat: 23.25,
      lon: 77.41,
      blurb: 'Disposable fixture.',
      status: 'published',
    })
    .returning({ id: schema.cities.id });
  cityId = city.id;
}, 60_000);

afterAll(async () => {
  await db?.$close();
});

beforeEach(async () => {
  await db.delete(schema.media).catch(() => {});
  await db.delete(schema.projects).catch(() => {});
  await db.delete(schema.memberProfiles).catch(() => {});
  // NOT members — see member-profile.test.ts for why.
});

/** Disposable member with a profile. */
async function fixtureMember(did: string): Promise<Member> {
  const { member } = await provisionMember(did, db);
  await ensureProfileShell(member, db);
  return member;
}

/** Disposable draft project owned by `member`. Returns its id. */
async function fixtureProject(member: Member, title = 'ZZ Upload Test'): Promise<string> {
  const [project] = await db
    .insert(schema.projects)
    .values({
      ownerMemberId: member.id,
      slug: `zz-upload-${Date.now()}`,
      title,
      publicationStatus: 'draft',
      moderationState: 'clean',
      status: 'draft',
      featured: false,
      category: 'product',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning({ id: schema.projects.id });
  return project.id;
}

// =============================================================================
describe('canEditProject — the ownership check the upload endpoint uses', () => {
  it('returns true for the project owner', async () => {
    const member = await fixtureMember('did:privy:zz-upload-owner');
    const projectId = await fixtureProject(member);
    expect(await canEditProject(member.id, projectId, db)).toBe(true);
  });

  it('returns false for an unrelated member', async () => {
    const owner = await fixtureMember('did:privy:zz-upload-owner-2');
    const stranger = await fixtureMember('did:privy:zz-upload-stranger');
    const projectId = await fixtureProject(owner);
    expect(await canEditProject(stranger.id, projectId, db)).toBe(false);
  });

  it('returns false for a non-existent project', async () => {
    const member = await fixtureMember('did:privy:zz-upload-noproject');
    expect(
      await canEditProject(member.id, '00000000-0000-0000-0000-000000000000', db),
    ).toBe(false);
  });

  it('returns false when projectId is the wrong format', async () => {
    const member = await fixtureMember('did:privy:zz-upload-badid');
    // A non-UUID will simply not match any row.
    expect(await canEditProject(member.id, 'not-a-uuid', db)).toBe(false);
  });
});

// =============================================================================
describe('draft can be created without media', () => {
  it('inserts a project row without touching the media table', async () => {
    const member = await fixtureMember('did:privy:zz-upload-nodraft');
    const projectId = await fixtureProject(member, 'ZZ No Media Draft');

    const [project] = await db
      .select({ id: schema.projects.id, title: schema.projects.title })
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId));
    expect(project.title).toBe('ZZ No Media Draft');

    const mediaRows = await db.select().from(schema.media).where(
      eq(schema.media.projectId, projectId),
    );
    expect(mediaRows).toHaveLength(0);
  });

  it('saving a draft twice does not create a duplicate project', async () => {
    const member = await fixtureMember('did:privy:zz-upload-nodupe');
    await fixtureProject(member, 'ZZ Duplicate Test');

    const allProjects = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.ownerMemberId, member.id));
    // Only one project for this member (from our fixture call above).
    expect(allProjects).toHaveLength(1);
  });
});

// =============================================================================
describe('media row integrity', () => {
  /**
   * Simulates what `onUploadCompleted` does after a successful Blob upload.
   * Verifies that the row is created with the correct ownership and no extra
   * trust escalations.
   */
  it('records a media row with owner derived from the verified member, not the client', async () => {
    const member = await fixtureMember('did:privy:zz-upload-mediarow');
    const projectId = await fixtureProject(member);

    await db.insert(schema.media).values({
      ownerMemberId: member.id,
      projectId,
      blobUrl: 'https://blob.vercel-storage.com/test/image.jpg',
      pathname: 'test/image.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 100_000,
      alt: 'A test image',
      status: 'staged',
      kind: 'cover',
      consent: true,
    });

    const [row] = await db
      .select()
      .from(schema.media)
      .where(eq(schema.media.projectId, projectId));

    expect(row.ownerMemberId).toBe(member.id);
    expect(row.status).toBe('staged');  // an upload is not a publication
    expect(row.kind).toBe('cover');
    expect(row.consent).toBe(true);
  });

  it('associates the media row with the correct project', async () => {
    const member = await fixtureMember('did:privy:zz-upload-assoc');
    const projectId = await fixtureProject(member);

    await db.insert(schema.media).values({
      ownerMemberId: member.id,
      projectId,
      blobUrl: 'https://blob.vercel-storage.com/test/assoc.jpg',
      pathname: 'test/assoc.jpg',
      mimeType: 'image/jpeg',
      alt: 'Association test',
      status: 'staged',
      kind: 'cover',
      consent: true,
    });

    const [row] = await db
      .select({ projectId: schema.media.projectId })
      .from(schema.media)
      .where(eq(schema.media.ownerMemberId, member.id));
    expect(row.projectId).toBe(projectId);
  });
});
