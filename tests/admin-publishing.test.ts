/**
 * PROMOTION AND PUBLISHING, against a real PostgreSQL.
 *
 * The Phase 3 counterpart to `admin-transitions.test.ts`, defending the same
 * class of claim about a different state machine:
 *
 *  · nothing reaches the website without an editor having published it
 *  · publishing and archiving are transactional and audited
 *  · promotion never leaves a half-made record behind
 *  · promotion is idempotent under a double click
 *  · a deploy hook failure does not undo an editorial decision
 *
 * PGlite is real PostgreSQL in-process, so `db.transaction()` is a real
 * BEGIN/COMMIT and a rollback really rolls back. Every atomicity assertion
 * below would be meaningless against a mock.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import * as schema from '../db/schema';
import {
  PUBLISH_RULES,
  availablePublishActions,
  canPublish,
  countPublishable,
  deployMessage,
  listPublishable,
  transitionContent,
  type DeployOutcome,
} from '../admin/src/server/publishing';
import { promoteSubmission, slugify } from '../admin/src/server/promotion';
import { loadRecordSet } from '../src/data/source-db';

let db: TestDatabase;
let cityId: string;

const admin = { id: '', email: 'admin@example.com', role: 'admin' };
const editor = { id: '', email: 'editor@example.com', role: 'editor' };
const viewer = { id: '', email: 'viewer@example.com', role: 'viewer' };

/** A deploy hook that records being called, without a network. */
function fakeDeploy(outcome: DeployOutcome = { triggered: true }) {
  const calls: number[] = [];
  return {
    calls,
    deploy: async (): Promise<DeployOutcome> => {
      calls.push(Date.now());
      return outcome;
    },
  };
}

beforeAll(async () => {
  db = await createTestDatabase();

  for (const person of [admin, editor, viewer]) {
    const [row] = await db
      .insert(schema.users)
      .values({ email: person.email, name: person.email, role: person.role as never })
      .returning({ id: schema.users.id });
    person.id = row.id;
  }

  // One city, so records that need one can resolve it. Published, because the
  // reader only returns published rows and some assertions read it back.
  const [city] = await db
    .insert(schema.cities)
    .values({
      slug: 'bhopal',
      name: 'Bhopal',
      region: 'Madhya Pradesh',
      lat: 23.26,
      lon: 77.41,
      blurb: 'A city.',
      status: 'published',
    })
    .returning({ id: schema.cities.id });
  cityId = city.id;
}, 60_000);

afterAll(async () => {
  await db?.$close();
});

beforeEach(async () => {
  // `audit_log` rejects DELETE by trigger — it is append-only, which is the
  // point of it. Assertions below are scoped to the record under test.
  await db.execute(sql`delete from city_interest`);
  await db.execute(sql`delete from submissions`);
  await db.execute(sql`delete from use_case_workflow_steps`);
  await db.execute(sql`delete from use_cases`);
  await db.execute(sql`delete from project_builders`);
  await db.execute(sql`delete from projects`);
  await db.execute(sql`delete from social_links`);
  await db.execute(sql`delete from builders`);
});

/** An approved submission of a given kind, ready to promote. */
async function submission(
  kind: 'builder' | 'project' | 'use-case' | 'city-interest',
  payload: Record<string, unknown>,
  status: 'pending' | 'approved' = 'approved',
): Promise<string> {
  const [row] = await db
    .insert(schema.submissions)
    .values({
      kind,
      payload,
      submitterName: 'A Person',
      submitterEmail: 'person@example.com',
      status,
    })
    .returning({ id: schema.submissions.id });
  return row.id;
}

const BUILDER_PAYLOAD = {
  name: 'Asha Menon',
  city: 'Bhopal',
  role: 'Builds developer tools',
  building: 'A CLI for the archive',
  claudeTools: 'Claude Code, the API',
  links: 'https://example.com, github.com/asha',
};

const PROJECT_PAYLOAD = {
  title: 'Archive CLI',
  city: 'Bhopal',
  category: 'developer-tool',
  summary: 'A command line tool for the community archive.',
  claudeUsage: 'Claude Code wrote the parser.',
  url: 'https://example.com/archive',
};

const USE_CASE_PAYLOAD = {
  title: 'Reviewing a schema with Claude',
  name: 'Asha Menon',
  credential: 'Ran the Bhopal Claude Code workshop, vol. 09',
  city: 'Bhopal',
  category: 'claude-code',
  problem: 'The schema had drifted from the code.',
  context: 'A weekend, one person, no test database.',
  workflow: 'Read the migrations\nCompared to the models\nWrote the diff',
  claudeDid: 'Read every migration, listed the drift',
  humanDid: 'Checked each claim against the real database',
  tools: 'Claude Code',
  result: 'Nine differences found, seven were real.',
};

// =========================================================================
// PROMOTION
// =========================================================================

describe('promotion', () => {
  it('refuses a submission that is not approved', async () => {
    const id = await submission('builder', BUILDER_PAYLOAD, 'pending');

    const result = await promoteSubmission(db as never, { submissionId: id, actor: editor });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.error).toMatch(/approved/i);

    // And nothing was created.
    const builders = await db.select().from(schema.builders);
    expect(builders).toHaveLength(0);
  });

  it('refuses a role that cannot promote', async () => {
    const id = await submission('builder', BUILDER_PAYLOAD);

    const result = await promoteSubmission(db as never, { submissionId: id, actor: viewer });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
    expect(await db.select().from(schema.builders)).toHaveLength(0);
  });

  it('creates a builder, at approved rather than published', async () => {
    const id = await submission('builder', BUILDER_PAYLOAD);

    const result = await promoteSubmission(db as never, { submissionId: id, actor: editor });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);

    const [builder] = await db.select().from(schema.builders);
    expect(builder.name).toBe('Asha Menon');
    expect(builder.slug).toBe('asha-menon');
    expect(builder.cityId).toBe(cityId);
    expect(builder.role).toBe('Builds developer tools');
    expect(builder.building).toBe('A CLI for the archive');
    expect(builder.claudeTools).toEqual(['Claude Code', 'the API']);

    // THE POINT: created, not live.
    expect(builder.status).toBe('approved');

    // No roles are assigned by a form — `ambassador` least of all.
    expect(builder.roles).toEqual([]);

    // No invented timestamp. The record's rule is that a date is written only
    // when the real one is known.
    expect(builder.createdAt).toBeNull();

    // Links that parse are kept, in order.
    const links = await db
      .select()
      .from(schema.socialLinks)
      .where(eq(schema.socialLinks.ownerId, builder.id));
    expect(links.map((l) => l.url)).toEqual([
      'https://example.com/',
      'https://github.com/asha',
    ]);
  });

  it('points the submission at what it created, and audits it', async () => {
    const id = await submission('builder', BUILDER_PAYLOAD);
    const result = await promoteSubmission(db as never, { submissionId: id, actor: editor });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [row] = await db
      .select()
      .from(schema.submissions)
      .where(eq(schema.submissions.id, id));
    expect(row.entityType).toBe('builder');
    expect(row.entityId).toBe(result.entityId);

    // The submission is NOT deleted. It is the historical source.
    expect(row.payload).toEqual(BUILDER_PAYLOAD);

    const [entry] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entityId, result.entityId));
    expect(entry.action).toBe('promoted');
    expect(entry.entityType).toBe('builder');
    expect(entry.actorEmail).toBe(editor.email);
    expect(entry.toStatus).toBe('approved');
  });

  it('is idempotent — a second click returns the first record', async () => {
    const id = await submission('builder', BUILDER_PAYLOAD);

    const first = await promoteSubmission(db as never, { submissionId: id, actor: editor });
    const second = await promoteSubmission(db as never, { submissionId: id, actor: editor });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.entityId).toBe(first.entityId);

    // One builder, not two.
    expect(await db.select().from(schema.builders)).toHaveLength(1);
  });

  it('does not create two records when two editors promote at once', async () => {
    const id = await submission('builder', BUILDER_PAYLOAD);

    const [a, b] = await Promise.all([
      promoteSubmission(db as never, { submissionId: id, actor: editor }),
      promoteSubmission(db as never, { submissionId: id, actor: admin }),
    ]);

    // Exactly one builder exists, whichever call won.
    expect(await db.select().from(schema.builders)).toHaveLength(1);

    // And a loser is told, rather than silently doing nothing.
    const outcomes = [a, b];
    expect(outcomes.filter((r) => r.ok && r.created)).toHaveLength(1);
  });

  it('refuses, and creates nothing, when a required field is missing', async () => {
    // No `role`, which a builder record cannot be written without.
    const id = await submission('builder', { name: 'Nobody', city: 'Bhopal' });

    const result = await promoteSubmission(db as never, { submissionId: id, actor: editor });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(422);
    expect(result.error).toMatch(/role/i);

    // THE TRANSACTION HELD. No builder, and no back-reference.
    expect(await db.select().from(schema.builders)).toHaveLength(0);
    const [row] = await db.select().from(schema.submissions).where(eq(schema.submissions.id, id));
    expect(row.entityId).toBeNull();
    expect(row.entityType).toBeNull();
  });

  it('refuses a city that is not on the atlas, and creates no city', async () => {
    const id = await submission('builder', { ...BUILDER_PAYLOAD, city: 'Atlantis' });

    const result = await promoteSubmission(db as never, { submissionId: id, actor: editor });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not a city on the atlas/i);

    // Promotion never creates a city. The atlas is not editable by a form.
    const cities = await db.select().from(schema.cities);
    expect(cities).toHaveLength(1);
    expect(cities[0].slug).toBe('bhopal');
  });

  it('creates a project with no fabricated attribution', async () => {
    const id = await submission('project', PROJECT_PAYLOAD);
    const result = await promoteSubmission(db as never, { submissionId: id, actor: editor });
    expect(result.ok).toBe(true);

    const [project] = await db.select().from(schema.projects);
    expect(project.title).toBe('Archive CLI');
    expect(project.category).toBe('developer-tool');
    expect(project.status).toBe('approved');

    /**
     * NOBODY IS CREDITED. The form collects a creator as free text, and a name
     * is not a builder record — guessing which existing builder was meant
     * would put a real person behind work they may not have done.
     */
    expect(await db.select().from(schema.projectBuilders)).toHaveLength(0);
  });

  it('refuses a category the schema does not know', async () => {
    const id = await submission('project', { ...PROJECT_PAYLOAD, category: 'a vibe' });

    const result = await promoteSubmission(db as never, { submissionId: id, actor: editor });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not a project category/i);
    expect(await db.select().from(schema.projects)).toHaveLength(0);
  });

  it('creates a use case, keeping both halves of the split and the workflow', async () => {
    const id = await submission('use-case', USE_CASE_PAYLOAD);
    const result = await promoteSubmission(db as never, { submissionId: id, actor: editor });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [useCase] = await db.select().from(schema.useCases);
    expect(useCase.status).toBe('approved');
    expect(useCase.authorCredential).toBe('Ran the Bhopal Claude Code workshop, vol. 09');
    expect(useCase.authorName).toBe('Asha Menon');
    expect(useCase.claudeDid.length).toBeGreaterThan(0);
    expect(useCase.humanDid.length).toBeGreaterThan(0);
    expect(useCase.result).toBe('Nine differences found, seven were real.');

    // Nothing submitted is discarded — the workflow keeps its order.
    const steps = await db
      .select()
      .from(schema.useCaseWorkflowSteps)
      .where(eq(schema.useCaseWorkflowSteps.useCaseId, useCase.id))
      .orderBy(schema.useCaseWorkflowSteps.position);
    expect(steps.map((s) => s.detail)).toEqual([
      'Read the migrations',
      'Compared to the models',
      'Wrote the diff',
    ]);
  });

  it('refuses a use case that cannot say what the person did', async () => {
    const id = await submission('use-case', { ...USE_CASE_PAYLOAD, humanDid: '' });

    const result = await promoteSubmission(db as never, { submissionId: id, actor: editor });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/person did|account of what the person/i);
    expect(await db.select().from(schema.useCases)).toHaveLength(0);
  });

  it('records city interest without creating a city or verifying anybody', async () => {
    const id = await submission('city-interest', {
      city: 'Bhopal',
      email: 'someone@example.com',
      doing: 'Building an app',
      helping: 'Can host',
    });

    const result = await promoteSubmission(db as never, { submissionId: id, actor: editor });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entityType).toBe('city_interest');

    const [interest] = await db.select().from(schema.cityInterest);
    expect(interest.cityName).toBe('Bhopal');
    // Matched to the existing city, because it exists.
    expect(interest.cityId).toBe(cityId);
    expect(interest.submissionId).toBe(id);

    /**
     * NOT VERIFIED. Editorial approval is not verification, and only verified
     * rows feed the interest count a city's derived state reads. This is the
     * assertion that stops a form being able to move a city towards looking
     * like a chapter.
     */
    expect(interest.verifiedAt).toBeNull();
    expect(interest.verifiedBy).toBeNull();
  });

  it('records interest in a city that is not on the atlas, without adding it', async () => {
    const id = await submission('city-interest', {
      city: 'Atlantis',
      email: 'someone@example.com',
    });

    const result = await promoteSubmission(db as never, { submissionId: id, actor: editor });
    expect(result.ok).toBe(true);

    const [interest] = await db.select().from(schema.cityInterest);
    expect(interest.cityName).toBe('Atlantis');
    // Nullable on purpose — somebody in a town that is not plotted still counts.
    expect(interest.cityId).toBeNull();

    expect(await db.select().from(schema.cities)).toHaveLength(1);
  });

  it('gives a colliding slug a free one rather than failing', async () => {
    const first = await submission('builder', BUILDER_PAYLOAD);
    await promoteSubmission(db as never, { submissionId: first, actor: editor });

    const second = await submission('builder', BUILDER_PAYLOAD);
    const result = await promoteSubmission(db as never, { submissionId: second, actor: editor });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slug).toBe('asha-menon-2');
  });

  it('slugifies predictably', () => {
    expect(slugify('Asha Menon')).toBe('asha-menon');
    expect(slugify('  Spaces   Everywhere  ')).toBe('spaces-everywhere');
    expect(slugify('Ünïcödé & Symbols!')).toBe('unicode-symbols');
    expect(slugify('!!!')).toBe('record');
  });
});

// =========================================================================
// PUBLISHING
// =========================================================================

describe('publishing', () => {
  /** An approved builder, the thing a publish acts on. */
  async function approvedBuilder(slug = 'asha-menon'): Promise<string> {
    const [row] = await db
      .insert(schema.builders)
      .values({ slug, name: 'Asha Menon', cityId, role: 'Builds things', status: 'approved' })
      .returning({ id: schema.builders.id });
    return row.id;
  }

  it('publishes an approved record, and audits it', async () => {
    const id = await approvedBuilder();
    const hook = fakeDeploy();

    const result = await transitionContent(db as never, {
      entityType: 'builder',
      entityId: id,
      action: 'publish',
      actor: editor,
      deploy: hook.deploy,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.from).toBe('approved');
    expect(result.to).toBe('published');

    const [builder] = await db.select().from(schema.builders).where(eq(schema.builders.id, id));
    expect(builder.status).toBe('published');

    const [entry] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.id, result.auditId));
    expect(entry.action).toBe('builder.published');
    expect(entry.fromStatus).toBe('approved');
    expect(entry.toStatus).toBe('published');
    expect(entry.actorEmail).toBe(editor.email);

    // And a rebuild was asked for.
    expect(hook.calls).toHaveLength(1);
  });

  it('NEVER publishes something that was not approved first', async () => {
    /**
     * The governance rule, asserted against every state that is not
     * `approved`. `pending → published` in particular must not exist: it would
     * let something reach the website without an editor having read it.
     */
    for (const status of [
      'draft',
      'pending',
      'in_review',
      'changes_requested',
      'rejected',
      'archived',
      'published',
    ] as const) {
      const [row] = await db
        .insert(schema.builders)
        .values({ slug: `b-${status}`, name: 'X', cityId, role: 'r', status })
        .returning({ id: schema.builders.id });

      const result = await transitionContent(db as never, {
        entityType: 'builder',
        entityId: row.id,
        action: 'publish',
        actor: admin,
        deploy: fakeDeploy().deploy,
      });

      expect(result.ok, `publish from "${status}" was allowed`).toBe(false);

      const [after] = await db
        .select()
        .from(schema.builders)
        .where(eq(schema.builders.id, row.id));
      expect(after.status).toBe(status);
    }
  });

  it('refuses a role that cannot publish', async () => {
    const id = await approvedBuilder();

    const result = await transitionContent(db as never, {
      entityType: 'builder',
      entityId: id,
      action: 'publish',
      actor: viewer,
      deploy: fakeDeploy().deploy,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);

    const [builder] = await db.select().from(schema.builders).where(eq(schema.builders.id, id));
    expect(builder.status).toBe('approved');
  });

  it('archives a published record without deleting it', async () => {
    const id = await approvedBuilder();
    await transitionContent(db as never, {
      entityType: 'builder',
      entityId: id,
      action: 'publish',
      actor: editor,
      deploy: fakeDeploy().deploy,
    });

    const result = await transitionContent(db as never, {
      entityType: 'builder',
      entityId: id,
      action: 'archive',
      actor: editor,
      note: 'Requested by the person.',
      deploy: fakeDeploy().deploy,
    });

    expect(result.ok).toBe(true);

    // THE ROW IS STILL THERE. A takedown hides; it does not destroy.
    const [builder] = await db.select().from(schema.builders).where(eq(schema.builders.id, id));
    expect(builder.status).toBe('archived');
    expect(builder.name).toBe('Asha Menon');
  });

  it('will not archive without a written reason', async () => {
    const id = await approvedBuilder();
    await transitionContent(db as never, {
      entityType: 'builder',
      entityId: id,
      action: 'publish',
      actor: editor,
      deploy: fakeDeploy().deploy,
    });

    const result = await transitionContent(db as never, {
      entityType: 'builder',
      entityId: id,
      action: 'archive',
      actor: editor,
      note: '   ',
      deploy: fakeDeploy().deploy,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(422);

    const [builder] = await db.select().from(schema.builders).where(eq(schema.builders.id, id));
    expect(builder.status).toBe('published');
  });

  it('restores to the queue rather than straight back onto the site', async () => {
    const id = await approvedBuilder();
    await transitionContent(db as never, {
      entityType: 'builder',
      entityId: id,
      action: 'publish',
      actor: editor,
      deploy: fakeDeploy().deploy,
    });
    await transitionContent(db as never, {
      entityType: 'builder',
      entityId: id,
      action: 'archive',
      actor: editor,
      note: 'Taken down.',
      deploy: fakeDeploy().deploy,
    });

    const result = await transitionContent(db as never, {
      entityType: 'builder',
      entityId: id,
      action: 'restore',
      actor: editor,
      note: 'Resolved, bringing it back.',
      deploy: fakeDeploy().deploy,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // NOT `published`. Undoing a takedown must not be a one-click way back onto
    // the website.
    expect(result.to).toBe('approved');
  });

  it('keeps the editorial decision when the deploy hook fails', async () => {
    /**
     * §13. The database is the source of truth and the deploy is a delivery
     * mechanism. Vercel being down is not a reason to un-publish something —
     * and for a takedown, "we could not reach Vercel so we put it back up"
     * would be dangerous.
     */
    const id = await approvedBuilder();

    const result = await transitionContent(db as never, {
      entityType: 'builder',
      entityId: id,
      action: 'publish',
      actor: editor,
      deploy: async () => ({ triggered: false, reason: 'unreachable' as const }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deploy.triggered).toBe(false);

    // Published anyway.
    const [builder] = await db.select().from(schema.builders).where(eq(schema.builders.id, id));
    expect(builder.status).toBe('published');

    // And the editor is told, in a sentence that says what happens next.
    expect(deployMessage(result.deploy)).toMatch(/nightly rebuild/i);
  });

  it('does not let two editors both win a publish', async () => {
    const id = await approvedBuilder();

    const [a, b] = await Promise.all([
      transitionContent(db as never, {
        entityType: 'builder',
        entityId: id,
        action: 'publish',
        actor: editor,
        deploy: fakeDeploy().deploy,
      }),
      transitionContent(db as never, {
        entityType: 'builder',
        entityId: id,
        action: 'publish',
        actor: admin,
        deploy: fakeDeploy().deploy,
      }),
    ]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);

    // And the audit log has exactly one entry claiming the move.
    const entries = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entityId, id));
    expect(entries.filter((e) => e.toStatus === 'published')).toHaveLength(1);
  });

  it('offers only the actions a state and a role actually allow', () => {
    expect(availablePublishActions('approved', 'editor')).toEqual(['publish']);
    expect(availablePublishActions('published', 'editor')).toEqual(['archive']);
    expect(availablePublishActions('archived', 'admin')).toEqual(['restore']);
    // A reviewer reviews; they do not ship.
    expect(availablePublishActions('approved', 'reviewer')).toEqual([]);
    expect(availablePublishActions('pending', 'admin')).toEqual([]);

    expect(canPublish('admin')).toBe(true);
    expect(canPublish('editor')).toBe(true);
    expect(canPublish('reviewer')).toBe(false);
    expect(canPublish('viewer')).toBe(false);
  });

  it('has no transition that reaches published from anywhere but approved', () => {
    // The map itself, asserted. A future edit that adds a shortcut fails here.
    for (const [action, rule] of Object.entries(PUBLISH_RULES)) {
      if (rule.to === 'published') {
        expect(rule.from, `${action} reaches published`).toEqual(['approved']);
      }
    }
  });
});

// =========================================================================
// THE QUEUE
// =========================================================================

describe('the publish queue', () => {
  it('lists approved records with who approved them', async () => {
    const id = await submission('builder', BUILDER_PAYLOAD);
    // Approve the submission first, so the audit trail is realistic.
    await db.insert(schema.auditLog).values({
      actorId: editor.id,
      actorEmail: editor.email,
      action: 'submission.approved',
      entityType: 'submission',
      entityId: id,
      fromStatus: 'in_review',
      toStatus: 'approved',
    });
    const promoted = await promoteSubmission(db as never, {
      submissionId: id,
      actor: editor,
    });
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) return;

    const rows = await listPublishable(db as never, ['approved']);
    const row = rows.find((r) => r.id === promoted.entityId);

    expect(row).toBeDefined();
    expect(row!.entityType).toBe('builder');
    expect(row!.title).toBe('Asha Menon');
    expect(row!.status).toBe('approved');
    // Credited to the person who sent it in, and to the editor who approved it.
    expect(row!.submissionId).toBe(id);
    expect(row!.submitterName).toBe('A Person');
    expect(row!.approvedBy).toBe(editor.email);
  });

  it('counts what is where', async () => {
    const [row] = await db
      .insert(schema.builders)
      .values({ slug: 'counted', name: 'X', cityId, role: 'r', status: 'approved' })
      .returning({ id: schema.builders.id });

    const before = await countPublishable(db as never);
    expect(before.approved).toBeGreaterThanOrEqual(1);

    await transitionContent(db as never, {
      entityType: 'builder',
      entityId: row.id,
      action: 'publish',
      actor: editor,
      deploy: fakeDeploy().deploy,
    });

    const after = await countPublishable(db as never);
    expect(after.approved).toBe(before.approved - 1);
    expect(after.published).toBe(before.published + 1);
  });
});

// =========================================================================
// THE WHOLE CYCLE — §23
// =========================================================================

describe('the editorial cycle, end to end', () => {
  it('carries a submission from the form to the public record and back off it', async () => {
    /**
     * §23, exercised against a real database:
     *
     *   pending → in_review → approved → promoted → published → public
     *                                             → archived  → gone
     *
     * Each step asserts the PUBLIC consequence, read through the same reader
     * the static build uses — so this tests what a visitor would see, not just
     * what a column says.
     */
    const id = await submission('builder', BUILDER_PAYLOAD, 'pending');

    // ── The editor reviews and approves ────────────────────────────────
    const { transitionSubmission } = await import('../admin/src/server/transitions');

    const started = await transitionSubmission(db as never, {
      submissionId: id,
      action: 'start_review',
      actor: editor,
    });
    expect(started.ok).toBe(true);

    const approved = await transitionSubmission(db as never, {
      submissionId: id,
      action: 'approve',
      actor: editor,
    });
    expect(approved.ok).toBe(true);

    // Approved is NOT public. Nothing is on the site yet.
    let record = await loadRecordSet(db as never);
    expect(record.builders.some((b) => b.slug === 'asha-menon')).toBe(false);

    // ── Promotion creates the record ───────────────────────────────────
    const promoted = await promoteSubmission(db as never, { submissionId: id, actor: editor });
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) return;

    // Still not public — it exists at `approved`.
    record = await loadRecordSet(db as never);
    const asApproved = record.builders.find((b) => b.slug === 'asha-menon');
    // The reader loads builders past the predicate for attribution, so the row
    // is visible — but it is not PUBLIC, which is what the site renders on.
    expect(asApproved?.status).not.toBe('published');
    expect(asApproved?.status).not.toBe('featured');

    // ── Publication puts it on the site ────────────────────────────────
    const hook = fakeDeploy();
    const published = await transitionContent(db as never, {
      entityType: 'builder',
      entityId: promoted.entityId,
      action: 'publish',
      actor: editor,
      deploy: hook.deploy,
    });
    expect(published.ok).toBe(true);
    expect(hook.calls).toHaveLength(1);

    record = await loadRecordSet(db as never);
    const live = record.builders.find((b) => b.slug === 'asha-menon');
    expect(live?.status).toBe('published');
    expect(live?.name).toBe('Asha Menon');

    // ── NO PRIVATE INFORMATION REACHED THE PUBLIC RECORD ───────────────
    /**
     * The submitter's email is on the submission and must never be on the
     * record made from it. Asserted against the whole serialised dataset
     * rather than field by field, because the failure this guards against is
     * a field nobody thought to check.
     */
    const serialised = JSON.stringify(record);
    expect(serialised).not.toContain('person@example.com');
    expect(serialised).not.toContain('someone@example.com');
    expect(serialised).not.toContain('submitterEmail');
    expect(serialised).not.toContain('ipHash');

    // ── Takedown removes it from the next build ────────────────────────
    const takenDown = await transitionContent(db as never, {
      entityType: 'builder',
      entityId: promoted.entityId,
      action: 'archive',
      actor: editor,
      note: 'The person asked us to take it down.',
      deploy: fakeDeploy().deploy,
    });
    expect(takenDown.ok).toBe(true);

    record = await loadRecordSet(db as never);
    const afterTakedown = record.builders.find((b) => b.slug === 'asha-menon');
    expect(afterTakedown?.status).not.toBe('published');
    expect(afterTakedown?.status).not.toBe('featured');

    // ── EVERY MUTATION IS AUDITED ──────────────────────────────────────
    const submissionTrail = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entityId, id));
    expect(submissionTrail.map((e) => e.action)).toEqual(
      expect.arrayContaining(['submission.review_started', 'submission.approved']),
    );

    const recordTrail = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entityId, promoted.entityId));
    expect(recordTrail.map((e) => e.action)).toEqual(
      expect.arrayContaining(['promoted', 'builder.published', 'builder.archived']),
    );

    // The takedown carries its reason, which is the point of requiring one.
    const archived = recordTrail.find((e) => e.action === 'builder.archived');
    expect(archived?.note).toBe('The person asked us to take it down.');

    // And the original submission still exists, unaltered.
    const [source] = await db
      .select()
      .from(schema.submissions)
      .where(eq(schema.submissions.id, id));
    expect(source.payload).toEqual(BUILDER_PAYLOAD);
  });
});
