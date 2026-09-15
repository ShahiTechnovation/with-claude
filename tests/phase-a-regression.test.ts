/**
 * PHASE A — proof that nothing that already worked stopped working.
 *
 * Migration 0006 adds two columns to `builders`, and `builders` is the table
 * the entire public site renders from. The equivalence suites already compare
 * the whole record set between sources; what this file adds is the specific
 * question those cannot ask, because they run before and after the same
 * migration: does the READER ignore the new columns, and do the defaults leave
 * every existing row exactly as it was?
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, isNull, sql } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import * as schema from '../db/schema';
import { loadRecordSet } from '../src/data/source-db';
import { provisionMember, ensureProfileShell } from '../src/server/auth/member';
import { publishProfile } from '../src/server/members/publish';

let db: TestDatabase;
let cityId: string;

const noDeploy = async () => {};

beforeAll(async () => {
  db = await createTestDatabase();
  const [city] = await db
    .insert(schema.cities)
    .values({
      slug: 'zz-city',
      name: 'ZZ City',
      region: 'ZZ Region',
      lat: 23.25,
      lon: 77.41,
      blurb: 'A disposable fixture.',
      status: 'published',
    })
    .returning({ id: schema.cities.id });
  cityId = city.id;

  // Three rows standing in for the shapes production actually holds: a
  // published legacy builder, a pending one (whose NAME is still a credit),
  // and an archived one (a takedown, which must stay out of the record set).
  await db.insert(schema.builders).values([
    { slug: 'zz-legacy-published', name: 'ZZ Legacy Published', cityId, role: 'Builder', status: 'published' },
    { slug: 'zz-legacy-pending', name: 'ZZ Legacy Pending', cityId, role: 'Builder', status: 'pending' },
    { slug: 'zz-legacy-archived', name: 'ZZ Legacy Archived', cityId, role: 'Builder', status: 'archived' },
  ]);
});

afterAll(async () => {
  await db?.$close();
});

describe('the migration leaves existing rows alone', () => {
  it('defaults every existing builder to unowned', async () => {
    const rows = await db
      .select({ slug: schema.builders.slug, owner: schema.builders.ownerMemberId })
      .from(schema.builders);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.owner).toBeNull();
  });

  it('defaults every existing builder to source = legacy', async () => {
    const rows = await db.select({ source: schema.builders.source }).from(schema.builders);
    for (const row of rows) expect(row.source).toBe('legacy');
  });

  it('leaves the ambassador CHECK in force', async () => {
    await expect(
      db.insert(schema.builders).values({
        slug: 'zz-self-ambassador',
        name: 'ZZ Self Ambassador',
        cityId,
        role: 'Builder',
        roles: ['ambassador'],
        status: 'published',
      }),
    ).rejects.toThrow();
  });
});

describe('the public reader is unaffected by the new columns', () => {
  it('still loads pending builders, because a name is still a credit', async () => {
    const records = await loadRecordSet(db);
    const slugs = records.builders.map((b) => b.slug);
    expect(slugs).toContain('zz-legacy-pending');
  });

  it('still excludes an archived builder — a takedown is a takedown', async () => {
    const records = await loadRecordSet(db);
    const slugs = records.builders.map((b) => b.slug);
    expect(slugs).not.toContain('zz-legacy-archived');
  });

  /**
   * The `Builder` shape is what every page and the search index read. A new
   * database column leaking into it would change the public record's shape
   * without anybody deciding to.
   */
  it('does not leak owner_member_id or source into the rendered record', async () => {
    const records = await loadRecordSet(db);
    const builder = records.builders.find((b) => b.slug === 'zz-legacy-published');
    expect(builder).toBeDefined();
    expect(builder).not.toHaveProperty('ownerMemberId');
    expect(builder).not.toHaveProperty('owner_member_id');
    expect(builder).not.toHaveProperty('source');
  });
});

describe('a member-published profile joins the same record set', () => {
  it('appears exactly like any other published builder', async () => {
    const { member } = await provisionMember('did:privy:zz-regression', db);
    await ensureProfileShell(member, db);
    await db
      .update(schema.memberProfiles)
      .set({ username: 'zz-new-member', displayName: 'ZZ New Member', primaryRole: 'Developer', cityId })
      .where(eq(schema.memberProfiles.memberId, member.id));

    await publishProfile(member, db, noDeploy);

    const records = await loadRecordSet(db);
    const published = records.builders.find((b) => b.slug === 'zz-new-member');

    expect(published).toBeDefined();
    expect(published?.name).toBe('ZZ New Member');
    expect(published?.citySlug).toBe('zz-city');
    // Same shape as a legacy record — the reader cannot tell them apart, which
    // is what lets the static pages and the search index stay unchanged.
    expect(published).not.toHaveProperty('source');
  });

  it('does not disturb the legacy rows around it', async () => {
    const records = await loadRecordSet(db);
    const legacy = records.builders.find((b) => b.slug === 'zz-legacy-published');
    expect(legacy?.name).toBe('ZZ Legacy Published');

    const unowned = await db
      .select({ slug: schema.builders.slug })
      .from(schema.builders)
      .where(isNull(schema.builders.ownerMemberId));
    expect(unowned.map((r) => r.slug)).toContain('zz-legacy-published');
  });
});

describe('the two identity systems stay separate', () => {
  it('members and users are different tables with no reference between them', async () => {
    const columns = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'members'
    `);
    const names = (columns.rows as { column_name: string }[]).map((r) => r.column_name);

    // Nothing in `members` points at the admin allowlist.
    // Role is now explicitly allowed for moderation
    expect(names).not.toContain('user_id');
    expect(names.sort()).toEqual(
      [
        'created_at',
        'deleted_at',
        'deleted_by',
        'deletion_reason',
        'id',
        'last_seen_at',
        'privy_user_id',
        'role',
        'status',
        'updated_at',
      ].sort(),
    );
  });

  it('gives a member no role or capability column to escalate through (except the authorized role column)', async () => {
    const columns = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name IN ('members', 'member_profiles')
    `);
    const names = (columns.rows as { column_name: string }[]).map((r) => r.column_name);

    for (const forbidden of ['is_admin', 'verified', 'featured', 'trust_level']) {
      expect(names).not.toContain(forbidden);
    }
  });
});
