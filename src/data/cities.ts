import type { City } from './types';

/**
 * The city record.
 *
 * IMPORTANT — honesty rule: a city is only `active` once it has actually run
 * events. Everything else is `open`, which the UI renders as an invitation to
 * start a chapter, never as a claim that one exists. Do not promote a city
 * here without a verified organiser and a real event.
 *
 * Coordinates are real decimal lat/lon and drive every map on the site.
 */
export const cities: City[] = [
  {
    id: 'city-bhopal',
    slug: 'bhopal',
    name: 'Bhopal',
    state: 'Madhya Pradesh',
    lat: 23.2599,
    lon: 77.4126,
    status: 'active',
    blurb:
      'The first chapter. Eleven events since March — workshops, conversations and a full-day Impact Lab — in a thousand-year-old city of lakes.',
    reported: {
      members: 420,
      prototypes: 34,
      // Figures published by the Bhopal chapter on claude-community-bhopal.netlify.app.
      // TODO: re-verify with the organisers before the national launch.
      source: 'Bhopal chapter, September 2026',
    },
    organiser: { name: 'The Origin Guild', url: 'https://t.me/tog_guild' },
    image: 'city/city-01.jpg',
    links: [
      { label: 'Telegram', url: 'https://t.me/tog_guild' },
      { label: 'Instagram', url: 'https://www.instagram.com/theoriginguild' },
      { label: 'X', url: 'https://x.com/og_guild' },
      { label: 'LinkedIn', url: 'https://www.linkedin.com/company/theoriginguild' },
    ],
  },

  // --- Open cities -------------------------------------------------------
  // No chapter, no organiser, no numbers. These are plotted so the map shows
  // the shape of the country and where the network could go next.
  {
    id: 'city-delhi',
    slug: 'delhi',
    name: 'Delhi',
    state: 'Delhi',
    lat: 28.6139,
    lon: 77.209,
    status: 'open',
    blurb: 'No chapter yet.',
  },
  {
    id: 'city-mumbai',
    slug: 'mumbai',
    name: 'Mumbai',
    state: 'Maharashtra',
    lat: 19.076,
    lon: 72.8777,
    status: 'open',
    blurb: 'No chapter yet.',
  },
  {
    id: 'city-bengaluru',
    slug: 'bengaluru',
    name: 'Bengaluru',
    state: 'Karnataka',
    lat: 12.9716,
    lon: 77.5946,
    status: 'open',
    blurb: 'No chapter yet.',
  },
  {
    id: 'city-hyderabad',
    slug: 'hyderabad',
    name: 'Hyderabad',
    state: 'Telangana',
    lat: 17.385,
    lon: 78.4867,
    status: 'open',
    blurb: 'No chapter yet.',
  },
  {
    id: 'city-chennai',
    slug: 'chennai',
    name: 'Chennai',
    state: 'Tamil Nadu',
    lat: 13.0827,
    lon: 80.2707,
    status: 'open',
    blurb: 'No chapter yet.',
  },
  {
    id: 'city-kolkata',
    slug: 'kolkata',
    name: 'Kolkata',
    state: 'West Bengal',
    lat: 22.5726,
    lon: 88.3639,
    status: 'open',
    blurb: 'No chapter yet.',
  },
  {
    id: 'city-pune',
    slug: 'pune',
    name: 'Pune',
    state: 'Maharashtra',
    lat: 18.5204,
    lon: 73.8567,
    status: 'open',
    blurb: 'No chapter yet.',
  },
  {
    id: 'city-ahmedabad',
    slug: 'ahmedabad',
    name: 'Ahmedabad',
    state: 'Gujarat',
    lat: 23.0225,
    lon: 72.5714,
    status: 'open',
    blurb: 'No chapter yet.',
  },
  {
    id: 'city-jaipur',
    slug: 'jaipur',
    name: 'Jaipur',
    state: 'Rajasthan',
    lat: 26.9124,
    lon: 75.7873,
    status: 'open',
    blurb: 'No chapter yet.',
  },
  {
    id: 'city-indore',
    slug: 'indore',
    name: 'Indore',
    state: 'Madhya Pradesh',
    lat: 22.7196,
    lon: 75.8577,
    status: 'open',
    blurb: 'No chapter yet.',
  },
  {
    id: 'city-chandigarh',
    slug: 'chandigarh',
    name: 'Chandigarh',
    state: 'Chandigarh',
    lat: 30.7333,
    lon: 76.7794,
    status: 'open',
    blurb: 'No chapter yet.',
  },
  {
    id: 'city-guwahati',
    slug: 'guwahati',
    name: 'Guwahati',
    state: 'Assam',
    lat: 26.1445,
    lon: 91.7362,
    status: 'open',
    blurb: 'No chapter yet.',
  },
  {
    id: 'city-kochi',
    slug: 'kochi',
    name: 'Kochi',
    state: 'Kerala',
    lat: 9.9312,
    lon: 76.2673,
    status: 'open',
    blurb: 'No chapter yet.',
  },
];
