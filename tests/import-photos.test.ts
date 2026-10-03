/**
 * `npm run db:import:photos`: the gallery photos into a database that already
 * holds the events, without the full import's rewrite of everything else.
 *
 * The database starts as production stands: every event, none of the record's
 * photos, and edits made since in the database that a full import would undo.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import { importEventPhotos, importRecords, repositoryRecords } from '../db/import';
import * as schema from '../db/schema';
import { events } from '../src/data/events';
import { projects } from '../src/data/projects';

let db: TestDatabase;

const withPhotos = events.filter((event) => (event.photos ?? []).length > 0);
const photoCount = withPhotos.reduce((n, event) => n + event.photos!.length, 0);
const EDITED_PROJECT = projects[0]!.slug;
const EDITED_EVENT = withPhotos[0]!.slug;

interface PhotoRow {
  slug: string;
  path: string;
  alt: string;
  position: number;
  media_id: string;
}

async function photoRows(): Promise<PhotoRow[]> {
  const result = await db.execute(sql`
    select e.slug, m.path, m.alt, p.position, p.media_id
    from event_photos p
    join events e on e.id = p.event_id
    join media m on m.id = p.media_id
    order by e.slug, p.position`);
  return result.rows as unknown as PhotoRow[];
}

async function count(query: ReturnType<typeof sql>): Promise<number> {
  const result = await db.execute(query);
  return (result.rows as { n: number }[])[0]!.n;
}

beforeAll(async () => {
  db = await createTestDatabase();
  await importRecords(db, {
    ...repositoryRecords,
    events: events.map((event) => ({ ...event, photos: [] })),
  });
  await db
    .update(schema.projects)
    .set({ url: 'https://edited.example/' })
    .where(eq(schema.projects.slug, EDITED_PROJECT));
  await db
    .update(schema.events)
    .set({ title: 'Edited in the admin' })
    .where(eq(schema.events.slug, EDITED_EVENT));
}, 120_000);

afterAll(async () => {
  await db?.$close();
});

describe('the photos-only import', () => {
  it('starts from a database with the events and none of their photos', async () => {
    expect(withPhotos.length).toBeGreaterThan(0);
    expect(await photoRows()).toHaveLength(0);
  });

  it('reports every event and photo on a dry run, and writes nothing', async () => {
    const summary = await importEventPhotos(db, events, { dryRun: true });
    expect(summary.events.map((event) => event.slug).sort()).toEqual(
      withPhotos.map((event) => event.slug).sort(),
    );
    expect(summary.events.flatMap((event) => event.photos)).toHaveLength(photoCount);
    expect(summary.skipped).toEqual([]);
    expect(await photoRows()).toHaveLength(0);
    expect(await count(sql`select count(*)::int as n from media`)).toBe(0);
  });

  it("writes every photo with its alt text, in the record's order", async () => {
    await importEventPhotos(db);
    const rows = await photoRows();
    expect(rows).toHaveLength(photoCount);
    for (const event of withPhotos) {
      const mine = rows.filter((row) => row.slug === event.slug);
      expect(mine.map((row) => row.path), event.slug).toEqual(event.photos!.map((p) => p.src));
      expect(mine.map((row) => row.alt), event.slug).toEqual(event.photos!.map((p) => p.alt));
    }
  });

  it('leaves what was edited in the database as it was', async () => {
    const [project] = await db
      .select({ url: schema.projects.url })
      .from(schema.projects)
      .where(eq(schema.projects.slug, EDITED_PROJECT));
    expect(project!.url).toBe('https://edited.example/');
    const [event] = await db
      .select({ title: schema.events.title })
      .from(schema.events)
      .where(eq(schema.events.slug, EDITED_EVENT));
    expect(event!.title).toBe('Edited in the admin');
  });

  it('leaves identical rows when it runs again', async () => {
    const before = await photoRows();
    await importEventPhotos(db);
    expect(await photoRows()).toEqual(before);
  });

  it('skips an event the database does not have, and creates nothing for it', async () => {
    const ghost = {
      ...withPhotos[0]!,
      slug: 'not-in-the-database',
      photos: [{ src: 'events/ghost.jpg', alt: 'A room that was never held' }],
    };
    const summary = await importEventPhotos(db, [...events, ghost]);
    expect(summary.skipped).toEqual(['not-in-the-database']);
    expect(await count(sql`select count(*)::int as n from media where path = 'events/ghost.jpg'`)).toBe(0);
    expect(
      await count(sql`select count(*)::int as n from events where slug = 'not-in-the-database'`),
    ).toBe(0);
    expect(await photoRows()).toHaveLength(photoCount);
  });
});
