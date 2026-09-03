import type { City } from './types';

/**
 * The city record.
 *
 * IMPORTANT — a city record contains no community status. There is no `active`
 * flag, no `chapter` field, and no way to promote a city by editing this file.
 * A city's state is derived at render time from verified records elsewhere:
 * an Ambassador pointing at it, events held in it, or interest registered for
 * it. See `cityState()` in `src/lib/city.ts`.
 *
 * That is deliberate. The old model had an `open` status that the UI rendered
 * as "claim this dot", which read as though a chapter were on offer. Nothing
 * on this site is on offer: Claude Community Ambassadors are appointed by
 * Anthropic.
 *
 * Coordinates are real decimal lat/lon and drive every map on the site.
 * `blurb` describes the *place*, never an implied promise about what is coming.
 */
export const cities: City[] = [
  {
    id: 'city-bhopal',
    slug: 'bhopal',
    status: 'published',
    name: 'Bhopal',
    state: 'Madhya Pradesh',
    lat: 23.2599,
    lon: 77.4126,
    blurb: 'Built around two lakes on the Malwa plateau, and the city where this record starts.',
    reported: {
      members: 420,
      prototypes: 34,
      // Figures published by the Bhopal organisers. Rendered only with this
      // attribution attached — never rolled into a national headline number.
      // TODO: re-verify with the organisers before the national launch.
      source: 'Reported by the Bhopal organisers, September 2026',
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

  // --- Plotted for discovery ---------------------------------------------
  // No ambassador, no events, no registered interest. These cities are on the
  // map because the map is of India, not because anything is promised in them.
  {
    id: 'city-delhi',
    slug: 'delhi',
    status: 'published',
    name: 'Delhi',
    state: 'Delhi',
    lat: 28.6139,
    lon: 77.209,
    blurb: 'The capital region, on the Yamuna.',
  },
  {
    id: 'city-mumbai',
    slug: 'mumbai',
    status: 'published',
    name: 'Mumbai',
    state: 'Maharashtra',
    lat: 19.076,
    lon: 72.8777,
    blurb: "On the Arabian Sea — India's financial centre.",
  },
  {
    id: 'city-bengaluru',
    slug: 'bengaluru',
    status: 'published',
    name: 'Bengaluru',
    state: 'Karnataka',
    lat: 12.9716,
    lon: 77.5946,
    blurb: 'On the Deccan plateau, some 900 metres up.',
  },
  {
    id: 'city-hyderabad',
    slug: 'hyderabad',
    status: 'published',
    name: 'Hyderabad',
    state: 'Telangana',
    lat: 17.385,
    lon: 78.4867,
    blurb: 'Either side of the Musi, on the Deccan.',
  },
  {
    id: 'city-chennai',
    slug: 'chennai',
    status: 'published',
    name: 'Chennai',
    state: 'Tamil Nadu',
    lat: 13.0827,
    lon: 80.2707,
    blurb: 'On the Coromandel Coast.',
  },
  {
    id: 'city-kolkata',
    slug: 'kolkata',
    status: 'published',
    name: 'Kolkata',
    state: 'West Bengal',
    lat: 22.5726,
    lon: 88.3639,
    blurb: 'On the Hooghly, in the Ganges delta.',
  },
  {
    id: 'city-pune',
    slug: 'pune',
    status: 'published',
    name: 'Pune',
    state: 'Maharashtra',
    lat: 18.5204,
    lon: 73.8567,
    blurb: 'Where the Mula meets the Mutha, east of the Ghats.',
  },
  {
    id: 'city-ahmedabad',
    slug: 'ahmedabad',
    status: 'published',
    name: 'Ahmedabad',
    state: 'Gujarat',
    lat: 23.0225,
    lon: 72.5714,
    blurb: 'On the Sabarmati.',
  },
  {
    id: 'city-jaipur',
    slug: 'jaipur',
    status: 'published',
    name: 'Jaipur',
    state: 'Rajasthan',
    lat: 26.9124,
    lon: 75.7873,
    blurb: 'At the foot of the Aravallis, on the edge of the Thar.',
  },
  {
    id: 'city-indore',
    slug: 'indore',
    status: 'published',
    name: 'Indore',
    state: 'Madhya Pradesh',
    lat: 22.7196,
    lon: 75.8577,
    blurb: 'On the Malwa plateau, west of Bhopal.',
  },
  {
    id: 'city-chandigarh',
    slug: 'chandigarh',
    status: 'published',
    name: 'Chandigarh',
    state: 'Chandigarh',
    lat: 30.7333,
    lon: 76.7794,
    blurb: 'A planned city at the foot of the Shivaliks.',
  },
  {
    id: 'city-guwahati',
    slug: 'guwahati',
    status: 'published',
    name: 'Guwahati',
    state: 'Assam',
    lat: 26.1445,
    lon: 91.7362,
    blurb: 'On the south bank of the Brahmaputra.',
  },
  {
    id: 'city-kochi',
    slug: 'kochi',
    status: 'published',
    name: 'Kochi',
    state: 'Kerala',
    lat: 9.9312,
    lon: 76.2673,
    blurb: 'On the Malabar Coast, among the backwaters.',
  },
];
