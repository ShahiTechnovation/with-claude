/**
 * THE COMMUNITY ACTIVITY INDEX — arithmetic, and the same arithmetic twice.
 *
 * §61 is the requirement this file exists for: the same state must produce the
 * same ranking. That is only testable if the clock is an argument, which is
 * why every call here passes `now` — a leaderboard that reads
 * `new Date()` internally cannot be asserted about at all, and would start
 * failing in January.
 *
 * The weights are asserted as literal numbers, not by importing
 * `CREDIT_WEIGHTS` into the expectation. §19 fixes them at 1.0 / 0.5 / 1.0 /
 * 0.25; a test that reads the table it is checking would pass just as happily
 * if someone doubled every weight.
 */
import { describe, expect, it } from 'vitest';
import { CREDIT_WEIGHTS, curatedCredits, isScorable, sortCredits } from '../src/lib/credits';
import { leaderboard, standingOf } from '../src/lib/leaderboard';
import type {
  Ambassador,
  CommunityEvent,
  EventHostCredit,
  EventHostRoleName,
} from '../src/data/types';

const NOW = new Date('2026-09-13T12:00:00Z');

const ambassador = (slug: string, name: string, citySlug = 'bhopal'): Ambassador =>
  ({
    id: `amb-${slug}`,
    slug,
    status: 'published',
    name,
    citySlug,
    title: 'Claude Community Ambassador',
    verifiedVia: 'test',
  }) as Ambassador;

const credit = (
  ambassadorSlug: string,
  role: EventHostRoleName,
  confidence = 1,
): EventHostCredit => ({ ambassadorSlug, role, source: 'curated', confidence });

const event = (
  slug: string,
  date: string,
  credits: EventHostCredit[],
  extra: Partial<CommunityEvent> = {},
): CommunityEvent =>
  ({
    id: slug,
    slug,
    status: 'published',
    title: slug,
    format: 'workshop',
    citySlug: 'bhopal',
    host: { ambassadorSlug: credits.find((c) => c.role === 'primary_host')?.ambassadorSlug, credits },
    date,
    startTime: '16:00',
    venue: { name: 'Somewhere' },
    summary: 'A room.',
    free: true,
    ...extra,
  }) as CommunityEvent;

describe('§19 credit weights', () => {
  it('scores a primary host at 1.0', () => {
    const [entry] = leaderboard(
      [ambassador('a', 'A')],
      [event('e1', '2026-03-01', [credit('a', 'primary_host')])],
      { now: NOW },
    );
    expect(entry.score).toBe(1);
    expect(entry.eventsHosted).toBe(1);
  });

  it('scores a co-host at 0.5', () => {
    const [entry] = leaderboard(
      [ambassador('a', 'A')],
      [event('e1', '2026-03-01', [credit('a', 'co_host')])],
      { now: NOW },
    );
    expect(entry.score).toBe(0.5);
    // A co-host has a credit on an event but has not HOSTED one in §20's
    // sense. The two public numbers are allowed to differ, and must.
    expect(entry.eventsHosted).toBe(0);
    expect(entry.events).toHaveLength(1);
  });

  it('scores an organiser at 1.0', () => {
    const [entry] = leaderboard(
      [ambassador('a', 'A')],
      [event('e1', '2026-03-01', [credit('a', 'organizer')])],
      { now: NOW },
    );
    expect(entry.score).toBe(1);
    expect(entry.eventsHosted).toBe(1);
  });

  it('scores a partner at 0.25', () => {
    const [entry] = leaderboard(
      [ambassador('a', 'A')],
      [event('e1', '2026-03-01', [credit('a', 'partner')])],
      { now: NOW },
    );
    expect(entry.score).toBe(0.25);
  });

  it('scores a speaker at nothing', () => {
    const [entry] = leaderboard(
      [ambassador('a', 'A')],
      [event('e1', '2026-03-01', [credit('a', 'speaker')])],
      { now: NOW },
    );
    expect(entry.score).toBe(0);
    expect(entry.roleCounts.speaker).toBe(1);
  });

  it('matches the published formula for a mixed record', () => {
    // §20's worked example: 3 hosted + 2 co-hosted + 1 organised
    //   = 3(1.0) + 2(0.5) + 1(1.0) = 5.0
    const events = [
      event('h1', '2026-01-01', [credit('a', 'primary_host')]),
      event('h2', '2026-02-01', [credit('a', 'primary_host')]),
      event('h3', '2026-03-01', [credit('a', 'primary_host')]),
      event('c1', '2026-04-01', [credit('a', 'co_host')]),
      event('c2', '2026-05-01', [credit('a', 'co_host')]),
      event('o1', '2026-06-01', [credit('a', 'organizer')]),
    ];
    const [entry] = leaderboard([ambassador('a', 'A')], events, { now: NOW });
    expect(entry.score).toBe(5);
    expect(entry.eventsHosted).toBe(4);
    expect(entry.roleCounts).toMatchObject({ primary_host: 3, co_host: 2, organizer: 1 });
  });

  it('adds quarter-credits without floating-point noise', () => {
    const events = [
      event('p1', '2026-01-01', [credit('a', 'partner')]),
      event('p2', '2026-02-01', [credit('a', 'partner')]),
      event('p3', '2026-03-01', [credit('a', 'partner')]),
    ];
    const [entry] = leaderboard([ambassador('a', 'A')], events, { now: NOW });
    expect(entry.score).toBe(0.75);
    expect(String(entry.score)).toBe('0.75');
  });
});

describe('§18 one event is one event', () => {
  it('counts an event once when two ambassadors hosted it', () => {
    const events = [
      event('shared', '2026-03-01', [credit('a', 'primary_host'), credit('b', 'co_host')]),
    ];
    const board = leaderboard([ambassador('a', 'A'), ambassador('b', 'B')], events, { now: NOW });
    expect(board.map((e) => [e.ambassador.slug, e.score, e.events.length])).toEqual([
      ['a', 1, 1],
      ['b', 0.5, 1],
    ]);
  });

  it('lists an event once for one person holding two scored roles', () => {
    const events = [
      event('e1', '2026-03-01', [credit('a', 'primary_host'), credit('a', 'organizer')]),
    ];
    const [entry] = leaderboard([ambassador('a', 'A')], events, { now: NOW });
    // Both credits score — they are different contributions, and §19 says one
    // credit per event/role combination, not one per event.
    expect(entry.score).toBe(2);
    // The event itself appears once. A profile that listed the same room twice
    // would look like a duplicate record, which is what §18 forbids.
    expect(entry.events).toHaveLength(1);
  });
});

describe('§55 what does not count', () => {
  it('ignores a cancelled event entirely', () => {
    const events = [
      event('on', '2026-03-01', [credit('a', 'primary_host')]),
      event('off', '2026-04-01', [credit('a', 'primary_host')], { statusOverride: 'cancelled' }),
    ];
    const [entry] = leaderboard([ambassador('a', 'A')], events, { now: NOW });
    expect(entry.score).toBe(1);
    expect(entry.events.map((e) => e.slug)).toEqual(['on']);
  });

  it('shows but does not score an ambiguous attribution', () => {
    const events = [event('e1', '2026-03-01', [credit('a', 'primary_host', 0.5)])];
    const [entry] = leaderboard([ambassador('a', 'A')], events, { now: NOW });
    expect(entry.score).toBe(0);
    expect(entry.unscoredCredits).toBe(1);
    // Recorded in the role count, so the admin can see there is something to
    // confirm rather than the credit vanishing.
    expect(entry.roleCounts.primary_host).toBe(1);
  });

  it('ignores a credit naming somebody not in the public record', () => {
    const events = [event('e1', '2026-03-01', [credit('ghost', 'primary_host')])];
    const board = leaderboard([ambassador('a', 'A')], events, { now: NOW });
    expect(board).toHaveLength(1);
    expect(board[0].score).toBe(0);
  });
});

describe('§21 time windows', () => {
  const events = [
    event('old', '2025-06-01', [credit('a', 'primary_host')]),
    event('this-year', '2026-03-01', [credit('a', 'primary_host')]),
    event('this-month', '2026-09-05', [credit('a', 'primary_host')]),
  ];

  it('all time counts everything', () => {
    const [entry] = leaderboard([ambassador('a', 'A')], events, { window: 'all', now: NOW });
    expect(entry.score).toBe(3);
  });

  it('this year counts only this year', () => {
    const [entry] = leaderboard([ambassador('a', 'A')], events, { window: 'year', now: NOW });
    expect(entry.events.map((e) => e.slug).sort()).toEqual(['this-month', 'this-year']);
  });

  it('this month counts only this month', () => {
    const [entry] = leaderboard([ambassador('a', 'A')], events, { window: 'month', now: NOW });
    expect(entry.events.map((e) => e.slug)).toEqual(['this-month']);
  });

  it('does not shift an event across a month boundary through a timezone', () => {
    // An IST event on 1 September is a September event. Parsed as a UTC
    // instant it would be 31 August, which is the bug this asserts against.
    const first = [event('first', '2026-09-01', [credit('a', 'primary_host')])];
    const [entry] = leaderboard([ambassador('a', 'A')], first, { window: 'month', now: NOW });
    expect(entry.events).toHaveLength(1);
  });

  it('keeps a long-term contributor visible in a narrow window', () => {
    // §21's fairness rule. The windowed entry is zero; the all-time figure is
    // still reachable, which is what the page prints alongside it.
    const standing = standingOf('a', [ambassador('a', 'A')], [events[0]], { now: NOW });
    expect(standing!.allTime.score).toBe(1);
    expect(standing!.month.score).toBe(0);
    expect(standing!.rank).toBe(1);
  });
});

describe('upcoming and past', () => {
  const events = [
    event('past', '2026-03-01', [credit('a', 'primary_host')]),
    event('soon', '2026-12-01', [credit('a', 'primary_host')]),
  ];

  it('splits on the clock, not on a stored flag', () => {
    const [entry] = leaderboard([ambassador('a', 'A')], events, { now: NOW });
    expect(entry.past.map((e) => e.slug)).toEqual(['past']);
    expect(entry.upcoming.map((e) => e.slug)).toEqual(['soon']);
  });

  it('moves an event from upcoming to past as the clock passes it', () => {
    const later = new Date('2027-01-01T12:00:00Z');
    const [entry] = leaderboard([ambassador('a', 'A')], events, { now: later });
    expect(entry.upcoming).toEqual([]);
    expect(entry.past.map((e) => e.slug)).toEqual(['soon', 'past']);
  });

  it('orders upcoming forwards and past backwards', () => {
    const many = [
      event('p1', '2026-01-01', [credit('a', 'primary_host')]),
      event('p2', '2026-02-01', [credit('a', 'primary_host')]),
      event('u1', '2026-11-01', [credit('a', 'primary_host')]),
      event('u2', '2026-12-01', [credit('a', 'primary_host')]),
    ];
    const [entry] = leaderboard([ambassador('a', 'A')], many, { now: NOW });
    expect(entry.upcoming.map((e) => e.slug)).toEqual(['u1', 'u2']);
    expect(entry.past.map((e) => e.slug)).toEqual(['p2', 'p1']);
  });
});

describe('§61 the ranking is deterministic', () => {
  const people = [ambassador('c', 'Chandni'), ambassador('a', 'Aarav'), ambassador('b', 'Bhavna')];
  const events = [
    event('e1', '2026-01-01', [credit('a', 'primary_host')]),
    event('e2', '2026-02-01', [credit('b', 'primary_host')]),
    event('e3', '2026-03-01', [credit('c', 'co_host')]),
  ];

  it('ranks by score, then breaks ties by name', () => {
    const board = leaderboard(people, events, { now: NOW });
    // a and b both score 1.0 — name orders them. c scores 0.5 and is last.
    expect(board.map((e) => e.ambassador.slug)).toEqual(['a', 'b', 'c']);
  });

  it('gives the same order however the inputs are ordered', () => {
    const forward = leaderboard(people, events, { now: NOW }).map((e) => e.ambassador.slug);
    const reversed = leaderboard([...people].reverse(), [...events].reverse(), { now: NOW }).map(
      (e) => e.ambassador.slug,
    );
    expect(reversed).toEqual(forward);
  });

  it('gives the same order on repeated runs', () => {
    const runs = Array.from({ length: 5 }, () =>
      leaderboard(people, events, { now: NOW }).map((e) => e.ambassador.slug),
    );
    expect(new Set(runs.map((r) => r.join(','))).size).toBe(1);
  });

  it('orders a total tie by slug, so nothing is left to the engine', () => {
    const twins = [ambassador('zara-b', 'Zara'), ambassador('zara-a', 'Zara')];
    const tied = [
      event('t1', '2026-01-01', [credit('zara-a', 'primary_host')]),
      event('t2', '2026-01-01', [credit('zara-b', 'primary_host')]),
    ];
    const board = leaderboard(twins, tied, { now: NOW });
    expect(board.map((e) => e.ambassador.slug)).toEqual(['zara-a', 'zara-b']);
  });

  it('includes an ambassador with no events, ranked last with a zero', () => {
    // §22 is a directory first and a ranking second: somebody newly verified
    // belongs on the page before they have run anything.
    const board = leaderboard([...people, ambassador('new', 'Newcomer')], events, { now: NOW });
    expect(board).toHaveLength(4);
    expect(board.at(-1)!.ambassador.slug).toBe('new');
    expect(board.at(-1)!.score).toBe(0);
  });
});

describe('cities', () => {
  it('collects the distinct cities somebody has been active in', () => {
    const events = [
      event('e1', '2026-01-01', [credit('a', 'primary_host')], { citySlug: 'bhopal' }),
      event('e2', '2026-02-01', [credit('a', 'primary_host')], { citySlug: 'indore' }),
      event('e3', '2026-03-01', [credit('a', 'primary_host')], { citySlug: 'bhopal' }),
    ];
    const [entry] = leaderboard([ambassador('a', 'A')], events, { now: NOW });
    expect(entry.cities).toEqual(['bhopal', 'indore']);
  });
});

describe('the curated credit rule', () => {
  it('derives one primary credit from an authored host', () => {
    expect(curatedCredits({ ambassadorSlug: 'aniket-sahu' })).toEqual([
      { ambassadorSlug: 'aniket-sahu', role: 'primary_host', source: 'curated', confidence: 1 },
    ]);
  });

  it('derives nothing from an unattributed event', () => {
    expect(curatedCredits({})).toEqual([]);
  });

  it('sorts credits into a stable, role-weighted order', () => {
    const sorted = sortCredits([
      credit('z', 'partner'),
      credit('b', 'co_host'),
      credit('a', 'co_host'),
      credit('m', 'primary_host'),
    ]);
    expect(sorted.map((c) => [c.ambassadorSlug, c.role])).toEqual([
      ['m', 'primary_host'],
      ['a', 'co_host'],
      ['b', 'co_host'],
      ['z', 'partner'],
    ]);
  });

  it('refuses to score anything below full confidence', () => {
    expect(isScorable(credit('a', 'primary_host', 1))).toBe(true);
    expect(isScorable(credit('a', 'primary_host', 0.99))).toBe(false);
    expect(isScorable(credit('a', 'speaker', 1))).toBe(false);
  });

  it('keeps §19 weights exactly as published', () => {
    expect(CREDIT_WEIGHTS).toEqual({
      primary_host: 1,
      organizer: 1,
      co_host: 0.5,
      partner: 0.25,
      speaker: 0,
    });
  });
});
