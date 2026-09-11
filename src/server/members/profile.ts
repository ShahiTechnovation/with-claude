/**
 * THE BUILDER PASSPORT — what a member may change, and what they may not.
 *
 * This file is where §14 stops being a table in a brief and becomes a
 * mechanism. Two functions carry the whole rule:
 *
 *   `sanitiseProfileInput()`  which submitted fields are even looked at
 *   `projectToBuilder()`      which builder columns a publish may write
 *
 * Both are whitelists — they enumerate what is allowed rather than filtering
 * out what is not. That direction matters more than it looks: a denylist
 * silently permits every field added to the schema after it was written, so
 * the first person to add a column gets a security decision they never knew
 * they were making. A whitelist fails closed, and the new column is simply
 * ignored until somebody names it.
 *
 * ── WHY A PROJECTION AT ALL ──────────────────────────────────────────────
 *
 * A member edits `member_profiles`. The public reads `builders`. Publishing
 * copies the allowed fields from the first to the second.
 *
 * The indirection is what makes claiming safe. A claimed builder row carries
 * things the member did not write and must not be able to rewrite: the name a
 * human editor verified, `roles`, the ambassador link, the event credits, the
 * `image_path` from the repository. Because the projection can only write the
 * columns it lists, none of those are reachable — not by a crafted request,
 * not by a future careless edit to a form, because the form is not what
 * decides.
 *
 * It also means the prerendered pages and the search index keep reading the
 * one table they already read, which is why Phase A needs no change to
 * `RecordSet`, to `source-db.ts`, or to anything Phase 0 verified.
 */
import { and, eq } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import * as schema from '../../../db/schema';
import type { Member } from '../auth/member';
import { checkUsernameAvailable } from './username';

type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

// =========================================================================
// WHAT A USER OWNS
// =========================================================================

/**
 * The fields a member may set on their own profile. The complete list.
 *
 * Compare with what is NOT here, all of which lives on `builders` and stays
 * there: `name`, `roles`, `featured`, `status`, `ambassadorId`, `imagePath`,
 * `builtAtEventId`, `owner_member_id`, `source`. And from
 * `member_profiles` itself: `visibility` is here (a member may unlist
 * themselves) but `published_at` is not (that is the outcome of publishing,
 * not an input to it).
 */
export const USER_OWNED_FIELDS = [
  'displayName',
  'firstName',
  'lastName',
  'headline',
  'bio',
  'country',
  'website',
  'primaryRole',
  'claudeSince',
  'publicEmail',
  'visibility',
] as const;

export type UserOwnedField = (typeof USER_OWNED_FIELDS)[number];

/**
 * Roles a member may give themselves.
 *
 * §15's list, and nothing that implies standing. The words a member may NOT
 * use are not filtered out of a free-text field — they are simply not in this
 * one, and anything else is rejected. `ambassador` in particular is refused
 * three times over: it is absent here, `PROTECTED_ROLE_WORDS` catches it in
 * free text, and `builders.roles` carries a CHECK that makes the database
 * refuse the row outright.
 */
export const SELECTABLE_ROLES = [
  'Founder',
  'Developer',
  'Designer',
  'Researcher',
  'Student',
  'Creator',
  'Product',
  'Marketer',
  'Operator',
  'Investor',
  'Educator',
] as const;

/**
 * Words that may not appear in any member-supplied role, headline or display
 * name.
 *
 * These are trust signals. They are granted by Anthropic or by a moderator and
 * recorded with their provenance — `ambassadors.verified_via` is NOT NULL for
 * exactly this reason. A member typing one into a headline would render the
 * strongest claim on the site next to their name, which is the single thing
 * this project must never print without evidence.
 */
export const PROTECTED_ROLE_WORDS = [
  'ambassador',
  'official',
  'verified',
  'anthropic',
  'partner',
  'sponsor',
  'staff',
  'moderator',
  'admin',
];

/** Does this text claim standing it cannot have? Word-boundary matched. */
export function claimsProtectedStanding(value: string): string | null {
  const lower = value.toLowerCase();
  for (const word of PROTECTED_ROLE_WORDS) {
    if (new RegExp(`\\b${word}\\b`).test(lower)) return word;
  }
  return null;
}

// =========================================================================
// VALIDATION
// =========================================================================

const LIMITS = {
  displayName: 80,
  name: 60,
  headline: 140,
  bio: 2_000,
  country: 60,
  role: 60,
  claudeSince: 40,
  url: 500,
} as const;

/**
 * An HTTPS URL, bounded and parseable.
 *
 * Mirrors `src/server/submissions/validate.ts` deliberately, including the
 * refusal to upgrade `http:` rather than rewriting it: a link somebody typed
 * as insecure is a link nobody has checked, and quietly changing it would make
 * this endpoint responsible for a destination it never saw.
 *
 * The submissions validator's copy is a module-private const, so this is a
 * second instance of the same six lines rather than a shared import. Worth it
 * over exporting from a file whose job is a different form's schema and whose
 * limits are its own.
 */
const httpsUrl = z
  .string()
  .trim()
  .max(LIMITS.url, `Links must be under ${LIMITS.url} characters.`)
  .superRefine((value, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'That does not look like a full URL.' });
      return;
    }
    if (parsed.protocol !== 'https:') {
      ctx.addIssue({ code: 'custom', message: 'Links must start with https://' });
    }
    if (!parsed.hostname.includes('.')) {
      ctx.addIssue({ code: 'custom', message: 'That URL has no domain in it.' });
    }
  });

/** Free text that must not assert standing. */
const plainText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .superRefine((value, ctx) => {
      const word = claimsProtectedStanding(value);
      if (word) {
        ctx.addIssue({
          code: 'custom',
          message: `"${word}" is a status the community grants, not one a profile can claim.`,
        });
      }
    });

/**
 * The profile patch schema.
 *
 * Every field optional, because this is a PATCH: a form that sends only the
 * bio must not blank the headline. `.strict()` is the important modifier —
 * an unknown key is an ERROR rather than being dropped silently, so a client
 * trying to send `owner_member_id` or `status` is told no rather than being
 * quietly ignored. Silence would look like success.
 */
export const profilePatchSchema = z
  .object({
    displayName: plainText(LIMITS.displayName).optional(),
    firstName: plainText(LIMITS.name).optional(),
    lastName: plainText(LIMITS.name).optional(),
    headline: plainText(LIMITS.headline).optional(),
    // A bio is prose and is escaped on render, so protected words are allowed
    // in it — "I met an ambassador at a meetup" is a sentence, not a claim.
    bio: z.string().trim().max(LIMITS.bio).optional(),
    /**
     * A city SLUG, not an id.
     *
     * The record's `id` is a uuid when the build reads PostgreSQL and a
     * hand-authored string like `cty-bhopal` when it reads the TypeScript
     * files, so a form that posted ids would work in production and fail in
     * development. The slug is the identity the whole site already uses and is
     * the same in both. `updateProfile()` resolves it.
     */
    citySlug: z.string().trim().max(80).nullable().optional(),
    country: z.string().trim().max(LIMITS.country).optional(),
    website: httpsUrl.optional(),
    primaryRole: z.enum(SELECTABLE_ROLES).optional(),
    claudeSince: z.string().trim().max(LIMITS.claudeSince).optional(),
    publicEmail: z.boolean().optional(),
    visibility: z.enum(schema.profileVisibility.enumValues).optional(),
    username: z.string().trim().max(64).optional(),
  })
  .strict();

export type ProfilePatch = z.infer<typeof profilePatchSchema>;

/**
 * Reduce a parsed patch to the fields a member owns.
 *
 * `profilePatchSchema` already rejects unknown keys, so this is the second of
 * two independent gates rather than the only one. Belt and braces on the one
 * decision in Phase A where being wrong means somebody editing a record that
 * is not theirs.
 */
export function sanitiseProfileInput(patch: ProfilePatch): Partial<Pick<ProfilePatch, UserOwnedField>> {
  const out: Partial<Pick<ProfilePatch, UserOwnedField>> = {};
  for (const field of USER_OWNED_FIELDS) {
    const value = patch[field];
    if (value !== undefined) {
      // The cast is confined to this one line. `field` is a `UserOwnedField`
      // and `value` is that field's own type, but TypeScript cannot see the
      // correlation across a loop over a union of keys.
      (out as Record<string, unknown>)[field] = value;
    }
  }
  return out;
}

// =========================================================================
// READING AND WRITING
// =========================================================================

export interface ProfileRow {
  memberId: string;
  username: string;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  headline: string | null;
  bio: string | null;
  cityId: string | null;
  country: string | null;
  website: string | null;
  primaryRole: string | null;
  claudeSince: string | null;
  publicEmail: boolean;
  visibility: (typeof schema.profileVisibility.enumValues)[number];
  publishedAt: Date | null;
}

export async function readProfile(memberId: string, db: AnyDatabase): Promise<ProfileRow | null> {
  const [row] = await db
    .select()
    .from(schema.memberProfiles)
    .where(eq(schema.memberProfiles.memberId, memberId));
  return (row as ProfileRow | undefined) ?? null;
}

export type UpdateResult =
  | { ok: true; profile: ProfileRow }
  | { ok: false; status: 400 | 409 | 422; error: string; field?: string };

/**
 * Apply a patch to the caller's own profile.
 *
 * `memberId` comes from `requireMember()` and is never read from the request
 * body. There is no parameter here that a browser could set to point this at
 * somebody else's row — the WHERE clause is built from the verified identity,
 * which is what makes "cannot edit another member" structural rather than a
 * check that could be forgotten.
 */
export async function updateProfile(
  member: Member,
  patch: ProfilePatch,
  db: AnyDatabase,
): Promise<UpdateResult> {
  const fields = sanitiseProfileInput(patch);

  // A username change is validated separately: it is the one field with
  // table-wide uniqueness and a reserved list behind it.
  let username: string | undefined;
  if (patch.username !== undefined) {
    const check = await checkUsernameAvailable(patch.username, db, member.id);
    if (!check.ok) {
      return {
        ok: false,
        status: check.reason === 'taken' || check.reason === 'reserved' ? 409 : 422,
        error: check.message,
        field: 'username',
      };
    }
    username = check.username;
  }

  // A city must exist and be published. NOTHING HERE CREATES ONE: a city's
  // community state is derived from verified ambassador and event records, so
  // a form that could add one would be a form that creates chapters.
  let cityId: string | null | undefined;
  if (patch.citySlug !== undefined) {
    if (patch.citySlug === null || patch.citySlug === '') {
      cityId = null;
    } else {
      const [city] = await db
        .select({ id: schema.cities.id })
        .from(schema.cities)
        .where(and(eq(schema.cities.slug, patch.citySlug), eq(schema.cities.status, 'published')));
      if (!city) {
        return {
          ok: false,
          status: 422,
          error: 'That is not a city on the atlas.',
          field: 'citySlug',
        };
      }
      cityId = city.id;
    }
  }

  if (Object.keys(fields).length === 0 && username === undefined && cityId === undefined) {
    return { ok: false, status: 400, error: 'Nothing to change.' };
  }

  const [row] = await db
    .update(schema.memberProfiles)
    .set({
      ...fields,
      ...(username ? { username } : {}),
      ...(cityId !== undefined ? { cityId } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.memberProfiles.memberId, member.id))
    .returning();

  if (!row) return { ok: false, status: 409, error: 'No profile to update.' };
  return { ok: true, profile: row as ProfileRow };
}

// =========================================================================
// PUBLISHING — the projection
// =========================================================================

/**
 * The `builders` columns a member's publish is allowed to write. The whole
 * list, and the reason this file exists.
 *
 * `name` is here ONLY for a row the member created (`source = 'user'`). For a
 * claimed legacy row it is source-owned — a human editor verified it — and
 * `projectToBuilder()` drops it. That single conditional is the entire
 * difference between "I own this profile" and "I can rewrite this person's
 * record".
 */
const PROJECTED_COLUMNS = ['name', 'bio', 'role', 'cityId'] as const;

export interface PublishOutcome {
  builderId: string;
  slug: string;
  created: boolean;
}

export type PublishResult =
  | { ok: true; outcome: PublishOutcome }
  | { ok: false; status: 403 | 409 | 422; error: string };

/**
 * Build the update for a builder row from a profile.
 *
 * Pure, and separated from the write so a test can assert exactly which keys
 * come out for a legacy row versus a user-created one without a database.
 */
export function projectToBuilder(
  profile: ProfileRow,
  source: (typeof schema.contentSource.enumValues)[number],
): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    bio: profile.bio ?? null,
    role: profile.primaryRole ?? 'Builder',
    updatedAt: new Date(),
  };

  // A profile the member created is theirs to name. A claimed one is not.
  if (source === 'user') {
    const name = profile.displayName?.trim() || [profile.firstName, profile.lastName].filter(Boolean).join(' ').trim();
    if (name) projected.name = name;
    if (profile.cityId) projected.cityId = profile.cityId;
  }

  return projected;
}

/** The columns a projection may touch, exported for the test that asserts it. */
export const projectedColumns = PROJECTED_COLUMNS;

/**
 * The slug of a stored `city_id`, or an empty string.
 *
 * A one-line query that exists so the passport form does not have to import a
 * database module into a page — see `src/server/http/page-guard.ts` for why
 * that boundary is worth keeping even for an on-demand route.
 */
export async function citySlugFor(
  cityId: string | null,
  db: AnyDatabase,
): Promise<string> {
  if (!cityId) return '';
  const [row] = await db
    .select({ slug: schema.cities.slug })
    .from(schema.cities)
    .where(eq(schema.cities.id, cityId));
  return row?.slug ?? '';
}
