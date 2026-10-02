/**
 * MEMBER-SITE MODERATION: hide, remove, restore.
 *
 * `moderationState` is the ONLY column these actions write. Publication is the
 * owner's decision (`publicationStatus` for projects, `status` for builders)
 * and moderation is a separate hold layered over it:
 *
 *   hide     → restricted   off every public surface, reversible
 *   remove   → removed      off every public surface, for serious cases
 *   restore  → clean        the hold is lifted; publication is UNCHANGED
 *
 * Restore used to write `published` + `clean` outright, which meant restoring
 * a moderated DRAFT published it, and "remove" overwrote the publication state
 * with `deleted` so restore could not know what it had been. Now a restore
 * returns the record to exactly the publication state its owner left it in,
 * and an item that was deleted stays deleted until an authorised transition
 * says otherwise.
 *
 * Every action audits before/after in the same transaction and re-asserts the
 * from-state, so a double click cannot write two entries.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { pooledDb } from '../../db/pool';
import * as dbSchema from '../../db/schema';
import { requireMember } from './auth/member';

type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof dbSchema>;
type ModerationState = (typeof dbSchema.moderationState.enumValues)[number];

export async function isRequestModerator(request: Request): Promise<boolean> {
  const db = pooledDb();
  const auth = await requireMember(request, db);
  return auth.ok && (auth.member.role === 'moderator' || auth.member.role === 'owner');
}

export type ModerationAction = 'hide' | 'remove' | 'restore';

const RULES: Record<ModerationAction, { from: readonly ModerationState[]; to: ModerationState }> = {
  hide: { from: ['clean', 'reported'], to: 'restricted' },
  remove: { from: ['clean', 'reported', 'restricted', 'archived'], to: 'removed' },
  restore: { from: ['reported', 'restricted', 'removed', 'archived'], to: 'clean' },
};

export type ModerationResult =
  | { ok: true; from: ModerationState; to: ModerationState }
  | { ok: false; status: 404 | 409; error: string };

type Target = 'project' | 'builder';

async function moderate(
  target: Target,
  id: string,
  action: ModerationAction,
  actorMemberId: string,
  db: AnyDatabase,
  note?: string,
): Promise<ModerationResult> {
  const rule = RULES[action];
  const table = target === 'project' ? dbSchema.projects : dbSchema.builders;

  const [row] =
    target === 'project'
      ? await db
          .select({
            moderationState: dbSchema.projects.moderationState,
            publication: dbSchema.projects.publicationStatus,
          })
          .from(dbSchema.projects)
          .where(eq(dbSchema.projects.id, id))
      : await db
          .select({
            moderationState: dbSchema.builders.moderationState,
            publication: dbSchema.builders.status,
          })
          .from(dbSchema.builders)
          .where(eq(dbSchema.builders.id, id));

  if (!row) return { ok: false, status: 404, error: `No ${target} with that id.` };
  if (!rule.from.includes(row.moderationState)) {
    return {
      ok: false,
      status: 409,
      error: `Cannot ${action} a ${target} whose moderation state is ${row.moderationState}.`,
    };
  }

  const from = row.moderationState;
  const changed = await db.transaction(async (tx) => {
    const updated = await tx
      .update(table)
      .set({ moderationState: rule.to, updatedAt: new Date() })
      .where(and(eq(table.id, id), inArray(table.moderationState, [from])))
      .returning({ id: table.id });
    if (updated.length !== 1) return false;
    await tx.insert(dbSchema.auditLog).values({
      actorMemberId,
      action: `${target}.moderation.${action}`,
      entityType: target,
      entityId: id,
      fromStatus: from,
      toStatus: rule.to,
      // Publication is recorded on both sides to make it checkable that a
      // moderation action never moved it.
      before: { moderationState: from, publication: row.publication },
      after: { moderationState: rule.to, publication: row.publication },
      note: note ?? `Moderator ${action} ${target}`,
    });
    return true;
  });

  if (!changed) {
    return { ok: false, status: 409, error: 'This changed a moment ago. Reload and try again.' };
  }
  return { ok: true, from, to: rule.to };
}

export function moderateProject(
  id: string,
  action: ModerationAction,
  actorMemberId: string,
  db: AnyDatabase = pooledDb(),
) {
  return moderate('project', id, action, actorMemberId, db);
}

export function moderateBuilder(
  id: string,
  action: ModerationAction,
  actorMemberId: string,
  db: AnyDatabase = pooledDb(),
) {
  return moderate('builder', id, action, actorMemberId, db);
}
