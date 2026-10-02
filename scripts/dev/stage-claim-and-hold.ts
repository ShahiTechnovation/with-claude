#!/usr/bin/env tsx
/**
 * LOCAL CLONE ONLY — before a sync rehearsal, give two imported projects the
 * states the sync must never disturb:
 *
 *   · an APPROVED member claim (the website owns it now: member authority,
 *     released mapping) — through the real claim functions
 *   · a MODERATOR RESTRICTION (moderation_state = restricted)
 *
 *   npx tsx scripts/dev/stage-claim-and-hold.ts <claimed-slug> <restricted-slug>
 *
 * Refuses any database that is not on 127.0.0.1 and named *_mirror or
 * *_baserow, so it cannot touch a shared or production database.
 */
import { eq } from 'drizzle-orm';
import { pooledDb } from '../../db/pool';
import * as schema from '../../db/schema';
import { requestProjectClaim, resolveProjectClaim } from '../../src/server/projects/claims';
import { provisionMember } from '../../src/server/auth/member';

const [claimSlug, holdSlug] = process.argv.slice(2);
if (!claimSlug || !holdSlug) throw new Error('usage: stage-claim-and-hold <claimed-slug> <restricted-slug>');
const url = new URL(process.env.DATABASE_URL ?? '');
if (url.hostname !== '127.0.0.1' || !/_(mirror|baserow)$/.test(url.pathname)) {
  throw new Error('stage-claim-and-hold only runs against a local *_mirror or *_baserow clone');
}
const db = pooledDb();
const pick = async (slug: string) => (await db.select().from(schema.projects).where(eq(schema.projects.slug, slug)))[0];
const claimed = await pick(claimSlug);
const held = await pick(holdSlug);
if (!claimed || !held) throw new Error(`no such project: ${!claimed ? claimSlug : holdSlug}`);

if (claimed.contentAuthority !== 'member') {
  const { member } = await provisionMember('did:privy:rehearsal-claimer', db);
  let [moderator] = await db.select().from(schema.users).where(eq(schema.users.email, 'rehearsal-moderator@example.com'));
  if (!moderator) [moderator] = await db.insert(schema.users).values({ email: 'rehearsal-moderator@example.com', role: 'editor' }).returning();
  const request = await requestProjectClaim(db, member.id, claimed.slug, 'I am the author of the linked repository (rehearsal).');
  if (!request.ok) throw new Error(`claim request refused: ${JSON.stringify(request)}`);
  const decision = await resolveProjectClaim(db, request.claimId, 'approve', moderator!, 'Rehearsal: verified');
  console.log(`claim on ${claimed.slug}: ${JSON.stringify(decision)}`);
}
await db.update(schema.projects).set({ moderationState: 'restricted' }).where(eq(schema.projects.id, held.id));
console.log(`moderation on ${held.slug}: restricted`);
process.exit(0);
