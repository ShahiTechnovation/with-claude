/**
 * WHAT A MODERATOR ACTION WRITES.
 *
 * One table for all three moderatable content types, because the moderation
 * route used to be three hand-copied branches and every bug in it was present
 * in two or three places at once:
 *
 *   - `restore` wrote the state column back and left the tombstone set, so a
 *     deleted row came back as `clean`/`published` with `deleted_at` still
 *     populated. Every reader that honours the tombstone — `publicProjectWhere()`,
 *     `loadRecordSet()`, `publicCover()` — went on hiding it. A moderator
 *     could take a project, a builder or a photograph down and never put it
 *     back. Three copies of the branch, three copies of the bug.
 *   - `archive` was accepted by the route and mapped by no branch, so the
 *     state column was written the empty string. Postgres refuses that for
 *     both enums, the transaction threw, and the moderator got a bare 500.
 *
 * Two kinds of column, two different jobs, and the contradiction the first bug
 * created is what happens when only one of them is maintained:
 *
 *   state         the editorial/moderation lifecycle. `moderation_state` on
 *                 projects and builders, `status` on media.
 *   `deleted_at`  the tombstone, with `deleted_by` and `deletion_reason`
 *
 * A delete writes both. A restore must unset both. That property — a takedown
 * is reversible — is the whole reason this module exists, and the rule behind
 * it is: fix the writer that creates the contradictory state rather than
 * weaken the readers to tolerate it.
 *
 * This lives outside the route handler because that is the only way a test can
 * reach it. `tests/moderation-actions.test.ts` asserts every action against a
 * real database and, for the takedowns, through the public projection rather
 * than by reading the row back.
 */

export const MODERATABLE_TYPES = ['project', 'builder', 'media'] as const;
export type ModeratableType = (typeof MODERATABLE_TYPES)[number];

export const MODERATION_ACTIONS = ['restrict', 'restore', 'archive', 'delete'] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

export function isModeratableType(value: string): value is ModeratableType {
  return (MODERATABLE_TYPES as readonly string[]).includes(value);
}

export function isModerationAction(value: string): value is ModerationAction {
  return (MODERATION_ACTIONS as readonly string[]).includes(value);
}

/** Exactly the columns an UPDATE sets. Shaped for drizzle's `.set()`. */
export type ModerationColumns = {
  updatedAt: Date;
  /** Projects and builders. */
  moderationState?: 'clean' | 'restricted' | 'archived' | 'removed';
  /** Media. */
  status?: 'published' | 'deleted';
  deletedAt?: Date | null;
  deletedBy?: string | null;
  deletionReason?: string | null;
};

export type ModerationWrite = {
  /** The enum value written to this type's state column. */
  state: string;
  /** The `audit_log.action` name for this action on this type. */
  auditAction: string;
  columns: ModerationColumns;
};

/**
 * How each action moves the state column, per content type.
 *
 * A missing key is an action the type does not support, and the route turns
 * that into a 400 rather than writing something the column cannot hold.
 */
type Mapping = {
  state: NonNullable<ModerationColumns['moderationState' | 'status']>;
  audit: string;
};

/**
 * Projects and builders. Both carry `moderation_state`, both are filtered to
 * `clean` on every public read, so the mapping is genuinely the same one and
 * is written once.
 */
const CONTENT_ACTIONS = {
  restrict: { state: 'restricted', audit: 'content.restricted' },
  restore: { state: 'clean', audit: 'content.restored' },
  archive: { state: 'archived', audit: 'content.archived' },
  delete: { state: 'removed', audit: 'content.removed' },
} as const satisfies Partial<Record<ModerationAction, Mapping>>;

const ACTIONS: Record<ModeratableType, Partial<Record<ModerationAction, Mapping>>> = {
  project: CONTENT_ACTIONS,
  builder: CONTENT_ACTIONS,
  /**
   * `media_status` is `staged | published | deleted`. There is NO `archived`
   * value, and the missing `archive` key below is the decision not to invent
   * one: an archived image and a deleted image are not a distinction anyone
   * has asked for, and the moderation UI has never offered the affordance
   * (`admin/src/pages/reports/[id].astro` renders restrict, restore and
   * delete). An additive enum value stays cheap to add later and is awkward
   * to remove, so it is not being added on speculation.
   *
   * `restrict` writes `deleted` because that is the strongest hold the enum
   * can express. It is audited as a restrict even so — the audit log records
   * what the moderator did, and reading `content.deleted` off a restrict was
   * the one place this module changes an existing audit name.
   */
  media: {
    restrict: { state: 'deleted', audit: 'content.restricted' },
    restore: { state: 'published', audit: 'content.restored' },
    delete: { state: 'deleted', audit: 'content.deleted' },
  },
};

/** The column holding the state the audit log records as `from_status`. */
export const STATE_COLUMN: Record<ModeratableType, 'moderationState' | 'status'> = {
  project: 'moderationState',
  builder: 'moderationState',
  media: 'status',
};

/**
 * What a moderator action writes, or `null` when this content type does not
 * support the action at all.
 *
 * `restore` unsets every tombstone column `delete` sets, which is the property
 * that makes a takedown reversible. `restrict` and `archive` are holds rather
 * than removals: they move the state column and leave the tombstone exactly as
 * they found it, so archiving an already-deleted row does not quietly claim to
 * have undeleted it.
 */
export function moderationWrite(
  type: ModeratableType,
  action: ModerationAction,
  actorId: string | null,
  now = new Date(),
): ModerationWrite | null {
  const mapping = ACTIONS[type][action];
  if (!mapping) return null;

  const columns: ModerationColumns = { updatedAt: now };
  if (STATE_COLUMN[type] === 'status') {
    columns.status = mapping.state as NonNullable<ModerationColumns['status']>;
  } else {
    columns.moderationState = mapping.state as NonNullable<ModerationColumns['moderationState']>;
  }

  if (action === 'delete') {
    columns.deletedAt = now;
    columns.deletedBy = actorId;
    columns.deletionReason = 'Moderator removed';
  } else if (action === 'restore') {
    columns.deletedAt = null;
    columns.deletedBy = null;
    columns.deletionReason = null;
  }

  return { state: mapping.state, auditAction: mapping.audit, columns };
}

// ── The request boundary ──────────────────────────────────────────────────

/** Path ids reach Postgres as `uuid`, so a malformed one is a 400, not a 500. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A refusal, with the status the route returns and the two halves of the body:
 * `code` is stable and machine-readable, `error` is what a moderator reads.
 * Neither ever carries a driver message or a stack.
 */
export type ModerationRefusal = { ok: false; status: number; code: string; error: string };

export type ModerationRequest =
  | {
      ok: true;
      type: ModeratableType;
      action: ModerationAction;
      id: string;
      write: ModerationWrite;
    }
  | ModerationRefusal;

/**
 * Everything the route decides before it touches the database.
 *
 * Extracted from the handler because a decision a test cannot reach is a
 * decision nobody checked — which is the whole reason three broken actions
 * shipped. `tests/moderation-actions.test.ts` drives this directly.
 */
export function moderationRequest(
  params: { type?: string; id?: string; action?: string },
  actorId: string | null,
  now = new Date(),
): ModerationRequest {
  const { type, id, action } = params;
  if (!type || !id || !action) {
    return { ok: false, status: 400, code: 'missing_parameters', error: 'Missing parameters.' };
  }
  if (!isModeratableType(type)) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_type',
      error: `"${type}" is not a moderatable content type.`,
    };
  }
  if (!isModerationAction(action)) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_action',
      error: `"${action}" is not a moderation action.`,
    };
  }
  if (!UUID.test(id)) {
    return { ok: false, status: 400, code: 'invalid_id', error: 'Entity id must be a UUID.' };
  }

  /**
   * THE (TYPE, ACTION) PAIR, not the action alone.
   *
   * `archive` is a real action and `media` is a real type, but `media_status`
   * has no `archived` value. The route used to accept the pair, map it to
   * nothing, and write the empty string to the enum column — which Postgres
   * refused, uncaught, as a bare 500. Refusing it here is the fix.
   */
  const write = moderationWrite(type, action, actorId, now);
  if (!write) {
    return {
      ok: false,
      status: 400,
      code: 'unsupported_action',
      error: `A ${type} cannot be ${action}d.`,
    };
  }

  return { ok: true, type, action, id, write };
}

// ── Media-only compatibility surface ──────────────────────────────────────
//
// `mediaModerationPatch()` is what the media takedown fix introduced and what
// `tests/media-takedown.test.ts` asserts against. It is kept as a delegate
// rather than a second copy of the rules, so there is still exactly one place
// that decides what a restore writes.

/** The moderator actions media supports. */
export type MediaModerationAction = 'restrict' | 'restore' | 'delete';

export type MediaModerationPatch = {
  status: 'published' | 'deleted';
  updatedAt: Date;
  deletedAt?: Date | null;
  deletedBy?: string | null;
  deletionReason?: string | null;
};

/**
 * The columns a moderator action sets on a media row, or `null` for an action
 * media does not support — which is `archive`, for the reason given in
 * `ACTIONS.media` above.
 */
export function mediaModerationPatch(
  action: string,
  actorId: string | null,
  now = new Date(),
): MediaModerationPatch | null {
  if (!isModerationAction(action)) return null;
  const write = moderationWrite('media', action, actorId, now);
  return write ? (write.columns as MediaModerationPatch) : null;
}
