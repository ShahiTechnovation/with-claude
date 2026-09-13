/**
 * WHAT AN EVENT CREDIT IS WORTH, AND WHAT THE CURATED RECORD CAN EXPRESS.
 *
 * Two things live here because they are the same decision seen from two sides:
 * the weights §19 fixes, and the rule that turns a curated event's single
 * `ambassadorSlug` into the credit list §19 scores.
 *
 * ── WHY THE WEIGHTS ARE A FROZEN TABLE AND NOT A FUNCTION ────────────────
 *
 * §20 requires the formula to be public and §61 requires the ranking to be
 * deterministic — the same database state must produce the same order, every
 * time, with no model in the loop. A lookup table is the strongest available
 * statement of that: there is no branch to take, nothing reads the clock, and
 * the numbers printed under the leaderboard are these numbers because the page
 * imports this object rather than restating it.
 */
import type { EventHostCredit, EventHostRoleName } from '../data/types';

/**
 * §19's credit weights, verbatim.
 *
 * `speaker` is 0 and is in the table anyway. Speaking at an event is a real
 * contribution and it is not hosting one; leaving the role out would mean a
 * speaker credit fell through to a default, and a default is how a weight gets
 * assigned by accident. Zero is a decision and reads like one.
 */
export const CREDIT_WEIGHTS: Record<EventHostRoleName, number> = {
  primary_host: 1,
  organizer: 1,
  co_host: 0.5,
  partner: 0.25,
  speaker: 0,
};

/**
 * How each role is named in prose, in one place.
 *
 * The database enum is `co_host`; a reader should see "co-host". Kept here so
 * the event page, the ambassador page and the admin all print the same word
 * for the same role — three spellings of one role is how a reader concludes
 * they are three different things.
 */
export const CREDIT_ROLE_LABEL: Record<EventHostRoleName, string> = {
  primary_host: 'host',
  co_host: 'co-host',
  organizer: 'organiser',
  partner: 'partner',
  speaker: 'speaker',
};

/** How the weights are printed under the leaderboard. §20 — no hidden formula. */
export const CREDIT_WEIGHT_LABELS: { role: EventHostRoleName; label: string; weight: number }[] = [
  { role: 'primary_host', label: 'Host', weight: CREDIT_WEIGHTS.primary_host },
  { role: 'organizer', label: 'Organiser', weight: CREDIT_WEIGHTS.organizer },
  { role: 'co_host', label: 'Co-host', weight: CREDIT_WEIGHTS.co_host },
  { role: 'partner', label: 'Partner', weight: CREDIT_WEIGHTS.partner },
];

/**
 * The confidence a credit must carry to count toward a score.
 *
 * §19: "if event attribution is ambiguous, do not automatically score it."
 * A credit below this is still shown — the event genuinely lists that person —
 * and contributes nothing until a moderator confirms it.
 */
export const SCORED_CONFIDENCE = 1;

/** True when this credit is allowed to move a public ranking. */
export function isScorable(credit: EventHostCredit): boolean {
  return credit.confidence >= SCORED_CONFIDENCE && CREDIT_WEIGHTS[credit.role] > 0;
}

/** What one credit is worth. 0 for anything unconfirmed or unweighted. */
export function weightOf(credit: EventHostCredit): number {
  return isScorable(credit) ? CREDIT_WEIGHTS[credit.role] : 0;
}

/**
 * The credits implied by a curated event's authored host.
 *
 * ── WHY THIS EXISTS IN EXACTLY ONE PLACE ─────────────────────────────────
 *
 * Three callers derive credits from the same authored field and they must
 * agree to the letter, or `tests/equivalence.test.ts` fails and the site
 * renders two different leaderboards depending on `DATA_SOURCE`:
 *
 *   `src/data/source-ts.ts`  synthesises them for the TypeScript record,
 *                            which has no `event_hosts` table to read
 *   `db/import/index.ts`     writes exactly these rows into `event_hosts`
 *   migration 0012           backfilled exactly these rows from the column
 *
 * `curated` because a person authored the field this reads, and confidence 1
 * because the curated archive's attributions are the ones the site was built
 * on. A curated event can express one host and no roles, which is precisely
 * the limitation `event_hosts` was added to lift — so this returns at most one
 * credit, and everything richer arrives through the database.
 */
export function curatedCredits(host: {
  ambassadorSlug?: string;
  credits?: EventHostCredit[];
}): EventHostCredit[] {
  // An authored credit list wins. Nothing in the repository record uses this
  // today; it is here so the TypeScript source stays a genuine rollback path
  // for a record that has grown richer attribution.
  if (host.credits) return host.credits;
  if (!host.ambassadorSlug) return [];
  return [
    {
      ambassadorSlug: host.ambassadorSlug,
      role: 'primary_host',
      source: 'curated',
      confidence: 1,
    },
  ];
}

/**
 * A deterministic order for a credit list.
 *
 * Applied by both sources so equality is comparable at all — Postgres returns
 * rows in whatever order it likes, and a `RecordSet` whose arrays differ only
 * by ordering would fail the equivalence suite for no reason a reader would
 * ever see. Sorted by role weight (so the headline host reads first), then by
 * slug, which is unique per role and makes the order total.
 */
export function sortCredits(credits: EventHostCredit[]): EventHostCredit[] {
  const rank: Record<EventHostRoleName, number> = {
    primary_host: 0,
    organizer: 1,
    co_host: 2,
    partner: 3,
    speaker: 4,
  };
  return [...credits].sort(
    (a, b) => rank[a.role] - rank[b.role] || a.ambassadorSlug.localeCompare(b.ambassadorSlug),
  );
}
