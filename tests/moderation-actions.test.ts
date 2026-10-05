/**
 * EVERY MODERATOR ACTION HAS TO DO WHAT ITS NAME SAYS.
 *
 * The moderation route shipped three broken actions because nothing asserted
 * any of them. This suite is one test per action per content type, and the
 * takedowns are asserted through the public projection — the function the
 * public page actually calls — rather than by reading the row back. Reading
 * the row back is what made the original bug invisible: `restore` wrote
 * `moderation_state = 'clean'` and the row looked restored, while every public
 * reader went on hiding it because `deleted_at` was still set.
 *
 * The two defects pinned here:
 *
 *   1. `restore` left the tombstone (`deleted_at`, `deleted_by`,
 *      `deletion_reason`) in place for projects and builders. A moderator
 *      could delete either one and the restore button would not bring it
 *      back. Live, not latent — both public predicates require
 *      `deleted_at IS NULL`.
 *   2. `archive` was accepted by the route and mapped by no branch, so the
 *      state column was written the empty string. Postgres refuses that for
 *      `moderation_state` and for `media_status`, and the uncaught throw
 *      became a bare 500. The archive button did not work for any type.
 *
 * Media's delete → restore round trip is asserted in
 * `tests/media-takedown.test.ts`, which owns the media read paths. What is
 * asserted here for media is the other half: that `archive` is refused rather
 * than written, because `media_status` has no `archived` value.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import * as schema from '../db/schema';
import { listPublicProjects } from '../src/server/public/projects';
import { getPublicBuilderList } from '../src/server/directory';
import {
  MODERATABLE_TYPES,
  MODERATION_ACTIONS,
  isModeratableType,
  isModerationAction,
  moderationRequest,
  moderationWrite,
  type ModerationAction,
  type ModeratableType,
} from '../admin/src/server/moderation';

let db: TestDatabase;
let cityId: string;
let n = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  const [city] = await db
    .insert(schema.cities)
    .values({
      slug: 'zz-moderation-city',
      name: 'Moderation City',
      region: 'Test',
      lat: 23,
      lon: 77,
      blurb: 'Fixture.',
      status: 'published',
    })
    .returning({ id: schema.cities.id });
  cityId = city.id;
}, 60_000);

afterAll(async () => {
  await db?.$close();
});

beforeEach(async () => {
  await db.delete(schema.projects);
  await db.delete(schema.builders);
  await db.delete(schema.media);
});

/** The actor column is a real FK, so the audit actor has to exist. */
const ACTOR: string | null = null;

/**
 * Applies a moderator action the way the route does: the columns
 * `moderationWrite()` returns, written to the row.
 *
 * A null write would mean the type does not support the action, which for
 * every call in this file would be the defect rather than the expectation, so
 * it throws rather than silently skipping the update.
 */
async function moderate(
  type: 'project' | 'builder',
  id: string,
  action: ModerationAction,
): Promise<void> {
  const write = moderationWrite(type, action, ACTOR);
  if (!write) throw new Error(`moderationWrite("${type}", "${action}") returned null`);
  const table = type === 'project' ? schema.projects : schema.builders;
  await db
    .update(table)
    .set(write.columns as never)
    .where(eq(table.id, id));
}

// ── fixtures ──────────────────────────────────────────────────────────────

async function publicProject(): Promise<{ id: string; slug: string }> {
  n += 1;
  const slug = `zz-moderation-project-${n}`;
  const [row] = await db
    .insert(schema.projects)
    .values({
      slug,
      title: `Moderation Project ${n}`,
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
    })
    .returning({ id: schema.projects.id });
  return { id: row.id, slug };
}

async function publicBuilder(): Promise<{ id: string; slug: string }> {
  n += 1;
  const slug = `zz-moderation-builder-${n}`;
  const [row] = await db
    .insert(schema.builders)
    .values({
      slug,
      name: `Moderation Builder ${n}`,
      cityId,
      role: 'Builds things',
      status: 'published',
      moderationState: 'clean',
    })
    .returning({ id: schema.builders.id });
  return { id: row.id, slug };
}

/** The slugs `/projects/` renders — `listPublicProjects()` is what it calls. */
async function publicProjectSlugs(): Promise<string[]> {
  const { items } = await listPublicProjects(db as never);
  return items.map((item) => item.slug);
}

/** The slugs `/builders/` renders. */
async function publicBuilderSlugs(): Promise<string[]> {
  const list = await getPublicBuilderList(db as never);
  return list.map((builder) => builder.slug);
}

/** The tombstone columns, as a shape a `toMatchObject` can read. */
async function tombstoneOf(
  type: 'project' | 'builder',
  id: string,
): Promise<{ deletedAt: Date | null; deletedBy: string | null; deletionReason: string | null }> {
  const table = type === 'project' ? schema.projects : schema.builders;
  const [row] = await db.select().from(table).where(eq(table.id, id));
  return { deletedAt: row.deletedAt, deletedBy: row.deletedBy, deletionReason: row.deletionReason };
}

// ── 1. the mapping, as a table ────────────────────────────────────────────

describe('moderationWrite()', () => {
  /**
   * The grid the route used to get wrong in two places at once. Every cell is
   * either a state the column can actually hold or an explicit refusal; the
   * one thing no cell may be is the empty string, which is what `archive`
   * wrote before and what Postgres refused.
   */
  const GRID: Record<ModeratableType, Record<ModerationAction, string | null>> = {
    project: { restrict: 'restricted', restore: 'clean', archive: 'archived', delete: 'removed' },
    builder: { restrict: 'restricted', restore: 'clean', archive: 'archived', delete: 'removed' },
    media: { restrict: 'deleted', restore: 'published', archive: null, delete: 'deleted' },
  };

  for (const type of MODERATABLE_TYPES) {
    for (const action of MODERATION_ACTIONS) {
      const expected = GRID[type][action];

      it(`maps ${action} on a ${type} to ${expected === null ? 'no write at all' : `"${expected}"`}`, () => {
        const write = moderationWrite(type, action, 'actor-1');

        if (expected === null) {
          // Media has no `archived` status. Declining is the whole fix: the
          // route turns this null into a 400 instead of writing `''`.
          expect(write).toBeNull();
          return;
        }

        expect(write?.state).toBe(expected);
        expect(write?.state).not.toBe('');

        // Written to the column that type actually has.
        const columns = write!.columns;
        if (type === 'media') {
          expect(columns.status).toBe(expected);
          expect(columns).not.toHaveProperty('moderationState');
        } else {
          expect(columns.moderationState).toBe(expected);
          expect(columns).not.toHaveProperty('status');
        }
      });
    }
  }

  it('sets the tombstone on a delete and clears it on a restore, for every type', () => {
    for (const type of MODERATABLE_TYPES) {
      expect(moderationWrite(type, 'delete', 'actor-1')?.columns).toMatchObject({
        deletedBy: 'actor-1',
        deletionReason: 'Moderator removed',
      });
      expect(moderationWrite(type, 'delete', 'actor-1')?.columns.deletedAt).toBeInstanceOf(Date);

      // The defect, stated as the property: a restore unsets every column a
      // delete sets. Nothing weaker is enough, because the public predicates
      // read `deleted_at` and not the state column alone.
      expect(moderationWrite(type, 'restore', 'actor-1')?.columns).toMatchObject({
        deletedAt: null,
        deletedBy: null,
        deletionReason: null,
      });
    }
  });

  it('leaves the tombstone alone for a hold, which is not a removal', () => {
    // `restrict` and `archive` move the state column and say nothing about
    // the tombstone, so archiving an already-deleted row does not quietly
    // claim to have undeleted it.
    for (const type of MODERATABLE_TYPES) {
      for (const action of ['restrict', 'archive'] as const) {
        const write = moderationWrite(type, action, 'actor-1');
        if (!write) continue; // media has no archive; covered above
        expect(write.columns).not.toHaveProperty('deletedAt');
        expect(write.columns).not.toHaveProperty('deletedBy');
        expect(write.columns).not.toHaveProperty('deletionReason');
      }
    }
  });

  it('names the audit action after what the moderator did', () => {
    // `from_status`/`to_status` record the enum values; this is the verb, and
    // it has to be the verb the moderator pressed. Media's `restrict` used to
    // be audited as `content.deleted` because the name was derived from the
    // resulting state, which for media is `deleted` either way.
    expect(moderationWrite('project', 'archive', null)?.auditAction).toBe('content.archived');
    expect(moderationWrite('builder', 'archive', null)?.auditAction).toBe('content.archived');
    expect(moderationWrite('media', 'restrict', null)?.auditAction).toBe('content.restricted');
    expect(moderationWrite('media', 'delete', null)?.auditAction).toBe('content.deleted');
    expect(moderationWrite('project', 'restore', null)?.auditAction).toBe('content.restored');
  });

  it('recognises exactly the types and actions the route accepts', () => {
    expect(isModeratableType('project')).toBe(true);
    expect(isModeratableType('city')).toBe(false);
    expect(isModerationAction('archive')).toBe(true);
    expect(isModerationAction('nuke')).toBe(false);
  });
});

// ── 2. what the route refuses before it touches the database ─────────────

describe('moderationRequest()', () => {
  const ID = '11111111-2222-3333-4444-555555555555';

  it('accepts a well-formed request and hands back the write', () => {
    const parsed = moderationRequest({ type: 'project', id: ID, action: 'archive' }, 'actor-1');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.write.state).toBe('archived');
    expect(parsed.id).toBe(ID);
  });

  /**
   * The 500 this issue was opened for, now a 400 a moderator can read.
   *
   * `media` + `archive` passed every check the route had, mapped to nothing,
   * and wrote `''` to `media_status`. Postgres refused it and the throw was
   * uncaught.
   */
  it('refuses archiving media, which has no archived status', () => {
    const parsed = moderationRequest({ type: 'media', id: ID, action: 'archive' }, 'actor-1');
    expect(parsed).toMatchObject({
      ok: false,
      status: 400,
      code: 'unsupported_action',
      error: 'A media cannot be archived.',
    });
  });

  it.each([
    ['a missing parameter', { type: 'project', action: 'restore' }, 'missing_parameters'],
    ['an unknown type', { type: 'city', id: ID, action: 'restore' }, 'invalid_type'],
    ['an unknown action', { type: 'project', id: ID, action: 'nuke' }, 'invalid_action'],
    // A non-uuid id used to reach Postgres and come back as a bare 500.
    ['a malformed id', { type: 'project', id: 'not-a-uuid', action: 'restore' }, 'invalid_id'],
    ['an empty id', { type: 'project', id: '', action: 'restore' }, 'missing_parameters'],
  ])('refuses %s with a 400 and a typed code', (_label, params, code) => {
    const parsed = moderationRequest(params, 'actor-1');
    expect(parsed).toMatchObject({ ok: false, status: 400, code });
  });

  it('never leaks a driver message or a stack in a refusal', () => {
    const parsed = moderationRequest({ type: 'media', id: ID, action: 'archive' }, 'actor-1');
    if (parsed.ok) throw new Error('expected a refusal');
    expect(parsed.error).not.toMatch(/invalid input value|enum|at Object\.|\n/);
  });
});

// ── 3. projects, through the public list ──────────────────────────────────

describe('a moderated project', () => {
  it('is public until something is done to it', async () => {
    const { slug } = await publicProject();
    expect(await publicProjectSlugs()).toEqual([slug]);
  });

  it('stops being public when restricted, archived or deleted', async () => {
    for (const action of ['restrict', 'archive', 'delete'] as const) {
      await db.delete(schema.projects);
      const { id, slug } = await publicProject();
      expect(await publicProjectSlugs()).toEqual([slug]);

      await moderate('project', id, action);
      expect(await publicProjectSlugs()).toEqual([]);
    }
  });

  /**
   * THE ONE-WAY DOOR, which is what this issue was opened for.
   *
   * `restore` wrote `moderation_state = 'clean'` and left `deleted_at` set.
   * `publicProjectWhere()` requires `deleted_at IS NULL`, so the project
   * never came back — and because the row read back as `clean`, it looked
   * like the restore had worked.
   */
  it('comes back when restored after a delete', async () => {
    const { id, slug } = await publicProject();

    await moderate('project', id, 'delete');
    expect(await publicProjectSlugs()).toEqual([]);
    expect((await tombstoneOf('project', id)).deletedAt).toBeInstanceOf(Date);

    await moderate('project', id, 'restore');
    expect(await publicProjectSlugs()).toEqual([slug]);
    expect(await tombstoneOf('project', id)).toEqual({
      deletedAt: null,
      deletedBy: null,
      deletionReason: null,
    });
  });

  it('comes back when restored after a restrict or an archive', async () => {
    for (const action of ['restrict', 'archive'] as const) {
      await db.delete(schema.projects);
      const { id, slug } = await publicProject();

      await moderate('project', id, action);
      expect(await publicProjectSlugs()).toEqual([]);

      await moderate('project', id, 'restore');
      expect(await publicProjectSlugs()).toEqual([slug]);
    }
  });

  it('keeps the row — a takedown hides, it does not destroy', async () => {
    const { id, slug } = await publicProject();
    await moderate('project', id, 'delete');

    const [row] = await db.select().from(schema.projects).where(eq(schema.projects.id, id));
    expect(row.slug).toBe(slug);
    expect(row.moderationState).toBe('removed');
  });
});

// ── 4. builders, through the public list ──────────────────────────────────

describe('a moderated builder', () => {
  it('is public until something is done to it', async () => {
    const { slug } = await publicBuilder();
    expect(await publicBuilderSlugs()).toEqual([slug]);
  });

  it('stops being public when restricted, archived or deleted', async () => {
    for (const action of ['restrict', 'archive', 'delete'] as const) {
      await db.delete(schema.builders);
      const { id, slug } = await publicBuilder();
      expect(await publicBuilderSlugs()).toEqual([slug]);

      await moderate('builder', id, action);
      expect(await publicBuilderSlugs()).toEqual([]);
    }
  });

  /** The same one-way door, on the second of the three copied branches. */
  it('comes back when restored after a delete', async () => {
    const { id, slug } = await publicBuilder();

    await moderate('builder', id, 'delete');
    expect(await publicBuilderSlugs()).toEqual([]);
    expect((await tombstoneOf('builder', id)).deletedAt).toBeInstanceOf(Date);

    await moderate('builder', id, 'restore');
    expect(await publicBuilderSlugs()).toEqual([slug]);
    expect(await tombstoneOf('builder', id)).toEqual({
      deletedAt: null,
      deletedBy: null,
      deletionReason: null,
    });
  });

  it('comes back when restored after a restrict or an archive', async () => {
    for (const action of ['restrict', 'archive'] as const) {
      await db.delete(schema.builders);
      const { id, slug } = await publicBuilder();

      await moderate('builder', id, action);
      expect(await publicBuilderSlugs()).toEqual([]);

      await moderate('builder', id, 'restore');
      expect(await publicBuilderSlugs()).toEqual([slug]);
    }
  });

  it('keeps the row', async () => {
    const { id, slug } = await publicBuilder();
    await moderate('builder', id, 'delete');

    const [row] = await db.select().from(schema.builders).where(eq(schema.builders.id, id));
    expect(row.slug).toBe(slug);
    expect(row.moderationState).toBe('removed');
  });
});

// ── 5. the enum values the database will actually accept ─────────────────

describe('what the state columns can hold', () => {
  /**
   * The fix for defect 2, asserted at the database rather than at the mapping
   * table, because the mapping table is the thing that could drift. Every
   * state `moderationWrite()` produces is written to a real column here; an
   * empty string — the old `archive` behaviour — fails this test.
   */
  it('accepts every moderation state the route can write', async () => {
    const { id } = await publicProject();
    for (const action of MODERATION_ACTIONS) {
      const write = moderationWrite('project', action, ACTOR);
      expect(write).not.toBeNull();
      await db
        .update(schema.projects)
        .set(write!.columns as never)
        .where(eq(schema.projects.id, id));
    }
  });

  it('accepts every media status the route can write', async () => {
    const [row] = await db
      .insert(schema.media)
      .values({ alt: 'Photograph', kind: 'photo' })
      .returning({ id: schema.media.id });

    for (const action of MODERATION_ACTIONS) {
      const write = moderationWrite('media', action, ACTOR);
      if (!write) {
        // `archive`. The route refuses the pair, so nothing is written and
        // there is no empty string for the enum to reject.
        expect(action).toBe('archive');
        continue;
      }
      await db
        .update(schema.media)
        .set(write.columns as never)
        .where(eq(schema.media.id, row.id));
    }
  });

  it('refuses the empty string the old archive branch wrote', async () => {
    // Proof that defect 2 was a real 500 and not a theory. This is the exact
    // statement the route used to run for `archive`.
    const { id } = await publicProject();
    await expect(
      db
        .update(schema.projects)
        .set({ moderationState: '' as never })
        .where(eq(schema.projects.id, id)),
    ).rejects.toThrow();
  });
});
