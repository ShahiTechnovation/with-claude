/**
 * ADMIN AMBASSADOR FLOW — an integration substitute for a browser click-through.
 *
 * The final-integration pass asks for a manual browser verification of the
 * admin's ambassador UI: list loads, edit works, member-link works, save
 * works, audit entry is created. No browser-automation tool was available in
 * the session that wrote this file, so this exercises the exact same server
 * functions those forms POST to — `admin/src/server/ambassadors.ts` — against
 * a real PGlite database. It is not a substitute for someone actually clicking
 * through `admin.withclaude.in`, and it does not claim to be; it is what
 * confirms the code those clicks would run is correct.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import * as schema from '../db/schema';
import { ensureProfileShell, provisionMember } from '../src/server/auth/member';
import {
  ambassadorAudit,
  correctEventHost,
  createAmbassador,
  getAmbassador,
  linkMember,
  listAmbassadors,
  requestLeaderboardRebuild,
  setAmbassadorStatus,
  updateAmbassador,
} from '../admin/src/server/ambassadors';
import { attributionDrift } from '../src/server/events/hosts';

let db: TestDatabase;
let cityId: string;
const actor = { id: '00000000-0000-0000-0000-0000000000aa', email: 'moderator@withclaude.in' };

beforeAll(async () => {
  db = await createTestDatabase();
  // The actor is a real `users` row: audit_log.actor_id references it.
  await db.insert(schema.users).values({
    id: actor.id,
    email: actor.email,
    role: 'admin',
    active: true,
  });
  const [city] = await db
    .insert(schema.cities)
    .values({
      slug: 'zz-admin-flow-city',
      name: 'Admin Flow City',
      region: 'Test Region',
      lat: 23.25,
      lon: 77.41,
      blurb: 'Disposable.',
      status: 'published',
    })
    .returning({ id: schema.cities.id });
  cityId = city.id;
}, 60_000);

afterAll(async () => {
  await db?.$close();
});

beforeEach(async () => {
  await db.delete(schema.eventHosts).catch(() => {});
  await db.delete(schema.events).catch(() => {});
  await db.delete(schema.ambassadors).catch(() => {});
  await db.delete(schema.memberProfiles).catch(() => {});
  await db.delete(schema.members).catch(() => {});
});

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
}

describe('the ambassador list loads', () => {
  it('is empty before anything is created, and shows what exists after', async () => {
    expect(await listAmbassadors(db)).toEqual([]);

    await createAmbassador(
      form({ name: 'ZZ Flow Ambassador', cityId, verifiedVia: 'Confirmed for the test' }),
      actor,
      db,
    );

    const rows = await listAmbassadors(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'ZZ Flow Ambassador', status: 'draft' });
  });
});

describe('create, edit, link, publish, disable — the record read back each time', () => {
  it('runs the whole lifecycle and leaves an audit entry at every step', async () => {
    // CREATE refuses without provenance.
    const noProof = await createAmbassador(
      form({ name: 'ZZ Flow', cityId, verifiedVia: '' }),
      actor,
      db,
    );
    expect(noProof.ok).toBe(false);

    const created = await createAmbassador(
      form({
        name: 'ZZ Flow',
        cityId,
        verifiedVia: 'Confirmed for the test',
        lumaDisplayName: 'ZZ Flow Organiser',
      }),
      actor,
      db,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('unreachable');
    const id = created.id;

    let row = await getAmbassador(id, db);
    expect(row).toMatchObject({
      name: 'ZZ Flow',
      status: 'draft',
      lumaDisplayName: 'ZZ Flow Organiser',
    });

    // EDIT — the form the [id].astro "Record" panel posts.
    const edited = await updateAmbassador(
      id,
      form({ name: 'ZZ Flow Edited', cityId, verifiedVia: 'Confirmed for the test, edited' }),
      actor,
      db,
    );
    expect(edited.ok).toBe(true);
    row = await getAmbassador(id, db);
    expect(row?.name).toBe('ZZ Flow Edited');

    // EDIT refuses to blank out provenance.
    const strippedProof = await updateAmbassador(
      id,
      form({ name: 'ZZ Flow Edited', cityId, verifiedVia: '' }),
      actor,
      db,
    );
    expect(strippedProof.ok).toBe(false);

    // LINK MEMBER — resolves a username to a member id.
    const { member } = await provisionMember('did:privy:zz-admin-flow', db);
    await ensureProfileShell(member, db);
    await db
      .update(schema.memberProfiles)
      .set({ username: 'zz-admin-flow-user' })
      .where(eq(schema.memberProfiles.memberId, member.id));

    const badLink = await linkMember(id, 'no-such-username', actor, db);
    expect(badLink.ok).toBe(false);

    const link = await linkMember(id, 'zz-admin-flow-user', actor, db);
    expect(link.ok).toBe(true);
    row = await getAmbassador(id, db);
    expect(row?.memberUsername).toBe('zz-admin-flow-user');

    // PUBLISH.
    const published = await setAmbassadorStatus(id, 'published', actor, db);
    expect(published.ok).toBe(true);
    row = await getAmbassador(id, db);
    expect(row?.status).toBe('published');

    // DISABLE — archives, does not delete.
    const disabled = await setAmbassadorStatus(id, 'archived', actor, db);
    expect(disabled.ok).toBe(true);
    row = await getAmbassador(id, db);
    expect(row?.status).toBe('archived');
    expect(row?.name).toBe('ZZ Flow Edited');

    // AUDIT — one entry per step, all attributed to the actor, none rewritten.
    const trail = await ambassadorAudit(id, db);
    const actions = trail.map((t: { action: string }) => t.action);
    expect(actions).toContain('ambassador.created');
    expect(actions).toContain('ambassador.updated');
    expect(actions).toContain('ambassador.linked');
    expect(actions).toContain('ambassador.disabled');
    expect(trail.every((t: { actorEmail: string | null }) => t.actorEmail === actor.email)).toBe(
      true,
    );
  });
});

describe('correcting an event host from the attribution queue', () => {
  it('writes a manual credit that a future sync will not overwrite, and it is audited', async () => {
    const created = await createAmbassador(
      form({ name: 'ZZ Correction Target', cityId, verifiedVia: 'Confirmed for the test' }),
      actor,
      db,
    );
    if (!created.ok) throw new Error('unreachable');
    await setAmbassadorStatus(created.id, 'published', actor, db);

    const [event] = await db
      .insert(schema.events)
      .values({
        slug: 'zz-admin-flow-event',
        title: 'ZZ Flow Event',
        format: 'meetup',
        cityId,
        date: '2026-01-01',
        startTime: '10:00:00',
        venueName: 'Somewhere',
        summary: 'x',
        status: 'published',
      })
      .returning({ id: schema.events.id });

    const correction = await correctEventHost(
      event.id,
      { ambassadorId: created.id, role: 'primary_host' },
      actor,
      db,
    );
    expect(correction.ok).toBe(true);

    const [hostRow] = await db
      .select()
      .from(schema.eventHosts)
      .where(
        and(eq(schema.eventHosts.eventId, event.id), eq(schema.eventHosts.role, 'primary_host')),
      );
    expect(hostRow).toMatchObject({ ambassadorId: created.id, source: 'manual' });

    const [eventRow] = await db
      .select({ ambassadorId: schema.events.ambassadorId })
      .from(schema.events)
      .where(eq(schema.events.id, event.id));
    expect(eventRow.ambassadorId).toBe(created.id);

    // The invariant, checked the same way production is.
    expect(await attributionDrift(db)).toEqual([]);

    // Logged against the EVENT, not the ambassador.
    const [entityScoped] = await db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.entityType, 'event'), eq(schema.auditLog.entityId, event.id)));
    expect(entityScoped).toMatchObject({ action: 'event.host.linked' });
  });
});

describe('leaderboard "recalculate" without a configured deploy hook', () => {
  it('says plainly that nothing was triggered, and still audits the attempt', async () => {
    // No VERCEL_DEPLOY_HOOK_URL in this test environment — the honest,
    // unconfigured path the admin note describes.
    const result = await requestLeaderboardRebuild(actor, db);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/saved/i);

    const [entry] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'leaderboard.recalculated'))
      .orderBy(schema.auditLog.createdAt);
    expect(entry).toBeDefined();
  });
});

describe('database conflicts are translated into sentences', () => {
  it('refuses two ambassadors configured with the same Luma organiser name', async () => {
    /**
     * The unique index is `lower(btrim(luma_display_name))` — case and outer
     * whitespace only. Internal-whitespace collapsing (`"John  Doe"` vs
     * `"John Doe"`) happens one layer up, in `organizerKey()` in
     * `src/server/events/hosts.ts`, for matching an incoming feed string —
     * it is NOT mirrored in this index. So the two configured names below
     * differ only by case and leading/trailing space, which is exactly what
     * the index catches; a doubled internal space would NOT be caught here
     * and is a known, narrower gap than the runtime matcher's normalisation.
     */
    await createAmbassador(
      form({ name: 'ZZ First', cityId, verifiedVia: 'test', lumaDisplayName: 'Shared Name' }),
      actor,
      db,
    );
    const second = await createAmbassador(
      form({ name: 'ZZ Second', cityId, verifiedVia: 'test', lumaDisplayName: '  shared name  ' }),
      actor,
      db,
    );
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.error).toMatch(/one person/i);
  });

  it('does NOT catch a difference in internal whitespace — a known, narrower gap', async () => {
    // Documents the gap rather than hiding it: the database constraint and
    // the runtime matcher normalise organiser names differently, so two rows
    // that look distinct to Postgres can still collide at match time in
    // `loadAmbassadorIdentities()`. Fixing it needs a migration that widens
    // the index expression, which is deliberately out of scope for this pass.
    await createAmbassador(
      form({ name: 'ZZ First', cityId, verifiedVia: 'test', lumaDisplayName: 'John Doe' }),
      actor,
      db,
    );
    const second = await createAmbassador(
      form({ name: 'ZZ Second', cityId, verifiedVia: 'test', lumaDisplayName: 'John  Doe' }),
      actor,
      db,
    );
    expect(second.ok).toBe(true);
  });
});
