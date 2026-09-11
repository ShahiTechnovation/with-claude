/**
 * "CLAIM THIS PROFILE."
 *
 * The repository already holds 72 builders. Some of them are people who will
 * sign in one day and find a record of themselves that somebody else wrote.
 * They should be able to take ownership of it — and nobody else should.
 *
 * ── THE ONE RULE ─────────────────────────────────────────────────────────
 *
 * A claim resolves automatically ONLY on evidence that two accounts are the
 * same account. Never on evidence that two records look like the same person.
 *
 * That distinction is the whole file. `github.com/ashahi` on a builder record
 * and a Privy-verified GitHub login of `ashahi` is the same account: GitHub
 * asserted the identity, Privy verified the assertion, and the curated record
 * named it. A matching name in the same city is a coincidence with a plausible
 * story attached, and treating it as proof would mean the site hands somebody
 * else's public identity to whoever signs up first with the right name.
 *
 * So there is no name comparison in this file, no city comparison and no
 * fuzzy matching of any kind — and `claim_proof_type` has no enum value for
 * one, which means a future well-meaning change cannot add it without a
 * migration that says out loud what it is doing.
 *
 * ── WHERE THE EVIDENCE COMES FROM ────────────────────────────────────────
 *
 * A freshly verified Privy IDENTITY token, not this database. `member_identities`
 * is written after a match as a record of what was matched; it is never the
 * thing consulted to authorise one, because a cached identity is a claim about
 * the past and linking can be undone.
 *
 * ── WHAT AMBIGUITY DOES ──────────────────────────────────────────────────
 *
 * It creates a `pending` row and stops. It does not "probably" transfer
 * ownership, and it does not silently do nothing either — a person who
 * clicked Claim gets told a human will look. Phase C gives moderators the
 * queue; the row is already the right shape for it.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { createHash } from 'node:crypto';
import type { User } from '@privy-io/node/resources';
import * as schema from '../../../db/schema';
import type { Member } from '../auth/member';

type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

export type ProofType = (typeof schema.claimProofType.enumValues)[number];

/**
 * A hash of the value that proved the claim, salted.
 *
 * Never the value itself. The email proof compares an authenticated address
 * against a private legacy contact address, and storing either would turn this
 * table into a store of other people's email addresses for no product benefit:
 * nothing reads it back, only the fact that two things matched.
 *
 * Salted with `SUBMISSION_IP_SALT`, which already exists for exactly this
 * shape of problem — an unsalted hash of a short, guessable value is a lookup
 * table away from being the value.
 */
function hashProof(value: string): string {
  const salt = process.env.SUBMISSION_IP_SALT ?? '';
  return createHash('sha256').update(`${salt}:${value.toLowerCase()}`).digest('hex');
}

// =========================================================================
// READING WHAT PRIVY VERIFIED
// =========================================================================

export interface VerifiedAccounts {
  githubUsernames: string[];
  linkedinVanityNames: string[];
  emails: string[];
}

/**
 * Pull the linked accounts that can prove something out of a verified user.
 *
 * Only three of the many account types Privy supports are read, because only
 * three appear on a builder record in a form that can be compared:
 *
 *   `github_oauth`    carries `username` — the handle in a github.com URL
 *   `linkedin_oauth`  carries `vanity_name` — the slug in a /in/ URL
 *   `email`           carries `address`
 *
 * NOTE ON LINKEDIN: `vanity_name` is OPTIONAL in Privy's own type. When it is
 * absent there is nothing to compare against `linkedin.com/in/<slug>`, and the
 * honest outcome is a pending claim rather than a guess. Twitter/X is not read
 * at all: the account type carries a username, but a display handle is
 * renameable and gets recycled, so it is not identity evidence.
 */
export function verifiedAccountsOf(user: User): VerifiedAccounts {
  const githubUsernames: string[] = [];
  const linkedinVanityNames: string[] = [];
  const emails: string[] = [];

  for (const account of user.linked_accounts ?? []) {
    if (account.type === 'github_oauth' && account.username) {
      githubUsernames.push(account.username.toLowerCase());
    } else if (account.type === 'linkedin_oauth' && account.vanity_name) {
      linkedinVanityNames.push(account.vanity_name.toLowerCase());
    } else if (account.type === 'email' && account.address) {
      emails.push(account.address.toLowerCase());
    }
  }

  return { githubUsernames, linkedinVanityNames, emails };
}

// =========================================================================
// READING WHAT THE RECORD ALREADY SAYS
// =========================================================================

/**
 * The GitHub handle in a URL, or null.
 *
 * Strict on host — `github.com` and `www.github.com` and nothing else, so
 * `github.com.evil.example/ashahi` does not read as a GitHub profile. Strict
 * on shape: the first path segment only, and not one of GitHub's own reserved
 * paths, because `github.com/orgs/...` is not a person's handle.
 */
export function githubHandleOf(url: string): string | null {
  return handleFrom(url, ['github.com', 'www.github.com'], 0, [
    'orgs',
    'features',
    'about',
    'pricing',
    'topics',
    'collections',
    'sponsors',
    'settings',
    'apps',
    'marketplace',
  ]);
}

/**
 * The LinkedIn vanity name in a URL, or null.
 *
 * Only the `/in/<slug>` form. A `linkedin.com/company/...` URL is an
 * organisation, and a personal LinkedIn login must not be able to claim a
 * record that cites a company page.
 */
export function linkedinVanityOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  // Regional subdomains are real: `in.linkedin.com`, `uk.linkedin.com`.
  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return null;

  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 2 || parts[0].toLowerCase() !== 'in') return null;
  const slug = decodeURIComponent(parts[1]).toLowerCase();
  return slug || null;
}

function handleFrom(
  url: string,
  hosts: string[],
  segment: number,
  reserved: string[],
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!hosts.includes(parsed.hostname.toLowerCase())) return null;

  const parts = parsed.pathname.split('/').filter(Boolean);
  const raw = parts[segment];
  if (!raw) return null;
  const handle = decodeURIComponent(raw).toLowerCase();
  if (reserved.includes(handle)) return null;
  return handle;
}

// =========================================================================
// DECIDING
// =========================================================================

export interface ClaimEvidence {
  /** The builder's curated links, as stored. */
  links: { label: string; url: string }[];
}

export type ClaimDecision =
  | { resolves: true; proofType: ProofType; proofValue: string; matched: string }
  | { resolves: false; reason: 'no-match' };

/**
 * Compare what Privy verified against what the record says.
 *
 * Returns the FIRST deterministic match. Order is by strength of the
 * identifier rather than by convenience: a GitHub handle is stable and
 * effectively never reassigned, a LinkedIn vanity name is stable but
 * changeable by its owner.
 *
 * Email is NOT decided here. A legacy contact address lives in `submissions`,
 * which is private, and matching against it needs a different query and a
 * different consent argument — see `emailProofAvailable()`.
 */
export function decideClaim(
  accounts: VerifiedAccounts,
  evidence: ClaimEvidence,
): ClaimDecision {
  for (const link of evidence.links) {
    const github = githubHandleOf(link.url);
    if (github && accounts.githubUsernames.includes(github)) {
      return {
        resolves: true,
        proofType: 'github_identity',
        proofValue: github,
        matched: link.url,
      };
    }
  }

  for (const link of evidence.links) {
    const linkedin = linkedinVanityOf(link.url);
    if (linkedin && accounts.linkedinVanityNames.includes(linkedin)) {
      return {
        resolves: true,
        proofType: 'linkedin_identity',
        proofValue: linkedin,
        matched: link.url,
      };
    }
  }

  return { resolves: false, reason: 'no-match' };
}

// =========================================================================
// RECORDING
// =========================================================================

export type ClaimResult =
  | { ok: true; status: 'approved'; claimId: string; slug: string; proofType: ProofType }
  | { ok: true; status: 'pending'; claimId: string; slug: string }
  | { ok: false; status: 403 | 404 | 409 | 422; error: string };

/**
 * Attempt a claim on one builder record.
 *
 * ── THE RACE, AND WHY THE DATABASE SETTLES IT ────────────────────────────
 *
 * Two members claiming the same builder in the same instant both read
 * `owner_member_id IS NULL`, both find a valid proof, and both try to write.
 * No amount of checking first fixes that; the fix is a constraint. The partial
 * unique index `profile_claims_one_owner` allows exactly one `approved` row
 * per builder, so the second transaction fails at COMMIT and its member is
 * told the record is already claimed. That is the intended outcome, arrived at
 * by the only component that can actually serialise it.
 *
 * The ownership write carries `owner_member_id IS NULL` in its WHERE clause
 * for the same reason: it cannot take a record away from an existing owner
 * even if everything above it were wrong.
 */
export async function attemptClaim(
  member: Member,
  builderSlug: string,
  privyUser: User,
  db: AnyDatabase,
): Promise<ClaimResult> {
  if (member.status !== 'active') {
    return { ok: false, status: 403, error: 'This account cannot claim a profile.' };
  }

  const [builder] = await db
    .select({
      id: schema.builders.id,
      slug: schema.builders.slug,
      name: schema.builders.name,
      ownerMemberId: schema.builders.ownerMemberId,
      status: schema.builders.status,
    })
    .from(schema.builders)
    .where(eq(schema.builders.slug, builderSlug));

  if (!builder) return { ok: false, status: 404, error: 'No such profile.' };

  if (builder.ownerMemberId) {
    return {
      ok: false,
      status: 409,
      error:
        builder.ownerMemberId === member.id
          ? 'You already own this profile.'
          : 'This profile has already been claimed.',
    };
  }

  // A member may own one builder record. Owning two would make "whose profile
  // is this" ambiguous on every page that credits them.
  const [alreadyOwns] = await db
    .select({ slug: schema.builders.slug })
    .from(schema.builders)
    .where(eq(schema.builders.ownerMemberId, member.id));

  if (alreadyOwns) {
    return {
      ok: false,
      status: 409,
      error: `This account already owns /builders/${alreadyOwns.slug}.`,
    };
  }

  const links = await db
    .select({ label: schema.socialLinks.label, url: schema.socialLinks.url })
    .from(schema.socialLinks)
    .where(
      and(eq(schema.socialLinks.ownerType, 'builder'), eq(schema.socialLinks.ownerId, builder.id)),
    );

  const decision = decideClaim(verifiedAccountsOf(privyUser), { links });

  // ── Ambiguous: a pending row, and a human decides ─────────────────────
  if (!decision.resolves) {
    const [existing] = await db
      .select({ id: schema.profileClaims.id })
      .from(schema.profileClaims)
      .where(
        and(
          eq(schema.profileClaims.memberId, member.id),
          eq(schema.profileClaims.builderId, builder.id),
          eq(schema.profileClaims.status, 'pending'),
        ),
      );

    if (existing) {
      return { ok: false, status: 409, error: 'You already have a claim waiting on this profile.' };
    }

    const [claim] = await db
      .insert(schema.profileClaims)
      .values({
        memberId: member.id,
        builderId: builder.id,
        proofType: 'moderator_review',
        status: 'pending',
        note: 'No deterministic identity match. Awaiting moderator review.',
      })
      .returning({ id: schema.profileClaims.id });

    return { ok: true, status: 'pending', claimId: claim.id, slug: builder.slug };
  }

  // ── Deterministic: resolve it, in one transaction ─────────────────────
  try {
    const result = await db.transaction(async (tx) => {
      const [claim] = await tx
        .insert(schema.profileClaims)
        .values({
          memberId: member.id,
          builderId: builder.id,
          proofType: decision.proofType,
          proofValueHash: hashProof(decision.proofValue),
          status: 'approved',
          resolvedAt: new Date(),
          // No `resolvedBy`: nobody resolved it, a match did.
          note: `Deterministic ${decision.proofType} match against ${decision.matched}.`,
        })
        .returning({ id: schema.profileClaims.id });

      await tx.insert(schema.auditLog).values({
        actorMemberId: member.id,
        action: 'builder.claimed',
        entityType: 'builder',
        entityId: builder.id,
        note:
          `Ownership linked by a verified ${decision.proofType.replace('_identity', '')} identity ` +
          `matching ${decision.matched}. The record itself was not modified.`,
      });

      const updated = await tx
        .update(schema.builders)
        // OWNERSHIP ONLY. Not the name, not the bio, not the roles — a claim
        // links a person to a record, it does not rewrite the record. §13.
        .set({ ownerMemberId: member.id })
        .where(and(eq(schema.builders.id, builder.id), isNull(schema.builders.ownerMemberId)))
        .returning({ id: schema.builders.id });

      if (updated.length === 0) {
        // Somebody claimed it between our read and this write.
        throw new ClaimRace();
      }

      return claim.id;
    });

    return {
      ok: true,
      status: 'approved',
      claimId: result,
      slug: builder.slug,
      proofType: decision.proofType,
    };
  } catch (error) {
    if (error instanceof ClaimRace) {
      return { ok: false, status: 409, error: 'This profile has already been claimed.' };
    }
    // A unique violation on `profile_claims_one_owner` is the same story told
    // by the index instead of by the row count.
    if (isUniqueViolation(error)) {
      return { ok: false, status: 409, error: 'This profile has already been claimed.' };
    }
    throw error;
  }
}

/** Lost a race for ownership. Not an error worth a stack trace. */
class ClaimRace extends Error {}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  );
}

/** Claims this member has open or resolved, for `/me`. */
export async function claimsFor(memberId: string, db: AnyDatabase) {
  return db
    .select({
      id: schema.profileClaims.id,
      builderId: schema.profileClaims.builderId,
      slug: schema.builders.slug,
      name: schema.builders.name,
      proofType: schema.profileClaims.proofType,
      status: schema.profileClaims.status,
      createdAt: schema.profileClaims.createdAt,
    })
    .from(schema.profileClaims)
    .innerJoin(schema.builders, eq(schema.builders.id, schema.profileClaims.builderId))
    .where(eq(schema.profileClaims.memberId, memberId))
    .orderBy(sql`${schema.profileClaims.createdAt} DESC`);
}
