import type { Ambassador } from './types';

/**
 * The Ambassador record.
 *
 * Claude Community Ambassadors are appointed by Anthropic. This website does
 * not grant, confer, or apply the status to anyone — it only records people
 * whose status has been confirmed, and every entry must say how.
 *
 * Adding a name here is the single most consequential edit in this repository:
 * it is what turns a city into an Ambassador-led community and what gives an
 * event its verified treatment. If you cannot fill in `verifiedVia` from
 * something you actually saw, do not add the record.
 */
export const ambassadors: Ambassador[] = [
  {
    id: 'amb-aniket-sahu',
    slug: 'aniket-sahu',
    status: 'published',
    name: 'Aniket Sahu',
    citySlug: 'bhopal',
    title: 'Claude Community Ambassador',
    verifiedVia: 'Confirmed by the Bhopal organisers, September 2026',
    builderSlug: 'aniket-sahu',
  },
];
