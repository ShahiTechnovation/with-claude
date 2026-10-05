/**
 * MEDIA CONSENT — the column says one thing, and the basis says how far it
 * reaches.
 *
 * `media.consent` records that the person shown in an image permitted it to be
 * published. `media.consent_basis` records how: `self_upload` (the subject
 * uploaded their own image) or `registration_terms` (the subject accepted the
 * event registration terms, which permit public web use with no end date).
 * Migration 0017 settled both and backfilled the rows that already existed.
 *
 * Two claims are tested, because they fail in different ways:
 *
 *   1. The import writes the pair on every event photograph, so rows arriving
 *      after 0017 cannot land at the `false` default and split one photograph
 *      set across two consent states.
 *   2. The backfill in 0017 targets event photographs by what they are, leaves
 *      everything else alone, and is safe to run twice.
 *
 * Claim 2 runs the migration's own SQL, read from the committed file, rather
 * than a re-typed copy of it — a test that agrees with a paraphrase of the
 * migration would pass while the migration was wrong.
 */
import { readFileSync } from 'node:fs';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import { importRecords, repositoryRecords } from '../db/import';
import * as schema from '../db/schema';
import { events } from '../src/data/events';

/** The two `UPDATE` statements of 0017, in file order. */
function backfillStatements(): string[] {
  const file = readFileSync('db/migrations/0017_media_consent_basis.sql', 'utf8');
  const statements = file
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.includes('UPDATE "media"'));
  expect(statements, 'two guarded backfills in 0017').toHaveLength(2);
  // The event photographs must be labelled before the self-uploads are, or the
  // second statement would catch them and call a registration-terms permission
  // a self-upload.
  expect(statements[0]).toContain('registration_terms');
  expect(statements[1]).toContain('self_upload');
  return statements;
}

describe('the import records the permission on every event photograph', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    await importRecords(db, repositoryRecords);
  }, 120_000);

  afterAll(async () => {
    await db?.$close();
  });

  it('every event photograph carries consent on the registration-terms basis', async () => {
    const rows = await db
      .select({
        path: schema.media.path,
        consent: schema.media.consent,
        basis: schema.media.consentBasis,
      })
      .from(schema.media)
      .where(eq(schema.media.kind, 'photo'));

    const declared = events.flatMap((event) => event.photos ?? []).length;
    expect(rows).toHaveLength(declared);
    expect(declared).toBeGreaterThan(0);

    for (const row of rows) {
      expect(row.path, 'an event photograph is addressed by its path').toMatch(/^events\//);
      expect(row.consent, row.path ?? '').toBe(true);
      expect(row.basis, row.path ?? '').toBe('registration_terms');
    }
  });

  it('leaves no media row with a permission and no basis', async () => {
    const orphans = await db
      .select({ path: schema.media.path, kind: schema.media.kind })
      .from(schema.media)
      .where(and(eq(schema.media.consent, true), isNull(schema.media.consentBasis)));
    expect(orphans).toEqual([]);
  });
});

describe('the 0017 backfill', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await db?.$close();
  });

  it('labels event photographs, labels self-uploads, and touches nothing else', async () => {
    const [member] = await db
      .insert(schema.members)
      .values({ privyUserId: 'did:privy:consent-test' })
      .returning({ id: schema.members.id });

    // A row per case the predicates have to tell apart.
    await db.insert(schema.media).values([
      { path: 'events/backfill-1.jpg', alt: 'A group at an event', kind: 'photo' },
      // A photo that is not an event photograph, and an event asset that is
      // not a photograph. Neither is covered by what the organiser answered.
      { path: 'cities/backfill-2.jpg', alt: 'A city', kind: 'photo' },
      { path: 'events/backfill-3.jpg', alt: 'An event cover', kind: 'cover' },
      // A member's own upload, already true since before 0017.
      {
        path: 'uploads/backfill-4.jpg',
        alt: 'A portrait',
        kind: 'portrait',
        consent: true,
        ownerMemberId: member.id,
      },
      // True, but owned by nobody: no basis can be inferred, so none is set.
      { path: 'uploads/backfill-5.jpg', alt: 'An orphan', kind: 'cover', consent: true },
    ]);

    const statements = backfillStatements();
    // Twice: the guards make the second run a no-op, which is the property
    // that lets this migration be re-applied to a database that has it.
    for (const pass of [1, 2]) {
      for (const statement of statements) await db.execute(sql.raw(statement));
      const rows = await db
        .select({
          path: schema.media.path,
          consent: schema.media.consent,
          basis: schema.media.consentBasis,
        })
        .from(schema.media);
      const byPath = new Map(rows.map((r) => [r.path, r]));

      expect(byPath.get('events/backfill-1.jpg'), `pass ${pass}`).toMatchObject({
        consent: true,
        basis: 'registration_terms',
      });
      expect(byPath.get('cities/backfill-2.jpg'), `pass ${pass}`).toMatchObject({
        consent: false,
        basis: null,
      });
      expect(byPath.get('events/backfill-3.jpg'), `pass ${pass}`).toMatchObject({
        consent: false,
        basis: null,
      });
      expect(byPath.get('uploads/backfill-4.jpg'), `pass ${pass}`).toMatchObject({
        consent: true,
        basis: 'self_upload',
      });
      expect(byPath.get('uploads/backfill-5.jpg'), `pass ${pass}`).toMatchObject({
        consent: true,
        basis: null,
      });
    }
  });
});
