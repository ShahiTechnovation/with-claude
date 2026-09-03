import type { CommunityEvent, EventStatus } from '@/data/types';
import { istDay, istInstant } from './datetime';

/** Events without an end time are assumed to run this long. */
const DEFAULT_DURATION_HOURS = 2;

/**
 * The single source of truth for what state an event is in.
 *
 * Nothing else on the site is allowed to decide this. Pages ask for the status,
 * they never compare dates themselves — that is how "next event" drifts out of
 * sync across a page.
 */
export function statusOf(event: CommunityEvent, now: Date = new Date()): EventStatus {
  if (event.statusOverride === 'cancelled') return 'cancelled';

  const start = istInstant(event.date, event.startTime);
  const end = event.endTime
    ? istInstant(event.date, event.endTime)
    : new Date(start.getTime() + DEFAULT_DURATION_HOURS * 3_600_000);

  if (now >= end) return 'past';
  if (now >= start) return 'live';

  // Still ahead of us. A door state, if set, outranks the calendar.
  if (event.statusOverride === 'sold-out') return 'sold-out';
  if (event.statusOverride === 'registration-closed') return 'registration-closed';

  return istDay(now) === event.date ? 'today' : 'upcoming';
}

/** True when the event has not finished yet, whatever its door state. */
export function isForthcoming(event: CommunityEvent, now: Date = new Date()): boolean {
  return statusOf(event, now) !== 'past' && statusOf(event, now) !== 'cancelled';
}

/** True when we should still be sending people to the registration link. */
export function isRegistrationOpen(event: CommunityEvent, now: Date = new Date()): boolean {
  const status = statusOf(event, now);
  return (
    Boolean(event.registrationUrl) &&
    (status === 'upcoming' || status === 'today' || status === 'live')
  );
}

const LABELS: Record<EventStatus, string> = {
  upcoming: 'Upcoming',
  today: 'Today',
  live: 'Happening now',
  'sold-out': 'Sold out',
  'registration-closed': 'Registration closed',
  past: 'Past',
  cancelled: 'Cancelled',
};

export function statusLabel(status: EventStatus): string {
  return LABELS[status];
}

/**
 * Which visual treatment a status gets. Kept here so the mapping lives with the
 * logic rather than being re-guessed in every component.
 */
export type StatusTone = 'live' | 'next' | 'closed' | 'archive';

const TONES: Record<EventStatus, StatusTone> = {
  live: 'live',
  today: 'live',
  upcoming: 'next',
  'sold-out': 'closed',
  'registration-closed': 'closed',
  cancelled: 'closed',
  past: 'archive',
};

export function statusTone(status: EventStatus): StatusTone {
  return TONES[status];
}
