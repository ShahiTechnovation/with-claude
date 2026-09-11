/**
 * PHASE A — claiming an existing builder record.
 *
 * The riskiest feature in the phase, because getting it wrong hands one
 * person's public identity to another. Every test here is a variation on
 * "prove that resemblance is not enough".
 *
 * A note on the fixtures: none of them is modelled on a real person. §69's
 * rule is not only about production databases — a test that uses a real
 * builder as its claimable subject teaches whoever reads it that doing so is
 * normal. Everything here is `zz-`-prefixed and invented.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { User } from '@privy-io/node/resources';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import * as schema from '../db/schema';
import { provisionMember, type Member } from '../src/server/auth/member';
import {
  attemptClaim,
  decideClaim,
  githubHandleOf,
  linkedinVanityOf,
  verifiedAccountsOf,
} from '../src/server/members/claims';

let db: TestDatabase;
let cityId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  const [city] = await db
    .insert(schema.cities)
    .values({
      slug: 'zz-test-city',
      name: 'Test City',
      region: 'Test Region',
      lat: 23.25,
      lon: 77.41,
      blurb: 'A disposable fixture.',
      status: 'published',
    })
    .returning({ id: schema.cities.id });
  cityId = city.id;
});

afterAll(async () => {
  await db.$close();
});

beforeEach(async () => {
  await db.delete(schema.profileClaims);
  await db.delete(schema.socialLinks);
  await db.delete(schema.memberProfiles);
  await db.delete(schema.builders);
  // Not `members` or `audit_log` — see the note in member-profile.test.ts.
});

/** An invented legacy builder with the links a claim would compare against. */
async function fixtureBuilder(
  slug: string,
  links: { label: string; url: string }[] = [],
): Promise<string> {
  const [builder] = await db
    .insert(schema.builders)
    .values({
      slug,
      name: `ZZ ${slug}`,
      cityId,
      role: 'Builder',
      status: 'published',
      source: 'legacy',
    })
    .returning({ id: schema.builders.id });

  for (const [index, link] of links.entries()) {
    await db.insert(schema.socialLinks).values({
      ownerType: 'builder',
      ownerId: builder.id,
      position: index,
      label: link.label,
      url: link.url,
    });
  }
  return builder.id;
}

/** A Privy user with the linked accounts a test needs. Shape only. */
function privyUser(accounts: Record<string, unknown>[]): User {
  return { linked_accounts: accounts } as unknown as User;
}

const githubAccount = (username: string) => ({ type: 'github_oauth', username, subject: `gh|${username}` });
const linkedinAccount = (vanity: string) => ({
  type: 'linkedin_oauth',
  vanity_name: vanity,
  subject: `li|${vanity}`,
});

// =========================================================================
describe('reading a handle out of a URL', () => {
  it('reads a GitHub handle', () => {
    expect(githubHandleOf('https://github.com/ashahi')).toBe('ashahi');
    expect(githubHandleOf('https://www.github.com/AShahi/repo')).toBe('ashahi');
  });

  /** `github.com.evil.example/ashahi` must not read as a GitHub profile. */
  it.each([
    'https://github.com.evil.example/ashahi',
    'https://notgithub.com/ashahi',
    'https://gitlab.com/ashahi',
    'https://github.com/',
    'not a url',
    'javascript:alert(1)',
  ])('refuses %s', (url) => {
    expect(githubHandleOf(url)).toBeNull();
  });

  it('refuses GitHub\'s own reserved paths', () => {
    expect(githubHandleOf('https://github.com/orgs/anthropics')).toBeNull();
    expect(githubHandleOf('https://github.com/marketplace')).toBeNull();
  });

  it('reads a LinkedIn vanity name, including regional hosts', () => {
    expect(linkedinVanityOf('https://linkedin.com/in/someone')).toBe('someone');
    expect(linkedinVanityOf('https://www.linkedin.com/in/Someone/')).toBe('someone');
    expect(linkedinVanityOf('https://in.linkedin.com/in/someone')).toBe('someone');
  });

  /** A company page is an organisation, not a person. */
  it('refuses a LinkedIn company page', () => {
    expect(linkedinVanityOf('https://linkedin.com/company/anthropic')).toBeNull();
    expect(linkedinVanityOf('https://linkedin.com/in/')).toBeNull();
    expect(linkedinVanityOf('https://linkedin.com.evil.example/in/someone')).toBeNull();
  });
});

// =========================================================================
describe('reading what Privy verified', () => {
  it('picks out GitHub, LinkedIn and email', () => {
    const accounts = verifiedAccountsOf(
      privyUser([
        githubAccount('ZZHandle'),
        linkedinAccount('ZZVanity'),
        { type: 'email', address: 'ZZ@example.com' },
        { type: 'wallet', address: '0xabc' },
      ]),
    );

    expect(accounts.githubUsernames).toEqual(['zzhandle']);
    expect(accounts.linkedinVanityNames).toEqual(['zzvanity']);
    expect(accounts.emails).toEqual(['zz@example.com']);
  });

  /**
   * `vanity_name` is OPTIONAL in Privy's own type. A LinkedIn account without
   * one carries nothing comparable, and the honest result is no proof.
   */
  it('ignores a LinkedIn account with no vanity name', () => {
    const accounts = verifiedAccountsOf(privyUser([{ type: 'linkedin_oauth', subject: 'li|x' }]));
    expect(accounts.linkedinVanityNames).toEqual([]);
  });

  /** A display handle is renameable and recycled. Not identity evidence. */
  it('does not read Twitter/X as a proof source', () => {
    const accounts = verifiedAccountsOf(
      privyUser([{ type: 'twitter_oauth', username: 'someone', subject: 'tw|1' }]),
    );
    expect(accounts.githubUsernames).toEqual([]);
    expect(accounts.linkedinVanityNames).toEqual([]);
  });
});

// =========================================================================
describe('the decision', () => {
  it('resolves on a GitHub match', () => {
    const decision = decideClaim(verifiedAccountsOf(privyUser([githubAccount('zzhandle')])), {
      links: [{ label: 'GitHub', url: 'https://github.com/zzhandle' }],
    });
    expect(decision).toMatchObject({ resolves: true, proofType: 'github_identity' });
  });

  it('resolves on a LinkedIn match', () => {
    const decision = decideClaim(verifiedAccountsOf(privyUser([linkedinAccount('zzvanity')])), {
      links: [{ label: 'LinkedIn', url: 'https://linkedin.com/in/zzvanity' }],
    });
    expect(decision).toMatchObject({ resolves: true, proofType: 'linkedin_identity' });
  });

  it('does not resolve when the handles differ', () => {
    const decision = decideClaim(verifiedAccountsOf(privyUser([githubAccount('someone-else')])), {
      links: [{ label: 'GitHub', url: 'https://github.com/zzhandle' }],
    });
    expect(decision.resolves).toBe(false);
  });

  it('does not resolve when the record has no links at all', () => {
    const decision = decideClaim(verifiedAccountsOf(privyUser([githubAccount('zzhandle')])), {
      links: [],
    });
    expect(decision.resolves).toBe(false);
  });
});

// =========================================================================
describe('claiming', () => {
  async function member(did: string): Promise<Member> {
    return (await provisionMember(did, db)).member;
  }

  it('links ownership on a deterministic GitHub match', async () => {
    const builderId = await fixtureBuilder('zz-claim-gh', [
      { label: 'GitHub', url: 'https://github.com/zz-gh-user' },
    ]);
    const claimant = await member('did:privy:zz-claim-gh');

    const result = await attemptClaim(
      claimant,
      'zz-claim-gh',
      privyUser([githubAccount('zz-gh-user')]),
      db,
    );

    expect(result).toMatchObject({ ok: true, status: 'approved' });

    const [builder] = await db
      .select()
      .from(schema.builders)
      .where(eq(schema.builders.id, builderId));
    expect(builder.ownerMemberId).toBe(claimant.id);
  });

  /**
   * §13: A CLAIM LINKS, IT DOES NOT REWRITE.
   *
   * The record's name, role and source stay exactly as the archive had them.
   */
  it('changes ownership and nothing else', async () => {
    const builderId = await fixtureBuilder('zz-untouched', [
      { label: 'GitHub', url: 'https://github.com/zz-untouched' },
    ]);
    const before = (
      await db.select().from(schema.builders).where(eq(schema.builders.id, builderId))
    )[0];

    const claimant = await member('did:privy:zz-untouched');
    await attemptClaim(claimant, 'zz-untouched', privyUser([githubAccount('zz-untouched')]), db);

    const after = (
      await db.select().from(schema.builders).where(eq(schema.builders.id, builderId))
    )[0];

    expect(after.name).toBe(before.name);
    expect(after.role).toBe(before.role);
    expect(after.bio).toBe(before.bio);
    expect(after.roles).toEqual(before.roles);
    expect(after.source).toBe('legacy');
    expect(after.status).toBe(before.status);
  });

  it('records the proof as a hash, never as the value', async () => {
    await fixtureBuilder('zz-hash', [{ label: 'GitHub', url: 'https://github.com/zz-secret' }]);
    const claimant = await member('did:privy:zz-hash');
    await attemptClaim(claimant, 'zz-hash', privyUser([githubAccount('zz-secret')]), db);

    const [claim] = await db.select().from(schema.profileClaims);
    expect(claim.proofValueHash).toBeTruthy();
    expect(claim.proofValueHash).not.toContain('zz-secret');
    expect(claim.proofValueHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('writes an audit entry attributed to the member', async () => {
    const builderId = await fixtureBuilder('zz-audit-claim', [
      { label: 'GitHub', url: 'https://github.com/zz-audit-claim' },
    ]);
    const claimant = await member('did:privy:zz-audit-claim');
    await attemptClaim(
      claimant,
      'zz-audit-claim',
      privyUser([githubAccount('zz-audit-claim')]),
      db,
    );

    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entityId, builderId));

    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('builder.claimed');
    expect(audit[0].actorMemberId).toBe(claimant.id);
  });

  /** ── THE CENTRAL RULE ────────────────────────────────────────────── */

  it('does NOT resolve on a matching name — resemblance is not proof', async () => {
    // A record with the same name and city as the claimant, and no linked
    // identity in common. This is the attack the whole design exists to stop.
    await db.insert(schema.builders).values({
      slug: 'zz-same-name',
      name: 'ZZ Common Name',
      cityId,
      role: 'Builder',
      status: 'published',
      source: 'legacy',
    });

    const impostor = await member('did:privy:zz-impostor');
    const result = await attemptClaim(
      impostor,
      'zz-same-name',
      privyUser([githubAccount('unrelated-handle')]),
      db,
    );

    expect(result).toMatchObject({ ok: true, status: 'pending' });

    const [builder] = await db
      .select()
      .from(schema.builders)
      .where(eq(schema.builders.slug, 'zz-same-name'));
    expect(builder.ownerMemberId).toBeNull();
  });

  it('queues an ambiguous claim rather than doing nothing', async () => {
    await fixtureBuilder('zz-ambiguous');
    const claimant = await member('did:privy:zz-ambiguous');
    const result = await attemptClaim(claimant, 'zz-ambiguous', privyUser([]), db);

    expect(result).toMatchObject({ ok: true, status: 'pending' });
    const [claim] = await db.select().from(schema.profileClaims);
    expect(claim.status).toBe('pending');
    expect(claim.proofType).toBe('moderator_review');
    expect(claim.resolvedBy).toBeNull();
  });

  it('refuses a second claim on an already-owned record', async () => {
    await fixtureBuilder('zz-owned', [{ label: 'GitHub', url: 'https://github.com/zz-owner' }]);
    const owner = await member('did:privy:zz-owner');
    await attemptClaim(owner, 'zz-owned', privyUser([githubAccount('zz-owner')]), db);

    const second = await member('did:privy:zz-second-claim');
    const result = await attemptClaim(
      second,
      'zz-owned',
      privyUser([githubAccount('zz-owner')]),
      db,
    );

    expect(result).toMatchObject({ ok: false, status: 409 });
  });

  it('refuses a duplicate pending claim from the same member', async () => {
    await fixtureBuilder('zz-dupe');
    const claimant = await member('did:privy:zz-dupe');
    await attemptClaim(claimant, 'zz-dupe', privyUser([]), db);
    const second = await attemptClaim(claimant, 'zz-dupe', privyUser([]), db);

    expect(second).toMatchObject({ ok: false, status: 409 });
    const claims = await db.select().from(schema.profileClaims);
    expect(claims).toHaveLength(1);
  });

  it('refuses a member who already owns a different record', async () => {
    await fixtureBuilder('zz-first-owned', [
      { label: 'GitHub', url: 'https://github.com/zz-multi' },
    ]);
    await fixtureBuilder('zz-second-target', [
      { label: 'GitHub', url: 'https://github.com/zz-multi' },
    ]);

    const claimant = await member('did:privy:zz-multi');
    await attemptClaim(claimant, 'zz-first-owned', privyUser([githubAccount('zz-multi')]), db);
    const second = await attemptClaim(
      claimant,
      'zz-second-target',
      privyUser([githubAccount('zz-multi')]),
      db,
    );

    expect(second).toMatchObject({ ok: false, status: 409 });
  });

  it('refuses a suspended member', async () => {
    await fixtureBuilder('zz-susp-claim', [
      { label: 'GitHub', url: 'https://github.com/zz-susp' },
    ]);
    const claimant = await member('did:privy:zz-susp-claim');
    const result = await attemptClaim(
      { ...claimant, status: 'suspended' },
      'zz-susp-claim',
      privyUser([githubAccount('zz-susp')]),
      db,
    );

    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('404s a record that does not exist', async () => {
    const claimant = await member('did:privy:zz-404');
    const result = await attemptClaim(claimant, 'no-such-builder', privyUser([]), db);
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  /**
   * THE RACE.
   *
   * Two members with the same verified GitHub handle — which cannot happen in
   * reality, and is exactly why it is the right fixture: it forces both
   * attempts past every application-level check so only the database can
   * separate them. Exactly one must win.
   */
  it('lets exactly one of two simultaneous claims win', async () => {
    await fixtureBuilder('zz-race', [{ label: 'GitHub', url: 'https://github.com/zz-race' }]);
    const a = await member('did:privy:zz-race-a');
    const b = await member('did:privy:zz-race-b');

    const results = await Promise.allSettled([
      attemptClaim(a, 'zz-race', privyUser([githubAccount('zz-race')]), db),
      attemptClaim(b, 'zz-race', privyUser([githubAccount('zz-race')]), db),
    ]);

    const approved = results.filter(
      (r) => r.status === 'fulfilled' && r.value.ok && r.value.status === 'approved',
    );
    expect(approved).toHaveLength(1);

    const [builder] = await db
      .select()
      .from(schema.builders)
      .where(eq(schema.builders.slug, 'zz-race'));
    expect([a.id, b.id]).toContain(builder.ownerMemberId);

    // And the index held: only one approved claim exists for this record.
    const approvedClaims = await db
      .select()
      .from(schema.profileClaims)
      .where(eq(schema.profileClaims.status, 'approved'));
    expect(approvedClaims).toHaveLength(1);
  });

  /** The index is the real guarantee, so assert it directly too. */
  it('refuses a second approved claim row at the database level', async () => {
    const builderId = await fixtureBuilder('zz-index');
    const a = await member('did:privy:zz-index-a');
    const b = await member('did:privy:zz-index-b');

    await db.insert(schema.profileClaims).values({
      memberId: a.id,
      builderId,
      proofType: 'github_identity',
      status: 'approved',
    });

    await expect(
      db.insert(schema.profileClaims).values({
        memberId: b.id,
        builderId,
        proofType: 'github_identity',
        status: 'approved',
      }),
    ).rejects.toThrow();
  });
});
