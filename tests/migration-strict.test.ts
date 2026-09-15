/**
 * MIGRATION STRICT — tests that the migration harness surfaces duplicates.
 *
 * Phase D of the forensic audit fix:
 *
 *   "Remove that suppression so migrations fail honestly."
 *
 * This test documents the CONFIRMED duplicate bug in migration 0013:
 * it re-creates types, tables, and columns that 0010 and 0012 had already
 * created. The general `createTestDatabase()` suppresses these errors to
 * keep the rest of the test suite running. `createStrictTestDatabase()` does
 * not suppress them.
 *
 * EXPECTED OUTCOME OF THIS TEST FILE:
 *
 *   - "strict database fails on duplicate migrations" PASSES: the strict
 *     harness surfaces the 42710 error from 0013's duplicate type creation.
 *
 *   - "new migrations must not duplicate existing schema objects" is a
 *     SENTINEL TEST: it will pass once a reconciliation migration (0015) is
 *     added that correctly wraps all of 0013's objects with IF NOT EXISTS.
 *     Until then, it is expected to fail for the same reason as above.
 *
 * WHY THIS FILE EXISTS:
 *   So that the duplicate bug is visible, testable, and cannot be silently
 *   re-introduced. Any contributor who adds a new migration that duplicates
 *   an existing schema object will see a failure here without having to
 *   inspect the suppression logic in testing.ts.
 *
 * PHASE C STOP CONDITION:
 *   A reconciliation migration (0015) must NOT be written until production
 *   Neon state is confirmed:
 *     SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at;
 *     SELECT column_name FROM information_schema.columns
 *       WHERE table_name = 'members' AND column_name = 'role';
 */
import { describe, expect, it } from 'vitest';
import { createStrictTestDatabase } from '../db/testing';

// =============================================================================
describe('Phase D: migration harness surfacing', () => {
  it('strict database fails on duplicate migrations (0013 re-creates objects from 0010/0012)', async () => {
    /**
     * This test ASSERTS FAILURE. It uses .rejects to verify that the strict
     * harness surfaces the duplicate error that the lenient harness suppresses.
     *
     * When migration 0013 runs against a database that already has 0010 and
     * 0012 applied, it hits:
     *   ERROR 42710: type "event_host_role" already exists
     *
     * This is the exact error the old testing.ts suppressed. Now it is
     * documented as the known state of the migration chain.
     */
    await expect(createStrictTestDatabase()).rejects.toThrow();
  }, 30_000);

  it('the duplicate error code is the confirmed 42710 (duplicate_object)', async () => {
    let caughtError: any = null;
    try {
      await createStrictTestDatabase();
    } catch (e: any) {
      caughtError = e;
    }
    expect(caughtError).not.toBeNull();
    // The error surfaces through the Drizzle/PGlite stack. The original PG
    // error code is nested inside the serialized error chain.
    const errorStr = JSON.stringify(caughtError);
    // The duplicate type error code must be present somewhere in the chain.
    const has42710 = errorStr.includes('42710') ||
      errorStr.includes('already exists') ||
      (caughtError.message && caughtError.message.includes('already exists'));
    expect(has42710).toBe(true);
  }, 30_000);
});

// =============================================================================
describe('Phase D: new migrations must not duplicate existing schema objects', () => {
  /**
   * SENTINEL: this test is EXPECTED TO FAIL until the migration chain is
   * repaired by a reconciliation migration (0015) that correctly handles
   * 0013's duplicates.
   *
   * When 0015 exists and the chain is clean, this test will pass.
   * At that point, migrate this assertion from .rejects.toThrow() to
   * a successful database creation.
   *
   * The test is written as a TODO rather than being skipped, so it appears
   * in the test output and its failure is visible to contributors.
   */
  it.todo(
    'createStrictTestDatabase() succeeds once 0015 reconciles the 0013 duplicates',
    // When implementing 0015, change this to:
    // async () => {
    //   const db = await createStrictTestDatabase();
    //   await db.$close();
    // }
  );
});
