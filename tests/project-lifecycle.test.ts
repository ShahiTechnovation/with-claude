/**
 * PROJECT LIFECYCLE, PERMISSIONS, MODERATION, COVERS AND PUBLIC READS.
 *
 * The Phase A correctness suite. Every assertion here is a defect that was
 * reproduced in code before it was fixed:
 *
 *   · a contributor could archive/restore the owner's project
 *   · archive/restore moved `publicationStatus` but not the legacy `status`,
 *     and wrote no audit row
 *   · moderation "restore" published a moderated draft
 *   · moderation "remove" overwrote `publicationStatus` with `deleted`
 *   · admin publish/archive of a project moved only `status`
 *   · any string could be set as a cover via `imagePath`
 *   · the detail page admitted `reported`; "Built at" never resolved
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import * as schema from '../db/schema';
import { provisionMember, ensureProfileShell, type Member } from '../src/server/auth/member';
import {
  can,
  isPublicProject,
  legacyStatusFor,
  projectAccess,
  publicationStatusForLegacy,
  transitionProject,
} from '../src/server/projects/lifecycle';
import { moderateBuilder, moderateProject } from '../src/server/moderation';
import {
  isProjectBlobUrl,
  publishProjectCover,
  recordCoverUpload,
  resolveCoverChoice,
} from '../src/server/media/covers';
import {
  getProjectDetail,
  listPublicProjects,
  normaliseDirectoryQuery,
  publicCover,
  publicProjectsForEvent,
  relatedPublicProjects,
} from '../src/server/public/projects';
import { projectPublicationFor } from '../admin/src/server/publishing';

let db: TestDatabase;
let cityId: string;
let eventId: string;
let n = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  const [city] = await db
    .insert(schema.cities)
    .values({
      slug: 'zz-life-city',
      name: 'Life City',
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
      slug: 'zz-life-buildday',
      title: 'Life Build Day',
      format: 'hackathon',
      cityId,
      date: '2026-03-14',
      startTime: '10:00',
      venueName: 'Somewhere',
      summary: 'A build day.',
      status: 'published',
    })
    .returning({ id: schema.events.id });
  eventId = event.id;
}, 60_000);

afterAll(async () => {
  await db?.$close();
});

beforeEach(async () => {
  await db.delete(schema.media);
  await db.delete(schema.projectCredits);
  await db.delete(schema.projectBuilders);
  await db.delete(schema.projectMembers);
  await db.delete(schema.projects);
});

async function member(): Promise<Member> {
  n += 1;
  const { member } = await provisionMember(`did:privy:life-${n}-${Date.now()}`, db);
  await ensureProfileShell(member, db);
  return member;
}

async function project(
  owner: Member | null,
  overrides: Partial<typeof schema.projects.$inferInsert> = {},
): Promise<string> {
  n += 1;
  const [row] = await db
    .insert(schema.projects)
    .values({
      ownerMemberId: owner?.id ?? null,
      slug: `zz-life-${n}`,
      title: `Life ${n}`,
      summary: 'A complete tagline.',
      description: 'What it does.',
      claudeUsage: 'Claude wrote the parser.',
      category: 'product',
      cityId,
      contentAuthority: owner ? 'member' : 'curated',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    })
    .returning({ id: schema.projects.id });
  return row.id;
}

async function addMember(projectId: string, m: Member, role: 'collaborator' | 'contributor') {
  await db.insert(schema.projectMembers).values({ projectId, memberId: m.id, role });
}

async function state(id: string) {
  const [row] = await db
    .select({
      publicationStatus: schema.projects.publicationStatus,
      status: schema.projects.status,
      moderationState: schema.projects.moderationState,
      publishedAt: schema.projects.publishedAt,
    })
    .from(schema.projects)
    .where(eq(schema.projects.id, id));
  return row;
}

// ── the matrix ──────────────────────────────────────────────────────────

describe('permission matrix', () => {
  it('owner can do everything; collaborator edits; contributor only reads', () => {
    for (const action of ['read', 'edit', 'upload_media', 'publish', 'archive', 'restore'] as const) {
      expect(can('owner', action)).toBe(true);
    }
    expect(can('collaborator', 'edit')).toBe(true);
    expect(can('collaborator', 'upload_media')).toBe(true);
    expect(can('collaborator', 'publish')).toBe(false);
    expect(can('collaborator', 'archive')).toBe(false);
    expect(can('collaborator', 'manage_collaborators')).toBe(false);
    expect(can('contributor', 'read')).toBe(true);
    expect(can('contributor', 'edit')).toBe(false);
    expect(can('contributor', 'archive')).toBe(false);
    expect(can(null, 'read')).toBe(false);
  });

  it('resolves roles from the database, and strangers get null', async () => {
    const owner = await member();
    const collab = await member();
    const credit = await member();
    const stranger = await member();
    const id = await project(owner);
    await addMember(id, collab, 'collaborator');
    await addMember(id, credit, 'contributor');

    expect((await projectAccess(owner.id, id, db))?.role).toBe('owner');
    expect((await projectAccess(collab.id, id, db))?.role).toBe('collaborator');
    expect((await projectAccess(credit.id, id, db))?.role).toBe('contributor');
    expect(await projectAccess(stranger.id, id, db)).toBeNull();
    expect(await projectAccess(owner.id, 'not-a-uuid', db)).toBeNull();
  });
});

// ── transitions ─────────────────────────────────────────────────────────

describe('transitionProject', () => {
  it('a contributor cannot archive, and a collaborator cannot publish', async () => {
    const owner = await member();
    const collab = await member();
    const credit = await member();
    const id = await project(owner, { publicationStatus: 'published', status: 'published' });
    await addMember(id, collab, 'collaborator');
    await addMember(id, credit, 'contributor');

    const byContributor = await transitionProject(db, credit.id, id, 'archive');
    expect(byContributor).toMatchObject({ ok: false, status: 403 });
    const byCollaborator = await transitionProject(db, collab.id, id, 'archive');
    expect(byCollaborator).toMatchObject({ ok: false, status: 403 });
    expect((await state(id)).publicationStatus).toBe('published');
  });

  it('keeps the legacy status in step and audits before/after in one transaction', async () => {
    const owner = await member();
    const id = await project(owner);

    const published = await transitionProject(db, owner.id, id, 'publish');
    expect(published).toMatchObject({ ok: true, from: 'draft', to: 'published' });
    let s = await state(id);
    expect(s).toMatchObject({ publicationStatus: 'published', status: 'published' });
    const firstPublishedAt = s.publishedAt;
    expect(firstPublishedAt).toBeInstanceOf(Date);

    expect(await transitionProject(db, owner.id, id, 'archive')).toMatchObject({ ok: true });
    s = await state(id);
    expect(s).toMatchObject({ publicationStatus: 'archived', status: 'archived' });

    expect(await transitionProject(db, owner.id, id, 'restore')).toMatchObject({
      ok: true,
      to: 'draft',
    });
    s = await state(id);
    expect(s).toMatchObject({ publicationStatus: 'draft', status: 'draft' });

    await transitionProject(db, owner.id, id, 'publish');
    s = await state(id);
    // First publication date is kept; "newest" does not reward churn.
    expect(s.publishedAt?.getTime()).toBe(firstPublishedAt?.getTime());

    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.entityType, 'project'), eq(schema.auditLog.entityId, id)));
    expect(audit.map((a) => a.action)).toEqual([
      'project.published',
      'project.archived',
      'project.restored',
      'project.published',
    ]);
    expect(audit[1].before).toMatchObject({ publicationStatus: 'published' });
    expect(audit[1].after).toMatchObject({ publicationStatus: 'archived', status: 'archived' });
  });

  it('refuses an invalid from-state without writing an audit row', async () => {
    const owner = await member();
    const id = await project(owner);
    expect(await transitionProject(db, owner.id, id, 'restore')).toMatchObject({
      ok: false,
      status: 409,
    });
    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, id));
    expect(audit).toHaveLength(0);
  });

  it('publishing is not a way out of moderation', async () => {
    const owner = await member();
    const id = await project(owner, { moderationState: 'restricted' });
    expect(await transitionProject(db, owner.id, id, 'publish')).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it('a member cannot transition content the organisers own', async () => {
    const owner = await member();
    const id = await project(owner, { contentAuthority: 'baserow' });
    expect(await transitionProject(db, owner.id, id, 'publish')).toMatchObject({
      ok: false,
      status: 409,
    });
  });

  it('a precheck refusal writes nothing', async () => {
    const owner = await member();
    const id = await project(owner);
    const result = await transitionProject(db, owner.id, id, 'publish', {
      precheck: async () => ({ ok: false, status: 422, error: 'nope' }),
    });
    expect(result).toMatchObject({ ok: false, status: 422 });
    expect((await state(id)).publicationStatus).toBe('draft');
  });
});

describe('legacy status compatibility mapping', () => {
  it('round-trips the public states', () => {
    for (const p of ['draft', 'published', 'archived'] as const) {
      expect(publicationStatusForLegacy(legacyStatusFor(p))).toBe(p);
    }
    expect(legacyStatusFor('deleted')).toBe('archived');
  });

  it('the admin editorial path uses the same mapping', () => {
    for (const status of schema.contentStatus.enumValues) {
      expect(projectPublicationFor('project', status).publicationStatus).toBe(
        publicationStatusForLegacy(status),
      );
    }
    expect(projectPublicationFor('builder', 'published')).toEqual({});
  });
});

// ── moderation ──────────────────────────────────────────────────────────

describe('moderation preserves publication state', () => {
  it('restoring a moderated DRAFT leaves it a draft', async () => {
    const owner = await member();
    const mod = await member();
    const id = await project(owner);
    expect(await moderateProject(id, 'hide', mod.id, db)).toMatchObject({ ok: true });
    expect(await moderateProject(id, 'restore', mod.id, db)).toMatchObject({ ok: true });
    expect(await state(id)).toMatchObject({ publicationStatus: 'draft', moderationState: 'clean' });
  });

  it('remove does not overwrite publication, so restore returns it as it was', async () => {
    const owner = await member();
    const mod = await member();
    const id = await project(owner, { publicationStatus: 'published', status: 'published' });
    await moderateProject(id, 'remove', mod.id, db);
    expect(await state(id)).toMatchObject({ publicationStatus: 'published', moderationState: 'removed' });
    await moderateProject(id, 'restore', mod.id, db);
    expect(await state(id)).toMatchObject({ publicationStatus: 'published', moderationState: 'clean' });
  });

  it('a deleted project stays deleted after a moderation restore', async () => {
    const owner = await member();
    const mod = await member();
    const id = await project(owner, { publicationStatus: 'deleted', moderationState: 'removed' });
    await moderateProject(id, 'restore', mod.id, db);
    expect((await state(id)).publicationStatus).toBe('deleted');
  });

  it('a repeated restore is refused rather than double-audited', async () => {
    const owner = await member();
    const mod = await member();
    const id = await project(owner);
    await moderateProject(id, 'hide', mod.id, db);
    await moderateProject(id, 'restore', mod.id, db);
    expect(await moderateProject(id, 'restore', mod.id, db)).toMatchObject({ ok: false, status: 409 });
    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, id));
    expect(audit.filter((a) => a.action === 'project.moderation.restore')).toHaveLength(1);
  });

  it('builder restore keeps the builder unpublished if it was', async () => {
    const mod = await member();
    const [b] = await db
      .insert(schema.builders)
      .values({ slug: `zz-life-b-${Date.now()}`, name: 'B', cityId, role: 'Builder', status: 'draft' })
      .returning({ id: schema.builders.id });
    await moderateBuilder(b.id, 'hide', mod.id, db);
    await moderateBuilder(b.id, 'restore', mod.id, db);
    const [row] = await db.select().from(schema.builders).where(eq(schema.builders.id, b.id));
    expect(row).toMatchObject({ status: 'draft', moderationState: 'clean' });
  });
});

// ── covers ──────────────────────────────────────────────────────────────

describe('cover media authority', () => {
  const store = 'https://abc123.public.blob.vercel-storage.com';

  it('accepts only Blob URLs under the project prefix', () => {
    const id = '11111111-1111-1111-1111-111111111111';
    expect(isProjectBlobUrl(`${store}/projects/${id}/cover.png`, id)).toBe(true);
    expect(isProjectBlobUrl(`${store}/projects/other/cover.png`, id)).toBe(false);
    expect(isProjectBlobUrl(`https://evil.example/projects/${id}/x.png`, id)).toBe(false);
    expect(isProjectBlobUrl(`http://abc.public.blob.vercel-storage.com/projects/${id}/x.png`, id)).toBe(false);
    expect(isProjectBlobUrl(`${store}/projects/${id}/x.png?redirect=1`, id)).toBe(false);
  });

  it('records idempotently, attaches only own-project media, publishes with the project', async () => {
    const owner = await member();
    const id = await project(owner);
    const other = await project(owner);
    const facts = {
      url: `${store}/projects/${id}/cover-a.png`,
      pathname: `projects/${id}/cover-a.png`,
      contentType: 'image/png',
      size: 1000,
    };
    const first = await recordCoverUpload(db, { memberId: owner.id, projectId: id, alt: 'x', facts });
    const second = await recordCoverUpload(db, { memberId: owner.id, projectId: id, alt: 'x', facts });
    expect(first.ok && second.ok && first.mediaId === second.mediaId).toBe(true);
    if (!first.ok) throw new Error('unreachable');

    // Media for THIS project cannot be attached to ANOTHER project.
    expect(await resolveCoverChoice(db, other, first.mediaId)).toMatchObject({ ok: false });
    const attach = await resolveCoverChoice(db, id, first.mediaId);
    expect(attach).toMatchObject({ ok: true, imageId: first.mediaId, imagePath: facts.url });

    await db.update(schema.projects).set({ imageId: first.mediaId, imagePath: facts.url }).where(eq(schema.projects.id, id));
    await publishProjectCover(db as never, id);
    const [m] = await db.select().from(schema.media).where(eq(schema.media.id, first.mediaId));
    expect(m.status).toBe('published');
  });

  it('refuses wrong types and oversize files', async () => {
    const owner = await member();
    const id = await project(owner);
    const base = { url: `${store}/projects/${id}/c.svg`, pathname: 'p', size: 10 };
    expect(
      await recordCoverUpload(db, { memberId: owner.id, projectId: id, alt: 'x', facts: { ...base, contentType: 'image/svg+xml' } }),
    ).toMatchObject({ ok: false, status: 422 });
    expect(
      await recordCoverUpload(db, { memberId: owner.id, projectId: id, alt: 'x', facts: { ...base, contentType: 'image/png', size: 6 * 1024 * 1024 } }),
    ).toMatchObject({ ok: false, status: 422 });
  });

  it('public readers never render an arbitrary URL or a staged upload', () => {
    expect(publicCover({ imagePath: 'https://evil.example/x.png', mediaUrl: null, mediaStatus: null })).toBeUndefined();
    expect(publicCover({ imagePath: 'javascript:alert(1)', mediaUrl: null, mediaStatus: null })).toBeUndefined();
    expect(publicCover({ imagePath: 'x', mediaUrl: `${store}/a.png`, mediaStatus: 'staged' })).toBeUndefined();
    expect(publicCover({ imagePath: null, mediaUrl: `${store}/a.png`, mediaStatus: 'published' })).toBe(`${store}/a.png`);
    expect(publicCover({ imagePath: 'covers/cover-vol01.jpg', mediaUrl: null, mediaStatus: null })).toBe('covers/cover-vol01.jpg');
  });
});

// ── public reads ────────────────────────────────────────────────────────

describe('public project reads', () => {
  it('resolves Built-at through the event UUID, and agrees with the event list', async () => {
    const owner = await member();
    const id = await project(owner, { publicationStatus: 'published', builtAtEventId: eventId });
    const [row] = await db.select({ slug: schema.projects.slug }).from(schema.projects).where(eq(schema.projects.id, id));
    const detail = await getProjectDetail(db, row.slug);
    expect(detail?.event).toMatchObject({ slug: 'zz-life-buildday', date: '2026-03-14' });
    const forEvent = await publicProjectsForEvent(db, eventId);
    expect(forEvent.map((p) => p.id)).toEqual([id]);
  });

  it('a reported, restricted, draft or deleted project is not public anywhere', async () => {
    const owner = await member();
    const visible = await project(owner, { publicationStatus: 'published' });
    await project(owner, { publicationStatus: 'published', moderationState: 'reported' });
    await project(owner, { publicationStatus: 'published', moderationState: 'restricted' });
    await project(owner, { publicationStatus: 'draft' });
    await project(owner, { publicationStatus: 'published', deletedAt: new Date() });

    const list = await listPublicProjects(db, {});
    expect(list.items.map((p) => p.id)).toEqual([visible]);
    expect(list.total).toBe(1);

    const rows = await db.select({ slug: schema.projects.slug, id: schema.projects.id }).from(schema.projects);
    for (const r of rows) {
      const d = await getProjectDetail(db, r.slug);
      expect(d?.isPublic).toBe(r.id === visible);
    }
  });

  it('filters, counts and paginates on the server with a stable order', async () => {
    const owner = await member();
    for (let i = 0; i < 5; i += 1) {
      await project(owner, {
        publicationStatus: 'published',
        category: i % 2 ? 'agent' : 'product',
        title: `Page ${i}`,
        publishedAt: new Date(2026, 0, i + 1),
      });
    }
    const page1 = await listPublicProjects(db, { sort: 'recent', pageSize: 2, page: 1 });
    const page2 = await listPublicProjects(db, { sort: 'recent', pageSize: 2, page: 2 });
    const page3 = await listPublicProjects(db, { sort: 'recent', pageSize: 2, page: 3 });
    expect(page1.total).toBe(5);
    expect(page1.pageCount).toBe(3);
    const all = [...page1.items, ...page2.items, ...page3.items].map((p) => p.title);
    expect(all).toEqual(['Page 4', 'Page 3', 'Page 2', 'Page 1', 'Page 0']);

    const agents = await listPublicProjects(db, { categories: ['agent'] });
    expect(agents.total).toBe(2);
    expect(agents.facets.categories).toEqual(
      expect.arrayContaining([
        { value: 'agent', label: 'agent', count: 2 },
        { value: 'product', label: 'product', count: 3 },
      ]),
    );
  });

  it('the row predicate agrees with the SQL predicate', () => {
    expect(isPublicProject({ publicationStatus: 'published', moderationState: 'clean', deletedAt: null })).toBe(true);
    expect(isPublicProject({ publicationStatus: 'published', moderationState: 'reported' })).toBe(false);
    expect(isPublicProject({ publicationStatus: 'published', moderationState: 'clean', deletedAt: new Date() })).toBe(false);
  });

  it('related projects work with and without an event (no constant ORDER BY)', async () => {
    const owner = await member();
    const a = await project(owner, { publicationStatus: 'published' });
    const b = await project(owner, { publicationStatus: 'published' });
    const withEvent = await project(owner, { publicationStatus: 'published', builtAtEventId: eventId });
    const noEvent = await relatedPublicProjects(db, { id: a, event: null, city: { slug: 'zz-life-city' } });
    expect(noEvent.map((p) => p.id).sort()).toEqual([b, withEvent].sort());
    const fromEvent = await relatedPublicProjects(db, { id: a, event: { slug: 'zz-life-buildday' }, city: { slug: 'zz-life-city' } });
    expect(fromEvent[0].id).toBe(withEvent);
    expect(await relatedPublicProjects(db, { id: a, event: null, city: null })).toEqual([]);
  });

  it('treats search text literally', async () => {
    const owner = await member();
    await project(owner, { publicationStatus: 'published', title: '100% offline' });
    await project(owner, { publicationStatus: 'published', title: 'Something else' });
    expect((await listPublicProjects(db, { q: '%' })).total).toBe(1);
    expect((await listPublicProjects(db, { q: 'offline' })).total).toBe(1);
  });

  it('normalises untrusted query strings', () => {
    const q = normaliseDirectoryQuery(
      new URLSearchParams('category=nope&city=Bad Slug&event=ok-1&sort=evil&page=-4&q=  hi  '),
    );
    expect(q).toEqual({ q: 'hi', events: ['ok-1'], categories: [], cities: [], statuses: [], has: [], sort: 'event', page: 1 });
    // The old sort name still works for shared links.
    expect(normaliseDirectoryQuery(new URLSearchParams('sort=newest')).sort).toBe('recent');
  });

  it('credits: archived builders are not credited, pending are unlinked, organiser credits are names', async () => {
    const owner = await member();
    const id = await project(owner, { publicationStatus: 'published' });
    const mk = (slug: string, status: 'published' | 'pending' | 'archived') =>
      db
        .insert(schema.builders)
        .values({ slug, name: slug, cityId, role: 'Builder', status })
        .returning({ id: schema.builders.id });
    const [pub] = await mk(`zz-pub-${n}`, 'published');
    const [pend] = await mk(`zz-pend-${n}`, 'pending');
    const [arch] = await mk(`zz-arch-${n}`, 'archived');
    await db.insert(schema.projectBuilders).values([
      { projectId: id, builderId: pub.id, position: 0 },
      { projectId: id, builderId: pend.id, position: 1 },
      { projectId: id, builderId: arch.id, position: 2 },
    ]);
    await db.insert(schema.projectCredits).values({ projectId: id, displayName: 'Team Mate', role: 'Design', position: 3 });

    const [row] = await db.select({ slug: schema.projects.slug }).from(schema.projects).where(eq(schema.projects.id, id));
    const detail = await getProjectDetail(db, row.slug);
    expect(detail?.credits).toEqual([
      { name: `zz-pub-${n}`, href: `/builders/zz-pub-${n}/` },
      { name: `zz-pend-${n}` },
      { name: 'Team Mate', role: 'Design' },
    ]);
  });
});
