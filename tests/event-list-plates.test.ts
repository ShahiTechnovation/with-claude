/**
 * THE /events/ LIST THUMBNAILS. A row's tile is the event's cover, else its event-kit plate at
 * src/assets/plates/<slug>.jpg (eventPlate()); with neither, the row drops its tile
 * (EventRecord's `no-plate`) and shows up bare on /events/ and its city page, as the October
 * 2026 events, Delhi (5 Sep) and Indore (15 Aug) once did.
 *
 * It checks every public event in src/data/events.ts. Rows that exist only in the database (the
 * Luma feed) are not covered here.
 */
import { expect, it } from 'vitest';
import { events } from '../src/data/events';
import { isPublic } from '../src/data/selectors';
import { eventPlate } from '../src/lib/event-plate';

it('gives every public event a thumbnail: its cover or its plate', () => {
  const bare = events.filter((e) => isPublic(e) && !eventPlate(e)).map((e) => e.slug);
  expect(bare).toEqual([]);
});
