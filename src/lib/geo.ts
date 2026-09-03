/**
 * The plate.
 *
 * The map on this site is not a traced outline of India — it is a coordinate
 * field. Cities are plotted from their real latitude and longitude onto a
 * graticule, the way a survey sheet does it. That is a deliberate choice:
 *
 *  1. It is honest. Every dot is where the city actually is.
 *  2. It sidesteps depicting national boundaries, which is a regulated matter
 *     in India and not something a community site should get wrong.
 *  3. It looks like a cartographic artifact rather than a Google Maps clone.
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
export const PLATE = { width: 720, height: 800, pad: 34 } as const;

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
export const SCALE = Math.min(inner.width / spanLon, inner.height / spanLat);
const OFFSET_X = PLATE.pad + (inner.width - spanLon * SCALE) / 2;
const OFFSET_Y = PLATE.pad + (inner.height - spanLat * SCALE) / 2;

/** Project real coordinates into the plate's viewBox space. */
export function project(lat: number, lon: number): Point {
  return {
    x: OFFSET_X + (lon - EXTENT.minLon) * LON_SCALE * SCALE,
    y: OFFSET_Y + (EXTENT.maxLat - lat) * SCALE,
  };
}

/** Graticule positions at whole-degree intervals, for the grid and its ticks. */
export function graticule(stepDeg = 5) {
  const meridians: { lon: number; x: number }[] = [];
  const parallels: { lat: number; y: number }[] = [];

  const firstLon = Math.ceil(EXTENT.minLon / stepDeg) * stepDeg;
  for (let lon = firstLon; lon <= EXTENT.maxLon; lon += stepDeg) {
    meridians.push({ lon, x: project(0, lon).x });
  }

  const firstLat = Math.ceil(EXTENT.minLat / stepDeg) * stepDeg;
  for (let lat = firstLat; lat <= EXTENT.maxLat; lat += stepDeg) {
    parallels.push({ lat, y: project(lat, 0).y });
  }

  return { meridians, parallels };
}

/** `23.26° N, 77.41° E` — the coordinate stamp used all over the site. */
export function formatCoords(lat: number, lon: number, precision = 2): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(precision)}° ${ns}, ${Math.abs(lon).toFixed(precision)}° ${ew}`;
}

/**
 * A gently bowed connector between two plotted points. A straight line reads as
 * a network diagram; an arc reads as a drawn thread, which is the brand device.
 */
export function threadPath(from: Point, to: Point, bow = 0.16): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const mx = from.x + dx / 2;
  const my = from.y + dy / 2;
  // Push the control point perpendicular to the run.
  const cx = mx - dy * bow;
  const cy = my + dx * bow;
  return `M${from.x.toFixed(1)} ${from.y.toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
}

/**
 * Great-circle distance in kilometres. Used to tell each open city how far it
 * is from the first chapter — a real number that varies, in place of thirteen
 * identical "no chapter yet" labels.
 */
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

/**
 * A scale bar for the plate, in real kilometres.
 *
 * One degree of latitude is 110.574 km everywhere, so the vertical scale is
 * exact — which is why the bar is measured against latitude rather than the
 * cosine-corrected longitude axis.
 */
const KM_PER_DEG_LAT = 110.574;

export function scaleBar(targetKm = 500): { km: number; width: number } {
  const unitsPerKm = SCALE / KM_PER_DEG_LAT;
  // Snap to a round number a reader can actually use.
  const steps = [100, 200, 250, 500, 1000];
  const km = steps.reduce((best, step) =>
    Math.abs(step - targetKm) < Math.abs(best - targetKm) ? step : best,
  );
  return { km, width: km * unitsPerKm };
}

/**
 * The compass rose sits at true north because the projection has no rotation:
 * meridians are vertical by construction. Exported as a constant so the map
 * cannot drift from the claim its furniture makes.
 */
export const NORTH_IS_UP = true;
