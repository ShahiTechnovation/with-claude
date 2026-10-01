/**
 * PUBLIC BUILDER READS for the homepage — bounded, discoverable profiles only.
 *
 * "Discoverable" is stricter than "public": a profile set to `unlisted` is
 * reachable by its URL but is never promoted, so it never appears here.
 */
import { and, count, eq, isNull, or, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../../../db/schema';
import { builderImage } from '../directory';
import { publicProjectWhere } from '../projects/lifecycle';

type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface PublicBuilderCard {
  slug: string;
  name: string;
  role: string;
  city: { slug: string; name: string };
  image?: string;
}

const discoverable = () =>
  and(
    eq(schema.builders.status, 'published'),
    eq(schema.builders.moderationState, 'clean'),
    isNull(schema.builders.deletedAt),
    or(isNull(schema.memberProfiles.visibility), eq(schema.memberProfiles.visibility, 'public')),
  );

/**
 * A handful of real builders: featured first, then fuller profiles (portrait,
 * bio), then the most recently updated. Ordering never invents activity.
 */
export async function featuredPublicBuilders(db: AnyDatabase, limit = 6): Promise<PublicBuilderCard[]> {
  const rows = await db
    .select({
      slug: schema.builders.slug,
      name: schema.builders.name,
      role: schema.builders.role,
      imagePath: schema.builders.imagePath,
      mediaUrl: schema.media.blobUrl,
      mediaStatus: schema.media.status,
      citySlug: schema.cities.slug,
      cityName: schema.cities.name,
    })
    .from(schema.builders)
    .innerJoin(schema.cities, eq(schema.cities.id, schema.builders.cityId))
    .leftJoin(schema.memberProfiles, eq(schema.memberProfiles.memberId, schema.builders.ownerMemberId))
    .leftJoin(schema.media, eq(schema.media.id, schema.builders.imageId))
    .where(discoverable())
    .orderBy(
      sql`${schema.builders.featured} DESC`,
      sql`(${schema.media.status} = 'published' OR ${schema.builders.imagePath} IS NOT NULL) DESC`,
      sql`(${schema.builders.bio} IS NOT NULL) DESC`,
      sql`${schema.builders.updatedAt} DESC NULLS LAST`,
      schema.builders.name,
    )
    .limit(limit);

  return rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    role: r.role,
    city: { slug: r.citySlug, name: r.cityName },
    image: builderImage(r.imagePath, r.mediaUrl ? { status: r.mediaStatus ?? '', blobUrl: r.mediaUrl } : null),
  }));
}

/** Real counts for the community strip. Each is a COUNT over public rows. */
export async function communityCounts(db: AnyDatabase): Promise<{
  builders: number;
  projects: number;
  events: number;
  cities: number;
}> {
  const [[b], [p], [e], [c]] = await Promise.all([
    db
      .select({ n: count() })
      .from(schema.builders)
      .leftJoin(schema.memberProfiles, eq(schema.memberProfiles.memberId, schema.builders.ownerMemberId))
      .where(discoverable()),
    db.select({ n: count() }).from(schema.projects).where(publicProjectWhere()),
    db
      .select({ n: count() })
      .from(schema.events)
      .where(and(eq(schema.events.status, 'published'), isNull(schema.events.canceledAt))),
    db
      .select({ n: sql<number>`count(distinct ${schema.events.cityId})`.mapWith(Number) })
      .from(schema.events)
      .where(and(eq(schema.events.status, 'published'), isNull(schema.events.canceledAt))),
  ]);
  return { builders: b.n, projects: p.n, events: e.n, cities: c.n };
}
