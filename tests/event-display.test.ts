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
    expect(stripCityPrefix('Delhi NCR | Claude Meetup', 'Delhi')).toBe('Claude Meetup');
    expect(stripCityPrefix('New  Delhi | Claude Meetup', 'Delhi')).toBe('Claude Meetup');
  });

  it('keeps a suburb or satellite city: that is a place, not a second spelling', () => {
    expect(stripCityPrefix('Gandhinagar | Claude Meetup', 'Ahmedabad')).toBe('Gandhinagar | Claude Meetup');
    expect(stripCityPrefix('Thane | Claude Meetup', 'Mumbai')).toBe('Thane | Claude Meetup');
    expect(stripCityPrefix('Navi Mumbai | Claude Meetup', 'Mumbai')).toBe('Navi Mumbai | Claude Meetup');
    expect(stripCityPrefix('Secunderabad | Claude Meetup', 'Hyderabad')).toBe('Secunderabad | Claude Meetup');
    expect(stripCityPrefix('Mohali | Claude Meetup', 'Chandigarh')).toBe('Mohali | Claude Meetup');
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

  it('recognises a bare event link, which is how Luma marks a registrant-only venue', () => {
    expect(isVenuePlaceholder('https://luma.com/event/evt-IcKOSAOGP6GAeEX')).toBe(true);
    expect(isVenuePlaceholder(' http://lu.ma/abc ')).toBe(true);
    // A venue that mentions a link is still a venue.
    expect(isVenuePlaceholder('Paytm, see https://paytm.com')).toBe(false);
  });

  it("recognises the stand-in that ingestion itself stores, so rows already synced read the same", () => {
    expect(isVenuePlaceholder(PRIVATE_VENUE_NAME)).toBe(true);
  });

  it('does not swallow a real venue', () => {
    expect(isVenuePlaceholder('Sheryians HQ')).toBe(false);
  });
});

describe('displayEvent', () => {
  it('cleans the title and turns the placeholder into a private venue', () => {
    const shown = displayEvent(base, 'Mumbai');
    expect(shown.title).toBe('Claude Conversation');
    // Named by its city, as the curated record does. The pages add "Shared with
    // confirmed registrants" under it, so the name must not say that too.
    expect(shown.venue).toEqual({ name: 'Mumbai', private: true });
    // The stored record is not edited.
    expect(base.title).toBe('Mumbai | Claude Conversation');
    expect(base.venue.name).toBe('Check event page for more details.');
  });

  it('names a venue that ingestion already stored as private by its city too', () => {
    const synced = { ...base, title: 'Claude Meetup', venue: { name: PRIVATE_VENUE_NAME, private: true } };
    expect(displayEvent(synced, 'Mumbai').venue).toEqual({ name: 'Mumbai', private: true });
    const link = { ...base, title: 'Claude Meetup', venue: { name: 'https://luma.com/event/evt-x' } };
    expect(displayEvent(link, 'Mumbai').venue).toEqual({ name: 'Mumbai', private: true });
  });

  it('falls back to the stand-in when the city is not in the record', () => {
    expect(displayEvent(base, undefined).venue).toEqual({ name: PRIVATE_VENUE_NAME, private: true });
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
      expect(event.venue).toEqual({ name: 'Mumbai', private: true });
      expect(selectors.venueLabel(event)).toBeUndefined();
    }
    expect(rs.events[0]).toBe(base);
  });
});
