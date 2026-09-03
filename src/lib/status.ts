import type { CommunityEvent, EventLifecycle } from '@/data/types';
import { istDay, istInstant } from './datetime';

/** Events without an end time are assumed to run this long. */
const DEFAULT_DURATION_HOURS = 2;

/**
 * The single source of truth for what state an event is in.
 *
 * Nothing else on the site is allowed to decide this. Pages ask for the
 * lifecycle; they never compare dates themselves — that is how "next event"
 * drifts out of sync across a page.
 *
 * Note this is separate from `event.status`, which is the record's *moderation*
 * state (pending / published / featured / archived). One is the clock, the
 * other is the editor.
 */
export function lifecycleOf(event: CommunityEvent, now: Date = new Date()): EventLifecycle {
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
  const lifecycle = lifecycleOf(event, now);
  return lifecycle !== 'past' && lifecycle !== 'cancelled';
}

/** True when we should still be sending people to the registration link. */
export function isRegistrationOpen(event: CommunityEvent, now: Date = new Date()): boolean {
  const lifecycle = lifecycleOf(event, now);
  return (
    Boolean(event.registrationUrl) &&
    (lifecycle === 'upcoming' || lifecycle === 'today' || lifecycle === 'live')
  );
}

const LABELS: Record<EventLifecycle, string> = {
  upcoming: 'Upcoming',
  today: 'Today',
  live: 'Happening now',
  'sold-out': 'Sold out',
  'registration-closed': 'Registration closed',
  past: 'Past',
  cancelled: 'Cancelled',
};

export function lifecycleLabel(lifecycle: EventLifecycle): string {
  return LABELS[lifecycle];
}

/**
 * Which visual treatment a lifecycle gets. Kept here so the mapping lives with
 * the logic rather than being re-guessed in every component.
 */
export type LifecycleTone = 'live' | 'next' | 'closed' | 'archive';

const TONES: Record<EventLifecycle, LifecycleTone> = {
  live: 'live',
  today: 'live',
  upcoming: 'next',
  'sold-out': 'closed',
  'registration-closed': 'closed',
  cancelled: 'closed',
  past: 'archive',
};

export function lifecycleTone(lifecycle: EventLifecycle): LifecycleTone {
  return TONES[lifecycle];
}

/** `impact-lab` renders as `Impact lab`. */
export function formatName(format: string): string {
  const words = format.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
