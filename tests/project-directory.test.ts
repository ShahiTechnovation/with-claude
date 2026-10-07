/**
 * THE PROJECT DIRECTORY, ON A REAL DATABASE (PGlite, all migrations).
 *
 *   1. the Impact Lab 2 correction (13 → 15 September) in migration 0016 —
 *      targeted, guarded, idempotent, UUID-preserving — and the Luma sync
 *      cannot undo it;
 *   2. directory semantics: OR within a group, AND across groups, link
 *      switches as requirements, facet counts, sorts, search, the public
 *      predicate everywhere (hidden/draft never counted);
 *   3. the whole import pipeline through the file-backed Baserow stand-in:
 *      adapter → plan → apply → reconcile/queue → projection, re-run with no
 *      change, a claimed project and a moderator hold left alone.
 *
 * Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import * as schema from '../db/schema';
import { ManualEventSource } from '../src/server/events/registry';
import { syncSource } from '../src/server/events/sync';
import {
  allPublicProjectCards,
  directoryHref,
  eventLabel,
  getProjectDetail,
  INDEPENDENT,
  listPublicProjects,
  normaliseDirectoryQuery,
  publicProjectCountForEvent,
  publicProjectsForEvent,
  relatedPublicProjects,
} from '../src/server/public/projects';
import { projectGroups } from '../src/server/public/pages';
import { eventLabel as eventLabelFromLib } from '../src/lib/event-display';
import { FileBaserow } from '../scripts/import/lib/file-baserow';
import { buildPlan } from '../scripts/import/lib/plan';
import { applyPlan, type Decision } from '../scripts/import/lib/apply';
import {
  fieldOptionsFrom,
  loadBaserowProjects,
  loadCrosswalk,
  loadNeonProjects,
} from '../scripts/import/lib/existing';
import { reconcile, runQueue } from '../src/server/integrations/baserow/sync';
import {
  buildArchiveCandidates,
  type ArchiveDecisions,
} from '../scripts/import/sources/event-archive-2026-09/index';
import type { Workbook } from '../scripts/import/lib/workbook';

let db: TestDatabase;
let bhopal: string;
let indore: string;

beforeAll(async () => {
  db = await createTestDatabase();
  const [c1, c2] = await db
    .insert(schema.cities)
    .values([
      {
        slug: 'bhopal',
        name: 'Bhopal',
        region: 'Madhya Pradesh',
        lat: 23.26,
        lon: 77.41,
        blurb: 'b',
        status: 'published',
      },
      {
        slug: 'indore',
        name: 'Indore',
        region: 'Madhya Pradesh',
        lat: 22.72,
        lon: 75.86,
        blurb: 'i',
        status: 'published',
      },
    ])
    .returning({ id: schema.cities.id });
  bhopal = c1!.id;
  indore = c2!.id;
}, 60_000);

afterAll(async () => {
  await db?.$close();
});

const event = (o: Partial<typeof schema.events.$inferInsert> & { slug: string; date: string }) =>
  db
    .insert(schema.events)
    .values({
      title: o.slug,
      format: 'hackathon',
      cityId: bhopal,
      startTime: '10:00',
      venueName: 'Hall',
      summary: 'A day.',
      status: 'published',
      ...o,
    })
    .returning()
    .then((r) => r[0]!);

// ── 1. the event correction ──────────────────────────────────────────────

/** The data statements of migration 0016 (everything after the DDL). */
function correctionStatements(): string[] {
  const text = readFileSync(
    join(process.cwd(), 'db/migrations/0016_project_directory.sql'),
    'utf8',
  );
  return text
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => /^(--[^\n]*\n)*\s*UPDATE/i.test(s));
}

describe('Impact Lab 2: one event, held 15 September (announced for 13)', () => {
  it('the migration moves the curated row in place — same UUID and slug — and records the announced date', async () => {
    const before = await event({
      slug: 'claude-impact-lab-september',
      title: 'Claude Impact Lab',
      date: '2026-09-13',
      startTime: '10:00',
      endTime: '19:00',
    });
    const other = await event({
      slug: 'another-event-on-the-13th',
      date: '2026-09-13',
      summary: 'Unrelated, on 13 September.',
    });
    await event({
      slug: 'claude-conversation-september',
      date: '2026-09-12',
      description:
        'A small, focused evening for founders and builders around one question. The room picks a real problem worth solving — and the Impact Lab spends the next day building the answer.',
    });
    const statements = correctionStatements();
    expect(statements.length).toBe(3);
    for (const s of statements) await db.execute(sql.raw(s));

    const [after] = await db.select().from(schema.events).where(eq(schema.events.id, before.id));
    expect(after).toMatchObject({
      slug: 'claude-impact-lab-september',
      date: '2026-09-15',
      rescheduledFrom: '2026-09-13',
      startTime: '09:00:00',
      endTime: '18:00:00',
      title: 'Claude Code Impact Lab 2',
      shortTitle: 'Impact Lab 2',
    });
    // Nothing else that happens to mention or sit on the 13th moved.
    const [untouched] = await db.select().from(schema.events).where(eq(schema.events.id, other.id));
    expect(untouched!.date).toBe('2026-09-13');
    expect(untouched!.summary).toBe('Unrelated, on 13 September.');
    const [conversation] = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.slug, 'claude-conversation-september'));
    expect(conversation!.description).toMatch(/the Impact Lab builds the answer\.$/);
    // Re-running is a no-op; there is still exactly one Impact Lab row.
    for (const s of statements) await db.execute(sql.raw(s));
    const labs = await db
      .select()
      .from(schema.events)
      .where(sql`${schema.events.slug} like 'claude-impact-lab%'`);
    expect(labs.map((e) => e.id)).toEqual([before.id]);
  });

  it('the Luma feed links to the curated event and never rewrites its date — even if the feed still said the 13th', async () => {
    const [lab] = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.slug, 'claude-impact-lab-september'));
    await db
      .update(schema.events)
      .set({ registrationUrl: 'https://luma.com/claude-r61u' })
      .where(eq(schema.events.id, lab!.id));
    const source = new ManualEventSource(
      [
        {
          externalId: 'evt-mLFu3IoSUvVP1FA',
          title: 'Bhopal | Claude Impact Lab',
          startsAt: new Date('2026-09-13T04:30:00Z'), // a stale feed still on the original date
          location: 'Check event page for more details.',
          latitude: 23.27,
          longitude: 77.45,
          registrationUrl: 'https://luma.com/claude-r61u',
        },
      ],
      { key: 'luma:test', complete: true },
    );
    const summary = await syncSource(source, db);
    expect(summary.matchedCurated).toBe(1);
    const [after] = await db.select().from(schema.events).where(eq(schema.events.id, lab!.id));
    expect(after!.date).toBe('2026-09-15');
    expect(after!.rescheduledFrom).toBe('2026-09-13');
    const labs = await db
      .select()
      .from(schema.events)
      .where(sql`${schema.events.title} ilike '%impact lab%'`);
    expect(labs).toHaveLength(1);
    const [record] = await db
      .select()
      .from(schema.eventSourceRecords)
      .where(eq(schema.eventSourceRecords.externalId, 'evt-mLFu3IoSUvVP1FA'));
    expect(record!.eventId).toBe(lab!.id);
  });
});

// ── 2. directory semantics ───────────────────────────────────────────────

describe('directory queries', () => {
  let fable: typeof schema.events.$inferSelect;
  let lab: typeof schema.events.$inferSelect;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    [lab] = (await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.slug, 'claude-impact-lab-september'))) as [
      typeof schema.events.$inferSelect,
    ];
    fable = await event({
      slug: 'bhopal-fable-build-day',
      title: 'Bhopal | Claude Code Build Day - Fable 5.1',
      date: '2026-09-20',
      shortTitle: 'Fable 5.1 Build Day',
    });
    const indoreEvent = await event({
      slug: 'indore-build-day',
      title: 'Indore Build Day',
      date: '2026-08-01',
      cityId: indore,
    });
    const hidden = await event({ slug: 'hidden-event', date: '2026-09-25', status: 'draft' });
    const mk = async (key: string, o: Partial<typeof schema.projects.$inferInsert>) => {
      const [p] = await db
        .insert(schema.projects)
        .values({
          slug: `dq-${key.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          title: key,
          summary: `${key} summary`,
          category: 'product',
          publicationStatus: 'published',
          status: 'published',
          moderationState: 'clean',
          contentAuthority: 'baserow',
          publishedAt: new Date('2026-10-01T00:00:00Z'),
          ...o,
        })
        .returning({ id: schema.projects.id });
      ids[key] = p!.id;
    };
    await mk('Alpha', {
      builtAtEventId: fable.id,
      category: 'agent',
      url: 'https://a.example',
      repoUrl: 'https://github.com/x/a',
      buildStatus: 'functional',
    });
    await mk('beta', {
      builtAtEventId: fable.id,
      repoUrl: 'https://github.com/x/b',
      videoUrl: 'https://youtu.be/b',
      buildStatus: 'prototype',
    });
    await mk('Gamma Traffic', {
      builtAtEventId: lab.id,
      repoUrl: 'https://github.com/x/g',
      videoUrl: 'https://youtu.be/g',
    });
    await mk('delta', {
      builtAtEventId: indoreEvent.id,
      category: 'agent',
      url: 'https://d.example',
    });
    await mk('Independent One', {
      url: 'https://i.example',
      publishedAt: new Date('2026-10-02T00:00:00Z'),
    });
    await mk('on-hidden-event', { builtAtEventId: hidden.id, url: 'https://h.example' });
    // Never public, never counted:
    await mk('draft-one', {
      builtAtEventId: fable.id,
      publicationStatus: 'draft',
      status: 'draft',
      url: 'https://x.example',
    });
    await mk('restricted-one', {
      builtAtEventId: fable.id,
      moderationState: 'restricted',
      url: 'https://x.example',
    });
    await mk('deleted-one', {
      builtAtEventId: fable.id,
      deletedAt: new Date(),
      url: 'https://x.example',
    });
    await db
      .insert(schema.projectCredits)
      .values({ projectId: ids.beta!, displayName: 'Team Kisan', role: 'Team', position: 0 });
  });

  const titles = (r: Awaited<ReturnType<typeof listPublicProjects>>) => r.items.map((p) => p.title);

  it('never counts or lists a draft, restricted or deleted project', async () => {
    const all = await listPublicProjects(db, {});
    expect(all.totalPublic).toBe(all.total);
    expect(titles(all)).not.toEqual(expect.arrayContaining(['draft-one']));
    expect(titles(all).some((t) => /draft-one|restricted-one|deleted-one/.test(t))).toBe(false);
    const fableFacet = all.facets.events.find((e) => e.value === fable.slug)!;
    expect(fableFacet.count).toBe(2);
    expect(await publicProjectCountForEvent(db, fable.id)).toBe(2);
    expect((await publicProjectsForEvent(db, fable.id)).map((p) => p.title).sort()).toEqual([
      'Alpha',
      'beta',
    ]);
  });

  it('an event label drops only a prefix that repeats the event city, as the archive does', async () => {
    expect(eventLabel('Bangalore | Claude Fable Build Day', null, 'Bengaluru')).toBe(
      'Claude Fable Build Day',
    );
    expect(eventLabel('Claude Code | Build Day', null, 'Bhopal')).toBe('Claude Code | Build Day');
    expect(eventLabel('Bhopal | Claude Meetup', null, null)).toBe('Bhopal | Claude Meetup');
    expect(eventLabel('Bhopal | Claude Meetup', ' Meetup ', 'Bhopal')).toBe('Meetup');

    // The filter option is cleaned the same way as the card's event.
    const { facets } = await listPublicProjects(db, {});
    const labels = facets.events.map((f) => f.label);
    expect(labels).toContain('Fable 5.1 Build Day');
    expect(labels.some((label) => label.includes('|'))).toBe(false);
  });

  it('the shared event DTO carries the held date, label, city and UUID — on lists, details and related', async () => {
    const all = await listPublicProjects(db, { events: [lab.slug] });
    const gamma = all.items[0]!;
    expect(gamma.event).toMatchObject({
      id: lab.id,
      slug: lab.slug,
      label: 'Impact Lab 2',
      date: '2026-09-15',
      rescheduledFrom: '2026-09-13',
      city: { slug: 'bhopal', name: 'Bhopal' },
    });
    const detail = await getProjectDetail(db, gamma.slug);
    expect(detail?.event).toEqual(gamma.event);
    const alpha = (await listPublicProjects(db, { q: 'Alpha' })).items[0]!;
    expect(alpha.event?.label).toBe('Fable 5.1 Build Day');
    expect(alpha.event?.name).toBe('Claude Code Build Day\u00a0- Fable 5.1');
    const related = await relatedPublicProjects(db, alpha);
    expect(related.map((p) => p.title)).toEqual(['beta']); // never itself, never a hidden one
  });

  it('a project on a non-public event is independent (no badge) and sorts after dated ones', async () => {
    const r = await listPublicProjects(db, { events: [INDEPENDENT] });
    expect(titles(r).sort()).toEqual(['Independent One', 'on-hidden-event']);
    expect(r.items.every((p) => p.event === null)).toBe(true);
    const byEvent = await listPublicProjects(db, { sort: 'event' });
    expect(titles(byEvent).slice(-2).sort()).toEqual(['Independent One', 'on-hidden-event']);
    expect(titles(byEvent).slice(0, 2)).toEqual(['Alpha', 'beta']);
  });

  it('OR within the event group, AND across groups, AND across link switches', async () => {
    expect((await listPublicProjects(db, { events: [fable.slug, lab.slug] })).total).toBe(3);
    expect(
      titles(
        await listPublicProjects(db, { events: [fable.slug, lab.slug], categories: ['agent'] }),
      ),
    ).toEqual(['Alpha']);
    expect(titles(await listPublicProjects(db, { has: ['repo', 'video'] })).sort()).toEqual([
      'Gamma Traffic',
      'beta',
    ]);
    expect((await listPublicProjects(db, { has: ['live', 'video'] })).total).toBe(0);
    expect(titles(await listPublicProjects(db, { cities: ['indore'] }))).toEqual(['delta']);
    expect(
      titles(await listPublicProjects(db, { statuses: ['prototype', 'functional'] })).sort(),
    ).toEqual(['Alpha', 'beta']);
  });

  it('facet counts apply the OTHER groups, so each option shows what choosing it would give', async () => {
    const r = await listPublicProjects(db, { events: [fable.slug], has: ['repo'] });
    // The event group is counted without its own selection (alternatives stay visible)…
    expect(r.facets.events.find((e) => e.value === lab.slug)!.count).toBe(1);
    // …while categories are counted inside the chosen event and the repo requirement.
    expect(r.facets.categories.find((c) => c.value === 'agent')!.count).toBe(1);
    // A link switch counts with the other switches still applied.
    expect(r.facets.has.find((h) => h.value === 'video')!.count).toBe(1);
    // City is the EVENT's city.
    expect(r.facets.cities.map((c) => c.value).sort()).toEqual(['bhopal', 'indore']);
    // Status options exist only where a status was reported.
    expect(r.facets.statuses.map((s) => s.value)).toEqual(['functional', 'prototype']);
  });

  it('search covers title, summary, the team label and the event name — literally', async () => {
    expect(titles(await listPublicProjects(db, { q: 'traffic' }))).toEqual(['Gamma Traffic']);
    expect(titles(await listPublicProjects(db, { q: 'kisan' }))).toEqual(['beta']);
    expect((await listPublicProjects(db, { q: 'Fable 5.1' })).total).toBe(2);
    expect((await listPublicProjects(db, { q: '%' })).total).toBe(0);
  });

  it('search also covers the description and every credited name — never a builder no page credits', async () => {
    await db
      .update(schema.projects)
      .set({ description: 'Files a legal aid request.' })
      .where(eq(schema.projects.id, ids.delta!));
    const builder = (
      slug: string,
      name: string,
      o: Partial<typeof schema.builders.$inferInsert> = {},
    ) =>
      db
        .insert(schema.builders)
        .values({ slug, name, cityId: bhopal, role: 'Builder', status: 'pending', ...o })
        .returning({ id: schema.builders.id })
        .then((r) => r[0]!.id);
    await db.insert(schema.projectBuilders).values([
      { projectId: ids.Alpha!, builderId: await builder('dq-kestrel', 'Kestrel Builder') },
      {
        projectId: ids.Alpha!,
        builderId: await builder('dq-osprey', 'Osprey Archived', { status: 'archived' }),
      },
      {
        projectId: ids.Alpha!,
        builderId: await builder('dq-heron', 'Heron Held', { moderationState: 'restricted' }),
      },
    ]);
    await db.insert(schema.projectCredits).values({
      projectId: ids.delta!,
      displayName: 'Wren Organiser',
      role: 'Design',
      position: 1,
    });

    expect(titles(await listPublicProjects(db, { q: 'legal' }))).toEqual(['delta']);
    expect(titles(await listPublicProjects(db, { q: 'kestrel builder' }))).toEqual(['Alpha']);
    expect(titles(await listPublicProjects(db, { q: 'wren' }))).toEqual(['delta']);
    expect((await listPublicProjects(db, { q: 'osprey' })).total).toBe(0);
    expect((await listPublicProjects(db, { q: 'heron' })).total).toBe(0);
    // `_` stays literal on the new paths too.
    expect((await listPublicProjects(db, { q: 'legal_aid' })).total).toBe(0);
    expect((await listPublicProjects(db, { q: 'kestrel_builder' })).total).toBe(0);
  });

  it('sorts are stable and distinct; Name A–Z is case-insensitive; Featured falls back when nothing is featured', async () => {
    const byName = titles(await listPublicProjects(db, { sort: 'name' }));
    expect(byName).toEqual(
      [...byName].sort((a, b) =>
        Buffer.from(a.toLowerCase()).compare(Buffer.from(b.toLowerCase())),
      ),
    );
    const recent = await listPublicProjects(db, { sort: 'recent' });
    expect(recent.items[0]!.title).toBe('Independent One');
    const featured = await listPublicProjects(db, { sort: 'featured' });
    expect(featured.featuredAvailable).toBe(false);
    expect(featured.query.sort).toBe('event');
    const p1 = await listPublicProjects(db, { sort: 'name', pageSize: 2, page: 1 });
    const p2 = await listPublicProjects(db, { sort: 'name', pageSize: 2, page: 2 });
    expect(new Set([...titles(p1), ...titles(p2)]).size).toBe(4);
  });

  it('URL state round-trips: repeated keys, unknown values dropped, page reset by the caller', () => {
    const q = normaliseDirectoryQuery(
      new URLSearchParams(
        'event=a&event=b&category=agent&category=nope&has=repo&has=evil&status=partial&sort=name&page=3&q=traffic',
      ),
    );
    expect(q).toEqual({
      q: 'traffic',
      events: ['a', 'b'],
      categories: ['agent'],
      cities: [],
      statuses: ['partial'],
      has: ['repo'],
      sort: 'name',
      page: 3,
    });
    expect(directoryHref({ ...q, page: 1 })).toBe(
      '/projects/?q=traffic&event=a&event=b&category=agent&status=partial&has=repo&sort=name',
    );
    expect(normaliseDirectoryQuery(new URLSearchParams(directoryHref(q).split('?')[1]))).toEqual(q);
  });

  it('a team label is the team, not a person credit; no logo means the placeholder', async () => {
    const beta = (await listPublicProjects(db, { q: 'beta' })).items[0]!;
    expect(beta.team).toBe('Team Kisan');
    expect(beta.credits).toEqual([]);
    expect(beta.logo.kind).toBe('placeholder');
  });

  it('a card carries the description and its event the cover; the lib eventLabel is the same function', async () => {
    await db
      .update(schema.projects)
      .set({ description: 'Alpha, in its own words.' })
      .where(eq(schema.projects.id, ids.Alpha!));
    await db
      .update(schema.events)
      .set({ coverImagePath: 'covers/fable.jpg' })
      .where(eq(schema.events.id, fable.id));
    const alpha = (await listPublicProjects(db, { q: 'Alpha' })).items[0]!;
    expect(alpha.description).toBe('Alpha, in its own words.');
    expect(alpha.event?.coverImage).toBe('covers/fable.jpg');
    const gamma = (await listPublicProjects(db, { events: [lab.slug] })).items[0]!;
    expect(gamma.description).toBeNull();
    expect(gamma.event?.coverImage).toBeNull();
    expect((await getProjectDetail(db, alpha.slug))?.description).toBe('Alpha, in its own words.');
    expect(eventLabel).toBe(eventLabelFromLib);
  });

  it('allPublicProjectCards and projectGroups: every public card, one group per event, newest first, no event last', async () => {
    const all = await allPublicProjectCards(db);
    const listed = await listPublicProjects(db, {});
    expect(all.map((p) => p.slug)).toEqual(listed.items.map((p) => p.slug));
    expect(all.some((p) => /draft-one|restricted-one|deleted-one/.test(p.title))).toBe(false);

    const groups = await projectGroups(db);
    expect(groups.map((g) => g.event?.slug ?? null)).toEqual([
      fable.slug,
      lab.slug,
      'indore-build-day',
      null,
    ]);
    expect(groups.map((g) => g.items.map((p) => p.title))).toEqual([
      ['Alpha', 'beta'],
      ['Gamma Traffic'],
      ['delta'],
      ['Independent One', 'on-hidden-event'],
    ]);
    expect(groups.flatMap((g) => g.items).length).toBe(listed.totalPublic);
  });

  it('atEvents counts only projects built at a public event, whatever the filters', async () => {
    const all = await listPublicProjects(db, {});
    // 'Independent One' has no event and 'on-hidden-event' sits on a hidden one.
    expect(all.atEvents).toBe(all.totalPublic - 2);
    const filtered = await listPublicProjects(db, { events: [fable.slug] });
    expect(filtered.atEvents).toBe(all.atEvents);
    expect(filtered.totalPublic).toBe(all.totalPublic);
  });
});

// ── 3. the pipeline, end to end ──────────────────────────────────────────

const FABLE_HEADERS = [
  'Timestamp',
  'Email address',
  'Team Name',
  'Provide a publicly accessible link to your working project.',
  'Provide the Github repository containing your project source code.',
  'What problem did you identify, and who experiences it?',
  'Briefly explain your solution, its core functionality, and how it solves the problem.',
  'A 2-minute screen recording of your product demo.',
  'Is your submitted project currently functional?',
  'Public Showcase Requirement',
  'Final Confirmation',
];
const IL_HEADERS = [
  'Timestamp',
  'Email address',
  'Email',
  'Team member 1 (name)',
  'Member 1 Email',
  'Team Name',
  'Member 2 Name',
  'Member 2 Email',
  'Member 3 Name',
  'Member 3 email',
  'Member 4 Name',
  'Member 4 email',
  'Number of Team Members',
  'Project Name',
  'What problem are you solving?',
  'Tell us about your solution',
  'What did you build it with?',
  'GitHub Repository',
  'Live or Deployed Project',
  'Demo Video',
  'Drive link',
  'Want Your Project Featured by Claude?',
  'GitHub and Hackathon Work',
  'Our Work',
  'Everything Works',
  'Final Confirmation',
  'Anything else you want us to know?',
];
const wb = (rows: string[][]): Workbook => ({
  format: 'xlsx',
  sheets: [
    { name: 'Form responses 1', rows, dateCells: new Set(), formulaCells: 0, hidden: false },
  ],
  hasMacros: false,
  date1904: false,
  checksum: 'x',
});
const fb = (team: string, live: string, repo: string, status = 'Fully functional') => [
  '46285.6',
  'p@example.test',
  team,
  live,
  repo,
  'A problem.',
  'A solution. Claude writes the summaries.',
  '',
  status,
  '',
  'I confirm',
];
const il = (team: string, title: string, repo: string) => {
  const r = new Array(27).fill('');
  Object.assign(r, {
    0: '46280.6',
    1: 'a@example.test',
    3: 'Person Name',
    5: team,
    12: '1',
    13: title,
    14: 'Problem.',
    15: 'Solution.',
    16: 'React',
    17: repo,
  });
  return r as string[];
};

describe('the import pipeline through the file-backed Baserow', () => {
  let dir: string;
  let fixture: FileBaserow;
  const decisions: ArchiveDecisions = {
    'impact-lab-2': {
      2: {
        expect: 'p/one',
        disposition: 'publish',
        summary: 'One summary text.',
        category: 'product',
      },
    },
    'fable-5-1': {
      2: {
        expect: 'p/two',
        disposition: 'publish',
        title: 'Two',
        titleEvidence: 't',
        summary: 'Two summary text.',
        category: 'agent',
      },
      3: {
        expect: 'p/three',
        disposition: 'hold',
        title: 'Three',
        titleEvidence: 't',
        summary: 'Three summary text.',
        category: 'product',
        holds: ['title unclear'],
      },
    },
    repeats: [],
  };
  const workbooks = () => ({
    'impact-lab-2': wb([IL_HEADERS, il('Team One', 'One', 'https://github.com/p/one')]),
    'fable-5-1': wb([
      FABLE_HEADERS,
      fb('Team Two', 'https://two.example.com', 'https://github.com/p/two'),
      fb('Team Three', '', 'https://github.com/p/three'),
    ]),
  });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wc-fixture-'));
    fixture = new FileBaserow(join(dir, 'baserow.json'));
    const c = fixture.config;
    const [lab] = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.slug, 'claude-impact-lab-september'));
    const [fable] = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.slug, 'bhopal-fable-build-day'));
    const city = await fixture.createRow(c.tables.cities!.tableId, {
      [fixture.field('cities', 'slug')]: 'bhopal',
    });
    for (const [key, e] of [
      ['evt-il2', lab!],
      ['evt-f51', fable!],
    ] as const) {
      await fixture.createRow(c.tables.events.tableId, {
        [fixture.field('events', 'key')]: key,
        [fixture.field('events', 'neonId')]: e.id,
        [fixture.field('events', 'title')]: e.title,
        [fixture.field('events', 'summary')]: e.summary,
        [fixture.field('events', 'city')]: [city.id],
        [fixture.field('events', 'venueName')]: e.venueName,
        [fixture.field('events', 'date')]: e.date,
        [fixture.field('events', 'rescheduledFrom')]: e.rescheduledFrom,
        [fixture.field('events', 'shortTitle')]: e.shortTitle,
        [fixture.field('events', 'startTime')]: String(e.startTime).slice(0, 5),
        [fixture.field('events', 'format')]: fixture.optionId('events', 'format', e.format),
        [fixture.field('events', 'editorialStatus')]: fixture.optionId(
          'events',
          'editorialStatus',
          'published',
        ),
      });
    }
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function importOnce() {
    const eventsTable = (await fixture.listAllRows(fixture.config.tables.events.tableId)).rows;
    const keyField = fixture.field('events', 'key');
    const built = buildArchiveCandidates(
      workbooks(),
      {
        'impact-lab-2': {
          key: 'evt-il2',
          baserowRowId: eventsTable.find((r) => r[keyField] === 'evt-il2')!.id,
        },
        'fable-5-1': {
          key: 'evt-f51',
          baserowRowId: eventsTable.find((r) => r[keyField] === 'evt-f51')!.id,
        },
      },
      {},
      decisions,
    );
    const config = fixture.config;
    const [baserowRows, neonProjects, crosswalk] = await Promise.all([
      loadBaserowProjects(fixture, config),
      loadNeonProjects(db),
      loadCrosswalk(db),
    ]);
    const plan = buildPlan({
      label: 'test archive',
      file: 'x',
      checksum: 'x',
      candidates: built.candidates,
      stats: {
        sourceRows: 3,
        blankRows: 0,
        groupedRows: 0,
        invalidLinks: 0,
        withheldColumns: [],
        withheldPublicValues: 0,
        creditsWithoutConsent: 0,
      },
      errors: [],
      crosswalk,
      baserowRows,
      neonProjects,
    });
    const [batch] = await db
      .insert(schema.importBatches)
      .values({ label: 'test', sourceFile: 'x', checksum: 'x', mapping: {} })
      .returning({ id: schema.importBatches.id });
    const decide: Record<string, Decision> = Object.fromEntries(
      plan.items.map((i) => [
        i.key,
        i.action === 'unchanged'
          ? 'skip'
          : i.action === 'review' && !i.reasons.every((r) => r.startsWith('held:'))
            ? 'hold'
            : 'apply',
      ]),
    );
    const report = await applyPlan({
      db,
      writer: fixture,
      config,
      batchId: batch!.id,
      plan,
      candidates: built.candidates,
      decisions: decide,
      options: fieldOptionsFrom(await fixture.listFields(config.tables.projects.tableId), config),
      publish: true,
    });
    for (let pass = 0; pass < 3; pass += 1) {
      await reconcile(db, fixture, config);
      await runQueue(db, fixture, config, { budgetMs: 20_000, trigger: 'manual', batchSize: 25 });
    }
    return { plan, report };
  }

  const imported = () =>
    db
      .select()
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.contentAuthority, 'baserow'),
          sql`${schema.projects.slug} not like 'dq-%'`,
        ),
      );

  it('projects publishable candidates as public and holds as drafts, with the event joined by UUID', async () => {
    const { report } = await importOnce();
    expect(report).toMatchObject({ created: 3, failed: [], publishedRequested: 2 });
    const rows = await imported();
    expect(rows.map((r) => [r.title, r.publicationStatus]).sort()).toEqual([
      ['One', 'published'],
      ['Three', 'draft'],
      ['Two', 'published'],
    ]);
    const two = rows.find((r) => r.title === 'Two')!;
    const [fable] = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.slug, 'bhopal-fable-build-day'));
    expect(two.builtAtEventId).toBe(fable!.id);
    expect(two.buildStatus).toBe('functional');
    expect(two.claudeUsage).toBe('Claude writes the summaries.');
    // The adopted events keep the corrected date after projection.
    const [lab] = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.slug, 'claude-impact-lab-september'));
    expect(lab).toMatchObject({
      date: '2026-09-15',
      rescheduledFrom: '2026-09-13',
      contentAuthority: 'baserow',
    });
    // Held drafts are 404 for the public and absent from lists and counts.
    const three = rows.find((r) => r.title === 'Three')!;
    expect((await getProjectDetail(db, three.slug))?.isPublic).toBe(false);
    expect((await listPublicProjects(db, { q: 'Three' })).total).toBe(0);
    // No person was credited, no account created.
    expect(
      await db
        .select()
        .from(schema.projectCredits)
        .where(sql`${schema.projectCredits.displayName} = 'Person Name'`),
    ).toEqual([]);
  });

  it('the same import again creates and updates nothing', async () => {
    const before = (await imported()).length;
    const credits = (await db.select().from(schema.projectCredits)).length;
    const { plan, report } = await importOnce();
    expect(plan.totals.create).toBe(0);
    expect(report.created + report.updated + report.credits).toBe(0);
    expect((await imported()).length).toBe(before);
    expect((await db.select().from(schema.projectCredits)).length).toBe(credits);
  });

  it('a claimed project and a moderator hold are left alone by a later import', async () => {
    const rows = await imported();
    const one = rows.find((r) => r.title === 'One')!;
    const two = rows.find((r) => r.title === 'Two')!;
    await db
      .update(schema.projects)
      .set({ contentAuthority: 'member', title: 'One (edited by its owner)' })
      .where(eq(schema.projects.id, one.id));
    await db
      .update(schema.projects)
      .set({ moderationState: 'restricted' })
      .where(eq(schema.projects.id, two.id));
    // An organiser edit in Baserow for both.
    const projects = (await fixture.listAllRows(fixture.config.tables.projects.tableId)).rows;
    const titleField = fixture.field('projects', 'title');
    for (const row of projects)
      await fixture.updateRow(fixture.config.tables.projects.tableId, row.id, {
        [titleField]: `${row[titleField]} — organiser edit`,
      });
    await reconcile(db, fixture, fixture.config);
    await runQueue(db, fixture, fixture.config, { budgetMs: 20_000, trigger: 'manual' });
    const [oneAfter] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, one.id));
    const [twoAfter] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, two.id));
    expect(oneAfter!.title).toBe('One (edited by its owner)');
    expect(twoAfter!.moderationState).toBe('restricted');
    expect((await listPublicProjects(db, { q: 'Two' })).total).toBe(0);
  });
});
