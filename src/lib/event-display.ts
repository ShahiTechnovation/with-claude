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

/**
 * What ingestion stores for an event with no public venue. Display replaces it
 * with the city (see `displayEvent`); it is shown only when the city is unknown.
 */
export const PRIVATE_VENUE_NAME = 'Venue shared with registrants';

/**
 * Luma's two ways of saying "registrants only": its stand-in sentence, and a
 * LOCATION that is nothing but the event's own link.
 */
const VENUE_PLACEHOLDER = /^(?:check event page for more details\.?|https?:\/\/\S+)$/i;

/**
 * True when there is no venue to name: an empty value, either of Luma's
 * placeholders, or the stand-in ingestion stored for one of them.
 */
export function isVenuePlaceholder(value: string | null | undefined): boolean {
  const venue = value?.trim();
  return !venue || venue === PRIVATE_VENUE_NAME || VENUE_PLACEHOLDER.test(venue);
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
    // A private venue is named by its city, as the curated record names one.
    // The pages print "Shared with confirmed registrants" beneath it, so a
    // name that said the same would say it twice.
    venue: placeholder ? { ...event.venue, name: cityName ?? PRIVATE_VENUE_NAME, private: true } : event.venue,
  };
}
