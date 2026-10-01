/**
 * CLAIMING AN IMPORTED PROJECT.
 *
 * An imported project credits a team as the organisers recorded it. Being
 * credited is not owning: nothing here grants ownership on a name match, an
 * imported email or a credit row. A member asks, with evidence; a moderator
 * reviews; only an approved claim changes anything, and then atomically:
 *
 *   · the member becomes `owner_member_id`
 *   · `content_authority` moves from `baserow` to `member` — so the projection
 *     stops writing it (its mapping is `released`) and the owner edits it on
 *     the website from now on
 *   · provenance stays: the mapping, the credits and the audit trail are kept
 *   · the owner's builder profile, if published, is credited on it
 *
 * Rejected and superseded claims change nothing but their own row.
 */
import { and, eq } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../../../db/schema';

type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

export type ClaimRequestResult =
  | { ok: true; claimId: string }
  | { ok: false; status: 404 | 409 | 422; error: string };

export async function requestProjectClaim(
  db: AnyDatabase,
  memberId: string,
  projectSlug: string,
  evidence: string,
): Promise<ClaimRequestResult> {
  const text = evidence.trim();
  if (text.length < 10 || text.length > 2_000) {
    return { ok: false, status: 422, error: 'Describe your connection to the project in 10–2000 characters.' };
  }
  const [project] = await db
    .select({ id: schema.projects.id, authority: schema.projects.contentAuthority, owner: schema.projects.ownerMemberId })
    .from(schema.projects)
    .where(eq(schema.projects.slug, projectSlug));
  if (!project) return { ok: false, status: 404, error: 'No such project.' };
  if (project.authority !== 'baserow' || project.owner) {
    return { ok: false, status: 409, error: 'This project already has an owner on the site.' };
  }
  const [open] = await db
    .select({ id: schema.projectClaims.id })
    .from(schema.projectClaims)
    .where(
      and(
        eq(schema.projectClaims.projectId, project.id),
        eq(schema.projectClaims.memberId, memberId),
        eq(schema.projectClaims.status, 'pending'),
      ),
    );
  if (open) return { ok: true, claimId: open.id };

  const [claim] = await db
    .insert(schema.projectClaims)
    .values({ projectId: project.id, memberId, evidence: text })
    .returning({ id: schema.projectClaims.id });
  await db.insert(schema.auditLog).values({
    actorMemberId: memberId,
    action: 'project.claim.requested',
    entityType: 'project',
    entityId: project.id,
    toStatus: 'pending',
  });
  return { ok: true, claimId: claim.id };
}

export type ClaimResolution =
  | { ok: true; status: 'approved' | 'rejected' }
  | { ok: false; status: 404 | 409; error: string };

export async function resolveProjectClaim(
  db: AnyDatabase,
  claimId: string,
  decision: 'approve' | 'reject',
  moderator: { id: string; email: string },
  note: string | null,
): Promise<ClaimResolution> {
  return db.transaction(async (tx) => {
    const [claim] = await tx
      .select()
      .from(schema.projectClaims)
      .where(eq(schema.projectClaims.id, claimId))
      .for('update');
    if (!claim) return { ok: false as const, status: 404 as const, error: 'No such claim.' };
    if (claim.status !== 'pending') {
      return { ok: false as const, status: 409 as const, error: `This claim is already ${claim.status}.` };
    }
    const now = new Date();

    if (decision === 'reject') {
      await tx
        .update(schema.projectClaims)
        .set({ status: 'rejected', resolvedBy: moderator.id, resolvedAt: now, resolutionNote: note })
        .where(eq(schema.projectClaims.id, claimId));
      await tx.insert(schema.auditLog).values({
        actorId: moderator.id,
        actorEmail: moderator.email,
        action: 'project.claim.rejected',
        entityType: 'project',
        entityId: claim.projectId,
        fromStatus: 'pending',
        toStatus: 'rejected',
        note,
      });
      return { ok: true as const, status: 'rejected' as const };
    }

    const [project] = await tx
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, claim.projectId))
      .for('update');
    if (!project || project.contentAuthority !== 'baserow' || project.ownerMemberId) {
      return { ok: false as const, status: 409 as const, error: 'The project is no longer claimable.' };
    }

    await tx
      .update(schema.projects)
      .set({ ownerMemberId: claim.memberId, contentAuthority: 'member', updatedAt: now })
      .where(eq(schema.projects.id, project.id));
    // The projection must stop writing this row. Provenance is kept.
    await tx
      .update(schema.integrationMappings)
      .set({ status: 'released', lastError: 'claimed: the website owns this project now', updatedAt: now })
      .where(and(eq(schema.integrationMappings.entityType, 'project'), eq(schema.integrationMappings.entityId, project.id)));
    await tx
      .update(schema.projectClaims)
      .set({ status: 'approved', resolvedBy: moderator.id, resolvedAt: now, resolutionNote: note })
      .where(eq(schema.projectClaims.id, claimId));
    // Every other open claim on the project is now moot.
    await tx
      .update(schema.projectClaims)
      .set({ status: 'cancelled', resolvedBy: moderator.id, resolvedAt: now, resolutionNote: 'Another claim was approved.' })
      .where(and(eq(schema.projectClaims.projectId, project.id), eq(schema.projectClaims.status, 'pending')));

    const [builder] = await tx
      .select({ id: schema.builders.id })
      .from(schema.builders)
      .where(eq(schema.builders.ownerMemberId, claim.memberId));
    if (builder) {
      await tx.insert(schema.projectBuilders).values({ projectId: project.id, builderId: builder.id, position: 0 }).onConflictDoNothing();
    }

    await tx.insert(schema.auditLog).values({
      actorId: moderator.id,
      actorEmail: moderator.email,
      action: 'project.claim.approved',
      entityType: 'project',
      entityId: project.id,
      fromStatus: 'baserow',
      toStatus: 'member',
      before: { ownerMemberId: null, contentAuthority: 'baserow' },
      after: { ownerMemberId: claim.memberId, contentAuthority: 'member' },
      note,
    });
    return { ok: true as const, status: 'approved' as const };
  });
}
