/**
 * HOST ATTRIBUTION — the one writer, and the only matcher.
 *
 * §17 wants every imported event related to its hosts. §16 wants that
 * relationship established from a stable identity rather than from a name that
 * looks about right. §31 wants an event with no confident host to remain a
 * perfectly good event that is simply unattributed. §37 wants a moderator's
 * correction to survive the next sync.
 *
 * Those four requirements are in tension, and this module is where the tension
 * is resolved once instead of at every call site.
 *
 * ── THE INVARIANT ────────────────────────────────────────────────────────
 *
 *     events.ambassador_id  ==  the ambassador_id of that event's single
 *                               `primary_host` row in `event_hosts`, or NULL
 *
 * `event_hosts` is canonical — it carries the role, the provenance and the
 * confidence. `events.ambassador_id` is a denormalisation of its primary row,
 * kept because `RecordSet`, `cityState()` and the prerendered pages read it.
 *
 * Two writes that must not diverge is exactly the shape of bug that gets
 * written when two modules each do half of it, so every mutation in the system
 * goes through `setPrimaryHost()` or `clearPrimaryHost()` here, and
 * `tests/event-hosts.test.ts` asserts the invariant holds after each. Nothing
 * else may UPDATE `events.ambassador_id`.
 *
 * ── WHY MATCHING IS NOT FUZZY, AND WHAT IT COSTS ─────────────────────────
 *
 * The Claude Community calendar is an ICS feed. Its entire statement about who
 * is running an event is `ORGANIZER;CN="Some Name":MAILTO:calendar@…` — a
 * display name, and a MAILTO that is the same generic calendar address on
 * every one of the 317 events. There is no Luma user id and no profile URL in
 * the feed.
 *
 * So the only key available is a name, and §16 forbids matching ambassadors by
 * name similarity. The way out is that this does not match on
 * `ambassadors.name` at all. It matches on `ambassadors.luma_display_name`: a
 * column that is empty by default and holds the organiser string an admin has
 * actually seen and assigned. An exact match against a human-entered mapping
 * is §16's "manually verified mapping", not its "fuzzy name matching" — the
 * difference being that a wrong match here requires a person to have typed the
 * wrong thing, rather than two people sharing a surname.
 *
 * What it costs is coverage: until an admin configures a mapping, real events
 * hosted by real ambassadors come in unattributed. That is the intended
 * trade. An unattributed event is honest and fixable; a wrongly attributed one
 * moves a public leaderboard and nobody notices.
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import * as schema from '../../../db/schema';
import type { AnyDatabase } from './sync';

/** The roles §19 scores, plus speaking, which it does not. */
export type EventHostRole = (typeof schema.eventHostRole.enumValues)[number];
export type EventHostSource = (typeof schema.eventHostSource.enumValues)[number];

/**
 * Fold an organiser string to its match key.
 *
 * Lower-cased, trimmed, and internal whitespace collapsed — and nothing else.
 * No accent folding, no punctuation stripping, no initials: every one of those
 * widens the match, and a wider match is the failure mode this module is built
 * to avoid. `"Xavier (최훈민)"` matches only itself.
 *
 * The same expression is indexed in the database
 * (`ambassadors_luma_display_name_unique` uses `lower(btrim(...))`), which is
 * what makes "at most one row can match" a guarantee rather than a query
 * result we hope stays true. Whitespace collapsing is done here and not in the
 * index because a doubled space inside a configured name is a typo we can
 * absorb on read, not a second identity.
 */
export function organizerKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = raw.replace(/\s+/g, ' ').trim().toLowerCase();
  return key.length > 0 ? key : null;
}

export interface AmbassadorMatch {
  ambassadorId: string;
  /** What the source actually said, stored on the row for review. */
  sourceLabel: string;
  /** Which of §16's tiers produced this. Recorded, never inferred later. */
  via: 'luma_external_id' | 'luma_display_name';
}

/**
 * The configured Luma identities, read once per sync.
 *
 * Returned as lookup maps rather than queried per event: a sync processes 317
 * events, and a query each would be the N+1 §45 forbids. Only `published`
 * ambassadors are loaded — a draft or archived ambassador record is not a
 * thing to attribute an event to, and §36's "disable ambassador" is
 * implemented as exactly that status change.
 */
export async function loadAmbassadorIdentities(db: AnyDatabase) {
  const rows = await db
    .select({
      id: schema.ambassadors.id,
      lumaExternalId: schema.ambassadors.lumaExternalId,
      lumaDisplayName: schema.ambassadors.lumaDisplayName,
    })
    .from(schema.ambassadors)
    .where(eq(schema.ambassadors.status, 'published'));

  const byExternalId = new Map<string, string>();
  const byDisplayName = new Map<string, string>();
  for (const row of rows) {
    if (row.lumaExternalId) byExternalId.set(row.lumaExternalId, row.id);
    const key = organizerKey(row.lumaDisplayName);
    if (key) byDisplayName.set(key, row.id);
  }
  return { byExternalId, byDisplayName, configured: rows.length };
}

export type AmbassadorIdentities = Awaited<ReturnType<typeof loadAmbassadorIdentities>>;

/**
 * Resolve one event's organiser to an ambassador, in §16's order of preference.
 *
 * Returns null for "we do not know", which is a valid and common answer. There
 * is deliberately no third return value for "probably" — a probable match with
 * a low confidence would still appear on a public profile as a hosted event,
 * and §31 says not to force attribution.
 */
export function matchAmbassador(
  identities: AmbassadorIdentities,
  event: { organizer?: string | null; organizerExternalId?: string | null },
): AmbassadorMatch | null {
  // 1. A stable provider id. Never available from ICS; preferred when it is.
  if (event.organizerExternalId) {
    const id = identities.byExternalId.get(event.organizerExternalId);
    if (id) {
      return { ambassadorId: id, sourceLabel: event.organizerExternalId, via: 'luma_external_id' };
    }
  }

  // 2. An exact match on a mapping a human configured.
  const key = organizerKey(event.organizer);
  if (key) {
    const id = identities.byDisplayName.get(key);
    if (id) {
      return {
        ambassadorId: id,
        sourceLabel: (event.organizer ?? '').trim(),
        via: 'luma_display_name',
      };
    }
  }

  return null;
}

/**
 * Who currently holds the primary host row, and on whose authority.
 *
 * The `source` is what makes §37 work: a sync must not overwrite what a
 * moderator corrected, and cannot know that without asking who wrote the row
 * it is about to replace.
 */
async function currentPrimary(db: AnyDatabase, eventId: string) {
  const [row] = await db
    .select({
      ambassadorId: schema.eventHosts.ambassadorId,
      source: schema.eventHosts.source,
      confidence: schema.eventHosts.confidence,
    })
    .from(schema.eventHosts)
    .where(and(eq(schema.eventHosts.eventId, eventId), eq(schema.eventHosts.role, 'primary_host')));
  return row ?? null;
}

/**
 * Set the primary host, and keep the denormalised column with it.
 *
 * Both writes or neither. They are not wrapped in a transaction because the
 * ingestion path runs against Neon's HTTP driver, where each statement is its
 * own round trip and a transaction is not available; the ordering is chosen so
 * that the failure between them is the harmless one — `event_hosts` first, so
 * a crash leaves a canonical row whose denormalisation is stale, which the
 * next sync corrects. The reverse order would leave `events.ambassador_id`
 * pointing at an ambassador with no attribution row to explain it, which is
 * the state the invariant exists to forbid.
 */
export async function setPrimaryHost(options: {
  db: AnyDatabase;
  eventId: string;
  ambassadorId: string;
  source: EventHostSource;
  /** §19 only scores 1. Anything lower is recorded and deliberately unscored. */
  confidence?: number;
  sourceLabel?: string | null;
}): Promise<void> {
  const { db, eventId, ambassadorId, source, confidence = 1, sourceLabel = null } = options;
  const now = new Date();

  const existing = await currentPrimary(db, eventId);
  if (existing && existing.ambassadorId !== ambassadorId) {
    // Replacing somebody. The unique index allows only one primary row, so the
    // old one has to go before the new one lands.
    await db
      .delete(schema.eventHosts)
      .where(
        and(eq(schema.eventHosts.eventId, eventId), eq(schema.eventHosts.role, 'primary_host')),
      );
  }

  await db
    .insert(schema.eventHosts)
    .values({
      eventId,
      ambassadorId,
      role: 'primary_host',
      source,
      confidence: confidence.toFixed(2),
      sourceLabel,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [schema.eventHosts.eventId, schema.eventHosts.ambassadorId, schema.eventHosts.role],
      set: {
        source: sql`excluded.source`,
        confidence: sql`excluded.confidence`,
        sourceLabel: sql`excluded.source_label`,
        updatedAt: now,
      },
    });

  await db
    .update(schema.events)
    .set({ ambassadorId, updatedAt: now })
    .where(eq(schema.events.id, eventId));
}

/** Remove the primary host, and the column with it. */
export async function clearPrimaryHost(db: AnyDatabase, eventId: string): Promise<void> {
  await db
    .delete(schema.eventHosts)
    .where(and(eq(schema.eventHosts.eventId, eventId), eq(schema.eventHosts.role, 'primary_host')));
  await db
    .update(schema.events)
    .set({ ambassadorId: null, updatedAt: new Date() })
    .where(eq(schema.events.id, eventId));
}

/**
 * Add or update a non-primary credit: co-host, organiser, partner, speaker.
 *
 * Separate function from `setPrimaryHost` because these roles do NOT touch
 * `events.ambassador_id` — there is nothing to denormalise, several people can
 * hold each role on one event, and conflating the two would let a co-host
 * silently become the event's headline host.
 */
export async function setHostCredit(options: {
  db: AnyDatabase;
  eventId: string;
  ambassadorId: string;
  role: Exclude<EventHostRole, 'primary_host'>;
  source: EventHostSource;
  confidence?: number;
  sourceLabel?: string | null;
}): Promise<void> {
  const { db, eventId, ambassadorId, role, source, confidence = 1, sourceLabel = null } = options;
  const now = new Date();
  await db
    .insert(schema.eventHosts)
    .values({
      eventId,
      ambassadorId,
      role,
      source,
      confidence: confidence.toFixed(2),
      sourceLabel,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [schema.eventHosts.eventId, schema.eventHosts.ambassadorId, schema.eventHosts.role],
      set: {
        source: sql`excluded.source`,
        confidence: sql`excluded.confidence`,
        sourceLabel: sql`excluded.source_label`,
        updatedAt: now,
      },
    });
}

/** Remove one credit. The primary role is refused — use `clearPrimaryHost`. */
export async function removeHostCredit(
  db: AnyDatabase,
  eventId: string,
  ambassadorId: string,
  role: Exclude<EventHostRole, 'primary_host'>,
): Promise<void> {
  await db
    .delete(schema.eventHosts)
    .where(
      and(
        eq(schema.eventHosts.eventId, eventId),
        eq(schema.eventHosts.ambassadorId, ambassadorId),
        eq(schema.eventHosts.role, role),
      ),
    );
}

/**
 * Attribute a freshly-ingested event, if it can be attributed. §31.
 *
 * ── WHAT THIS WILL NOT DO ────────────────────────────────────────────────
 *
 * It will not overwrite an attribution it did not write. A `curated` row came
 * from a human authoring the archive and a `manual` row came from a moderator
 * correcting this exact event (§37); a feed that reasserted its own guess on
 * every sync would undo that correction every hour and look like a haunting
 * rather than a bug.
 *
 * It will also not clear an existing attribution when the match comes back
 * empty. An organiser string changing, or an admin removing a mapping, is not
 * evidence that the event was not hosted by the person the record says hosted
 * it.
 *
 * Returns what happened, so the sync can report honest counts (§35) rather
 * than "ingestion completed".
 */
export async function attributeIngestedEvent(options: {
  db: AnyDatabase;
  eventId: string;
  identities: AmbassadorIdentities;
  event: { organizer?: string | null; organizerExternalId?: string | null };
}): Promise<'matched' | 'unresolved' | 'kept-existing' | 'no-organizer'> {
  const { db, eventId, identities, event } = options;

  const existing = await currentPrimary(db, eventId);
  if (existing && existing.source !== 'ingest') return 'kept-existing';

  const match = matchAmbassador(identities, event);
  if (!match) {
    if (!organizerKey(event.organizer) && !event.organizerExternalId) return 'no-organizer';
    return 'unresolved';
  }

  await setPrimaryHost({
    db,
    eventId,
    ambassadorId: match.ambassadorId,
    source: 'ingest',
    confidence: 1,
    sourceLabel: match.sourceLabel,
  });
  return 'matched';
}

/**
 * Every event whose column and canonical row disagree.
 *
 * Exists so the invariant is auditable in production rather than only in the
 * test suite — the admin source-status page reads it, and a non-empty result
 * is a bug in this module by definition.
 */
export async function attributionDrift(db: AnyDatabase) {
  const primaries = await db
    .select({ eventId: schema.eventHosts.eventId, ambassadorId: schema.eventHosts.ambassadorId })
    .from(schema.eventHosts)
    .where(eq(schema.eventHosts.role, 'primary_host'));
  const byEvent = new Map(primaries.map((row) => [row.eventId, row.ambassadorId]));

  const eventRows = await db
    .select({
      id: schema.events.id,
      slug: schema.events.slug,
      ambassadorId: schema.events.ambassadorId,
    })
    .from(schema.events);

  const drift: { slug: string; column: string | null; canonical: string | null }[] = [];
  for (const row of eventRows) {
    const canonical = byEvent.get(row.id) ?? null;
    if (canonical !== row.ambassadorId) {
      drift.push({ slug: row.slug, column: row.ambassadorId, canonical });
    }
  }
  return drift;
}

/**
 * Organisers of PUBLISHED events that no configured ambassador claims. §35.
 *
 * ── WHY IT IS SCOPED TO PROMOTED RECORDS ─────────────────────────────────
 *
 * The Claude Community calendar is a GLOBAL calendar: a sync of the live feed
 * stages 317 events and promotes the ~13 it can place in India. The other 304
 * are staged, correctly, and have organisers in Seoul, Tallinn and Brisbane.
 *
 * The first version of this query ignored that and returned every staged
 * organiser without a credit — 134 names, almost all of them people who have
 * never run an event in India and never will. An admin queue of 134 rows where
 * 8 matter is not a queue, it is a reason to stop opening the page.
 *
 * So: only records that were actually promoted to a public event
 * (`event_id IS NOT NULL`) and whose event has no primary host. That set is
 * exactly "events on the site with nobody credited", which is the work.
 */
export async function unresolvedOrganizers(db: AnyDatabase, sourceId?: string) {
  const rows = await db
    .select({
      organizer: schema.eventSourceRecords.organizer,
      eventId: schema.eventSourceRecords.eventId,
    })
    .from(schema.eventSourceRecords)
    .where(
      and(
        isNotNull(schema.eventSourceRecords.organizer),
        isNotNull(schema.eventSourceRecords.eventId),
        ...(sourceId ? [eq(schema.eventSourceRecords.sourceId, sourceId)] : []),
      ),
    );

  const attributed = new Set(
    (
      await db
        .select({ eventId: schema.eventHosts.eventId })
        .from(schema.eventHosts)
        .where(eq(schema.eventHosts.role, 'primary_host'))
    ).map((row) => row.eventId),
  );

  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.eventId && attributed.has(row.eventId)) continue;
    const key = row.organizer?.trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }


  return [...counts.entries()]
    .map(([organizer, events]) => ({ organizer, events }))
    .sort((a, b) => b.events - a.events || a.organizer.localeCompare(b.organizer));
}
