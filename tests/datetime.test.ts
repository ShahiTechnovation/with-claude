import { describe, expect, it } from 'vitest';
import {
  dateParts,
  daysUntil,
  formatDate,
  formatTime,
  formatTimeRange,
  isoDateTime,
  istDay,
  relativeDay,
} from '../src/lib/datetime';

describe('dateParts', () => {
  it('reads an IST calendar date without timezone drift', () => {
    const p = dateParts('2026-09-12');
    expect(p).toMatchObject({
      day: 12,
      dayPadded: '12',
      monthShort: 'Sep',
      monthDisplay: 'SEP',
      weekdayShort: 'Sat',
      year: 2026,
    });
  });

  it('pads single-digit days', () => {
    expect(dateParts('2026-03-01').dayPadded).toBe('01');
  });
});

describe('formatDate', () => {
  it('reads as a person would say it', () => {
    expect(formatDate('2026-09-12')).toBe('Sat, 12 Sep 2026');
    expect(formatDate('2026-03-01')).toBe('Sun, 1 Mar 2026');
  });
});

describe('formatTime', () => {
  it('drops :00 and keeps the meridiem', () => {
    expect(formatTime('18:00')).toBe('6 PM');
    expect(formatTime('20:30')).toBe('8:30 PM');
    expect(formatTime('10:00')).toBe('10 AM');
    expect(formatTime('00:30')).toBe('12:30 AM');
    expect(formatTime('12:00')).toBe('12 PM');
  });
});

describe('formatTimeRange', () => {
  it('collapses a shared meridiem', () => {
    expect(formatTimeRange('18:00', '20:30')).toBe('6 – 8:30 PM IST');
  });

  it('keeps both when the range crosses noon', () => {
    expect(formatTimeRange('10:00', '19:00')).toBe('10 AM – 7 PM IST');
  });

  it('handles an open-ended event', () => {
    expect(formatTimeRange('16:00')).toBe('4 PM IST');
  });
});

describe('istDay', () => {
  it('rolls over at IST midnight, not UTC midnight', () => {
    // 19:00 UTC on the 11th is 00:30 IST on the 12th.
    expect(istDay(new Date('2026-09-11T19:00:00Z'))).toBe('2026-09-12');
    expect(istDay(new Date('2026-09-11T18:00:00Z'))).toBe('2026-09-11');
  });
});

describe('daysUntil / relativeDay', () => {
  const now = new Date('2026-09-03T12:00:00+05:30');

  it('counts whole IST days', () => {
    expect(daysUntil('2026-09-12', now)).toBe(9);
    expect(daysUntil('2026-09-03', now)).toBe(0);
    expect(daysUntil('2026-08-27', now)).toBe(-7);
  });

  it('phrases the distance in words', () => {
    expect(relativeDay('2026-09-03', now)).toBe('today');
    expect(relativeDay('2026-09-04', now)).toBe('tomorrow');
    expect(relativeDay('2026-09-12', now)).toBe('in 9 days');
    expect(relativeDay('2026-08-27', now)).toBe('7 days ago');
    expect(relativeDay('2026-03-01', now)).toBe('6 months ago');
  });
});

describe('isoDateTime', () => {
  it('always stamps the IST offset', () => {
    expect(isoDateTime('2026-09-12', '18:00')).toBe('2026-09-12T18:00:00+05:30');
  });
});
