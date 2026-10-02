import { describe, expect, it } from 'vitest';
import { RecordSelectors } from '../src/data/selectors';
import { tsRecordSet } from '../src/data/source-ts';
import type { CommunityEvent } from '../src/data/types';
import {
  PRIVATE_VENUE_NAME,
  displayEvent,
  isVenuePlaceholder,
  stripCityPrefix,
} from '../src/lib/event-display';

/**
 * Feed events arrive exactly as an organiser typed them into Luma. The stored
 * row keeps that; these are the two things the public record cleans on the way
 * out, and the one place it does so.
 */
const base: CommunityEvent = {
  id: 'evt-display',
  slug: 'evt-display',
  status: 'published',
  title: 'Mumbai | Claude Conversation',
  host: { credits: [] },
  format: 'meetup',
  citySlug: 'mumbai',
  date: '2026-11-01',
  startTime: '18:00',
  venue: { name: 'Check event page for more details.' },
  summary: 'A test.',
  free: true,
};

describe('stripCityPrefix', () => {
  it('drops a leading "<city> |" that repeats the event city', () => {
    expect(stripCityPrefix('Mumbai | Claude Conversation', 'Mumbai')).toBe('Claude Conversation');
    expect(stripCityPrefix('Bhopal | Claude Code Build Day - Fable 5.1', 'Bhopal')).toBe(
      'Claude Code Build Day - Fable 5.1',
    );
    expect(stripCityPrefix('BHOPAL|Claude Meetup', 'Bhopal')).toBe('Claude Meetup');
  });

  it('matches the aliases a feed writes for the same city', () => {
    expect(stripCityPrefix('Bangalore | Claude Fable Build Day', 'Bengaluru')).toBe('Claude Fable Build Day');
    expect(stripCityPrefix('Bombay | Claude Meetup', 'Mumbai')).toBe('Claude Meetup');
  });

  it('leaves a prefix that is not the event city', () => {
    expect(stripCityPrefix('Claude Code | Build Day', 'Bhopal')).toBe('Claude Code | Build Day');
    expect(stripCityPrefix('Delhi | Claude Meetup', 'Bhopal')).toBe('Delhi | Claude Meetup');
  });

  it('leaves a title with nothing after the prefix, no pipe, or no known city', () => {
    expect(stripCityPrefix('Bhopal |', 'Bhopal')).toBe('Bhopal |');
    expect(stripCityPrefix('Claude Meetup', 'Bhopal')).toBe('Claude Meetup');
    expect(stripCityPrefix('Bhopal | Claude Meetup', undefined)).toBe('Bhopal | Claude Meetup');
  });
});

describe('isVenuePlaceholder', () => {
  it("recognises Luma's stand-in, whatever its case, and an empty value", () => {
    expect(isVenuePlaceholder('Check event page for more details.')).toBe(true);
    expect(isVenuePlaceholder('  CHECK EVENT PAGE FOR MORE DETAILS ')).toBe(true);
    expect(isVenuePlaceholder('')).toBe(true);
    expect(isVenuePlaceholder(undefined)).toBe(true);
  });

  it('does not swallow a real venue', () => {
    expect(isVenuePlaceholder('Sheryians HQ')).toBe(false);
  });
});

describe('displayEvent', () => {
  it('cleans the title and turns the placeholder into a private venue', () => {
    const shown = displayEvent(base, 'Mumbai');
    expect(shown.title).toBe('Claude Conversation');
    expect(shown.venue).toEqual({ name: PRIVATE_VENUE_NAME, private: true });
    // The stored record is not edited.
    expect(base.title).toBe('Mumbai | Claude Conversation');
    expect(base.venue.name).toBe('Check event page for more details.');
  });

  it('returns the same record when there is nothing to clean', () => {
    const clean = { ...base, title: 'Claude Meetup', venue: { name: 'Paytm', address: 'Delhi' } };
    expect(displayEvent(clean, 'Mumbai')).toBe(clean);
  });
});

describe('the public record', () => {
  it('hands every consumer the cleaned event', () => {
    const rs = { ...tsRecordSet(), events: [base] };
    const selectors = new RecordSelectors(rs);

    for (const event of [
      selectors.events[0],
      selectors.publicEvents[0],
      selectors.eventsChronological[0],
      selectors.eventBySlug.get(base.slug)!,
    ]) {
      expect(event.title).toBe('Claude Conversation');
      expect(event.venue.name).toBe(PRIVATE_VENUE_NAME);
      expect(selectors.venueLabel(event)).toBeUndefined();
    }
    expect(rs.events[0]).toBe(base);
  });
});
