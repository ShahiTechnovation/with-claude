/**
 * IS THIS EVENT IN INDIA, AND HOW SURE ARE WE?
 *
 * The Claude Community Luma calendar is a WORLD calendar. Measured against the
 * live feed: 317 events, of which 2 were in India. So this file is not a
 * formality — it is the thing standing between a directory of Indian community
 * events and a directory of meetups in Zurich.
 *
 * ── WHY NOT THE TITLE ────────────────────────────────────────────────────
 *
 * §21 forbids deciding from title text, and the feed shows why. The two real
 * Indian events are titled `Mumbai | Claude Fable 5.1 Build Day` and
 * `Bangalore | Claude Fable Build Day`, so a title match would have worked —
 * right up until `Claude Code Meetup Zurich`, `Hyderabad House` (a restaurant
 * in Washington) or an online event titled for its audience rather than its
 * venue. A title is marketing copy. `LOCATION` and `GEO` are data.
 *
 * ── THE SIGNALS, IN ORDER OF TRUST ───────────────────────────────────────
 *
 * 1. AN EXPLICIT COUNTRY. `LOCATION` ends `…, Karnataka, India`. This is the
 *    only signal that is conclusive on its own, and it is present on all 317
 *    events in the live feed.
 *
 * 2. COORDINATES. `GEO` is present on 301/317. A bounding box is NOT
 *    conclusive by itself — the box around India also contains Pakistan,
 *    Nepal, Bangladesh, Sri Lanka, Bhutan and part of Tibet — so it confirms
 *    and never decides. It is worth having because it is the signal that
 *    catches a mislabelled country.
 *
 * 3. AN INDIAN STATE OR A KNOWN CITY. `Karnataka`, `Bengaluru`, `Gurugram`.
 *    Good corroboration, weak alone: `Hyderabad` is also in Pakistan and
 *    `Delhi` is also in Ontario, which is exactly why a name alone does not
 *    reach the publish threshold.
 *
 * 4. THE TIMEZONE. `Asia/Kolkata` is India and nowhere else. Rarely present
 *    in a feed, decisive when it is.
 *
 * ── WHAT HAPPENS WHEN WE ARE NOT SURE ────────────────────────────────────
 *
 * Nothing is published. §21 says an event that cannot be confidently placed is
 * neither published nor dropped — it is kept, with a reason, for a human. That
 * is `review`, and the confidence score is stored alongside it so the decision
 * can be re-examined rather than re-guessed.
 */

/**
 * The score at or above which an event may be published automatically.
 *
 * 80 is set so that an explicit country (100) or a timezone (95) passes alone,
 * a city name corroborated by coordinates (85) passes, and a bare city name
 * (55) does not. Changing this number changes what goes public without review,
 * so it is a constant with a comment rather than a literal in a condition.
 */
import { distanceKm } from '@/lib/geo';

export const INDIA_PUBLISH_THRESHOLD = 80;

/**
 * A generous box around the Indian landmass, including the island territories.
 *
 * Deliberately NOT `src/lib/geo.ts`'s `EXTENT`. That one is a drawing frame,
 * cropped tight to the fourteen plotted cities for visual reasons, and its own
 * comment says so — using it here would reject Srinagar and Port Blair for
 * being outside a map's margins. Two different questions, two constants.
 */
export const INDIA_BBOX = {
  minLat: 6.0,
  maxLat: 37.6,
  minLon: 67.5,
  maxLon: 97.5,
} as const;

export function withinIndiaBox(lat: number, lon: number): boolean {
  return (
    lat >= INDIA_BBOX.minLat &&
    lat <= INDIA_BBOX.maxLat &&
    lon >= INDIA_BBOX.minLon &&
    lon <= INDIA_BBOX.maxLon
  );
}

/** Spellings of the country that a feed might use. Lower-case. */
const INDIA_NAMES = new Set(['india', 'republic of india', 'bharat', 'in', 'ind']);

/**
 * States and union territories, for corroboration.
 *
 * The real feed puts one of these before the country on every Indian address
 * (`Koramangala, Bengaluru, Karnataka, India`), so this is the signal that
 * still works if the country is ever dropped.
 */
const INDIAN_STATES = new Set([
  'andhra pradesh', 'arunachal pradesh', 'assam', 'bihar', 'chhattisgarh', 'goa', 'gujarat',
  'haryana', 'himachal pradesh', 'jharkhand', 'karnataka', 'kerala', 'madhya pradesh',
  'maharashtra', 'manipur', 'meghalaya', 'mizoram', 'nagaland', 'odisha', 'orissa', 'punjab',
  'rajasthan', 'sikkim', 'tamil nadu', 'telangana', 'tripura', 'uttar pradesh', 'uttarakhand',
  'west bengal', 'andaman and nicobar islands', 'chandigarh', 'dadra and nagar haveli',
  'daman and diu', 'delhi', 'nct of delhi', 'jammu and kashmir', 'ladakh', 'lakshadweep',
  'puducherry', 'pondicherry',
]);

/**
 * Indian cities, with the aliases a feed actually writes.
 *
 * The value is the canonical name, so `bangalore` resolves to `Bengaluru` and
 * the atlas lookup gets one spelling to match against. This list is the
 * fourteen curated cities plus the metros and tech hubs a Claude event is
 * plausibly held in — it does not need to be a gazetteer, because failing to
 * recognise a city sends an event to `review`, which is the safe outcome.
 */
const INDIAN_CITIES = new Map<string, string>([
  ['bhopal', 'Bhopal'],
  ['delhi', 'Delhi'], ['new delhi', 'Delhi'], ['dilli', 'Delhi'],
  ['mumbai', 'Mumbai'], ['bombay', 'Mumbai'], ['navi mumbai', 'Mumbai'], ['thane', 'Mumbai'],
  ['bengaluru', 'Bengaluru'], ['bangalore', 'Bengaluru'], ['bangalore urban', 'Bengaluru'],
  ['hyderabad', 'Hyderabad'], ['secunderabad', 'Hyderabad'],
  ['chennai', 'Chennai'], ['madras', 'Chennai'],
  ['kolkata', 'Kolkata'], ['calcutta', 'Kolkata'],
  ['pune', 'Pune'], ['poona', 'Pune'],
  ['ahmedabad', 'Ahmedabad'], ['amdavad', 'Ahmedabad'], ['gandhinagar', 'Ahmedabad'],
  ['jaipur', 'Jaipur'],
  ['indore', 'Indore'],
  ['chandigarh', 'Chandigarh'], ['mohali', 'Chandigarh'], ['panchkula', 'Chandigarh'],
  ['guwahati', 'Guwahati'],
  ['kochi', 'Kochi'], ['cochin', 'Kochi'], ['ernakulam', 'Kochi'],
  // Not in the atlas, but real places Indian events happen. Recognising them
  // makes the country call confident; the atlas lookup then decides separately
  // whether there is a city page to attach the event to.
  ['gurugram', 'Gurugram'], ['gurgaon', 'Gurugram'],
  ['noida', 'Noida'], ['greater noida', 'Noida'],
  ['coimbatore', 'Coimbatore'], ['visakhapatnam', 'Visakhapatnam'], ['vizag', 'Visakhapatnam'],
  ['bhubaneswar', 'Bhubaneswar'], ['nagpur', 'Nagpur'], ['lucknow', 'Lucknow'],
  ['kanpur', 'Kanpur'], ['surat', 'Surat'], ['vadodara', 'Vadodara'], ['baroda', 'Vadodara'],
  ['nashik', 'Nashik'], ['rajkot', 'Rajkot'], ['patna', 'Patna'], ['ranchi', 'Ranchi'],
  ['raipur', 'Raipur'], ['dehradun', 'Dehradun'], ['mysuru', 'Mysuru'], ['mysore', 'Mysuru'],
  ['thiruvananthapuram', 'Thiruvananthapuram'], ['trivandrum', 'Thiruvananthapuram'],
  ['madurai', 'Madurai'], ['varanasi', 'Varanasi'], ['amritsar', 'Amritsar'],
  ['goa', 'Goa'], ['panaji', 'Goa'], ['udaipur', 'Udaipur'], ['jodhpur', 'Jodhpur'],
  ['srinagar', 'Srinagar'], ['shillong', 'Shillong'], ['manipal', 'Manipal'],
  ['vellore', 'Vellore'], ['warangal', 'Warangal'], ['tiruchirappalli', 'Tiruchirappalli'],
  // Both spellings resolve to the canonical one, so a text match and a
  // coordinate match cannot name the same city two different ways.
  ['puducherry', 'Puducherry'], ['pondicherry', 'Puducherry'],
]);

/**
 * Countries whose presence rules India out.
 *
 * Only needed to stop a corroborating signal from winning on its own — an
 * event in `Hyderabad House, Washington, United States` must not be scored up
 * by the word `Hyderabad`. Everything not named here and not India simply
 * fails to reach the threshold, so the list does not have to be exhaustive to
 * be safe; it exists to make the common confusions explicit and rejected
 * rather than merely unconfident.
 */
const FOREIGN_MARKERS = new Set([
  'united states', 'usa', 'us', 'u.s.a.', 'canada', 'united kingdom', 'uk', 'england',
  'scotland', 'ireland', 'germany', 'france', 'spain', 'italy', 'netherlands', 'belgium',
  'switzerland', 'austria', 'sweden', 'norway', 'denmark', 'finland', 'poland', 'portugal',
  'czechia', 'czech republic', 'greece', 'turkey', 'israel', 'united arab emirates', 'uae',
  'saudi arabia', 'qatar', 'kuwait', 'bahrain', 'oman', 'egypt', 'nigeria', 'kenya',
  'south africa', 'ghana', 'morocco', 'brazil', 'argentina', 'chile', 'colombia', 'mexico',
  'peru', 'australia', 'new zealand', 'japan', 'south korea', 'korea', 'china', 'taiwan',
  'hong kong', 'singapore', 'malaysia', 'indonesia', 'thailand', 'vietnam', 'philippines',
  'pakistan', 'bangladesh', 'sri lanka', 'nepal', 'bhutan', 'myanmar', 'maldives',
  'afghanistan', 'russia', 'ukraine', 'romania', 'hungary', 'bulgaria', 'serbia', 'croatia',
]);

/**
 * Real coordinates for the cities above, and the reason this file has any.
 *
 * ── THE FALSE NEGATIVE THIS FIXES ────────────────────────────────────────
 *
 * A bounding box is a weak signal because the box around India also contains
 * six other countries, so it could never be worth enough to publish on. That
 * left a hole, and the live feed walked straight into it: eleven real Indian
 * events — including three in BHOPAL, this community's own city — publish their
 * address as a Luma URL rather than a street (`LOCATION:
 * https://luma.com/event/evt-…`) because the venue is only released to
 * registrants. Those events have no country, no state and no city name
 * anywhere in their text. All they have is `GEO`.
 *
 * Scored on the box alone they sat at 45 and went to review, which for the
 * most active chapter on the calendar is not a conservative default, it is a
 * broken directory.
 *
 * ── WHY PROXIMITY IS CONCLUSIVE WHERE A BOX IS NOT ───────────────────────
 *
 * "Inside a rectangle containing Karachi, Kathmandu and Colombo" is a weak
 * claim. "Within 75 km of the centre of Bhopal" is a strong one — no
 * non-Indian city is within 75 km of any of these points, because the nearest
 * foreign city to any of them is hundreds of kilometres away. So proximity
 * decides where the box only corroborates.
 *
 * It also does a second job: it names the city for an event whose text never
 * did, which is what lets a URL-only Luma event still land on a city page.
 *
 * The fourteen curated entries are copied from `src/data/cities.ts` so the two
 * agree by construction. `distanceKm` is reused from `src/lib/geo.ts` rather
 * than reimplemented here.
 */
const INDIAN_CITY_POINTS: ReadonlyArray<{ name: string; lat: number; lon: number }> = [
  // The atlas fourteen, values copied from `src/data/cities.ts`.
  { name: 'Bhopal', lat: 23.2599, lon: 77.4126 },
  { name: 'Delhi', lat: 28.6139, lon: 77.209 },
  { name: 'Mumbai', lat: 19.076, lon: 72.8777 },
  { name: 'Bengaluru', lat: 12.9716, lon: 77.5946 },
  { name: 'Hyderabad', lat: 17.385, lon: 78.4867 },
  { name: 'Chennai', lat: 13.0827, lon: 80.2707 },
  { name: 'Kolkata', lat: 22.5726, lon: 88.3639 },
  { name: 'Pune', lat: 18.5204, lon: 73.8567 },
  { name: 'Ahmedabad', lat: 23.0225, lon: 72.5714 },
  { name: 'Jaipur', lat: 26.9124, lon: 75.7873 },
  { name: 'Indore', lat: 22.7196, lon: 75.8577 },
  { name: 'Chandigarh', lat: 30.7333, lon: 76.7794 },
  { name: 'Guwahati', lat: 26.1445, lon: 91.7362 },
  { name: 'Kochi', lat: 9.9312, lon: 76.2673 },
  // Off-atlas, but real places Indian events happen. Recognising the country
  // is this list's job; whether there is a city page to attach to is decided
  // separately, against the `cities` table.
  { name: 'Gurugram', lat: 28.4595, lon: 77.0266 },
  { name: 'Noida', lat: 28.5355, lon: 77.391 },
  { name: 'Coimbatore', lat: 11.0168, lon: 76.9558 },
  { name: 'Visakhapatnam', lat: 17.6868, lon: 83.2185 },
  { name: 'Bhubaneswar', lat: 20.2961, lon: 85.8245 },
  { name: 'Nagpur', lat: 21.1458, lon: 79.0882 },
  { name: 'Lucknow', lat: 26.8467, lon: 80.9462 },
  { name: 'Kanpur', lat: 26.4499, lon: 80.3319 },
  { name: 'Surat', lat: 21.1702, lon: 72.8311 },
  { name: 'Vadodara', lat: 22.3072, lon: 73.1812 },
  { name: 'Nashik', lat: 19.9975, lon: 73.7898 },
  { name: 'Rajkot', lat: 22.3039, lon: 70.8022 },
  { name: 'Patna', lat: 25.5941, lon: 85.1376 },
  { name: 'Ranchi', lat: 23.3441, lon: 85.3096 },
  { name: 'Raipur', lat: 21.2514, lon: 81.6296 },
  { name: 'Dehradun', lat: 30.3165, lon: 78.0322 },
  { name: 'Mysuru', lat: 12.2958, lon: 76.6394 },
  { name: 'Thiruvananthapuram', lat: 8.5241, lon: 76.9366 },
  { name: 'Madurai', lat: 9.9252, lon: 78.1198 },
  { name: 'Varanasi', lat: 25.3176, lon: 82.9739 },
  { name: 'Amritsar', lat: 31.634, lon: 74.8723 },
  { name: 'Goa', lat: 15.4909, lon: 73.8278 },
  { name: 'Udaipur', lat: 24.5854, lon: 73.7125 },
  { name: 'Jodhpur', lat: 26.2389, lon: 73.0243 },
  { name: 'Puducherry', lat: 11.9416, lon: 79.8083 },
  { name: 'Shillong', lat: 25.5788, lon: 91.8933 },
  { name: 'Manipal', lat: 13.3525, lon: 74.7868 },
  { name: 'Vellore', lat: 12.9165, lon: 79.1325 },
  { name: 'Warangal', lat: 17.9689, lon: 79.5941 },
  { name: 'Tiruchirappalli', lat: 10.7905, lon: 78.7047 },
  { name: 'Srinagar', lat: 34.0837, lon: 74.7973 },
];

/**
 * How near a known Indian city centre counts as being in that city.
 *
 * 75 km covers a metropolitan region — a venue in Whitefield is 20 km from
 * central Bengaluru, one in Greater Noida 30 km from Delhi — while staying far
 * short of any international border crossing. Widening it much past this
 * starts to reach toward Nepal from Patna, so it is a constant with a comment.
 */
export const CITY_PROXIMITY_KM = 75;

/** The closest known Indian city to a point, if any is close enough. */
export function nearestIndianCity(
  lat: number,
  lon: number,
): { name: string; km: number } | undefined {
  let best: { name: string; km: number } | undefined;
  for (const city of INDIAN_CITY_POINTS) {
    const km = distanceKm({ lat, lon }, { lat: city.lat, lon: city.lon });
    if (km <= CITY_PROXIMITY_KM && (!best || km < best.km)) best = { name: city.name, km };
  }
  return best;
}

export type IndiaVerdict =
  /** Confidently in India. May be promoted. */
  | { inIndia: true; confidence: number; city?: string; signals: string[] }
  /** Not confident. `reason` is a fixed code, never text from the feed. */
  | { inIndia: false; confidence: number; reason: IndiaRejection; city?: string; signals: string[] };

export type IndiaRejection =
  /** A country other than India was named. */
  | 'foreign-country'
  /** Coordinates fall outside the Indian box. */
  | 'foreign-coordinates'
  /** Some Indian-looking signal, but not enough to publish unreviewed. */
  | 'low-confidence'
  /** Nothing locational at all — typically an online event. */
  | 'no-location-signal';

export interface LocationInput {
  /** `LOCATION`, or any single-line address. */
  location?: string | null;
  /** A separately-known country, if the source provides one. */
  country?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  /** An IANA zone, if the source names one. */
  timezone?: string | null;
}

/** Address components, lower-cased. Handles both `,` and newline separators. */
function parts(value: string): string[] {
  return value
    .split(/[,\n|/]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Score an event's location.
 *
 * Additive scoring with a cap, so two weak signals can corroborate into
 * confidence but no single weak signal ever reaches the threshold alone.
 */
export function classifyIndia(input: LocationInput): IndiaVerdict {
  const signals: string[] = [];
  const haystack = [input.location, input.country].filter(Boolean).join(', ');
  const segments = haystack ? parts(haystack) : [];

  const hasCoords =
    typeof input.latitude === 'number' &&
    typeof input.longitude === 'number' &&
    Number.isFinite(input.latitude) &&
    Number.isFinite(input.longitude);

  // ── The conclusive negatives, checked first ───────────────────────────
  //
  // A named foreign country ends it. Checked before the positives so that
  // `Hyderabad House, Washington, United States` cannot be talked into India
  // by its first word.
  const foreign = segments.find((segment) => FOREIGN_MARKERS.has(segment));
  if (foreign && !segments.some((segment) => INDIA_NAMES.has(segment))) {
    return { inIndia: false, confidence: 0, reason: 'foreign-country', signals: ['foreign-country'] };
  }

  if (hasCoords && !withinIndiaBox(input.latitude as number, input.longitude as number)) {
    return {
      inIndia: false,
      confidence: 0,
      reason: 'foreign-coordinates',
      signals: ['coordinates-outside-india'],
    };
  }

  if (segments.length === 0 && !hasCoords && !input.timezone) {
    return { inIndia: false, confidence: 0, reason: 'no-location-signal', signals: [] };
  }

  // ── The positives ─────────────────────────────────────────────────────
  let score = 0;

  if (segments.some((segment) => INDIA_NAMES.has(segment))) {
    score += 100;
    signals.push('country-india');
  }

  const zone = input.timezone?.trim().toLowerCase();
  if (zone === 'asia/kolkata' || zone === 'asia/calcutta') {
    score += 95;
    signals.push('timezone-india');
  }

  if (segments.some((segment) => INDIAN_STATES.has(segment))) {
    score += 40;
    signals.push('indian-state');
  }

  // Match a city name against whole address components, so `Delhi` matches but
  // `New Delhi Restaurant, Chicago` does not become a location claim on the
  // strength of a business name.
  let city: string | undefined;
  for (const segment of segments) {
    const canonical = INDIAN_CITIES.get(segment);
    if (canonical) {
      city = canonical;
      score += 35;
      signals.push('indian-city');
      break;
    }
  }

  if (hasCoords) {
    /**
     * Proximity to a known Indian city centre is conclusive; the box alone is
     * not. See `INDIAN_CITY_POINTS` for why that distinction has to exist —
     * eleven real Indian events, three of them in Bhopal, publish no address
     * at all and reach us with nothing but these coordinates.
     */
    const near = nearestIndianCity(input.latitude as number, input.longitude as number);
    if (near) {
      score += 100;
      signals.push('coordinates-near-indian-city');
      // Only name the city from coordinates if the text did not already. Text
      // is the source's own statement and outranks our nearest-centre guess.
      city ??= near.name;
    } else {
      // Inside the box but not near anywhere we know. Corroboration only:
      // this is also what a venue in Kathmandu or Karachi looks like.
      score += 45;
      signals.push('coordinates-in-india-box');
    }
  }

  const confidence = Math.min(100, score);

  if (confidence >= INDIA_PUBLISH_THRESHOLD) {
    return { inIndia: true, confidence, city, signals };
  }

  return {
    inIndia: false,
    confidence,
    reason: confidence > 0 ? 'low-confidence' : 'no-location-signal',
    city,
    signals,
  };
}

/**
 * The city name to match against the atlas, from a classified address.
 *
 * Returns the canonical spelling (`Bengaluru`, not `Bangalore`) so the caller
 * compares one form against `cities.name`. Resolution to an actual city row is
 * the sync's job, not this file's — nothing here touches the database.
 */
export function canonicalCityName(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  for (const segment of parts(value)) {
    const canonical = INDIAN_CITIES.get(segment);
    if (canonical) return canonical;
  }
  return undefined;
}
