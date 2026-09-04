import type { Guide } from './types';

/**
 * GUIDES — practical writing by people who did the thing.
 *
 * Empty, and it stays empty until a real contributor writes one. A guide is
 * commissioned by a question somebody actually asked, never by a keyword: if
 * the honest reason for a page is that people search for the phrase, that is
 * the reason not to write it.
 *
 * Every entry needs an author with a credential and a `modified` date the
 * moment the body changes. Both are rendered and both go into the JSON-LD, so
 * a stale guide is visibly stale rather than quietly wrong.
 *
 * TODO: the two questions the community actually asks in the room — "what do
 * I bring to a build day and what will I get out of it", and "how do I get
 * from a Claude Code prototype to something I can show" — are both worth a
 * guide, and both have someone in Bhopal who can write them first-hand.
 */
export const guides: Guide[] = [];
