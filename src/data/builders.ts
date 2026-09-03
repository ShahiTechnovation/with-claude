import type { Builder } from './types';

/**
 * The builder record.
 *
 * Only people whose involvement is publicly documented by the community.
 * Do not add anyone here without their agreement, and never invent a bio,
 * a photo or a social link. An honest short entry beats a padded one.
 *
 * TODO: collect bios, portraits and links from these two, then open
 * submissions so builders can add themselves.
 */
export const builders: Builder[] = [
  {
    id: 'bld-aniket-sahu',
    slug: 'aniket-sahu',
    name: 'Aniket Sahu',
    citySlug: 'bhopal',
    role: 'Workshop lead',
    eventSlugs: ['claude-code-workshop'],
  },
  {
    id: 'bld-vishal-kumar',
    slug: 'vishal-kumar',
    name: 'Vishal Kumar',
    citySlug: 'bhopal',
    role: 'Workshop lead',
    eventSlugs: ['claude-code-workshop'],
  },
];
