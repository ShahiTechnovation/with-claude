import { eq, or, and } from 'drizzle-orm';
import { requireMember } from '../auth/member';
import { pooledDb } from '../../../db/pool';
import * as dbSchema from '../../../db/schema';

export async function getMemberProjects(memberId: string) {
  const db = pooledDb();
  
  const memberProjects = await db
    .select({
      id: dbSchema.projects.id,
      title: dbSchema.projects.title,
      slug: dbSchema.projects.slug,
      publicationStatus: dbSchema.projects.publicationStatus,
      moderationState: dbSchema.projects.moderationState,
      ownerMemberId: dbSchema.projects.ownerMemberId,
      category: dbSchema.projects.category,
    })
    .from(dbSchema.projects)
    .leftJoin(dbSchema.projectMembers, eq(dbSchema.projectMembers.projectId, dbSchema.projects.id))
    .where(
      or(
        eq(dbSchema.projects.ownerMemberId, memberId),
        eq(dbSchema.projectMembers.memberId, memberId)
      )
    );

  return Array.from(new Map(memberProjects.map(p => [p.id, p])).values());
}

export async function getMemberProject(projectId: string, memberId: string) {
  const db = pooledDb();
  const [project] = await db
    .select()
    .from(dbSchema.projects)
    .where(eq(dbSchema.projects.id, projectId));
    
  if (!project || project.ownerMemberId !== memberId) return null;
  return project;
}

export async function getMemberProjectForEdit(projectId: string, memberId: string) {
  const db = pooledDb();
  
  const [project] = await db
    .select()
    .from(dbSchema.projects)
    .leftJoin(dbSchema.projectMembers, eq(dbSchema.projectMembers.projectId, dbSchema.projects.id))
    .where(
      and(
        eq(dbSchema.projects.id, projectId),
        or(
          eq(dbSchema.projects.ownerMemberId, memberId),
          eq(dbSchema.projectMembers.memberId, memberId)
        )
      )
    );
    
  return project;
}

export async function getIdentityFromRequest(request: Request) {
  const db = pooledDb();
  return requireMember(request, db);
}
