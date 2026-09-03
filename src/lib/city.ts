import type { CityState } from '@/data/types';

/**
 * City governance, in one place.
 *
 * A city's state is derived from verified records and nothing else. There is
 * no editorial override and no field to set, because the failure mode this
 * guards against is exactly the one that makes community sites untrustworthy:
 * a dot on a map that looks like a chapter on offer.
 *
 * The four states, and what each one is allowed to claim:
 *
 *  ambassador-led     A verified Claude Community Ambassador hosts here.
 *  event-activity     Events are on the record; no Ambassador is assigned.
 *  community-interest People here registered interest. Nothing is scheduled.
 *  discovery          Plotted so the map is of India. No verified activity.
 */

export interface CityFacts {
  /** A published Ambassador record points at this city. */
  hasAmbassador: boolean;
  /** Events on the record, past or future. */
  eventCount: number;
  /** Interest registered by people in the city. Real counts only. */
  interestCount: number;
}

export function cityState(facts: CityFacts): CityState {
  if (facts.hasAmbassador) return 'ambassador-led';
  if (facts.eventCount > 0) return 'event-activity';
  if (facts.interestCount > 0) return 'community-interest';
  return 'discovery';
}

/** The label shown on a chip or a legend. Kept short enough for a map key. */
export const CITY_STATE_LABEL: Record<CityState, string> = {
  'ambassador-led': 'Ambassador-led',
  'event-activity': 'Event activity',
  'community-interest': 'Community interest',
  discovery: 'Discovery',
};

/**
 * The sentence a city page leads with. These are the load-bearing strings for
 * the whole governance model — every one of them says what is true and stops.
 */
export const CITY_STATE_NOTE: Record<CityState, string> = {
  'ambassador-led': 'Claude Community events are hosted here by a verified Ambassador.',
  'event-activity': 'Events have happened here. No Ambassador is currently assigned.',
  'community-interest': 'People here have registered interest. Nothing is scheduled yet.',
  discovery: 'No verified community activity here yet.',
};

/** Ordering for indexes and legends — most active first. */
export const CITY_STATE_ORDER: CityState[] = [
  'ambassador-led',
  'event-activity',
  'community-interest',
  'discovery',
];

export function cityStateRank(state: CityState): number {
  return CITY_STATE_ORDER.indexOf(state);
}

/** True when the city has something to show beyond its coordinates. */
export function isLive(state: CityState): boolean {
  return state === 'ambassador-led' || state === 'event-activity';
}
