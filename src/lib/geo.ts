/**
 * Coordinates for the site's map of India.
 *
 * The boundary decision (DataMeet's outline, which follows the Survey of India boundary)
 * and its CC BY 2.5 IN credit are recorded in src/components/CityAtlas.astro and pinned by
 * tests/india-map.test.ts. projectIndia() places a city on that map; project() is the
 * older city-only frame, kept for the data checks.
 */

/**
 * The plotted extent. Tight to the cities rather than to the whole landmass —
 * a survey sheet is cropped to its subject, and the slack margins that a full
 * 6°N–37°N frame leaves read as an empty plate rather than as air.
 */
export const EXTENT = {
  minLon: 68,
  maxLon: 95.5,
  minLat: 7,
  maxLat: 34.5,
} as const;

/** The drawing frame every projected point lands in. */
const PLATE = { width: 720, height: 800, pad: 34 } as const;

/**
 * Longitude degrees shrink as you move away from the equator. Correcting by
 * the cosine of the mid-latitude keeps India from looking stretched sideways.
 */
const MID_LAT_RAD = (((EXTENT.minLat + EXTENT.maxLat) / 2) * Math.PI) / 180;
const LON_SCALE = Math.cos(MID_LAT_RAD);

export interface Point {
  x: number;
  y: number;
}

const spanLon = (EXTENT.maxLon - EXTENT.minLon) * LON_SCALE;
const spanLat = EXTENT.maxLat - EXTENT.minLat;

/** Uniform scale so the plate keeps its true proportions, then centred. */
const inner = {
  width: PLATE.width - PLATE.pad * 2,
  height: PLATE.height - PLATE.pad * 2,
};
const SCALE = Math.min(inner.width / spanLon, inner.height / spanLat);
const OFFSET_X = PLATE.pad + (inner.width - spanLon * SCALE) / 2;
const OFFSET_Y = PLATE.pad + (inner.height - spanLat * SCALE) / 2;

/** Project real coordinates into the plate's viewBox space. */
export function project(lat: number, lon: number): Point {
  return {
    x: OFFSET_X + (lon - EXTENT.minLon) * LON_SCALE * SCALE,
    y: OFFSET_Y + (EXTENT.maxLat - lat) * SCALE,
  };
}

/** `23.26° N, 77.41° E` — the coordinate stamp used all over the site. */
export function formatCoords(lat: number, lon: number, precision = 2): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(precision)}° ${ns}, ${Math.abs(lon).toFixed(precision)}° ${ew}`;
}

/** Great-circle distance in kilometres. */
export function distanceKm(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(to.lat - from.lat);
  const dLon = toRad(to.lon - from.lon);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

/*
 * The India map's frame (src/data/india-map.ts, built by scripts/map/build.sh): Lambert
 * conformal conic on WGS84, standard parallels 12N and 28N, origin 22N 80E (Snyder 1987,
 * eq. 15-1 to 15-10), then x = (E + 1268500) / 2925, y = (1754300 - N) / 2925.
 */
const WGS84_A = 6378137;
const WGS84_E = Math.sqrt((1 / 298.257223563) * (2 - 1 / 298.257223563));
const RAD = Math.PI / 180;
const lccM = (p: number) => Math.cos(p) / Math.sqrt(1 - (WGS84_E * Math.sin(p)) ** 2);
const lccT = (p: number) =>
  Math.tan(Math.PI / 4 - p / 2) /
  ((1 - WGS84_E * Math.sin(p)) / (1 + WGS84_E * Math.sin(p))) ** (WGS84_E / 2);
const LCC_N = Math.log(lccM(12 * RAD) / lccM(28 * RAD)) / Math.log(lccT(12 * RAD) / lccT(28 * RAD));
const LCC_F = lccM(12 * RAD) / (LCC_N * lccT(12 * RAD) ** LCC_N);
const lccRho = (p: number) => WGS84_A * LCC_F * lccT(p) ** LCC_N;
const LCC_RHO0 = lccRho(22 * RAD);

/** Place a latitude and longitude in INDIA_MAP's viewBox (0 0 1040 1176). */
export function projectIndia(lat: number, lon: number): Point {
  const r = lccRho(lat * RAD);
  const th = LCC_N * (lon * RAD - 80 * RAD);
  const E = r * Math.sin(th);
  const N = LCC_RHO0 - r * Math.cos(th);
  return { x: (E + 1268500) / 2925, y: (1754300 - N) / 2925 };
}
