/**
 * COMMUNITY ACTIVITY — an arithmetic index, and nothing more than that.
 *
 * §22 asks for a ranked directory of the people running Claude community
 * events in India. §53 is emphatic about what that ranking is NOT: it is not
 * an Anthropic ranking, it does not imply endorsement, and it must be labelled
 * as what it is. This module computes the number; `src/pages/ambassadors`
 * carries the label.
 *
 * ── EVERY DESIGN CHOICE HERE SERVES DETERMINISM ──────────────────────────
 *
 * §61: the same database state must produce the same ranking. So:
 *
 *   · The weights are a frozen table in `src/lib/credits.ts`. No judgement,
 *     no model, no "importance".
 *   · `now` is a PARAMETER, defaulted but never read from the clock inside a
 *     comparison. A ranking that depends on when it ran is not reproducible,
 *     and a test that cannot pin the clock cannot assert an order.
 *   · The sort is total. Score, then events, then name, then slug — and slug
 *     is unique, so no two entries can tie all the way down and be ordered by
 *     whatever `Array.prototype.sort` felt like doing.
 *
 * ── WHAT IS DELIBERATELY NOT COUNTED ─────────────────────────────────────
 *
 * §56's list: registrations, attendance, reach, followers, engagement, growth.
 * The sources we have do not carry any of them — the ICS feed reports a title,
 * a time, a place and an organiser — so a metric built on them would be an
 * invention. §20 says not to imply an attendance-based ranking when attendance
 * is unavailable, which is why the only two public numbers are events hosted
 * and the activity score computed from them.
 */
import type { Ambassador, CommunityEvent, EventHostCredit, EventHostRoleName } from '../data/types';
import { CREDIT_WEIGHTS, isScorable, weightOf } from './credits';
import { lifecycleOf } from './status';

/** §21's windows. `all` is the default, and the one the page leads with. */
export type LeaderboardWindow = 'all' | 'year' | 'month';

export interface LeaderboardEntry {
  ambassador: Ambassador;
  /**
   * Events where this person holds a SCORED credit, most recent first.
   *
   * The list, not just a count, because `/ambassadors/[slug]` needs the actual
   * events (§23) and computing them twice — once for the score, once for the
   * page — is how the two end up disagreeing.
   */
  events: CommunityEvent[];
  upcoming: CommunityEvent[];
  past: CommunityEvent[];
  /** Count per role, all five, including the zero-weighted one. */
  roleCounts: Record<EventHostRoleName, number>;
  /** Distinct city slugs. A breadth figure, never a ranking input. */
  cities: string[];
  /**
   * §20's second public number: the sum of credit weights.
   *
   * Rounded to two decimals on the way out. Half-credits sum to values like
   * `2.5`, and floating-point addition of 0.25s produces `0.7500000000000001`
   * often enough that an unrounded score would print differently for two
   * ambassadors who have done exactly the same thing.
   */
  score: number;
  /** §20's first public number: events where the credit was a hosting one. */
  eventsHosted: number;
  /**
   * Credits that are real, shown, and NOT scored — ambiguous attributions
   * awaiting a moderator (§19). Surfaced so the page can be honest about the
   * gap rather than quietly under-counting somebody.
   */
  unscoredCredits: number;
}

/**
 * Which events a credit is allowed to be earned on. §55, the anti-gaming rule.
 *
 * A cancelled event earns nothing: it did not happen, and a room that was
 * called off is not community activity. Everything else §55 lists is excluded
 * structurally rather than by a filter here, and it is worth being explicit
 * about why, because "we check for duplicates" would be a false claim:
 *
 *   duplicate events   unrepresentable. `(source_id, external_id)` is unique
 *                      and `event_hosts`' primary key is (event, person, role),
 *                      so one event cannot be counted twice for one credit.
 *   outside India      cannot be in this list. Only events the India filter
 *                      placed confidently reach `published` at all — see
 *                      `src/server/events/india.ts`.
 *   ambiguous          `isScorable()` refuses anything below full confidence.
 *   user-invented      there is no path from a member account to an event
 *                      record. Events are curated or ingested, never submitted.
 */
function isScorableEvent(event: CommunityEvent, now: Date): boolean {
  return lifecycleOf(event, now) !== 'cancelled';
}

/** Whether an event falls inside §21's window. Dates are IST wall-clock. */
function inWindow(event: CommunityEvent, window: LeaderboardWindow, now: Date): boolean {
  if (window === 'all') return true;
  // `event.date` is an ISO `YYYY-MM-DD`, compared as a string prefix rather
  // than by constructing a Date — `new Date('2026-03-01')` is parsed as UTC
  // midnight, which for an IST event is the evening before and would put a
  // 1 March event in February.
  const year = String(now.getUTCFullYear());
  if (window === 'year') return event.date.startsWith(`${year}-`);
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return event.date.startsWith(`${year}-${month}-`);
}

const emptyRoleCounts = (): Record<EventHostRoleName, number> => ({
  primary_host: 0,
  co_host: 0,
  organizer: 0,
  partner: 0,
  speaker: 0,
});

/** Every credit on an event, whatever the source. Empty when unattributed. */
export function creditsOf(event: CommunityEvent): EventHostCredit[] {
  return event.host.credits ?? [];
}

/**
 * Build the leaderboard.
 *
 * Takes the records rather than reading the dataset so it stays pure and
 * testable — the selector in `src/data/index.ts` is what binds it to whichever
 * source this build is reading.
 *
 * ── COST ─────────────────────────────────────────────────────────────────
 *
 * One pass over the events, then one sort. No lookup inside a loop over
 * credits, and no per-ambassador scan of the event list, which is what §45
 * means by a bounded query on an ambassador page: everything the whole
 * directory needs is computed together, once.
 */
export function leaderboard(
  ambassadors: Ambassador[],
  events: CommunityEvent[],
  options: { window?: LeaderboardWindow; now?: Date } = {},
): LeaderboardEntry[] {
  const { window = 'all', now = new Date() } = options;

  const entries = new Map<string, LeaderboardEntry>();
  for (const ambassador of ambassadors) {
    entries.set(ambassador.slug, {
      ambassador,
      events: [],
      upcoming: [],
      past: [],
      roleCounts: emptyRoleCounts(),
      cities: [],
      score: 0,
      eventsHosted: 0,
      unscoredCredits: 0,
    });
  }

  const citySets = new Map<string, Set<string>>();

  for (const event of events) {
    if (!isScorableEvent(event, now)) continue;
    if (!inWindow(event, window, now)) continue;

    for (const credit of creditsOf(event)) {
      const entry = entries.get(credit.ambassadorSlug);
      // A credit naming an ambassador who is not in the public record is not
      // an error worth throwing over on a public page — it is what a
      // withdrawn or unpublished ambassador looks like from here.
      if (!entry) continue;

      entry.roleCounts[credit.role] += 1;

      if (!isScorable(credit)) {
        entry.unscoredCredits += 1;
        continue;
      }

      entry.score += weightOf(credit);
      // One appearance per event, however many scored roles the person holds
      // on it. §18: one event is one event.
      if (!entry.events.includes(event)) {
        entry.events.push(event);
        if (lifecycleOf(event, now) === 'past') entry.past.push(event);
        else entry.upcoming.push(event);
      }
      if (CREDIT_WEIGHTS[credit.role] >= 1) entry.eventsHosted += 1;

      const cities = citySets.get(credit.ambassadorSlug) ?? new Set<string>();
      cities.add(event.citySlug);
      citySets.set(credit.ambassadorSlug, cities);
    }
  }

  const result = [...entries.values()].map((entry) => ({
    ...entry,
    score: Math.round(entry.score * 100) / 100,
    cities: [...(citySets.get(entry.ambassador.slug) ?? [])].sort(),
    // Most recent first, which is the order both the leaderboard row and the
    // profile's archive want.
    events: [...entry.events].sort((a, b) => b.date.localeCompare(a.date)),
    past: [...entry.past].sort((a, b) => b.date.localeCompare(a.date)),
    // Soonest first — an upcoming list reads forwards.
    upcoming: [...entry.upcoming].sort((a, b) => a.date.localeCompare(b.date)),
  }));

  return result.sort(compareEntries);
}

/**
 * The total order. §61 — deterministic, and reproducible from the same state.
 *
 * Name before slug looks redundant and is not: two ambassadors can share a
 * display name, and `slug` is the unique tiebreak that makes the comparison
 * total. Without a final unique key, equal entries are left in engine-defined
 * order and the "same state, same ranking" claim is false on any input with a
 * tie — which, with a small directory and a 1.0 weight, is most inputs.
 */
export function compareEntries(a: LeaderboardEntry, b: LeaderboardEntry): number {
  return (
    b.score - a.score ||
    b.events.length - a.events.length ||
    b.upcoming.length - a.upcoming.length ||
    a.ambassador.name.localeCompare(b.ambassador.name) ||
    a.ambassador.slug.localeCompare(b.ambassador.slug)
  );
}

/**
 * One ambassador's standing, with their all-time figures alongside.
 *
 * §21's fairness rule: a windowed ranking must not make a long-term
 * contributor disappear, so the profile and the row both show recent activity
 * WITH the all-time score rather than instead of it.
 */
export function standingOf(
  slug: string,
  ambassadors: Ambassador[],
  events: CommunityEvent[],
  options: { now?: Date } = {},
): { allTime: LeaderboardEntry; year: LeaderboardEntry; month: LeaderboardEntry; rank: number } | null {
  const all = leaderboard(ambassadors, events, { window: 'all', now: options.now });
  const index = all.findIndex((entry) => entry.ambassador.slug === slug);
  if (index === -1) return null;

  const find = (window: LeaderboardWindow) => {
    const list = leaderboard(ambassadors, events, { window, now: options.now });
    return list.find((entry) => entry.ambassador.slug === slug)!;
  };

  return {
    allTime: all[index],
    year: find('year'),
    month: find('month'),
    /** 1-based, as it is printed. */
    rank: index + 1,
  };
}
