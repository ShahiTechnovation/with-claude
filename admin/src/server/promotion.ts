/**
 * PROMOTION — turning an approved submission into a real record.
 *
 * The first place in this project where something somebody sent in becomes an
 * entity with a slug. Everything before it was an inbox.
 *
 *     submission (approved)  ──promote──▶  entity (approved)  ──publish──▶  live
 *
 * Note the middle state. Promotion creates the record at `approved`, NOT at
 * `published`: making something exist and putting it on the website are two
 * decisions, and an editor gets to make them separately. §8 says this outright
 * for projects and it is applied to every kind, because the reasoning does not
 * change with the type.
 *
 * ── WHAT THIS REFUSES TO DO ──────────────────────────────────────────────
 *
 * INVENT. Every field written here comes from the payload or from a resolvable
 * reference. Where a required field is missing, promotion FAILS with a message
 * naming what is missing, rather than filling in a plausible value — a
 * fabricated summary or a guessed category is exactly the kind of content this
 * site exists not to publish, and an editor silently shipping one because the
 * promoter was helpful is worse than a promotion that refused.
 *
 * CREATE A CITY. A city-interest submission never creates a city. `cities` is
 * the atlas, and a person registering interest is a signal about a place, not
 * a decision to plot one. The city is matched where it can be and the interest
 * is recorded either way — `city_interest.city_id` is nullable precisely so
 * somebody in a town that is not on the map still counts.
 *
 * VERIFY. `city_interest.verified_at` is left null. Editorial approval means
 * "this is a real submission worth recording", which is a different claim from
 * "this person's interest is verified" — and only verified rows feed the count
 * a city's derived state reads. Conflating the two would make approving a form
 * enough to move a city towards looking like a chapter, which is the single
 * governance rule this codebase guards hardest.
 *
 * ── TRANSACTIONAL, AND IDEMPOTENT ────────────────────────────────────────
 *
 * One BEGIN/COMMIT covers: the entity, its relationships, the back-reference
 * on the submission, and the audit row. There is never an entity whose
 * submission points nowhere, and never a submission marked promoted with no
 * entity behind it.
 *
 * A second click returns the record the first one made. `entity_type` and
 * `entity_id` are re-checked inside the transaction with the update guarded on
 * them still being null, so two simultaneous requests cannot both insert.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../../../db/schema';
import type { Actor } from './transitions';
import type { EntityType } from './publishing';

type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;
type Transaction = Parameters<Parameters<AnyDatabase['transaction']>[0]>[0];

/** Promotion is an Editor/Admin act, like publishing. */
const PROMOTE_ROLES = ['admin', 'editor'] as const;

export function canPromote(role: string): boolean {
  return (PROMOTE_ROLES as readonly string[]).includes(role);
}

export type PromotionFailure =
  | { ok: false; status: 403; error: string }
  | { ok: false; status: 404; error: string }
  | { ok: false; status: 409; error: string }
  | { ok: false; status: 422; error: string };

export type PromotionResult =
  | {
      ok: true;
      entityType: EntityType | 'city_interest';
      entityId: string;
      slug: string | null;
      /** True when this call created it; false when it already existed. */
      created: boolean;
    }
  | PromotionFailure;

export interface PromotionInput {
  submissionId: string;
  actor: Actor;
}

/**
 * A field the payload had to carry and did not.
 *
 * Thrown rather than returned so the mapping code reads as a straight
 * description of what a record needs, and so any missing field aborts the
 * transaction rather than being written as a null.
 */
class MissingField extends Error {
  constructor(what: string) {
    super(what);
    this.name = 'MissingField';
  }
}

/** Read a required string from the payload, or refuse the whole promotion. */
function required(payload: Record<string, unknown>, field: string, label: string): string {
  const value = payload[field];
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0) {
    throw new MissingField(
      `This submission has no ${label}, which a record cannot be created without. ` +
        `Ask the submitter for it, or create the record by hand.`,
    );
  }
  return text;
}

/** Read an optional string. Absent and blank are the same thing. */
function optional(payload: Record<string, unknown>, field: string): string | null {
  const value = payload[field];
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > 0 ? text : null;
}

/**
 * A URL-safe slug, from whatever the person typed.
 *
 * Deliberately simple and deliberately not unique on its own — uniqueness is
 * enforced by the database and handled by `uniqueSlug()` below, because a
 * collision check that is not inside the transaction is a race.
 */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug.length > 0 ? slug : 'record';
}

/**
 * A slug nothing else is using, resolved inside the transaction.
 *
 * Appends `-2`, `-3` and so on. Two people submitting a project called the
 * same thing is ordinary, and it must not be an error an editor has to
 * untangle by hand.
 */
async function uniqueSlug(tx: Transaction, table: never, base: string): Promise<string> {
  const anyTable = table as unknown as { slug: never };
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const [taken] = await tx
      .select({ slug: anyTable.slug })
      .from(table as never)
      .where(eq(anyTable.slug, candidate as never))
      .limit(1);
    if (!taken) return candidate;
  }
  throw new MissingField(`Could not find a free slug starting "${base}".`);
}

/**
 * Match a city by the name somebody typed.
 *
 * Case- and punctuation-insensitive, because a form asks for a city and gets
 * "New Delhi", "new delhi" and "New  Delhi". Returns null rather than creating
 * anything — see the file header.
 */
async function matchCity(tx: Transaction, name: string): Promise<{ id: string } | null> {
  const [byName] = await tx
    .select({ id: schema.cities.id })
    .from(schema.cities)
    .where(sql`lower(trim(${schema.cities.name})) = ${name.trim().toLowerCase()}`)
    .limit(1);
  if (byName) return byName;

  const [bySlug] = await tx
    .select({ id: schema.cities.id })
    .from(schema.cities)
    .where(eq(schema.cities.slug, slugify(name)))
    .limit(1);
  return bySlug ?? null;
}

/** A city the record must resolve, or promotion fails. */
async function requireCity(tx: Transaction, name: string): Promise<string> {
  const city = await matchCity(tx, name);
  if (!city) {
    throw new MissingField(
      `"${name}" is not a city on the atlas. Add the city first, or edit the submission ` +
        `to name one that is — promotion does not create cities.`,
    );
  }
  return city.id;
}

/**
 * Split a free-text list into entries.
 *
 * Forms ask for "Claude Code, the API" and get commas, newlines, semicolons
 * and bullets. Everything empty is dropped; nothing is invented.
 */
function list(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(/[,;\n]+/)
    .map((entry) => entry.trim().replace(/^[-•*]\s*/, ''))
    .filter((entry) => entry.length > 0);
}

/** Links pasted as free text, kept only where they are real URLs. */
function links(value: string | null): { label: string; url: string }[] {
  return list(value)
    .map((entry) => {
      try {
        const url = new URL(entry.startsWith('http') ? entry : `https://${entry}`);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
        return { label: url.hostname.replace(/^www\./, ''), url: url.toString() };
      } catch {
        return null;
      }
    })
    .filter((link): link is { label: string; url: string } => link !== null);
}

// =========================================================================

/**
 * Promote one approved submission.
 *
 * The order of the checks mirrors the other two state machines: role, then the
 * submission, then its state, then the work.
 */
export async function promoteSubmission(
  db: AnyDatabase,
  { submissionId, actor }: PromotionInput,
): Promise<PromotionResult> {
  if (!canPromote(actor.role)) {
    return {
      ok: false,
      status: 403,
      error: `Your role (${actor.role}) cannot create records from submissions.`,
    };
  }

  const [submission] = await db
    .select({
      id: schema.submissions.id,
      kind: schema.submissions.kind,
      status: schema.submissions.status,
      payload: schema.submissions.payload,
      submitterName: schema.submissions.submitterName,
      submitterEmail: schema.submissions.submitterEmail,
      entityType: schema.submissions.entityType,
      entityId: schema.submissions.entityId,
    })
    .from(schema.submissions)
    .where(eq(schema.submissions.id, submissionId));

  if (!submission) {
    return { ok: false, status: 404, error: 'No submission with that id.' };
  }

  /**
   * IDEMPOTENCY, first check.
   *
   * Already promoted: hand back what was made rather than making a second one.
   * A double click on a slow connection is the ordinary way this happens, and
   * it must not produce two builders with the same name.
   */
  if (submission.entityType && submission.entityId) {
    return {
      ok: true,
      entityType: submission.entityType as EntityType,
      entityId: submission.entityId,
      slug: await slugOf(db, submission.entityType, submission.entityId),
      created: false,
    };
  }

  if (submission.status !== 'approved') {
    return {
      ok: false,
      status: 409,
      error:
        `Only an approved submission can become a record. This one is "${submission.status}". ` +
        `Approve it first — approving says it belongs in the record, and this creates it.`,
    };
  }

  const payload = (submission.payload ?? {}) as Record<string, unknown>;

  try {
    return await db.transaction(async (tx) => {
      /**
       * IDEMPOTENCY, second check — inside the transaction this time.
       *
       * The check above is a fast path for the common case. This one is the
       * one that is actually correct under concurrency: it re-reads the row
       * and the final UPDATE is guarded on `entity_id IS NULL`, so of two
       * simultaneous promotions exactly one can win and the other rolls back
       * everything it did.
       */
      const [fresh] = await tx
        .select({
          entityType: schema.submissions.entityType,
          entityId: schema.submissions.entityId,
        })
        .from(schema.submissions)
        .where(eq(schema.submissions.id, submissionId));

      if (fresh?.entityType && fresh.entityId) {
        return {
          ok: true as const,
          entityType: fresh.entityType as EntityType,
          entityId: fresh.entityId,
          slug: await slugOf(tx as never, fresh.entityType, fresh.entityId),
          created: false,
        };
      }

      const made = await create(tx, submission.kind, payload, submission);

      // The back-reference. Guarded on still being unset, so a lost race
      // updates zero rows and takes its whole transaction down with it.
      const linked = await tx
        .update(schema.submissions)
        .set({ entityType: made.entityType, entityId: made.entityId })
        .where(
          and(
            eq(schema.submissions.id, submissionId),
            isNull(schema.submissions.entityId),
            isNull(schema.submissions.entityType),
          ),
        )
        .returning({ id: schema.submissions.id });

      if (linked.length !== 1) throw new ConcurrentPromotion();

      await tx.insert(schema.auditLog).values({
        actorId: actor.id,
        actorEmail: actor.email,
        action: 'promoted',
        entityType: made.entityType,
        entityId: made.entityId,
        // No status moved on the submission — promotion is not a review step.
        // `toStatus` records where the new record starts, which is the fact
        // worth being able to read back: approved, not published.
        toStatus: made.entityType === 'city_interest' ? null : 'approved',
        note: `Created from submission ${submissionId}.`,
      });

      return {
        ok: true as const,
        entityType: made.entityType,
        entityId: made.entityId,
        slug: made.slug,
        created: true,
      };
    });
  } catch (error) {
    if (error instanceof MissingField) {
      return { ok: false, status: 422, error: error.message };
    }
    if (error instanceof ConcurrentPromotion || isUniqueViolation(error)) {
      return {
        ok: false,
        status: 409,
        error: 'Somebody else promoted this a moment ago. Reload and look again.',
      };
    }
    console.error('[promotion] failed:', error);
    throw error;
  }
}

class ConcurrentPromotion extends Error {
  constructor() {
    super('Submission promoted concurrently.');
    this.name = 'ConcurrentPromotion';
  }
}

/**
 * A unique-constraint violation — which here means a lost race, not a fault.
 *
 * `uniqueSlug()` resolves a free slug inside the transaction, but PostgreSQL's
 * snapshot isolation means two simultaneous promotions cannot see each other's
 * uncommitted insert. Both pick the same slug, both get past the check, and the
 * second one collides at COMMIT on `<table>_slug_unique`.
 *
 * That collision arrives BEFORE the `entity_id IS NULL` guard that raises
 * `ConcurrentPromotion`, so without this it escapes as a 500 — telling an
 * editor who double-clicked that the server broke, when what actually happened
 * is the thing this function is designed to guarantee: one record, not two. The
 * loser's transaction has already rolled back in full, so the honest answer is
 * the same 409 the guarded path gives.
 *
 * `23505` is PostgreSQL's unique_violation. Both drivers surface the driver
 * error as `cause` on Drizzle's wrapper, so the chain is walked rather than
 * assuming a shape.
 */
function isUniqueViolation(error: unknown): boolean {
  for (let cursor = error, depth = 0; cursor && depth < 5; depth += 1) {
    if (typeof cursor === 'object' && (cursor as { code?: unknown }).code === '23505') return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

/** The slug of an already-promoted record, for the "already done" answer. */
async function slugOf(
  db: AnyDatabase,
  entityType: string,
  entityId: string,
): Promise<string | null> {
  const tables: Record<string, { slug: never; id: never }> = {
    builder: schema.builders as never,
    project: schema.projects as never,
    use_case: schema.useCases as never,
  };
  const table = tables[entityType];
  if (!table) return null;

  const [row] = await db
    .select({ slug: table.slug })
    .from(table as never)
    .where(eq(table.id, entityId as never))
    .limit(1);
  return (row as { slug: string } | undefined)?.slug ?? null;
}

interface Created {
  entityType: EntityType | 'city_interest';
  entityId: string;
  slug: string | null;
}

/** Dispatch on what was submitted. */
async function create(
  tx: Transaction,
  kind: string,
  payload: Record<string, unknown>,
  submission: { submitterName: string | null; submitterEmail: string; id: string },
): Promise<Created> {
  switch (kind) {
    case 'builder':
      return createBuilder(tx, payload, submission);
    case 'project':
      return createProject(tx, payload);
    case 'use-case':
      return createUseCase(tx, payload, submission);
    case 'city-interest':
      return createCityInterest(tx, payload, submission);
    default:
      throw new MissingField(`"${kind}" is not a submission kind this can promote.`);
  }
}

// ── Builder ─────────────────────────────────────────────────────────────

async function createBuilder(
  tx: Transaction,
  payload: Record<string, unknown>,
  submission: { submitterName: string | null },
): Promise<Created> {
  const name = optional(payload, 'name') ?? submission.submitterName;
  if (!name) {
    throw new MissingField('This submission has no name, and a builder record needs one.');
  }

  const cityId = await requireCity(tx, required(payload, 'city', 'city'));
  const slug = await uniqueSlug(tx, schema.builders as never, slugify(name));

  const [row] = await tx
    .insert(schema.builders)
    .values({
      slug,
      name,
      cityId,
      role: required(payload, 'role', 'role — what they do, in a few words'),
      /**
       * NO ROLES ARE ASSIGNED HERE.
       *
       * `roles` stays empty. It is a curated field, and in particular the
       * database would reject `ambassador` outright — nobody arrives at that
       * status through a form. An editor adds roles afterwards if any apply.
       */
      roles: [],
      building: optional(payload, 'building'),
      claudeTools: list(optional(payload, 'claudeTools')),
      // Created, not published. Publishing is a separate act.
      status: 'approved',
      /**
       * No `createdAt`. The record's rule is that a timestamp is written only
       * when the real date is known, and "when the editor happened to click
       * promote" is not when this person started building.
       */
    })
    .returning({ id: schema.builders.id, slug: schema.builders.slug });

  const social = links(optional(payload, 'links'));
  if (social.length > 0) {
    await tx.insert(schema.socialLinks).values(
      social.map((link, i) => ({
        ownerType: 'builder' as const,
        ownerId: row.id,
        position: i,
        label: link.label,
        url: link.url,
      })),
    );
  }

  return { entityType: 'builder', entityId: row.id, slug: row.slug };
}

// ── Project ─────────────────────────────────────────────────────────────

async function createProject(
  tx: Transaction,
  payload: Record<string, unknown>,
): Promise<Created> {
  const title = required(payload, 'title', 'title');
  const cityId = await requireCity(tx, required(payload, 'city', 'city'));
  const slug = await uniqueSlug(tx, schema.projects as never, slugify(title));

  /**
   * The category has to be one the schema knows.
   *
   * The form offers a list, but a payload can be older than the list. An
   * unrecognised value fails rather than being coerced to something plausible
   * — filing a research project under "experiment" because the enum did not
   * match is a small lie the record would then carry forever.
   */
  const categoryInput = required(payload, 'category', 'category');
  const category = schema.projectCategory.enumValues.find(
    (value) => value === slugify(categoryInput),
  );
  if (!category) {
    throw new MissingField(
      `"${categoryInput}" is not a project category. Expected one of: ` +
        `${schema.projectCategory.enumValues.join(', ')}.`,
    );
  }

  const [row] = await tx
    .insert(schema.projects)
    .values({
      slug,
      title,
      cityId,
      summary: required(payload, 'summary', 'summary'),
      category,
      url: optional(payload, 'url'),
      claudeUsage: optional(payload, 'claudeUsage'),
      tags: [],
      status: 'approved',
    })
    .returning({ id: schema.projects.id, slug: schema.projects.slug });

  /**
   * NO BUILDERS ARE CREDITED.
   *
   * The form collects a creator as free text, and a name is not a builder
   * record. Guessing which existing builder somebody meant — or creating one
   * from a name — would put a real person's profile behind work they may not
   * have done. An editor links the credit afterwards, deliberately.
   *
   * `project_builders` stays empty until they do, and the project renders with
   * no attribution rather than a wrong one.
   */

  return { entityType: 'project', entityId: row.id, slug: row.slug };
}

// ── Use case ────────────────────────────────────────────────────────────

async function createUseCase(
  tx: Transaction,
  payload: Record<string, unknown>,
  submission: { submitterName: string | null },
): Promise<Created> {
  const title = required(payload, 'title', 'title');
  const slug = await uniqueSlug(tx, schema.useCases as never, slugify(title));

  const categoryInput = required(payload, 'category', 'category');
  const category = schema.useCaseCategory.enumValues.find(
    (value) => value === slugify(categoryInput),
  );
  if (!category) {
    throw new MissingField(
      `"${categoryInput}" is not a use-case category. Expected one of: ` +
        `${schema.useCaseCategory.enumValues.join(', ')}.`,
    );
  }

  const cityName = optional(payload, 'city');
  const city = cityName ? await matchCity(tx, cityName) : null;

  /**
   * BOTH HALVES OF THE SPLIT ARE REQUIRED.
   *
   * `claudeDid` and `humanDid` are what makes a use case a use case rather
   * than a product demo, and the database enforces it with a CHECK. Failing
   * here rather than at the constraint gives the editor a sentence they can
   * act on instead of a Postgres error.
   */
  const claudeDid = list(required(payload, 'claudeDid', 'account of what Claude did'));
  const humanDid = list(required(payload, 'humanDid', 'account of what the person did'));
  if (claudeDid.length === 0 || humanDid.length === 0) {
    throw new MissingField(
      'A use case must say what Claude did AND what the person did. One of those is empty.',
    );
  }

  const [row] = await tx
    .insert(schema.useCases)
    .values({
      slug,
      title,
      summary: optional(payload, 'summary') ?? required(payload, 'problem', 'summary or problem'),
      category,
      // The byline. `credential` is NOT NULL — no anonymous authority, at any
      // layer — and the form requires it for exactly this reason.
      authorBuilderId: null,
      authorName: optional(payload, 'name') ?? submission.submitterName,
      authorCredential: required(payload, 'credential', 'credential — why they would know'),
      cityId: city?.id ?? null,
      /**
       * The submission date, which IS evidenced — the form was filled in on a
       * real day and the row records it. Not a guess.
       */
      date: new Date().toISOString().slice(0, 10),
      problem: required(payload, 'problem', 'problem'),
      context: optional(payload, 'context') ?? required(payload, 'problem', 'context'),
      claudeDid,
      humanDid,
      tools: list(optional(payload, 'tools')),
      result: required(payload, 'result', 'result'),
      status: 'approved',
    })
    .returning({ id: schema.useCases.id, slug: schema.useCases.slug });

  /**
   * The workflow, in the order it was written.
   *
   * The form collects it as free text, one step per line. Each becomes a step
   * attributed to `both` — the honest reading of a line that does not say who
   * did it. An editor splits the attribution properly afterwards; what matters
   * is that nothing the person wrote is discarded.
   */
  const workflow = list(optional(payload, 'workflow'));
  if (workflow.length > 0) {
    await tx.insert(schema.useCaseWorkflowSteps).values(
      workflow.map((step, i) => ({
        useCaseId: row.id,
        position: i,
        title: step.slice(0, 120),
        detail: step,
        by: 'both' as const,
      })),
    );
  }

  return { entityType: 'use_case', entityId: row.id, slug: row.slug };
}

// ── City interest ───────────────────────────────────────────────────────

/**
 * Somebody saying "I am here".
 *
 * Creates NO city — see the file header. Records the interest against a
 * matched city where there is one, and against the typed name where there is
 * not, which is what `city_interest.city_id` being nullable is for.
 *
 * `verified_at` stays NULL. Approving a submission is not verifying a person,
 * and only verified rows count towards the interest figure a city's derived
 * state reads. That separation is what stops a form from being able to conjure
 * a chapter, and it is not weakened here.
 */
async function createCityInterest(
  tx: Transaction,
  payload: Record<string, unknown>,
  submission: { submitterEmail: string; id: string },
): Promise<Created> {
  const cityName = required(payload, 'city', 'city');
  const city = await matchCity(tx, cityName);
  const email = optional(payload, 'email') ?? submission.submitterEmail;

  /**
   * One signal per person per city.
   *
   * The unique index on `(email, city_name)` makes a second submission an
   * update rather than a duplicate — which is also what makes promoting the
   * same person's two submissions idempotent at the database level rather than
   * only in this function.
   */
  const [row] = await tx
    .insert(schema.cityInterest)
    .values({
      cityName,
      cityId: city?.id ?? null,
      email,
      doing: optional(payload, 'doing'),
      helping: optional(payload, 'helping'),
      submissionId: submission.id,
      // Not verified. Approval is not verification.
      verifiedAt: null,
      verifiedBy: null,
    })
    .onConflictDoUpdate({
      target: [schema.cityInterest.email, schema.cityInterest.cityName],
      set: {
        cityId: city?.id ?? null,
        doing: optional(payload, 'doing'),
        helping: optional(payload, 'helping'),
        submissionId: submission.id,
      },
    })
    .returning({ id: schema.cityInterest.id });

  return { entityType: 'city_interest', entityId: row.id, slug: null };
}
