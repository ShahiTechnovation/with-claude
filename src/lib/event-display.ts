import type { CommunityEvent } from '@/data/types';
import { canonicalCityName } from '@/server/events/india';

/**
 * WHAT THE PUBLIC RECORD CLEANS ON THE WAY OUT.
 *
 * A feed event is stored exactly as its organiser typed it into Luma. One of
 * those habits reads badly once the site prints the city as its own label:
 * a title that opens with the city again ("Bangalore | Claude Fable Build
 * Day"). It is cleaned here, at display, so the stored row stays what the
 * source said.
 */

/**
 * Drop a leading "<city> |" when it names the event's own city.
 *
 * Only the event's city, or an alias of it, is removed: "Claude Code | Build
 * Day" has a pipe too, and that prefix is part of the name.
 */
export function stripCityPrefix(title: string, cityName: string | undefined): string {
  const match = /^([^|]{2,40})\|\s*(\S.*)$/.exec(title);
  if (!match || !cityName) return title;

  const prefix = match[1].trim();
  const canonical = canonicalCityName(prefix);
  const sameCity =
    prefix.toLowerCase() === cityName.toLowerCase() ||
    (canonical !== undefined && canonical === canonicalCityName(cityName));
  return sameCity ? match[2].trim() : title;
}

/** The event as the public record shows it. The same object when it is already clean. */
export function displayEvent(event: CommunityEvent, cityName: string | undefined): CommunityEvent {
  const title = stripCityPrefix(event.title, cityName);
  return title === event.title ? event : { ...event, title };
}
