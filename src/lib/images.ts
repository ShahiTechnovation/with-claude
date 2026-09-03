import type { ImageMetadata } from 'astro';

/**
 * Image registry.
 *
 * Data files reference images by a path relative to `src/assets` (a plain
 * string), so the data layer stays free of build-tool imports and can be
 * unit-tested. This module resolves those strings to real `ImageMetadata`
 * that `<Image>` can optimise.
 */
const modules = import.meta.glob<{ default: ImageMetadata }>(
  '/src/assets/**/*.{jpg,jpeg,png,webp,avif}',
  { eager: true },
);

const registry = new Map<string, ImageMetadata>(
  Object.entries(modules).map(([path, mod]) => [path.replace('/src/assets/', ''), mod.default]),
);

/** Resolve a data-layer image key. Returns undefined for a missing asset. */
export function asset(key: string | undefined): ImageMetadata | undefined {
  if (!key) return undefined;
  return registry.get(key);
}

/**
 * Resolve, or throw. Use where a missing image is a build error rather than a
 * gracefully-empty slot.
 */
export function requireAsset(key: string): ImageMetadata {
  const found = registry.get(key);
  if (!found) {
    throw new Error(
      `Unknown image "${key}". Expected a file at src/assets/${key}. Known: ${[...registry.keys()].join(', ')}`,
    );
  }
  return found;
}
