/**
 * BASEROW → NEON: the projection, the durable queue and reconciliation.
 *
 * A fake `RowSource` stands in for the Baserow API (the HTTP client has its
 * own suite in baserow-client.test.ts). Everything else is real: PGlite runs
 * the committed migrations, and the projection writes real rows.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import * as schema from '../db/schema';
import { BaserowError } from '../src/server/integrations/baserow/client';
import { ConfigSchema, type BaserowConfig } from '../src/server/integrations/baserow/config';
import { applyRow, archiveContractBlockers, tombstoneRow } from '../src/server/integrations/baserow/projection';
import { claim, enqueue, reconcile, retryFailed, runQueue, type RowSource } from '../src/server/integrations/baserow/sync';
import { parseWebhook, secretMatches } from '../src/server/integrations/baserow/webhook';
import { validateSchema } from '../src/server/integrations/baserow/spec';
import { parseCredit, parseProject } from '../src/server/integrations/baserow/dto';
import { listPublicProjects, getProjectDetail } from '../src/server/public/projects';

const T = { cities: 101, events: 102, projects: 103, credits: 104 };
const config: BaserowConfig = ConfigSchema.parse({
  tables: {
    cities: { tableId: T.cities, fields: { slug: 1, name: 2 } },
    events: {
      tableId: T.events,
      fields: {
        key: 10, neonId: 11, title: 12, slug: 13, summary: 14, description: 15, city: 16, venueName: 17,
        venuePrivate: 18, date: 19, startTime: 20, endTime: 21, timezone: 22, format: 23, registrationUrl: 24,
        lifecycle: 25, editorialStatus: 26, featured: 27,
      },
    },
    projects: {
      tableId: T.projects,
      fields: {
        key: 30, neonId: 31, title: 32, slug: 33, summary: 34, description: 35, category: 36, tags: 37,
        liveUrl: 38, repoUrl: 39, videoUrl: 40, claudeUsage: 41, event: 42, city: 43, teamName: 44,
        editorialStatus: 45, featured: 46, featuredOrder: 47,
      },
    },
    credits: { tableId: T.credits, fields: { project: 50, displayName: 51, role: 52, publicUrl: 53, displayOrder: 54 } },
  },
});

const sel = (value: string) => ({ id: 1, value, color: 'blue' });
const link = (id: number) => [{ id, value: String(id) }];

const cityRow = (id: number, slug: string) => ({ id, field_1: slug, field_2: slug });
const eventRow = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  field_10: `evt-${id}`,
  field_12: `Build Day ${id}`,
  field_14: 'A day of building with Claude.',
  field_16: link(1),
  field_17: 'Hall A',
  field_19: '2026-03-14',
  field_20: '10:00',
  field_21: '18:00',
  field_23: sel('hackathon'),
  field_26: sel('published'),
  ...over,
});
const projectRow = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  field_30: `prj-${id}`,
  field_32: `Imported ${id}`,
  field_34: 'Helps farmers price their crops.',
  field_36: sel('agent'),
  field_37: [sel('Claude Code')],
  field_39: 'https://github.com/example/repo',
  field_42: link(2),
  field_44: 'Team Kisan',
  field_45: sel('published'),
  ...over,
});
const creditRow = (id: number, projectRowId: number, name: string) => ({
  id,
  field_50: link(projectRowId),
  field_51: name,
  field_52: 'Developer',
  field_54: '1',
});

/** A fake Baserow: rows by table, with switchable failures. */
class FakeSource implements RowSource {
  tables = new Map<number, Map<number, Record<string, unknown> & { id: number }>>();
  failGet: BaserowError | null = null;
  incomplete = false;
  set(tableId: number, row: Record<string, unknown> & { id: number }) {
    if (!this.tables.has(tableId)) this.tables.set(tableId, new Map());
    this.tables.get(tableId)!.set(row.id, row);
  }
  remove(tableId: number, rowId: number) {
    this.tables.get(tableId)?.delete(rowId);
  }
  async getRow(tableId: number, rowId: number) {
    if (this.failGet) throw this.failGet;
    const row = this.tables.get(tableId)?.get(rowId);
    if (!row) throw new BaserowError('not-found', 'row not found', { status: 404, retryable: false });
    return structuredClone(row);
  }
  async listAllRows(tableId: number) {
    return { rows: [...(this.tables.get(tableId)?.values() ?? [])].map((r) => structuredClone(r)), complete: !this.incomplete, pages: 1 };
  }
}

let db: TestDatabase;
let source: FakeSource;
let cityId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  const [city] = await db
    .insert(schema.cities)
    .values({ slug: 'zz-baserow-city', name: 'Baserow City', region: 'R', lat: 20, lon: 75, blurb: 'Fixture.', status: 'published' })
    .returning({ id: schema.cities.id });
  cityId = city.id;
}, 60_000);

afterAll(async () => db?.$close());

beforeEach(async () => {
  await db.delete(schema.integrationJobs);
  await db.delete(schema.integrationMappings);
  await db.delete(schema.projectCredits);
  await db.delete(schema.projectBuilders);
  await db.delete(schema.projectMembers);
  await db.delete(schema.projects);
  await db.delete(schema.events);
  source = new FakeSource();
  source.set(T.cities, cityRow(1, 'zz-baserow-city'));
  source.set(T.events, eventRow(2));
  source.set(T.projects, projectRow(3));
  source.set(T.credits, creditRow(4, 3, 'Asha Rao'));
});

/**
 * Reconcile, then drain the queue. The worker is deliberately bounded per
 * invocation; production drains across webhook/cron/admin runs, and a test
 * under full-suite load must not depend on one slice finishing everything.
 */
const syncAll = async () => {
  await reconcile(db, source, config);
  const total = await runQueue(db, source, config, { budgetMs: 10_000, trigger: 'manual' });
  for (let i = 0; i < 10; i += 1) {
    const more = await runQueue(db, source, config, { budgetMs: 10_000, trigger: 'manual' });
    if (more.claimed === 0) break;
    for (const k of Object.keys(more) as (keyof typeof more)[]) total[k] += more[k];
  }
  return total;
};
const project = async () => (await db.select().from(schema.projects))[0];
const mapping = async (tableId: number, rowId: number) =>
  (await db.select().from(schema.integrationMappings).where(and(eq(schema.integrationMappings.tableId, tableId), eq(schema.integrationMappings.rowId, rowId))))[0];

describe('webhook authentication and parsing', () => {
  it('compares the secret in constant time and refuses near misses', () => {
    const secret = 'x'.repeat(40);
    expect(secretMatches(secret, secret)).toBe(true);
    expect(secretMatches(`${secret}y`, secret)).toBe(false);
    expect(secretMatches('x'.repeat(39) + 'y', secret)).toBe(false);
    expect(secretMatches(null, secret)).toBe(false);
    expect(secretMatches(secret, null)).toBe(false);
  });

  it('turns row events into jobs and ignores what it does not sync', () => {
    const ok = parseWebhook({ table_id: T.projects, event_type: 'rows.updated', event_id: 'e1', items: [{ id: 3, field_32: 'ignored' }, { id: 3 }] }, config);
    expect(ok).toMatchObject({ ok: true, ignored: false, jobs: [{ kind: 'row.sync', tableId: T.projects, rowId: 3 }] });
    expect(parseWebhook({ table_id: T.projects, event_type: 'rows.deleted', row_ids: [3] }, config)).toMatchObject({ jobs: [{ kind: 'row.delete' }] });
    expect(parseWebhook({ table_id: 999, event_type: 'rows.updated', items: [{ id: 1 }] }, config)).toMatchObject({ ignored: true });
    expect(parseWebhook({ table_id: T.projects, event_type: 'field.created' }, config)).toMatchObject({ ignored: true });
    expect(parseWebhook({ nonsense: true }, config)).toMatchObject({ ok: false, status: 422 });
    expect(parseWebhook({ table_id: T.projects, event_type: 'rows.updated', items: Array.from({ length: 501 }, (_, i) => ({ id: i + 1 })) }, config)).toMatchObject({ ok: false });
  });
});

describe('schema validation', () => {
  it('reports missing, mistyped and mislinked fields', () => {
    const problems = validateSchema(
      'credits',
      [
        { id: 50, name: 'Project', type: 'link_row', link_row_table_id: 999 },
        { id: 51, name: 'Name', type: 'number' },
      ],
      config.tables.credits.fields,
      { cities: T.cities, events: T.events, projects: T.projects, credits: T.credits },
    );
    expect(problems.map((p) => p.field).sort()).toEqual(['displayName', 'displayOrder', 'project', 'publicUrl', 'role']);
  });
});

describe('projection', () => {
  it('applies cities → events → projects → credits in dependency order', async () => {
    const counts = await syncAll();
    expect(counts.failed).toBe(0);
    const p = await project();
    expect(p).toMatchObject({ title: 'Imported 3', publicationStatus: 'published', status: 'published', contentAuthority: 'baserow', moderationState: 'clean', ownerMemberId: null });
    const [event] = await db.select().from(schema.events);
    expect(event).toMatchObject({ contentAuthority: 'baserow', status: 'published', cityId, startTime: '10:00:00', timezone: 'Asia/Kolkata' });
    expect(p.builtAtEventId).toBe(event.id);
    const detail = await getProjectDetail(db, p.slug);
    // The organiser's team label is returned as `team`; people are `credits`.
    expect(detail?.team).toBe('Team Kisan');
    expect(detail?.credits.map((c) => c.name)).toEqual(['Asha Rao']);
    expect(detail?.credits.every((c) => !c.href)).toBe(true);
    expect(detail?.imported).toBe(true);
  });

  it('a project whose event is not yet mapped is quarantined, then repaired by reconciliation', async () => {
    // Apply the project alone, before its event exists in Neon.
    await applyRow(db, config, 'cities', cityRow(1, 'zz-baserow-city'));
    const first = await applyRow(db, config, 'projects', projectRow(3));
    expect(first.outcome).toBe('quarantined');
    expect(await db.select().from(schema.projects)).toHaveLength(0);
    await syncAll();
    expect((await project()).publicationStatus).toBe('published');
  });

  it('duplicate and out-of-order notifications converge on the CURRENT row', async () => {
    await syncAll();
    const appliedAudits = async () =>
      (await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'baserow.project.applied'))).length;
    const baseline = await appliedAudits();
    source.set(T.projects, projectRow(3, { field_32: 'Second title' }));
    // Three notifications for the same row, two of them stale in content.
    await enqueue(db, config, [
      { kind: 'row.sync', tableId: T.projects, rowId: 3 },
      { kind: 'row.sync', tableId: T.projects, rowId: 3 },
    ]);
    expect((await db.select().from(schema.integrationJobs).where(eq(schema.integrationJobs.status, 'pending'))).length).toBe(1);
    await runQueue(db, source, config, { budgetMs: 5_000, trigger: 'webhook' });
    await enqueue(db, config, [{ kind: 'row.sync', tableId: T.projects, rowId: 3 }]);
    const counts = await runQueue(db, source, config, { budgetMs: 5_000, trigger: 'webhook' });
    expect((await project()).title).toBe('Second title');
    expect(counts.unchanged).toBe(1);
    // The edit is audited once; the duplicate notification writes nothing.
    expect(await appliedAudits()).toBe(baseline + 1);
  });

  it('an invalid edit is quarantined and the last valid version keeps serving', async () => {
    await syncAll();
    source.set(T.projects, projectRow(3, { field_39: 'javascript:alert(1)', field_32: 'Bad edit' }));
    await enqueue(db, config, [{ kind: 'row.sync', tableId: T.projects, rowId: 3 }]);
    const counts = await runQueue(db, source, config, { budgetMs: 5_000, trigger: 'webhook' });
    expect(counts.quarantined).toBe(1);
    const p = await project();
    expect(p.title).toBe('Imported 3');
    expect(p.repoUrl).toBe('https://github.com/example/repo');
    expect((await mapping(T.projects, 3)).status).toBe('quarantined');
    expect((await listPublicProjects(db)).total).toBe(1);
  });

  it('holds publication when the historical-archive contract is not met', async () => {
    source.set(T.projects, projectRow(3, { field_39: null, field_44: null }));
    source.remove(T.credits, 4);
    await syncAll();
    const p = await project();
    expect(p.publicationStatus).toBe('draft');
    expect((await mapping(T.projects, 3)).lastError).toMatch(/publish held/);
    const parsed = parseProject(projectRow(3, { field_39: null, field_44: null }), config);
    if (!parsed.ok) throw new Error('fixture');
    // Only the missing artifact blocks: a team credit is not required.
    expect(archiveContractBlockers(parsed.dto, 'e', 0)).toEqual([
      'at least one artifact link (live, repo, video or download)',
    ]);
    expect(archiveContractBlockers(parsed.dto, null, 0)).toHaveLength(2);
  });

  it('publishes without any credit — names can be withheld pending permission', async () => {
    source.set(T.projects, projectRow(3, { field_44: null }));
    source.remove(T.credits, 4);
    await syncAll();
    const p = await project();
    expect(p.publicationStatus).toBe('published');
    const credits = await db.select().from(schema.projectCredits).where(eq(schema.projectCredits.projectId, p.id));
    expect(credits).toHaveLength(0);
  });

  it('a moderator hold outranks Baserow publication intent', async () => {
    await syncAll();
    const p = await project();
    await db.update(schema.projects).set({ moderationState: 'restricted' }).where(eq(schema.projects.id, p.id));
    source.set(T.projects, projectRow(3, { field_32: 'Edited while held' }));
    await enqueue(db, config, [{ kind: 'row.sync', tableId: T.projects, rowId: 3 }]);
    await runQueue(db, source, config, { budgetMs: 5_000, trigger: 'webhook' });
    const after = await project();
    expect(after.moderationState).toBe('restricted');
    expect((await listPublicProjects(db)).total).toBe(0);
  });

  it('after a claim the website owns the project and Baserow edits are ignored', async () => {
    await syncAll();
    const p = await project();
    await db.update(schema.projects).set({ contentAuthority: 'member' }).where(eq(schema.projects.id, p.id));
    source.set(T.projects, projectRow(3, { field_32: 'Organiser overwrite' }));
    await enqueue(db, config, [{ kind: 'row.sync', tableId: T.projects, rowId: 3 }]);
    const counts = await runQueue(db, source, config, { budgetMs: 5_000, trigger: 'webhook' });
    expect(counts.skipped).toBe(1);
    expect((await project()).title).toBe('Imported 3');
    expect((await mapping(T.projects, 3)).status).toBe('released');
    // And deletion upstream cannot touch it either.
    expect((await tombstoneRow(db, config, 'projects', 3)).outcome).toBe('skipped');
    expect((await project()).publicationStatus).toBe('published');
  });

  it('adopts an existing curated event by neonId and stops treating it as curated', async () => {
    const [curated] = await db
      .insert(schema.events)
      .values({ slug: 'zz-curated', title: 'Curated', format: 'workshop', cityId, date: '2026-01-01', startTime: '10:00', venueName: 'X', summary: 'S', status: 'published' })
      .returning({ id: schema.events.id });
    source.set(T.events, eventRow(2, { field_11: curated.id, field_12: 'Curated, now edited in Baserow' }));
    await syncAll();
    const [event] = await db.select().from(schema.events).where(eq(schema.events.id, curated.id));
    expect(event).toMatchObject({ contentAuthority: 'baserow', title: 'Curated, now edited in Baserow', slug: 'zz-curated' });
    expect(await db.select().from(schema.events)).toHaveLength(1);
  });

  it('refuses an unknown city rather than creating one', async () => {
    source.set(T.cities, cityRow(1, 'atlantis'));
    await syncAll();
    expect((await mapping(T.cities, 1)).status).toBe('quarantined');
    expect((await db.select().from(schema.cities).where(eq(schema.cities.slug, 'atlantis')))).toHaveLength(0);
    expect(await db.select().from(schema.events)).toHaveLength(0);
  });
});

describe('deletion and reconciliation', () => {
  it('a deleted row archives its projection; nothing is erased', async () => {
    await syncAll();
    source.remove(T.projects, 3);
    await enqueue(db, config, [{ kind: 'row.delete', tableId: T.projects, rowId: 3 }]);
    const counts = await runQueue(db, source, config, { budgetMs: 5_000, trigger: 'webhook' });
    expect(counts.tombstoned).toBe(1);
    const p = await project();
    expect(p).toMatchObject({ publicationStatus: 'archived', status: 'archived' });
    expect((await mapping(T.projects, 3)).status).toBe('tombstoned');
  });

  it('a delete notification for a row that still exists re-applies it instead', async () => {
    await syncAll();
    await enqueue(db, config, [{ kind: 'row.delete', tableId: T.projects, rowId: 3 }]);
    await runQueue(db, source, config, { budgetMs: 5_000, trigger: 'webhook' });
    expect((await project()).publicationStatus).toBe('published');
  });

  it('an incomplete scan never infers a deletion', async () => {
    await syncAll();
    source.remove(T.projects, 3);
    source.incomplete = true;
    const report = await reconcile(db, source, config);
    expect(report.complete).toBe(false);
    expect(await db.select().from(schema.integrationJobs).where(eq(schema.integrationJobs.kind, 'row.delete'))).toHaveLength(0);
    source.incomplete = false;
    await syncAll();
    expect((await project()).publicationStatus).toBe('archived');
  });

  it('a complete scan with nothing changed queues nothing', async () => {
    await syncAll();
    await db.delete(schema.integrationJobs);
    const report = await reconcile(db, source, config);
    expect(report.tables.every((t) => t.changed === 0 && t.missing === 0)).toBe(true);
  });
});

describe('retries and failures', () => {
  it('a transient upstream error is retried later; a configuration error is not', async () => {
    await enqueue(db, config, [{ kind: 'row.sync', tableId: T.projects, rowId: 3 }]);
    source.failGet = new BaserowError('server', 'upstream 503', { status: 503, retryable: true });
    let counts = await runQueue(db, source, config, { budgetMs: 3_000, trigger: 'webhook' });
    expect(counts.failed).toBe(1);
    let [job] = await db.select().from(schema.integrationJobs);
    expect(job.status).toBe('pending');
    expect(job.runAfter.getTime()).toBeGreaterThan(Date.now());

    await db.delete(schema.integrationJobs);
    await enqueue(db, config, [{ kind: 'row.sync', tableId: T.projects, rowId: 3 }]);
    source.failGet = new BaserowError('auth', 'token rejected', { status: 401, retryable: false });
    counts = await runQueue(db, source, config, { budgetMs: 3_000, trigger: 'webhook' });
    [job] = await db.select().from(schema.integrationJobs);
    expect(job.status).toBe('failed');
    expect(job.lastError).toMatch(/configuration/);

    source.failGet = null;
    expect(await retryFailed(db)).toBe(1);
    counts = await runQueue(db, source, config, { budgetMs: 3_000, trigger: 'manual' });
    expect(counts.failed).toBe(0);
  });

  it('a job whose worker died is reclaimed after its lease expires', async () => {
    await enqueue(db, config, [{ kind: 'row.sync', tableId: T.cities, rowId: 1 }]);
    const [leased] = await claim(db, 1);
    expect(leased.status).toBe('running');
    expect(await claim(db, 1)).toHaveLength(0);
    const later = new Date(Date.now() + 2 * 60_000);
    const [again] = await claim(db, 1, later);
    expect(again.id).toBe(leased.id);
  });

  it('a failed job gives way to a newer pending job for the same row instead of aborting the run', async () => {
    await enqueue(db, config, [{ kind: 'row.sync', tableId: T.cities, rowId: 1 }]);
    const getRow = source.getRow.bind(source);
    let reads = 0;
    source.getRow = async (tableId, rowId) => {
      if ((reads += 1) > 1) return getRow(tableId, rowId);
      // An edit's webhook queues the row again while this job runs, then the read fails.
      await enqueue(db, config, [{ kind: 'row.sync', tableId, rowId }]);
      throw new BaserowError('server', 'upstream 503', { status: 503, retryable: true });
    };
    const counts = await runQueue(db, source, config, { budgetMs: 3_000, trigger: 'webhook' });
    expect(counts.failed).toBe(1);
    const jobs = await db.select().from(schema.integrationJobs);
    expect(jobs.map((j) => j.status)).toEqual(['done', 'done']);
  });

  it('a job handed back at the deadline gives way to a newer pending job for the same row', async () => {
    await enqueue(db, config, [
      { kind: 'row.sync', tableId: T.cities, rowId: 1 },
      { kind: 'row.sync', tableId: T.events, rowId: 2 },
    ]);
    const getRow = source.getRow.bind(source);
    source.getRow = async (tableId, rowId) => {
      if (tableId === T.cities) {
        // The event row is edited while the city job runs, and then the budget is spent.
        await enqueue(db, config, [{ kind: 'row.sync', tableId: T.events, rowId: 2 }]);
        vi.setSystemTime(Date.now() + 60_000);
      }
      return getRow(tableId, rowId);
    };
    try {
      await runQueue(db, source, config, { budgetMs: 3_000, trigger: 'webhook' });
    } finally {
      vi.useRealTimers();
    }
    const jobs = await db.select().from(schema.integrationJobs).where(eq(schema.integrationJobs.tableId, T.events));
    expect(jobs.map((j) => j.status).sort()).toEqual(['done', 'pending']);
  });
});

describe('claiming an imported project', () => {
  it('credit is not ownership; an approved claim transfers authority atomically', async () => {
    const { requestProjectClaim, resolveProjectClaim } = await import('../src/server/projects/claims');
    const { provisionMember } = await import('../src/server/auth/member');
    await syncAll();
    const p = await project();
    const { member } = await provisionMember(`did:privy:claimer-${Date.now()}`, db);
    const [moderator] = await db.insert(schema.users).values({ email: `mod-${Date.now()}@example.com`, role: 'editor' }).returning();

    expect(await requestProjectClaim(db, member.id, p.slug, 'short')).toMatchObject({ ok: false, status: 422 });
    const requested = await requestProjectClaim(db, member.id, p.slug, 'I wrote the repo linked on this page.');
    if (!requested.ok) throw new Error('claim');
    // Nothing changes until a moderator decides.
    expect((await project()).ownerMemberId).toBeNull();

    expect(await resolveProjectClaim(db, requested.claimId, 'approve', moderator, 'Verified via GitHub')).toMatchObject({ ok: true, status: 'approved' });
    const after = await project();
    expect(after).toMatchObject({ ownerMemberId: member.id, contentAuthority: 'member' });
    expect((await mapping(T.projects, 3)).status).toBe('released');
    expect(await resolveProjectClaim(db, requested.claimId, 'approve', moderator, null)).toMatchObject({ ok: false, status: 409 });

    // And the organisers' later edits no longer reach it.
    source.set(T.projects, projectRow(3, { field_32: 'Organiser edit after claim' }));
    await enqueue(db, config, [{ kind: 'row.sync', tableId: T.projects, rowId: 3 }]);
    await runQueue(db, source, config, { budgetMs: 5_000, trigger: 'webhook' });
    expect((await project()).title).toBe('Imported 3');
  });
});

describe('a workspace without a Cities table', () => {
  // The organisers' real workspace: three tables, City as a text slug.
  const N = { events: 202, projects: 203, credits: 204 };
  const noCities: BaserowConfig = ConfigSchema.parse({
    tables: {
      events: { tableId: N.events, fields: { ...config.tables.events.fields } },
      projects: { tableId: N.projects, fields: { ...config.tables.projects.fields } },
      credits: { tableId: N.credits, fields: { ...config.tables.credits.fields } },
    },
  });

  it('resolves City from a Neon slug, never creating one, and syncs only the configured tables', async () => {
    const s = new FakeSource();
    s.set(N.events, eventRow(1, { field_10: 'evt-slug-city', field_16: 'zz-baserow-city' }));
    s.set(N.events, eventRow(2, { field_10: 'evt-unknown-city', field_16: 'atlantis' }));
    s.set(N.projects, projectRow(1, { field_30: 'prj-slug-city', field_42: link(1) }));
    const report = await reconcile(db, s, noCities);
    expect(report.tables.map((t) => t.table)).toEqual(['events', 'projects', 'credits']);
    for (let i = 0; i < 5; i += 1) if ((await runQueue(db, s, noCities, { budgetMs: 5_000, trigger: 'manual' })).claimed === 0) break;

    const [ok] = await db
      .select({ status: schema.integrationMappings.status, entityId: schema.integrationMappings.entityId })
      .from(schema.integrationMappings)
      .where(and(eq(schema.integrationMappings.tableId, N.events), eq(schema.integrationMappings.rowId, 1)));
    expect(ok.status).toBe('active');
    const [event] = await db.select().from(schema.events).where(eq(schema.events.id, ok.entityId!));
    expect(event.cityId).toBe(cityId);

    const [bad] = await db
      .select({ status: schema.integrationMappings.status, lastError: schema.integrationMappings.lastError })
      .from(schema.integrationMappings)
      .where(and(eq(schema.integrationMappings.tableId, N.events), eq(schema.integrationMappings.rowId, 2)));
    expect(bad).toMatchObject({ status: 'quarantined' });
    expect(bad.lastError).toContain('unknown city "atlantis"');
    expect(await db.select().from(schema.cities).where(eq(schema.cities.slug, 'atlantis'))).toHaveLength(0);

    // The project takes the event's city.
    const [pm] = await db
      .select({ entityId: schema.integrationMappings.entityId })
      .from(schema.integrationMappings)
      .where(and(eq(schema.integrationMappings.tableId, N.projects), eq(schema.integrationMappings.rowId, 1)));
    const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, pm.entityId!));
    expect(p).toMatchObject({ cityId, builtAtEventId: ok.entityId });
  });

  it('schema check: City may be text; a City link needs a configured Cities table', () => {
    const live = (type: string) => [
      { id: 10, name: 'Key', type: 'text' }, { id: 12, name: 'Title', type: 'text' }, { id: 14, name: 'Summary', type: 'long_text' },
      { id: 16, name: 'City', type, ...(type === 'link_row' ? { link_row_table_id: 999 } : {}) }, { id: 17, name: 'Venue', type: 'text' },
      { id: 19, name: 'Date', type: 'date' }, { id: 20, name: 'Start', type: 'text' },
      { id: 23, name: 'Format', type: 'single_select', select_options: ['conversation', 'workshop', 'impact-lab', 'campus', 'hackathon', 'demo', 'meetup', 'other'].map((value, i) => ({ id: i, value })) },
      { id: 26, name: 'Status', type: 'single_select', select_options: ['draft', 'ready', 'published', 'archived'].map((value, i) => ({ id: i, value })) },
    ];
    const fields = { key: 10, title: 12, summary: 14, city: 16, venueName: 17, date: 19, startTime: 20, format: 23, editorialStatus: 26 };
    const ids = { events: N.events, projects: N.projects, credits: N.credits };
    expect(validateSchema('events', live('text'), fields, ids)).toEqual([]);
    expect(validateSchema('events', live('link_row'), fields, ids).map((p) => p.field)).toEqual(['city']);
  });
});

describe('diagnostics survive a no-op re-sync', () => {
  it('an unchanged pass keeps the "publish held" note for the admin', async () => {
    source.set(T.projects, projectRow(3, { field_39: null }));
    await syncAll();
    expect((await mapping(T.projects, 3)).lastError).toMatch(/publish held/);
    // A reconcile with a stale source hash re-reads the row; nothing changed.
    await db.update(schema.integrationMappings).set({ sourceHash: null }).where(eq(schema.integrationMappings.tableId, T.projects));
    await syncAll();
    expect((await mapping(T.projects, 3)).lastError).toMatch(/publish held/);
  });
});

describe('Baserow publication intent never outranks moderation or a claim', () => {
  const resync = async () => {
    await enqueue(db, config, [{ kind: 'row.sync', tableId: T.projects, rowId: 3 }]);
    await runQueue(db, source, config, { budgetMs: 5_000, trigger: 'webhook' });
  };

  it('a restricted project that Baserow (re)publishes stays off the directory and its page', async () => {
    source.set(T.projects, projectRow(3, { field_45: sel('draft') }));
    await syncAll();
    const p = await project();
    for (const state of ['reported', 'restricted', 'archived', 'removed'] as const) {
      await db.update(schema.projects).set({ moderationState: state }).where(eq(schema.projects.id, p.id));
      // The organisers flip the row to published, and edit it.
      source.set(T.projects, projectRow(3, { field_45: sel('published'), field_32: `Published while ${state}` }));
      await resync();
      const after = await project();
      expect(after.moderationState).toBe(state); // the projection never writes moderation
      expect((await listPublicProjects(db)).total).toBe(0);
      // The detail loader reports visibility; the page answers 404 unless isPublic (or a verified moderator asks).
      expect((await getProjectDetail(db, after.slug))?.isPublic).toBe(false);
      source.set(T.projects, projectRow(3, { field_45: sel('draft') }));
      await resync();
    }
  });

  it('a claimed project keeps the member’s publication state whatever Baserow says', async () => {
    await syncAll();
    const p = await project();
    // The member owns it now; they unpublished it on the website.
    await db.update(schema.projects).set({ contentAuthority: 'member', publicationStatus: 'draft' }).where(eq(schema.projects.id, p.id));
    source.set(T.projects, projectRow(3, { field_45: sel('published') }));
    await resync();
    expect((await project()).publicationStatus).toBe('draft');
    expect((await listPublicProjects(db)).total).toBe(0);
    // …and republished it; Baserow archiving the row cannot take it down.
    await db.update(schema.projects).set({ publicationStatus: 'published' }).where(eq(schema.projects.id, p.id));
    source.set(T.projects, projectRow(3, { field_45: sel('archived') }));
    await resync();
    expect((await project()).publicationStatus).toBe('published');
    expect((await mapping(T.projects, 3)).status).toBe('released');
  });
});

describe('values the field type no longer guarantees', () => {
  it('quarantines a project linked to two events; many projects may share one event', () => {
    expect(parseProject(projectRow(3, { field_42: [...link(2), ...link(5)] }), config)).toMatchObject({
      ok: false,
      problems: ['event must link to exactly one event (links 2)'],
    });
    expect(parseProject(projectRow(7, { field_42: link(2) }), config).ok).toBe(true);
    expect(parseProject(projectRow(8, { field_42: link(2) }), config).ok).toBe(true);
  });

  it('quarantines a credit linked to two projects', () => {
    expect(parseCredit({ ...creditRow(4, 3, 'Asha Rao'), field_50: [...link(3), ...link(9)] }, config)).toMatchObject({
      ok: false,
      problems: ['project must link to exactly one project (links 2)'],
    });
  });

  it('validates URL values held in plain-text fields', () => {
    const bad: Record<string, string> = {
      'http://localhost:8765/repo': 'repoUrl points at a local or private host',
      'https://192.168.1.4/app': 'repoUrl points at a local or private host',
      'javascript:alert(1)': 'repoUrl is not a valid http(s) link',
      'ftp://files.example.com/x': 'repoUrl is not a valid http(s) link',
      'https://user:pw@example.com/repo': 'repoUrl carries credentials',
      'https://app.example.com/admin?key=abc123': 'repoUrl carries a credential or access parameter',
      'https://demo.vercel.app/?_vercel_share=abc': 'repoUrl carries a credential or access parameter',
      'not a link at all': 'repoUrl is not a valid http(s) link',
    };
    for (const [value, problem] of Object.entries(bad)) {
      const parsed = parseProject(projectRow(3, { field_39: value }), config);
      expect(parsed.ok, value).toBe(false);
      if (!parsed.ok) expect(parsed.problems, value).toContain(problem);
    }
    const good = parseProject(projectRow(3, { field_39: 'https://github.com/team/repo' }), config);
    expect(good.ok && good.dto.repoUrl).toBe('https://github.com/team/repo');
  });
});
