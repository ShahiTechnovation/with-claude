import type { ImageMetadata } from 'astro';
import { asset } from './images';

/**
 * The square image that stands for an event: its own cover, else the event-kit plate generated for it
 * (src/assets/plates/<slug>.jpg). The same order the event page's share image uses.
 *
 * Not in event-display.ts: images.ts uses import.meta.glob, and event-display.ts is imported by
 * src/server/events/sync.ts, which scripts/dev/ingest-sample-feed.ts runs under tsx.
 */
export function eventPlate(event: {
  slug: string;
  coverImage?: string | null;
}): ImageMetadata | undefined {
  return asset(event.coverImage ?? undefined) ?? asset(`plates/${event.slug}.jpg`);
}
