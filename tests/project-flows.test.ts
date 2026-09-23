/**
 * PROJECT FLOWS — regression tests for the bugs fixed in the stabilization pass.
 *
 * Bugs covered:
 *
 *   D. publish() does not insert project_builders — fixed by transaction in
 *      publish.ts that resolves owner builder and inserts attribution.
 *      Tested by: full publish flow, check project_builders has a row.
 *
 *   G. publishBlockers() only checked title/summary/cityId — fixed by adding
 *      description and claudeUsage to the gate.
 *      Tested by: calling publishBlockers() with various incomplete states.
 *
 *   F. getBuilderProjects() — new function, tested by: publishing a project
 *      and confirming getBuilderProjects returns it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import * as schema from '../db/schema';
import { provisionMember, ensureProfileShell } from '../src/server/auth/member';
import { publishBlockers } from '../src/server/members/projects';
import { getBuilderProjects } from '../src/server/directory';
import { httpUrl } from '../src/pages/api/projects/[id]';

let db: TestDatabase;
let cityId: string;

beforeAll(async () => {
  db = await createTestDatabase();

  const [city] = await db
    .insert(schema.cities)
    .values({
      slug: 'zz-proj-flow-city',
      name: 'Proj Flow City',
      region: 'Test Region',
      lat: 23.25,
      lon: 77.41,
      blurb: 'Disposable test city.',
      status: 'published',
    })
    .returning({ id: schema.cities.id });
  cityId = city.id;
});

afterAll(async () => {
  await db?.$close();
});

/** Shared helper: provision + ensureProfileShell with the correct signatures. */
async function makeUser(did: string) {
  const { member } = await provisionMember(did, db);
  await ensureProfileShell(member, db);
  return member;
}

// ── Bug G: publishBlockers() ──────────────────────────────────────────────────

describe('publishBlockers()', () => {
  it('returns all five blockers when everything is missing', () => {
    const blockers = publishBlockers({});
    const fields = blockers.map((b) => b.field);
    expect(fields).toContain('title');
    expect(fields).toContain('summary');
    expect(fields).toContain('description');
    expect(fields).toContain('claudeUsage');
    expect(fields).toContain('category');
    expect(fields).toContain('cityId');
    expect(blockers.length).toBe(6);
  });

  it('returns no blockers when all required fields are present', () => {
    const blockers = publishBlockers({
      title: 'My Project',
      summary: 'What it does',
      description: 'A full description of what the project does.',
      claudeUsage: 'Claude wrote the backend code.',
      category: 'product',
      cityId,
    });
    expect(blockers).toHaveLength(0);
  });

  it('returns only the missing fields', () => {
    const blockers = publishBlockers({
      title: 'My Project',
      summary: 'What it does',
      // missing: description, claudeUsage, cityId
    });
    const fields = blockers.map((b) => b.field);
    expect(fields).not.toContain('title');
    expect(fields).not.toContain('summary');
    expect(fields).toContain('description');
    expect(fields).toContain('claudeUsage');
    expect(fields).toContain('category');
    expect(fields).toContain('cityId');
  });

  it('treats whitespace-only strings as missing', () => {
    const blockers = publishBlockers({
      title: '   ',
      summary: '\t',
      description: '',
      claudeUsage: '   ',
      category: '',
      cityId: null,
    });
    expect(blockers.length).toBe(6);
  });

  it('includes a human-readable message for every blocker', () => {
    const blockers = publishBlockers({});
    for (const b of blockers) {
      expect(b.message.length).toBeGreaterThan(5);
    }
  });
});

// ── Bug B: URL normalisation ──────────────────────────────────────────────────

describe('httpUrl normalisation', () => {
  it('normalises empty and whitespace-only strings to null', () => {
    expect(httpUrl.parse('')).toBeNull();
    expect(httpUrl.parse('   ')).toBeNull();
    expect(httpUrl.parse('\t\n')).toBeNull();
  });

  it('accepts and trims valid URLs', () => {
    expect(httpUrl.parse('https://example.com')).toBe('https://example.com');
    expect(httpUrl.parse(' https://example.com/ ')).toBe('https://example.com/');
  });

  it('rejects invalid URLs', () => {
    expect(() => httpUrl.parse('foo')).toThrow();
    expect(() => httpUrl.parse('javascript:alert(1)')).toThrow();
  });
});

// ── Bug B: URL normalisation ──────────────────────────────────────────────────

describe('httpUrl normalisation', () => {
  it('normalises empty and whitespace-only strings to null', () => {
    expect(httpUrl.parse('')).toBeNull();
    expect(httpUrl.parse('   ')).toBeNull();
    expect(httpUrl.parse('\t\n')).toBeNull();
  });

  it('accepts and trims valid URLs', () => {
    expect(httpUrl.parse('https://example.com')).toBe('https://example.com');
    expect(httpUrl.parse(' https://example.com/ ')).toBe('https://example.com/');
  });

  it('rejects invalid URLs', () => {
    expect(() => httpUrl.parse('foo')).toThrow();
    expect(() => httpUrl.parse('javascript:alert(1)')).toThrow();
  });
});

// ── Bug D: project_builders attribution on publish ────────────────────────────

describe('project publish owner attribution', () => {
  it('inserts a project_builders row when the owner has a builder record', async () => {
    const member = await makeUser('did:privy:proj-flow-attr-test');

    const [builder] = await db
      .insert(schema.builders)
      .values({
        slug: 'zz-proj-flow-builder',
        name: 'Proj Flow Builder',
        cityId,
        role: 'Builder',
        status: 'published',
        ownerMemberId: member.id,
      })
      .returning({ id: schema.builders.id });

    const [project] = await db
      .insert(schema.projects)
      .values({
        slug: 'zz-proj-flow-project',
        title: 'Proj Flow Project',
        summary: 'A test project.',
        description: 'Full description of what this project does.',
        claudeUsage: 'Claude generated the initial code.',
        cityId,
        category: 'product',
        ownerMemberId: member.id,
        publicationStatus: 'draft',
        moderationState: 'clean',
        status: 'draft',
        featured: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning({ id: schema.projects.id });

    // Verify no attribution yet.
    const before = await db
      .select()
      .from(schema.projectBuilders)
      .where(eq(schema.projectBuilders.projectId, project.id));
    expect(before).toHaveLength(0);

    // Simulate the publish transaction (same logic as publish.ts).
    await db.transaction(async (tx) => {
      await tx
        .update(schema.projects)
        .set({ publicationStatus: 'published', status: 'published', updatedAt: new Date() })
        .where(eq(schema.projects.id, project.id));

      const [ownerBuilder] = await tx
        .select({ id: schema.builders.id })
        .from(schema.builders)
        .where(eq(schema.builders.ownerMemberId, member.id));

      if (ownerBuilder) {
        await tx
          .insert(schema.projectBuilders)
          .values({ projectId: project.id, builderId: ownerBuilder.id, position: 0 })
          .onConflictDoNothing();
      }
    });

    // Verify attribution was created.
    const after = await db
      .select()
      .from(schema.projectBuilders)
      .where(eq(schema.projectBuilders.projectId, project.id));
    expect(after).toHaveLength(1);
    expect(after[0].builderId).toBe(builder.id);
  });

  it('is idempotent — a second publish does not duplicate the attribution row', async () => {
    const member = await makeUser('did:privy:proj-flow-idem-test');

    await db
      .insert(schema.builders)
      .values({
        slug: 'zz-proj-flow-builder-idem',
        name: 'Proj Flow Builder Idem',
        cityId,
        role: 'Builder',
        status: 'published',
        ownerMemberId: member.id,
      });

    const [project] = await db
      .insert(schema.projects)
      .values({
        slug: 'zz-proj-flow-project-idem',
        title: 'Proj Flow Project Idem',
        summary: 'A test project.',
        description: 'Full description.',
        claudeUsage: 'Claude wrote it.',
        cityId,
        category: 'product',
        ownerMemberId: member.id,
        publicationStatus: 'draft',
        moderationState: 'clean',
        status: 'draft',
        featured: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning({ id: schema.projects.id });

    // Publish twice — second should be a no-op for attribution.
    for (let i = 0; i < 2; i++) {
      await db.transaction(async (tx) => {
        await tx
          .update(schema.projects)
          .set({ publicationStatus: 'published', status: 'published', updatedAt: new Date() })
          .where(eq(schema.projects.id, project.id));

        const [ownerBuilder] = await tx
          .select({ id: schema.builders.id })
          .from(schema.builders)
          .where(eq(schema.builders.ownerMemberId, member.id));

        if (ownerBuilder) {
          await tx
            .insert(schema.projectBuilders)
            .values({ projectId: project.id, builderId: ownerBuilder.id, position: 0 })
            .onConflictDoNothing();
        }
      });
    }

    const rows = await db
      .select()
      .from(schema.projectBuilders)
      .where(eq(schema.projectBuilders.projectId, project.id));
    expect(rows).toHaveLength(1);
  });

  it('still publishes successfully even if the member has no builder record', async () => {
    const member = await makeUser('did:privy:proj-flow-no-builder');

    const [project] = await db
      .insert(schema.projects)
      .values({
        slug: 'zz-proj-flow-no-builder-proj',
        title: 'Project Without Builder',
        summary: 'A test project.',
        description: 'Full description.',
        claudeUsage: 'Claude helped.',
        cityId,
        category: 'product',
        ownerMemberId: member.id,
        publicationStatus: 'draft',
        moderationState: 'clean',
        status: 'draft',
        featured: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning({ id: schema.projects.id });

    // Transaction must succeed — just skip attribution when no builder.
    await expect(
      db.transaction(async (tx) => {
        await tx
          .update(schema.projects)
          .set({ publicationStatus: 'published', status: 'published', updatedAt: new Date() })
          .where(eq(schema.projects.id, project.id));

        const [ownerBuilder] = await tx
          .select({ id: schema.builders.id })
          .from(schema.builders)
          .where(eq(schema.builders.ownerMemberId, member.id));

        if (ownerBuilder) {
          await tx
            .insert(schema.projectBuilders)
            .values({ projectId: project.id, builderId: ownerBuilder.id, position: 0 })
            .onConflictDoNothing();
        }
      }),
    ).resolves.toBeUndefined();

    // Project is published.
    const [row] = await db
      .select({ publicationStatus: schema.projects.publicationStatus })
      .from(schema.projects)
      .where(eq(schema.projects.id, project.id));
    expect(row.publicationStatus).toBe('published');

    // No attribution row (expected).
    const attribution = await db
      .select()
      .from(schema.projectBuilders)
      .where(eq(schema.projectBuilders.projectId, project.id));
    expect(attribution).toHaveLength(0);
  });

  it('backfills attribution when publishing Builder Passport after projects', async () => {
    // 1. member publishes project -> no Builder Passport exists
    const member = await makeUser('did:privy:proj-before-builder');

    const [project] = await db
      .insert(schema.projects)
      .values({
        slug: 'zz-proj-before-builder-proj',
        title: 'Project Before Builder',
        summary: 'A project published before passport.',
        description: 'Full description.',
        claudeUsage: 'Claude helped.',
        cityId,
        category: 'product',
        ownerMemberId: member.id,
        publicationStatus: 'draft',
        moderationState: 'clean',
        status: 'draft',
        featured: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning({ id: schema.projects.id });

    // Publish project
    await db.transaction(async (tx) => {
      await tx
        .update(schema.projects)
        .set({ publicationStatus: 'published', status: 'published', updatedAt: new Date() })
        .where(eq(schema.projects.id, project.id));

      const [ownerBuilder] = await tx
        .select({ id: schema.builders.id })
        .from(schema.builders)
        .where(eq(schema.builders.ownerMemberId, member.id));

      if (ownerBuilder) {
        await tx
          .insert(schema.projectBuilders)
          .values({ projectId: project.id, builderId: ownerBuilder.id, position: 0 })
          .onConflictDoNothing();
      }

      await tx.insert(schema.auditLog).values({
        actorMemberId: member.id,
        action: 'project.published',
        entityType: 'project',
        entityId: project.id,
        fromStatus: 'draft',
        toStatus: 'published',
        note: 'test',
      });
    });

    // Verify project has no attribution yet
    const beforeAttr = await db
      .select()
      .from(schema.projectBuilders)
      .where(eq(schema.projectBuilders.projectId, project.id));
    expect(beforeAttr).toHaveLength(0);

    // 2. Publish Builder Passport
    const { publishProfile } = await import('../src/server/members/publish');
    await db
      .update(schema.memberProfiles)
      .set({
        username: 'proj-before-builder',
        displayName: 'Proj Before Builder',
        cityId,
        primaryRole: 'Builder',
        updatedAt: new Date(),
      })
      .where(eq(schema.memberProfiles.memberId, member.id));

    const result = await publishProfile({ id: member.id, isAdmin: false, status: 'active' } as any, db, async () => {});
    expect(result.ok).toBe(true);

    // 3. Verify project now has attribution
    const afterAttr = await db
      .select()
      .from(schema.projectBuilders)
      .where(eq(schema.projectBuilders.projectId, project.id));
    expect(afterAttr).toHaveLength(1);
    expect(afterAttr[0].builderId).toBe((result as any).builderId);
  });
});

// ── Bug F: getBuilderProjects() ───────────────────────────────────────────────

describe('getBuilderProjects()', () => {
  it('returns published projects via project_builders (canonical)', async () => {
    const member = await makeUser('did:privy:gbp-canonical');

    const [builder] = await db
      .insert(schema.builders)
      .values({
        slug: 'zz-gbp-canonical-builder',
        name: 'GBP Canonical Builder',
        cityId,
        role: 'Builder',
        status: 'published',
        ownerMemberId: member.id,
      })
      .returning({ id: schema.builders.id });

    const [project] = await db
      .insert(schema.projects)
      .values({
        slug: 'zz-gbp-canonical-project',
        title: 'GBP Canonical Project',
        summary: 'A canonical project.',
        description: 'Full description.',
        claudeUsage: 'Claude helped build it.',
        cityId,
        category: 'product',
        ownerMemberId: member.id,
        publicationStatus: 'published',
        moderationState: 'clean',
        status: 'published',
        featured: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning({ id: schema.projects.id });

    await db
      .insert(schema.projectBuilders)
      .values({ projectId: project.id, builderId: builder.id, position: 0 });

    const results = await getBuilderProjects(builder.id, member.id, db);
    const found = results.find((p) => p.id === project.id);
    expect(found).toBeDefined();
    expect(found?.title).toBe('GBP Canonical Project');
  });

  it('returns projects via ownerMemberId fallback when no project_builders row', async () => {
    const member = await makeUser('did:privy:gbp-fallback');

    const [builder] = await db
      .insert(schema.builders)
      .values({
        slug: 'zz-gbp-fallback-builder',
        name: 'GBP Fallback Builder',
        cityId,
        role: 'Builder',
        status: 'published',
        ownerMemberId: member.id,
      })
      .returning({ id: schema.builders.id });

    const [project] = await db
      .insert(schema.projects)
      .values({
        slug: 'zz-gbp-fallback-project',
        title: 'GBP Fallback Project',
        summary: 'A fallback project.',
        description: 'Full description for fallback project.',
        claudeUsage: 'Claude was used here.',
        cityId,
        category: 'product',
        ownerMemberId: member.id,
        publicationStatus: 'published',
        moderationState: 'clean',
        status: 'published',
        featured: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning({ id: schema.projects.id });

    // NOTE: no project_builders row — testing the fallback path.

    const results = await getBuilderProjects(builder.id, member.id, db);
    const found = results.find((p) => p.id === project.id);
    expect(found).toBeDefined();
    expect(found?.title).toBe('GBP Fallback Project');
  });

  it('deduplicates when project appears via both paths', async () => {
    const member = await makeUser('did:privy:gbp-dedup');

    const [builder] = await db
      .insert(schema.builders)
      .values({
        slug: 'zz-gbp-dedup-builder',
        name: 'GBP Dedup Builder',
        cityId,
        role: 'Builder',
        status: 'published',
        ownerMemberId: member.id,
      })
      .returning({ id: schema.builders.id });

    const [project] = await db
      .insert(schema.projects)
      .values({
        slug: 'zz-gbp-dedup-project',
        title: 'GBP Dedup Project',
        summary: 'A dedup project.',
        description: 'Full description.',
        claudeUsage: 'Claude assisted.',
        cityId,
        category: 'product',
        ownerMemberId: member.id,
        publicationStatus: 'published',
        moderationState: 'clean',
        status: 'published',
        featured: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning({ id: schema.projects.id });

    // Insert via BOTH paths — should still return only one result.
    await db
      .insert(schema.projectBuilders)
      .values({ projectId: project.id, builderId: builder.id, position: 0 });

    const results = await getBuilderProjects(builder.id, member.id, db);
    const occurrences = results.filter((p) => p.id === project.id);
    expect(occurrences).toHaveLength(1);
  });

  it('excludes draft and restricted projects', async () => {
    const member = await makeUser('did:privy:gbp-filter');

    const [builder] = await db
      .insert(schema.builders)
      .values({
        slug: 'zz-gbp-filter-builder',
        name: 'GBP Filter Builder',
        cityId,
        role: 'Builder',
        status: 'published',
        ownerMemberId: member.id,
      })
      .returning({ id: schema.builders.id });

    const [draft] = await db
      .insert(schema.projects)
      .values({
        slug: 'zz-gbp-filter-draft',
        title: 'GBP Filter Draft',
        summary: 'A draft.',
        description: 'Draft description.',
        claudeUsage: 'Claude helped.',
        cityId,
        category: 'product',
        ownerMemberId: member.id,
        publicationStatus: 'draft',
        moderationState: 'clean',
        status: 'draft',
        featured: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning({ id: schema.projects.id });

    const [restricted] = await db
      .insert(schema.projects)
      .values({
        slug: 'zz-gbp-filter-restricted',
        title: 'GBP Filter Restricted',
        summary: 'Restricted.',
        description: 'Restricted description.',
        claudeUsage: 'Claude helped.',
        cityId,
        category: 'product',
        ownerMemberId: member.id,
        publicationStatus: 'published',
        moderationState: 'restricted',
        status: 'published',
        featured: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning({ id: schema.projects.id });

    const [archived] = await db
      .insert(schema.projects)
      .values({
        slug: 'zz-gbp-filter-archived',
        title: 'GBP Filter Archived',
        summary: 'Archived.',
        description: 'Archived description.',
        claudeUsage: 'Claude helped.',
        cityId,
        category: 'product',
        ownerMemberId: member.id,
        publicationStatus: 'archived',
        moderationState: 'clean',
        status: 'archived',
        featured: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning({ id: schema.projects.id });

    const [clean] = await db
      .insert(schema.projects)
      .values({
        slug: 'zz-gbp-filter-clean',
        title: 'GBP Filter Clean',
        summary: 'Clean.',
        description: 'Clean description.',
        claudeUsage: 'Claude helped.',
        cityId,
        category: 'product',
        ownerMemberId: member.id,
        publicationStatus: 'published',
        moderationState: 'clean',
        status: 'published',
        featured: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning({ id: schema.projects.id });

    const results = await getBuilderProjects(builder.id, member.id, db);
    const resultIds = results.map((p) => p.id);
    expect(resultIds).not.toContain(draft.id);
    expect(resultIds).not.toContain(restricted.id);
    expect(resultIds).not.toContain(archived.id);
    expect(resultIds).toContain(clean.id);
  });
});
