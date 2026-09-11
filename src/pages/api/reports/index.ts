import type { APIRoute } from 'astro';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { pooledDb } from '../../../../db/pool';
import * as schema from '../../../../db/schema';
import { guardMutation, json } from '@/server/http/guard';

export const prerender = false;

const ReportSchema = z.object({
  entityType: z.enum(['builder', 'project', 'media']),
  entityId: z.string().uuid(),
  reason: z.enum([
    'spam',
    'impersonation',
    'harassment',
    'misleading',
    'stolen_work',
    'unsafe_link',
    'inappropriate_content',
    'copyright',
    'duplicate',
    'privacy',
    'other',
  ]),
  details: z.string().trim().max(1000).optional().nullable(),
});

export const POST: APIRoute = async ({ request }) => {
  const db = pooledDb();
  const guard = await guardMutation(request, db, { schema: ReportSchema });
  if (!guard.ok) return guard.response;

  const { member, body: data } = guard;

  // 2. Prevent duplicate open reports from the same member against the same entity
  const existing = await db
    .select({ id: schema.reports.id })
    .from(schema.reports)
    .where(
      and(
        eq(schema.reports.reporterMemberId, member.id),
        eq(schema.reports.entityType, data.entityType),
        eq(schema.reports.entityId, data.entityId),
        eq(schema.reports.status, 'open')
      )
    );

  if (existing.length > 0) {
    return json({ success: true, message: 'You have already reported this content. Thanks for your vigilance!' }, 200);
  }

  // 3. Insert report
  const [report] = await db
    .insert(schema.reports)
    .values({
      reporterMemberId: member.id,
      entityType: data.entityType,
      entityId: data.entityId,
      reason: data.reason,
      details: data.details ?? null,
    })
    .returning({ id: schema.reports.id });

  return json({ success: true, reportId: report.id, message: 'Thanks — we\'ve received your report.' }, 201);
};
