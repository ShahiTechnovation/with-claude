import { eq } from 'drizzle-orm';
import { pooledDb } from '../../db/pool';
import * as dbSchema from '../../db/schema';
import { requireMember } from './auth/member';

export async function isRequestModerator(request: Request): Promise<boolean> {
  const db = pooledDb();
  const auth = await requireMember(request, db);
  return auth.ok && (auth.member.role === 'moderator' || auth.member.role === 'owner');
}

export async function requireModerator(request: Request) {
  const db = pooledDb();
  const auth = await requireMember(request, db);
  if (!auth.ok || (auth.member.role !== 'moderator' && auth.member.role !== 'owner')) {
    throw new Error('Unauthorized');
  }
  return auth.member;
}

export async function hideBuilder(id: string, actorId: string) {
  const db = pooledDb();
  await db.transaction(async (tx) => {
    await tx
      .update(dbSchema.builders)
      .set({ moderationState: 'restricted' })
      .where(eq(dbSchema.builders.id, id));
    await tx.insert(dbSchema.auditLog).values({
      actorMemberId: actorId,
      action: 'hide',
      entityType: 'builder',
      entityId: id,
      note: 'Moderator restricted builder'
    });
  });
}

export async function removeBuilder(id: string, actorId: string) {
  const db = pooledDb();
  await db.transaction(async (tx) => {
    await tx
      .update(dbSchema.builders)
      .set({ status: 'archived', moderationState: 'removed' })
      .where(eq(dbSchema.builders.id, id));
    await tx.insert(dbSchema.auditLog).values({
      actorMemberId: actorId,
      action: 'remove',
      entityType: 'builder',
      entityId: id,
      note: 'Moderator removed builder'
    });
  });
}

export async function restoreBuilder(id: string, actorId: string) {
  const db = pooledDb();
  await db.transaction(async (tx) => {
    await tx
      .update(dbSchema.builders)
      .set({ status: 'published', moderationState: 'clean' })
      .where(eq(dbSchema.builders.id, id));
    await tx.insert(dbSchema.auditLog).values({
      actorMemberId: actorId,
      action: 'restore',
      entityType: 'builder',
      entityId: id,
      note: 'Moderator restored builder'
    });
  });
}

export async function hideProject(id: string, actorId: string) {
  const db = pooledDb();
  await db.transaction(async (tx) => {
    await tx
      .update(dbSchema.projects)
      .set({ moderationState: 'restricted' })
      .where(eq(dbSchema.projects.id, id));
    await tx.insert(dbSchema.auditLog).values({
      actorMemberId: actorId,
      action: 'hide',
      entityType: 'project',
      entityId: id,
      note: 'Moderator restricted project'
    });
  });
}

export async function removeProject(id: string, actorId: string) {
  const db = pooledDb();
  await db.transaction(async (tx) => {
    await tx
      .update(dbSchema.projects)
      .set({ publicationStatus: 'deleted', moderationState: 'removed' })
      .where(eq(dbSchema.projects.id, id));
    await tx.insert(dbSchema.auditLog).values({
      actorMemberId: actorId,
      action: 'remove',
      entityType: 'project',
      entityId: id,
      note: 'Moderator removed project'
    });
  });
}

export async function restoreProject(id: string, actorId: string) {
  const db = pooledDb();
  await db.transaction(async (tx) => {
    await tx
      .update(dbSchema.projects)
      .set({ publicationStatus: 'published', moderationState: 'clean' })
      .where(eq(dbSchema.projects.id, id));
    await tx.insert(dbSchema.auditLog).values({
      actorMemberId: actorId,
      action: 'restore',
      entityType: 'project',
      entityId: id,
      note: 'Moderator restored project'
    });
  });
}
