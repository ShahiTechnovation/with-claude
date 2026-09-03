import { describe, expect, it } from 'vitest';
import type { CommunityEvent } from '../src/data/types';
import { isRegistrationOpen, lifecycleOf, lifecycleTone } from '../src/lib/status';

/**
 * Event lifecycle is the one derived value the whole site hangs off — the hero,
 * the masthead chip, the index, the JSON-LD. If it drifts, every one of those
 * lies at once, so it gets the tests.
 */
const base: CommunityEvent = {
  id: 'test',
  slug: 'test',
  status: 'published',
  title: 'Test event',
  host: { ambassadorSlug: 'aniket-sahu' },
  format: 'workshop',
  citySlug: 'bhopal',
  date: '2026-09-12',
  startTime: '18:00',
  endTime: '20:30',
  venue: { name: 'Somewhere' },
  summary: 'A test.',
  registrationUrl: 'https://luma.com/test',
  free: true,
};

/** An instant expressed in IST, so the tests read as the organisers think. */
const ist = (iso: string) => new Date(`${iso}+05:30`);

describe('lifecycleOf', () => {
  it('is upcoming on an earlier day', () => {
    expect(lifecycleOf(base, ist('2026-09-11T23:59:00'))).toBe('upcoming');
  });

  it('is today from midnight IST until the doors open', () => {
    expect(lifecycleOf(base, ist('2026-09-12T00:01:00'))).toBe('today');
    expect(lifecycleOf(base, ist('2026-09-12T17:59:00'))).toBe('today');
  });

  it('is live between start and end', () => {
    expect(lifecycleOf(base, ist('2026-09-12T18:00:00'))).toBe('live');
    expect(lifecycleOf(base, ist('2026-09-12T20:29:00'))).toBe('live');
  });

  it('is past the moment it ends', () => {
    expect(lifecycleOf(base, ist('2026-09-12T20:30:00'))).toBe('past');
    expect(lifecycleOf(base, ist('2026-09-13T09:00:00'))).toBe('past');
  });

  it('assumes a two-hour run when no end time is given', () => {
    const open = { ...base, endTime: undefined };
    expect(lifecycleOf(open, ist('2026-09-12T19:59:00'))).toBe('live');
    expect(lifecycleOf(open, ist('2026-09-12T20:01:00'))).toBe('past');
  });

  it('does not depend on the machine timezone', () => {
    // 17:00 UTC is 22:30 IST — after the event ended.
    expect(lifecycleOf(base, new Date('2026-09-12T17:00:00Z'))).toBe('past');
    // 12:00 UTC is 17:30 IST — still before the doors.
    expect(lifecycleOf(base, new Date('2026-09-12T12:00:00Z'))).toBe('today');
  });

  describe('overrides', () => {
    it('lets a sold-out door state outrank the calendar, while it is ahead', () => {
      const soldOut = { ...base, statusOverride: 'sold-out' as const };
      expect(lifecycleOf(soldOut, ist('2026-09-10T10:00:00'))).toBe('sold-out');
    });

    it('still goes past once a sold-out event has happened', () => {
      const soldOut = { ...base, statusOverride: 'sold-out' as const };
      expect(lifecycleOf(soldOut, ist('2026-09-14T10:00:00'))).toBe('past');
    });

    it('treats cancelled as absolute', () => {
      const cancelled = { ...base, statusOverride: 'cancelled' as const };
      expect(lifecycleOf(cancelled, ist('2026-09-12T19:00:00'))).toBe('cancelled');
      expect(lifecycleOf(cancelled, ist('2026-10-01T00:00:00'))).toBe('cancelled');
    });
  });
});

describe('isRegistrationOpen', () => {
  it('is open while the event is ahead or running', () => {
    expect(isRegistrationOpen(base, ist('2026-09-01T10:00:00'))).toBe(true);
    expect(isRegistrationOpen(base, ist('2026-09-12T19:00:00'))).toBe(true);
  });

  it('closes once the event is over', () => {
    expect(isRegistrationOpen(base, ist('2026-09-13T10:00:00'))).toBe(false);
  });

  it('closes when the door state says so', () => {
    const soldOut = { ...base, statusOverride: 'sold-out' as const };
    expect(isRegistrationOpen(soldOut, ist('2026-09-01T10:00:00'))).toBe(false);
  });

  it('is never open without a link to send people to', () => {
    const noLink = { ...base, registrationUrl: undefined };
    expect(isRegistrationOpen(noLink, ist('2026-09-01T10:00:00'))).toBe(false);
  });
});

describe('lifecycleTone', () => {
  it('maps every lifecycle to a tone', () => {
    const all = [
      'upcoming',
      'today',
      'live',
      'sold-out',
      'registration-closed',
      'past',
      'cancelled',
    ] as const;
    for (const lifecycle of all) {
      expect(['live', 'next', 'closed', 'archive']).toContain(lifecycleTone(lifecycle));
    }
  });
});
