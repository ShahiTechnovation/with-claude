/**
 * HOST ATTRIBUTION — the invariant, the matcher, and what a re-sync may not do.
 *
 * Three things are under test, and they are the three that would each produce a
 * quietly wrong public leaderboard:
 *
 *  1. `events.ambassador_id` and the canonical `primary_host` row never
 *     disagree. Every mutation is followed by an `attributionDrift()` check,
 *     which is the same query the admin runs in production.
 *  2. Matching is exact against a configured mapping and nothing else. The
 *     negative cases matter more than the positive one — §16 is a rule about
 *     what must NOT match.
 *  3. A sync cannot overwrite a human's attribution. §37.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import * as schema from '../db/schema';
import {
  attributeIngestedEvent,
  attributionDrift,
  clearPrimaryHost,
  loadAmbassadorIdentities,
  matchAmbassador,
  organizerKey,
  removeHostCredit,
  setHostCredit,
  setPrimaryHost,
  unresolvedOrganizers,
} from '../src/server/events/hosts';

let db: TestDatabase;
let cityId: string;
let eventId: string;
let aniket: string;
let priya: string;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db?.$close();
});

beforeEach(async () => {
  // A fresh graph per test. Deleting the city cascades nothing (it is
  // `restrict`), so the children go first, in dependency order.
  await db.delete(schema.eventHosts);
  await db.delete(schema.events);
  await db.delete(schema.eventSourceRecords);
  await db.delete(schema.eventSources);
  await db.delete(schema.ambassadors);
  await db.delete(schema.cities);

  [{ id: cityId }] = await db
    .insert(schema.cities)
    .values({ slug: 'bhopal', name: 'Bhopal', region: 'Madhya Pradesh', lat: 23.25, lon: 77.4, blurb: 'x', status: 'published' })
    .returning({ id: schema.cities.id });

  [{ id: aniket }] = await db
    .insert(schema.ambassadors)
    .values({
      slug: 'aniket-sahu',
      name: 'Aniket Sahu',
      cityId,
      verifiedVia: 'test',
      status: 'published',
      lumaDisplayName: 'Aniket Sahu',
    })
    .returning({ id: schema.ambassadors.id });

  [{ id: priya }] = await db
    .insert(schema.ambassadors)
    .values({
      slug: 'priya-nair',
      name: 'Priya Nair',
      cityId,
      verifiedVia: 'test',
      status: 'published',
      lumaDisplayName: 'Priya  Nair',
    })
    .returning({ id: schema.ambassadors.id });

  [{ id: eventId }] = await db
    .insert(schema.events)
    .values({
      slug: 'bhopal-build-day',
      title: 'Build Day',
      format: 'workshop',
      cityId,
      date: '2026-03-01',
      startTime: '16:00:00',
      venueName: 'Somewhere',
      summary: 'A room.',
      status: 'published',
    })
    .returning({ id: schema.events.id });
});

const primaryRow = async () => {
  const [row] = await db
    .select()
    .from(schema.eventHosts)
    .where(and(eq(schema.eventHosts.eventId, eventId), eq(schema.eventHosts.role, 'primary_host')));
  return row;
};

const columnValue = async () => {
  const [row] = await db
    .select({ ambassadorId: schema.events.ambassadorId })
    .from(schema.events)
    .where(eq(schema.events.id, eventId));
  return row.ambassadorId;
};

describe('the invariant: column and canonical row agree', () => {
  it('holds after setting a primary host', async () => {
    await setPrimaryHost({ db, eventId, ambassadorId: aniket, source: 'curated' });
    expect((await primaryRow()).ambassadorId).toBe(aniket);
    expect(await columnValue()).toBe(aniket);
    expect(await attributionDrift(db)).toEqual([]);
  });

  it('holds after replacing one host with another', async () => {
    await setPrimaryHost({ db, eventId, ambassadorId: aniket, source: 'curated' });
    await setPrimaryHost({ db, eventId, ambassadorId: priya, source: 'manual' });

    // Exactly one primary row, and it is the new person — not two rows, which
    // is what a naive upsert against a three-part primary key would leave.
    const rows = await db
      .select()
      .from(schema.eventHosts)
      .where(and(eq(schema.eventHosts.eventId, eventId), eq(schema.eventHosts.role, 'primary_host')));
    expect(rows).toHaveLength(1);
    expect(rows[0].ambassadorId).toBe(priya);
    expect(await columnValue()).toBe(priya);
    expect(await attributionDrift(db)).toEqual([]);
  });

  it('holds after clearing', async () => {
    await setPrimaryHost({ db, eventId, ambassadorId: aniket, source: 'curated' });
    await clearPrimaryHost(db, eventId);
    expect(await primaryRow()).toBeUndefined();
    expect(await columnValue()).toBeNull();
    expect(await attributionDrift(db)).toEqual([]);
  });

  it('is not disturbed by non-primary credits', async () => {
    await setPrimaryHost({ db, eventId, ambassadorId: aniket, source: 'curated' });
    await setHostCredit({ db, eventId, ambassadorId: priya, role: 'co_host', source: 'manual' });
    expect(await columnValue()).toBe(aniket);
    expect(await attributionDrift(db)).toEqual([]);

    await removeHostCredit(db, eventId, priya, 'co_host');
    expect(await columnValue()).toBe(aniket);
    expect(await attributionDrift(db)).toEqual([]);
  });

  it('reports drift when the column is written behind its back', async () => {
    // Proves the audit query actually detects the state it exists to forbid —
    // a check that can never fail is not a check. This is the one place in the
    // suite that writes `ambassador_id` directly.
    await db.update(schema.events).set({ ambassadorId: aniket }).where(eq(schema.events.id, eventId));
    const drift = await attributionDrift(db);
    expect(drift).toEqual([{ slug: 'bhopal-build-day', column: aniket, canonical: null }]);
  });
});

describe('the database refuses a second primary host', () => {
  it('rejects two primary rows on one event', async () => {
    await setPrimaryHost({ db, eventId, ambassadorId: aniket, source: 'curated' });
    await expect(
      db.insert(schema.eventHosts).values({
        eventId,
        ambassadorId: priya,
        role: 'primary_host',
        source: 'manual',
      }),
    ).rejects.toThrow();
  });

  it('allows the same person in a second, different role', async () => {
    await setPrimaryHost({ db, eventId, ambassadorId: aniket, source: 'curated' });
    await setHostCredit({ db, eventId, ambassadorId: aniket, role: 'organizer', source: 'manual' });
    const rows = await db.select().from(schema.eventHosts).where(eq(schema.eventHosts.eventId, eventId));
    expect(rows).toHaveLength(2);
  });

  it('refuses a confidence outside 0–1', async () => {
    await expect(
      db.insert(schema.eventHosts).values({
        eventId,
        ambassadorId: aniket,
        role: 'co_host',
        source: 'ingest',
        confidence: '1.50',
      }),
    ).rejects.toThrow();
  });
});

describe('the organiser match key', () => {
  it('folds case and collapses whitespace', () => {
    expect(organizerKey('  Aniket   Sahu ')).toBe('aniket sahu');
    expect(organizerKey('ANIKET SAHU')).toBe('aniket sahu');
  });

  it('is null for nothing', () => {
    expect(organizerKey('')).toBeNull();
    expect(organizerKey('   ')).toBeNull();
    expect(organizerKey(null)).toBeNull();
  });

  it('does not fold anything else', () => {
    // No accent folding and no punctuation stripping: both widen the match.
    expect(organizerKey('Nexø')).toBe('nexø');
    expect(organizerKey('Xavier (최훈민)')).toBe('xavier (최훈민)');
  });
});

describe('matching an organiser to an ambassador', () => {
  it('matches a configured display name exactly', async () => {
    const identities = await loadAmbassadorIdentities(db);
    const match = matchAmbassador(identities, { organizer: 'Aniket Sahu' });
    expect(match).toMatchObject({ ambassadorId: aniket, via: 'luma_display_name' });
  });

  it('matches through case and whitespace differences', async () => {
    const identities = await loadAmbassadorIdentities(db);
    expect(matchAmbassador(identities, { organizer: 'aniket   sahu' })?.ambassadorId).toBe(aniket);
    // Priya is configured with a doubled space; the key collapses both sides.
    expect(matchAmbassador(identities, { organizer: 'Priya Nair' })?.ambassadorId).toBe(priya);
  });

  it('does NOT match a name that merely resembles one', async () => {
    const identities = await loadAmbassadorIdentities(db);
    for (const near of ['Aniket', 'A. Sahu', 'Aniket Sahu Jr', 'Sahu Aniket', 'aniketsahu']) {
      expect(matchAmbassador(identities, { organizer: near })).toBeNull();
    }
  });

  it('does NOT match an ambassador by their own name when no mapping is configured', async () => {
    // The crux of §16. Vikram's name is on the record; his Luma identity is
    // not configured, so a feed naming him produces no attribution.
    await db.insert(schema.ambassadors).values({
      slug: 'vikram-rao',
      name: 'Vikram Rao',
      cityId,
      verifiedVia: 'test',
      status: 'published',
    });
    const identities = await loadAmbassadorIdentities(db);
    expect(matchAmbassador(identities, { organizer: 'Vikram Rao' })).toBeNull();
  });

  it('ignores an ambassador who is not published', async () => {
    await db
      .update(schema.ambassadors)
      .set({ status: 'archived' })
      .where(eq(schema.ambassadors.id, aniket));
    const identities = await loadAmbassadorIdentities(db);
    expect(matchAmbassador(identities, { organizer: 'Aniket Sahu' })).toBeNull();
  });

  it('prefers a stable external id over a display name', async () => {
    await db
      .update(schema.ambassadors)
      .set({ lumaExternalId: 'usr-123' })
      .where(eq(schema.ambassadors.id, priya));
    const identities = await loadAmbassadorIdentities(db);
    const match = matchAmbassador(identities, {
      organizer: 'Aniket Sahu',
      organizerExternalId: 'usr-123',
    });
    expect(match).toMatchObject({ ambassadorId: priya, via: 'luma_external_id' });
  });
});

describe('the database forbids an ambiguous mapping', () => {
  it('refuses to configure one organiser name against two ambassadors', async () => {
    // This is why `matchAmbassador` never has to break a tie.
    await expect(
      db.insert(schema.ambassadors).values({
        slug: 'imposter',
        name: 'Someone Else',
        cityId,
        verifiedVia: 'test',
        status: 'published',
        lumaDisplayName: 'aniket sahu',
      }),
    ).rejects.toThrow();
  });
});

describe('attributing an ingested event', () => {
  it('writes a matched attribution', async () => {
    const identities = await loadAmbassadorIdentities(db);
    const outcome = await attributeIngestedEvent({
      db,
      eventId,
      identities,
      event: { organizer: 'Aniket Sahu' },
    });
    expect(outcome).toBe('matched');
    const row = await primaryRow();
    expect(row.source).toBe('ingest');
    expect(row.sourceLabel).toBe('Aniket Sahu');
    expect(await columnValue()).toBe(aniket);
  });

  it('leaves an unmatched organiser unattributed, and the event intact', async () => {
    const identities = await loadAmbassadorIdentities(db);
    const outcome = await attributeIngestedEvent({
      db,
      eventId,
      identities,
      event: { organizer: 'Sumeet G Doshi' },
    });
    expect(outcome).toBe('unresolved');
    expect(await primaryRow()).toBeUndefined();

    // §31: still a published event. An unattributed event is not a broken one.
    const [row] = await db
      .select({ status: schema.events.status })
      .from(schema.events)
      .where(eq(schema.events.id, eventId));
    expect(row.status).toBe('published');
  });

  it('distinguishes no organiser from an unresolved one', async () => {
    const identities = await loadAmbassadorIdentities(db);
    expect(
      await attributeIngestedEvent({ db, eventId, identities, event: { organizer: null } }),
    ).toBe('no-organizer');
  });

  it('will not overwrite a curated attribution', async () => {
    await setPrimaryHost({ db, eventId, ambassadorId: priya, source: 'curated' });
    const identities = await loadAmbassadorIdentities(db);
    const outcome = await attributeIngestedEvent({
      db,
      eventId,
      identities,
      event: { organizer: 'Aniket Sahu' },
    });
    expect(outcome).toBe('kept-existing');
    expect(await columnValue()).toBe(priya);
  });

  it('will not overwrite a moderator correction, however many times it runs', async () => {
    // §37 — the regression that would make the admin look haunted.
    await setPrimaryHost({ db, eventId, ambassadorId: priya, source: 'manual' });
    const identities = await loadAmbassadorIdentities(db);
    for (let i = 0; i < 3; i += 1) {
      await attributeIngestedEvent({ db, eventId, identities, event: { organizer: 'Aniket Sahu' } });
    }
    expect((await primaryRow()).ambassadorId).toBe(priya);
    expect((await primaryRow()).source).toBe('manual');
  });

  it('updates its own earlier attribution when the organiser changes', async () => {
    const identities = await loadAmbassadorIdentities(db);
    await attributeIngestedEvent({ db, eventId, identities, event: { organizer: 'Aniket Sahu' } });
    await attributeIngestedEvent({ db, eventId, identities, event: { organizer: 'Priya Nair' } });
    expect((await primaryRow()).ambassadorId).toBe(priya);
    expect(await attributionDrift(db)).toEqual([]);
  });

  it('does not clear an existing attribution when the match goes away', async () => {
    const identities = await loadAmbassadorIdentities(db);
    await attributeIngestedEvent({ db, eventId, identities, event: { organizer: 'Aniket Sahu' } });
    // The mapping is removed; the feed still lists the event.
    await db
      .update(schema.ambassadors)
      .set({ lumaDisplayName: null })
      .where(eq(schema.ambassadors.id, aniket));
    const after = await loadAmbassadorIdentities(db);
    await attributeIngestedEvent({ db, eventId, identities: after, event: { organizer: 'Aniket Sahu' } });
    expect((await primaryRow()).ambassadorId).toBe(aniket);
  });

  it('is idempotent — repeated runs do not accumulate rows', async () => {
    const identities = await loadAmbassadorIdentities(db);
    for (let i = 0; i < 5; i += 1) {
      await attributeIngestedEvent({ db, eventId, identities, event: { organizer: 'Aniket Sahu' } });
    }
    const rows = await db.select().from(schema.eventHosts).where(eq(schema.eventHosts.eventId, eventId));
    expect(rows).toHaveLength(1);
  });
});

describe('unresolved organisers, for the admin', () => {
  it('counts the organisers nobody claims, commonest first', async () => {
    const [source] = await db
      .insert(schema.eventSources)
      .values({ key: 'luma:test', provider: 'luma', label: 'Test', syncMode: 'ics' })
      .returning({ id: schema.eventSources.id });

    /**
     * Each staged row is LINKED to a real event, because the queue is
     * "published events with nobody credited" and an unpromoted record is not
     * one. The live Claude Community feed stages 317 events and promotes ~13,
     * so a query that ignored the link would return the other 304 calendars'
     * organisers.
     */
    const makeEvent = async (slug: string) => {
      const [row] = await db
        .insert(schema.events)
        .values({
          slug,
          title: slug,
          format: 'meetup',
          cityId,
          date: '2026-03-01',
          startTime: '10:00:00',
          venueName: 'Somewhere',
          summary: 'x',
          status: 'published',
          sourceId: source.id,
          externalId: slug,
        })
        .returning({ id: schema.events.id });
      return row.id;
    };

    const staged = async (externalId: string, organizer: string) => ({
      sourceId: source.id,
      externalId,
      title: 't',
      startsAt: new Date('2026-03-01T10:00:00Z'),
      organizer,
      rawHash: externalId,
      state: 'promoted' as const,
      eventId: await makeEvent(externalId),
    });

    await db.insert(schema.eventSourceRecords).values([
      await staged('evt-1', 'Sumeet G Doshi'),
      await staged('evt-2', 'Sumeet G Doshi'),
      await staged('evt-3', 'Shubhangi Gupta'),
    ]);

    const unresolved = await unresolvedOrganizers(db, source.id);
    expect(unresolved).toEqual([
      { organizer: 'Sumeet G Doshi', events: 2 },
      { organizer: 'Shubhangi Gupta', events: 1 },
    ]);
  });

  it('does not list an organiser whose event is already attributed', async () => {
    const [source] = await db
      .insert(schema.eventSources)
      .values({ key: 'luma:test2', provider: 'luma', label: 'Test', syncMode: 'ics' })
      .returning({ id: schema.eventSources.id });

    await db.insert(schema.eventSourceRecords).values({
      sourceId: source.id,
      externalId: 'evt-9',
      title: 't',
      startsAt: new Date('2026-03-01T10:00:00Z'),
      organizer: 'Aniket Sahu',
      rawHash: 'evt-9',
      state: 'promoted',
      eventId,
    });

    await setPrimaryHost({ db, eventId, ambassadorId: aniket, source: 'ingest' });
    expect(await unresolvedOrganizers(db, source.id)).toEqual([]);
  });
});
