/**
 * AMBASSADOR ADMINISTRATION. §36, §37, §38.
 *
 * Everything a moderator can do to an ambassador record or to a host
 * attribution, in one module, with an audit entry per change.
 *
 * ── WHY THE MUTATIONS DO NOT WRITE `event_hosts` THEMSELVES ──────────────
 *
 * They call `setPrimaryHost()` / `clearPrimaryHost()` / `setHostCredit()` in
 * `src/server/events/hosts.ts` — the public site's module, imported across the
 * workspace boundary. That is deliberate and it is the single most important
 * decision in this file.
 *
 * The invariant "`events.ambassador_id` equals the primary host row" has to
 * hold no matter who wrote last: the Luma sync, the repository importer, or a
 * moderator on a Tuesday afternoon. An admin that wrote the two tables itself
 * would be a second implementation of that invariant, and the moment the two
 * disagreed the site would credit one person and the leaderboard another.
 * One writer, three callers.
 *
 * ── WHAT A MODERATOR CANNOT DO ───────────────────────────────────────────
 *
 * Grant ambassador status. `verified_via` is required by the database and by
 * `createAmbassador()` below, because §54 forbids the site claiming somebody
 * holds a status that has not actually been verified. The form asks how it was
 * verified and refuses to save without an answer — not as validation theatre,
 * but because a record that cannot answer "how do you know?" is exactly what
 * this table exists to prevent.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '@db/schema';
import { pooledDb } from '@db/pool';
import { deployMessage, triggerDeploy } from './publishing';
import {
  clearPrimaryHost,
  removeHostCredit,
  setHostCredit,
  setPrimaryHost,
  type EventHostRole,
} from '../../../src/server/events/hosts';

type Db = ReturnType<typeof pooledDb>;

/** Trim to null, so an empty form field clears rather than storing `''`. */
const blank = (value: FormDataEntryValue | null | undefined): string | null => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > 0 ? text : null;
};

const required = (value: FormDataEntryValue | null | undefined): string => {
  const text = blank(value);
  if (!text) throw new Error('required');
  return text;
};

/** A URL-safe handle from a display name. Admin-side only. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

export interface AmbassadorRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  cityId: string;
  cityName: string;
  verifiedVia: string;
  verifiedAt: Date | null;
  bio: string | null;
  builderId: string | null;
  builderSlug: string | null;
  memberId: string | null;
  memberUsername: string | null;
  lumaProfileUrl: string | null;
  lumaExternalId: string | null;
  lumaDisplayName: string | null;
  /** Scored roles only, so the figure matches the public leaderboard. */
  primaryHostEvents: number;
  coHostEvents: number;
  otherCredits: number;
}

/**
 * Every ambassador with the counts a moderator needs, in four queries.
 *
 * Not one query per ambassador, and not a count subquery per row: §45's
 * no-N+1 rule holds in the admin too, and an admin page that degrades as the
 * directory grows is a page somebody will eventually stop opening.
 */
export async function listAmbassadors(db: Db = pooledDb()): Promise<AmbassadorRow[]> {
  const [rows, cities, builders, members, credits] = await Promise.all([
    db.select().from(schema.ambassadors).orderBy(schema.ambassadors.name),
    db.select({ id: schema.cities.id, name: schema.cities.name }).from(schema.cities),
    db.select({ id: schema.builders.id, slug: schema.builders.slug }).from(schema.builders),
    db
      .select({ memberId: schema.memberProfiles.memberId, username: schema.memberProfiles.username })
      .from(schema.memberProfiles),
    db
      .select({
        ambassadorId: schema.eventHosts.ambassadorId,
        role: schema.eventHosts.role,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.eventHosts)
      .groupBy(schema.eventHosts.ambassadorId, schema.eventHosts.role),
  ]);

  const cityName = new Map(cities.map((c) => [c.id, c.name]));
  const builderSlug = new Map(builders.map((b) => [b.id, b.slug]));
  const username = new Map(members.map((m) => [m.memberId, m.username]));

  const byAmbassador = new Map<string, Map<string, number>>();
  for (const row of credits) {
    const bucket = byAmbassador.get(row.ambassadorId) ?? new Map<string, number>();
    bucket.set(row.role, Number(row.count));
    byAmbassador.set(row.ambassadorId, bucket);
  }

  return rows.map((row) => {
    const counts = byAmbassador.get(row.id) ?? new Map<string, number>();
    const primary = counts.get('primary_host') ?? 0;
    const co = counts.get('co_host') ?? 0;
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      status: row.status,
      cityId: row.cityId,
      cityName: cityName.get(row.cityId) ?? '—',
      verifiedVia: row.verifiedVia,
      verifiedAt: row.verifiedAt,
      bio: row.bio,
      builderId: row.builderId,
      builderSlug: row.builderId ? (builderSlug.get(row.builderId) ?? null) : null,
      memberId: row.memberId,
      memberUsername: row.memberId ? (username.get(row.memberId) ?? null) : null,
      lumaProfileUrl: row.lumaProfileUrl,
      lumaExternalId: row.lumaExternalId,
      lumaDisplayName: row.lumaDisplayName,
      primaryHostEvents: primary,
      coHostEvents: co,
      otherCredits: total - primary - co,
    };
  });
}

export async function getAmbassador(id: string, db: Db = pooledDb()) {
  const all = await listAmbassadors(db);
  return all.find((row) => row.id === id) ?? null;
}

interface Actor {
  id: string;
  email?: string | null;
}

async function audit(
  db: Db,
  actor: Actor,
  entry: {
    action: string;
    /** Null for a site-wide action, which belongs to no single record. */
    entityId: string | null;
    entityType?: string;
    fromStatus?: string | null;
    toStatus?: string | null;
    note?: string;
  },
): Promise<void> {
  await db.insert(schema.auditLog).values({
    actorId: actor.id,
    actorEmail: actor.email ?? null,
    action: entry.action,
    entityType: entry.entityType ?? 'ambassador',
    entityId: entry.entityId,
    fromStatus: entry.fromStatus ?? null,
    toStatus: entry.toStatus ?? null,
    note: entry.note ?? null,
  });
}

/**
 * Create an ambassador. §36.
 *
 * `verifiedVia` is required here as well as in the database. The duplication
 * is on purpose: the database constraint is what makes it impossible, and this
 * check is what makes the failure a sentence a moderator can read instead of a
 * constraint violation.
 */
export async function createAmbassador(
  form: FormData,
  actor: Actor,
  db: Db = pooledDb(),
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  let name: string;
  let cityId: string;
  let verifiedVia: string;
  try {
    name = required(form.get('name'));
    cityId = required(form.get('cityId'));
    verifiedVia = required(form.get('verifiedVia'));
  } catch {
    return {
      ok: false,
      error: 'Name, city and "how this was verified" are all required. An ambassador record without provenance is not one.',
    };
  }

  const slug = blank(form.get('slug')) ?? slugify(name);
  if (!slug) return { ok: false, error: 'That name does not produce a usable slug. Set one by hand.' };

  try {
    const [row] = await db
      .insert(schema.ambassadors)
      .values({
        slug,
        name,
        cityId,
        verifiedVia,
        // A record is created in `draft` and published deliberately. §36 gives
        // moderators the ability to add an ambassador; it does not follow that
        // adding one should immediately alter the public leaderboard.
        status: 'draft',
        verifiedAt: new Date(),
        verifiedBy: actor.id,
        bio: blank(form.get('bio')),
        lumaProfileUrl: blank(form.get('lumaProfileUrl')),
        lumaDisplayName: blank(form.get('lumaDisplayName')),
        lumaExternalId: blank(form.get('lumaExternalId')),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning({ id: schema.ambassadors.id });

    await audit(db, actor, {
      action: 'ambassador.created',
      entityId: row.id,
      toStatus: 'draft',
      note: `${name} (${slug}) — verified via: ${verifiedVia}`,
    });

    return { ok: true, id: row.id };
  } catch (error) {
    return { ok: false, error: conflictMessage(error) };
  }
}

/**
 * Turn a database constraint into something a moderator can act on.
 *
 * The unique index on the normalised Luma display name is the one that will
 * actually fire in practice, and "duplicate key value violates unique
 * constraint" tells a reader nothing about what to do. It is also the most
 * important refusal in the system — see `matchAmbassador()`.
 */
function conflictMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (text.includes('ambassadors_luma_display_name_unique')) {
    return 'Another ambassador is already configured with that Luma organiser name. One organiser name can only map to one person — that is what keeps event attribution unambiguous.';
  }
  if (text.includes('ambassadors_slug')) return 'That slug is already taken.';
  if (text.includes('ambassadors_member_unique')) {
    return 'That member account is already linked to another ambassador.';
  }
  if (text.includes('ambassadors_luma_external_unique')) {
    return 'That Luma user id is already linked to another ambassador.';
  }
  if (text.includes('ambassadors_builder_unique')) {
    return 'That builder profile is already linked to another ambassador.';
  }
  return 'That change could not be saved.';
}

/** Edit metadata, the Luma identity, and the links. §36. */
export async function updateAmbassador(
  id: string,
  form: FormData,
  actor: Actor,
  db: Db = pooledDb(),
): Promise<{ ok: true } | { ok: false; error: string }> {
  const [existing] = await db
    .select()
    .from(schema.ambassadors)
    .where(eq(schema.ambassadors.id, id));
  if (!existing) return { ok: false, error: 'No such ambassador.' };

  const verifiedVia = blank(form.get('verifiedVia'));
  if (!verifiedVia) {
    return { ok: false, error: 'Provenance cannot be removed. Every ambassador record has to say how the status was confirmed.' };
  }

  const values = {
    name: blank(form.get('name')) ?? existing.name,
    cityId: blank(form.get('cityId')) ?? existing.cityId,
    verifiedVia,
    bio: blank(form.get('bio')),
    lumaProfileUrl: blank(form.get('lumaProfileUrl')),
    lumaDisplayName: blank(form.get('lumaDisplayName')),
    lumaExternalId: blank(form.get('lumaExternalId')),
    updatedAt: new Date(),
  };

  try {
    await db.update(schema.ambassadors).set(values).where(eq(schema.ambassadors.id, id));
  } catch (error) {
    return { ok: false, error: conflictMessage(error) };
  }

  const changed = Object.entries(values)
    .filter(([key, value]) => key !== 'updatedAt' && value !== (existing as Record<string, unknown>)[key])
    .map(([key]) => key);

  await audit(db, actor, {
    action: 'ambassador.updated',
    entityId: id,
    note: changed.length > 0 ? `changed: ${changed.join(', ')}` : 'no field changed',
  });

  return { ok: true };
}

/**
 * Link, or unlink, a WITH CLAUDE member account. §25, §26.
 *
 * Takes a username and resolves it, rather than taking a member id: a
 * moderator has a handle in front of them, not a uuid, and a form that asks
 * for a uuid invites pasting the wrong one.
 *
 * ── WHY THIS IS NOT A MATCH ──────────────────────────────────────────────
 *
 * §26 forbids claiming an ambassador identity by name or city similarity.
 * This is an explicit, audited act by a named moderator against a named
 * account — the "moderator-reviewed mapping" §16 permits — and there is
 * deliberately no function anywhere that links these two tables automatically.
 */
export async function linkMember(
  id: string,
  username: string | null,
  actor: Actor,
  db: Db = pooledDb(),
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!username) {
    await db
      .update(schema.ambassadors)
      .set({ memberId: null, updatedAt: new Date() })
      .where(eq(schema.ambassadors.id, id));
    await audit(db, actor, {
      action: 'ambassador.linked',
      entityId: id,
      note: 'member link removed',
    });
    return { ok: true };
  }

  const [profile] = await db
    .select({ memberId: schema.memberProfiles.memberId })
    .from(schema.memberProfiles)
    .where(eq(schema.memberProfiles.username, username.trim().toLowerCase()));

  if (!profile) return { ok: false, error: `No member account with the username "${username}".` };

  try {
    await db
      .update(schema.ambassadors)
      .set({ memberId: profile.memberId, updatedAt: new Date() })
      .where(eq(schema.ambassadors.id, id));
  } catch (error) {
    return { ok: false, error: conflictMessage(error) };
  }

  await audit(db, actor, {
    action: 'ambassador.linked',
    entityId: id,
    note: `linked to member @${username.trim().toLowerCase()}`,
  });
  return { ok: true };
}

/**
 * Publish or disable an ambassador. §36.
 *
 * `archived` rather than a delete. §52 forbids rewriting history to tidy a
 * dataset, and a disabled ambassador's events still happened — the record
 * leaves the public site and the event archive is untouched. Note what this
 * does NOT do: it does not remove their `event_hosts` rows. The public reader
 * drops credits for an unpublished ambassador when it builds the `RecordSet`,
 * so disabling is reversible and loses nothing.
 */
export async function setAmbassadorStatus(
  id: string,
  status: 'published' | 'archived' | 'draft',
  actor: Actor,
  db: Db = pooledDb(),
): Promise<{ ok: true } | { ok: false; error: string }> {
  const [existing] = await db
    .select({ status: schema.ambassadors.status, name: schema.ambassadors.name })
    .from(schema.ambassadors)
    .where(eq(schema.ambassadors.id, id));
  if (!existing) return { ok: false, error: 'No such ambassador.' };

  await db
    .update(schema.ambassadors)
    .set({ status, updatedAt: new Date() })
    .where(eq(schema.ambassadors.id, id));

  await audit(db, actor, {
    action: status === 'archived' ? 'ambassador.disabled' : 'ambassador.updated',
    entityId: id,
    fromStatus: existing.status,
    toStatus: status,
    note: `${existing.name} ${status === 'archived' ? 'disabled' : `set to ${status}`}`,
  });

  return { ok: true };
}

/**
 * Correct a host attribution. §37.
 *
 * The correction is written with `source: 'manual'`, which is what makes it
 * survive: `attributeIngestedEvent()` refuses to overwrite any primary row it
 * did not write itself, so the next sync leaves this alone. That is the whole
 * mechanism behind "moderators can correct without editing the underlying Luma
 * source record destructively" — the staging row in `event_source_records`
 * keeps saying exactly what the feed said, and the canonical attribution says
 * what the moderator determined.
 */
export async function correctEventHost(
  eventId: string,
  options: { ambassadorId: string | null; role: EventHostRole },
  actor: Actor,
  db: Db = pooledDb(),
): Promise<{ ok: true } | { ok: false; error: string }> {
  const [event] = await db
    .select({ slug: schema.events.slug })
    .from(schema.events)
    .where(eq(schema.events.id, eventId));
  if (!event) return { ok: false, error: 'No such event.' };

  if (!options.ambassadorId) {
    if (options.role === 'primary_host') {
      await clearPrimaryHost(db as never, eventId);
    } else {
      return { ok: false, error: 'Removing a non-primary credit needs the ambassador it belongs to.' };
    }
    await audit(db, actor, {
      action: 'event.host.unlinked',
      entityType: 'event',
      entityId: eventId,
      note: `${event.slug}: ${options.role} cleared`,
    });
    return { ok: true };
  }

  try {
    if (options.role === 'primary_host') {
      await setPrimaryHost({
        db: db as never,
        eventId,
        ambassadorId: options.ambassadorId,
        source: 'manual',
        confidence: 1,
        sourceLabel: `corrected by ${actor.email ?? actor.id}`,
      });
    } else {
      await setHostCredit({
        db: db as never,
        eventId,
        ambassadorId: options.ambassadorId,
        role: options.role,
        source: 'manual',
        confidence: 1,
        sourceLabel: `added by ${actor.email ?? actor.id}`,
      });
    }
  } catch (error) {
    return { ok: false, error: conflictMessage(error) };
  }

  await audit(db, actor, {
    action: 'event.host.linked',
    entityType: 'event',
    entityId: eventId,
    note: `${event.slug}: ${options.role} set`,
  });
  return { ok: true };
}

/** Drop one non-primary credit. §37. */
export async function removeEventCredit(
  eventId: string,
  ambassadorId: string,
  role: Exclude<EventHostRole, 'primary_host'>,
  actor: Actor,
  db: Db = pooledDb(),
): Promise<{ ok: true }> {
  await removeHostCredit(db as never, eventId, ambassadorId, role);
  await audit(db, actor, {
    action: 'event.host.unlinked',
    entityType: 'event',
    entityId: eventId,
    note: `${role} credit removed`,
  });
  return { ok: true };
}

/**
 * "Recalculate the leaderboard." §36 — and an honest implementation of it.
 *
 * There is nothing stored to recalculate. The score is derived on every build
 * by `src/lib/leaderboard.ts` from `event_hosts`, which is why §61's
 * determinism is provable at all: no cached total can disagree with the rows,
 * because no total is cached.
 *
 * So what a moderator actually needs after changing an attribution is for the
 * PUBLIC SITE to be rebuilt, since the leaderboard lives on prerendered pages.
 * A button labelled "recalculate" that quietly did nothing would be worse than
 * no button.
 *
 * ── WHY IT CALLS `triggerDeploy()` AND DOES NOT READ THE HOOK ────────────
 *
 * `tests/admin-isolation.test.ts` asserts that exactly one module in this
 * application may name the deploy-hook environment variable at all, and it is
 * `server/publishing.ts`. The rule is worth more than the convenience of a
 * second `fetch`: one deploy path means one place where "what starts a
 * production build" is answered, and the first version of this function broke
 * that rule and was caught by that test. Reused rather than reimplemented —
 * which is also §65.
 */
export async function requestLeaderboardRebuild(
  actor: Actor,
  db: Db = pooledDb(),
): Promise<{ ok: boolean; message: string }> {
  const outcome = await triggerDeploy();

  await audit(db, actor, {
    action: 'leaderboard.recalculated',
    entityType: 'site',
    entityId: null,
    note: outcome.triggered
      ? 'public rebuild triggered; scores are derived at build time'
      : `rebuild not triggered (${outcome.reason})`,
  });

  return {
    ok: outcome.triggered,
    message: outcome.triggered
      ? 'Rebuild triggered. The leaderboard is recomputed from event records during the build.'
      : `${deployMessage(outcome)} Attribution changes are saved either way.`,
  };
}

/** The audit trail for one ambassador, newest first. §38. */
export async function ambassadorAudit(id: string, db: Db = pooledDb()) {
  return db
    .select({
      action: schema.auditLog.action,
      actorEmail: schema.auditLog.actorEmail,
      fromStatus: schema.auditLog.fromStatus,
      toStatus: schema.auditLog.toStatus,
      note: schema.auditLog.note,
      createdAt: schema.auditLog.createdAt,
    })
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.entityType, 'ambassador'), eq(schema.auditLog.entityId, id)))
    .orderBy(desc(schema.auditLog.createdAt))
    .limit(50);
}

/** Cities, for the create/edit selects. */
export async function cityOptions(db: Db = pooledDb()) {
  return db
    .select({ id: schema.cities.id, name: schema.cities.name, slug: schema.cities.slug })
    .from(schema.cities)
    .orderBy(schema.cities.name);
}

/**
 * Ingested events whose organiser matched nobody, newest first. §35.
 *
 * The working queue for attribution: each row is an event that is live on the
 * site with no host credit, and the organiser string the feed gave for it.
 * A moderator either maps that string to an ambassador (which fixes every
 * future event from the same organiser) or attributes this one event by hand.
 */
export async function unattributedIngestedEvents(db: Db = pooledDb()) {
  const attributed = new Set(
    (
      await db
        .select({ eventId: schema.eventHosts.eventId })
        .from(schema.eventHosts)
        .where(eq(schema.eventHosts.role, 'primary_host'))
    ).map((row) => row.eventId),
  );

  const rows = await db
    .select({
      eventId: schema.events.id,
      slug: schema.events.slug,
      title: schema.events.title,
      date: schema.events.date,
      cityId: schema.events.cityId,
      organizer: schema.eventSourceRecords.organizer,
    })
    .from(schema.events)
    .leftJoin(
      schema.eventSourceRecords,
      eq(schema.eventSourceRecords.eventId, schema.events.id),
    )
    .where(and(eq(schema.events.status, 'published'), sql`${schema.events.sourceId} IS NOT NULL`))
    .orderBy(desc(schema.events.date))
    .limit(100);

  const cities = await db
    .select({ id: schema.cities.id, name: schema.cities.name })
    .from(schema.cities);
  const cityName = new Map(cities.map((c) => [c.id, c.name]));

  return rows
    .filter((row) => !attributed.has(row.eventId))
    .map((row) => ({ ...row, cityName: cityName.get(row.cityId) ?? '—' }));
}

/** Source health plus the attribution figures §35 asks to see beside it. */
export async function sourceStatus(db: Db = pooledDb()) {
  const [sources, staged, credits] = await Promise.all([
    db.select().from(schema.eventSources).orderBy(schema.eventSources.key),
    db
      .select({
        sourceId: schema.eventSourceRecords.sourceId,
        state: schema.eventSourceRecords.state,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.eventSourceRecords)
      .groupBy(schema.eventSourceRecords.sourceId, schema.eventSourceRecords.state),
    db
      .select({ source: schema.eventHosts.source, count: sql<number>`count(*)::int` })
      .from(schema.eventHosts)
      .groupBy(schema.eventHosts.source),
  ]);

  const byState = new Map<string, Map<string, number>>();
  for (const row of staged) {
    const bucket = byState.get(row.sourceId) ?? new Map<string, number>();
    bucket.set(row.state, Number(row.count));
    byState.set(row.sourceId, bucket);
  }

  return {
    sources: sources.map((source) => ({
      ...source,
      states: Object.fromEntries(byState.get(source.id) ?? new Map()),
    })),
    attribution: Object.fromEntries(credits.map((row) => [row.source, Number(row.count)])),
  };
}

/** Published ambassadors, for an attribution select. */
export async function ambassadorOptions(db: Db = pooledDb()) {
  return db
    .select({ id: schema.ambassadors.id, name: schema.ambassadors.name, slug: schema.ambassadors.slug })
    .from(schema.ambassadors)
    .where(inArray(schema.ambassadors.status, ['published', 'draft']))
    .orderBy(schema.ambassadors.name);
}
