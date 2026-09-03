import type { Builder } from './types';

/**
 * The builder index.
 *
 * This is an OPEN index: anyone building with Claude in India can submit an
 * entry, and being in it confers nothing. It is deliberately not the same
 * thing as the Ambassador record — a builder here is a builder, not an
 * organiser, not a representative, and not appointed by anybody.
 *
 * Two rules:
 *
 *  · Every entry starts at `status: 'pending'` and is moved to `published` by
 *    a human. Nothing self-publishes.
 *  · The `ambassador` role is not honoured from this file. The UI reads it
 *    from `ambassadors.ts`, so writing it here achieves nothing — which is the
 *    point.
 *
 * Only people whose involvement the community has actually published are
 * listed. Never invent a bio, a portrait or a link; a short honest entry beats
 * a padded one.
 *
 * TODO: collect bios, portraits and links from these two, then open
 * submissions properly.
 */
export const builders: Builder[] = [
  {
    id: 'bld-aniket-sahu',
    slug: 'aniket-sahu',
    status: 'published',
    name: 'Aniket Sahu',
    citySlug: 'bhopal',
    role: 'Hosts the Bhopal community',
    roles: ['ambassador', 'host', 'speaker'],
    eventSlugs: ['claude-code-workshop'],
  },
  {
    id: 'bld-vishal-kumar',
    slug: 'vishal-kumar',
    status: 'published',
    name: 'Vishal Kumar',
    citySlug: 'bhopal',
    role: 'Workshop lead',
    roles: ['speaker'],
    eventSlugs: ['claude-code-workshop'],
  },
];
