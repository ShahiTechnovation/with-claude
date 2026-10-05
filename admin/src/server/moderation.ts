/**
 * WHAT A MODERATOR ACTION WRITES TO A MEDIA ROW.
 *
 * Two columns, two different jobs, and the bug this module exists to stop is
 * what happens when only one of them is maintained:
 *
 *   `status`      the editorial lifecycle — `published` or `deleted`
 *   `deleted_at`  the tombstone, with `deleted_by` and `deletion_reason`
 *
 * A delete writes both. A restore used to write back only `status`, leaving
 * the tombstone in place, so a restored row came back as `published` with
 * `deleted_at` still set. That state is a contradiction, and every reader
 * that honours the tombstone — `publicCover()`, `loadRecordSet()` — goes on
 * hiding the image. A moderator could take a photograph down and never put
 * it back.
 *
 * The rule, then: fix the writer that creates the contradictory state rather
 * than weaken the readers to tolerate it. A restore clears the tombstone.
 *
 * This lives outside the route handler because that is the only way a test
 * can reach it — `tests/media-takedown.test.ts` asserts the whole
 * delete → restore → renders round trip against a real database.
 *
 * MEDIA ONLY, and deliberately so. The identical restore bug on projects and
 * builders is live rather than latent, and `archive` writes an empty string
 * to an enum column for every content type; both are being fixed on their
 * own issue rather than smuggled in behind this one. `null` here is how this
 * module says "not mine" and leaves the caller's existing path alone.
 */

/** The moderator actions this module speaks for. */
export type MediaModerationAction = 'restrict' | 'restore' | 'delete';

export type MediaModerationPatch = {
  status: 'published' | 'deleted';
  updatedAt: Date;
  deletedAt?: Date | null;
  deletedBy?: string | null;
  deletionReason?: string | null;
};

/**
 * The columns a moderator action sets on a media row, or `null` for an
 * action this module does not handle.
 *
 * `restore` unsets every tombstone column `delete` sets, which is the whole
 * property that makes a takedown reversible. `restrict` is a hold rather
 * than a removal and writes no tombstone, exactly as it did before.
 */
export function mediaModerationPatch(
  action: string,
  actorId: string | null,
  now = new Date(),
): MediaModerationPatch | null {
  switch (action) {
    case 'delete':
      return {
        status: 'deleted',
        updatedAt: now,
        deletedAt: now,
        deletedBy: actorId,
        deletionReason: 'Moderator removed',
      };
    case 'restrict':
      return { status: 'deleted', updatedAt: now };
    case 'restore':
      return {
        status: 'published',
        updatedAt: now,
        deletedAt: null,
        deletedBy: null,
        deletionReason: null,
      };
    default:
      return null;
  }
}
