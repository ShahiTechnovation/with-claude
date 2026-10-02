import type { CommunityEvent } from '@/data/types';

/**
 * WHAT THE PUBLIC RECORD CLEANS ON THE WAY OUT.
 *
 * A feed event is stored exactly as its organiser typed it into Luma. Two of
 * those habits read badly once the site prints the city as its own label:
 * a title that opens with the city again ("Bangalore | Claude Fable Build
 * Day"), and Luma's stand-in text sitting where a venue should be. Both are
 * cleaned here, at display, so the stored row stays what the source said.
 */

/** What an event with no public venue is called. Ingestion stores the same. */
export const PRIVATE_VENUE_NAME = 'Venue shared with registrants';

const VENUE_PLACEHOLDER = /^check event page for more details\.?$/i;

/** True for an empty venue and for Luma's "Check event page for more details." */
export function isVenuePlaceholder(value: string | null | undefined): boolean {
  const venue = value?.trim();
  return !venue || VENUE_PLACEHOLDER.test(venue);
}

/**
 * Other spellings of the SAME city, keyed by the name the record uses.
 *
 * Deliberately not the metro map in `src/server/events/india.ts`. That one
 * folds Thane into Mumbai and Gandhinagar into Ahmedabad, which is right for
 * deciding which city page an event belongs to and wrong here: a suburb in a
 * title is a real place the organiser chose to name, and it stays.
 */
const CITY_SPELLINGS: Record<string, string[]> = {
  ahmedabad: ['amdavad'],
  bengaluru: ['bangalore'],
  chennai: ['madras'],
  delhi: ['new delhi', 'delhi ncr', 'dilli'],
  gurugram: ['gurgaon'],
  kochi: ['cochin'],
  kolkata: ['calcutta'],
  mumbai: ['bombay'],
  mysuru: ['mysore'],
  puducherry: ['pondicherry'],
  pune: ['poona'],
  thiruvananthapuram: ['trivandrum'],
  vadodara: ['baroda'],
  visakhapatnam: ['vizag'],
};

const cityKey = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Drop a leading "<city> |" when it names the event's own city.
 *
 * Only the event's city, or another spelling of it, is removed: "Claude Code |
 * Build Day" has a pipe too, and that prefix is part of the name.
 */
export function stripCityPrefix(title: string, cityName: string | undefined): string {
  const match = /^([^|]{2,40})\|\s*(\S.*)$/.exec(title);
  if (!match || !cityName) return title;

  const prefix = cityKey(match[1]);
  const city = cityKey(cityName);
  const sameCity = prefix === city || (CITY_SPELLINGS[city] ?? []).includes(prefix);
  return sameCity ? match[2].trim() : title;
}

/** The event as the public record shows it. The same object when it is already clean. */
export function displayEvent(event: CommunityEvent, cityName: string | undefined): CommunityEvent {
  const title = stripCityPrefix(event.title, cityName);
  const placeholder = isVenuePlaceholder(event.venue.name);
  if (title === event.title && !placeholder) return event;

  return {
    ...event,
    title,
    venue: placeholder ? { ...event.venue, name: PRIVATE_VENUE_NAME, private: true } : event.venue,
  };
}
