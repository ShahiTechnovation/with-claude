/**
 * PROJECT MOTIF — the shared visual language behind both placeholder boxes
 * (`ProjectCover.astro`, the screenshot-sized plate, and `ProjectLogo.astro`,
 * the square mark). Neither renders a photo or a logo that was not actually
 * supplied; this module only decides what abstract, honestly-a-placeholder
 * shape stands in for it.
 *
 * Two independent inputs drive the result, and both are facts the project
 * already has — nothing is invented or fetched:
 *
 *   category   one of the eight `project_category` enum values. Each gets its
 *              own small shape grammar (a motif), so every "research" project
 *              reads as research and every "agent" project reads as agent,
 *              at a glance, before any text is read.
 *   title/slug a stable hash of the project's own text, which drives hue and
 *              the motif's internal arrangement (rotation, offset, node
 *              positions) so two projects in the same category are clearly
 *              kin but not identical.
 *
 * The hash and hue logic here are the same ones `ProjectCover.astro` used
 * before this module existed — pulled out so the cover and the logo box
 * derive the same "look" for a given project instead of rolling their own.
 */

export const MOTIF_CATEGORIES = [
  'product',
  'agent',
  'developer-tool',
  'research',
  'creative',
  'campus',
  'experiment',
  'startup',
] as const;

export type MotifCategory = (typeof MOTIF_CATEGORIES)[number];

/** A stable small hash, so the same text always drives the same look. */
export function stableHash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic float in [0, 1) derived from a hash and a salt, for a second
 * independent variable (e.g. rotation) without correlating with hue. */
function fraction(hash: number, salt: number): number {
  return ((hash ^ Math.imul(salt, 2654435761)) >>> 0) / 4294967296;
}

// Each category keeps to its own hue band (still inside the site's warm
// clay/ochre/olive palette), so colour alone hints at category even before
// the motif shape is read.
const HUE_BANDS: Record<MotifCategory, [number, number]> = {
  product: [18, 34],
  agent: [200, 220],
  'developer-tool': [250, 268],
  research: [150, 168],
  creative: [330, 350],
  campus: [40, 56],
  experiment: [95, 112],
  startup: [4, 16],
};

export interface ProjectMotif {
  category: MotifCategory;
  hue: number;
  /** 0–1, independent of hue; use to vary rotation/offset/scale. */
  spin: number;
  /** 0–1, independent of hue and spin; use for a second placement axis. */
  drift: number;
}

const isMotifCategory = (c: string | undefined | null): c is MotifCategory =>
  Boolean(c) && (MOTIF_CATEGORIES as readonly string[]).includes(c as string);

/**
 * Resolve the deterministic look for a placeholder. `seed` is the project's
 * title (cover) or slug (logo) — any stable per-project text works; the two
 * boxes use different seeds on purpose so a project's cover and logo motifs
 * are related (same category, same hue band) without being the same roll.
 */
export function resolveMotif(seed: string, category: string | null | undefined): ProjectMotif {
  const cat: MotifCategory = isMotifCategory(category) ? category : 'experiment';
  const h = stableHash(seed);
  const [from, to] = HUE_BANDS[cat];
  const span = to - from;
  return {
    category: cat,
    hue: from + (h % (span * 10)) / 10,
    spin: fraction(h, 1),
    drift: fraction(h, 2),
  };
}
