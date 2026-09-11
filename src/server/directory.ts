import { eq, and } from 'drizzle-orm';
import { pooledDb } from '../../db/pool';
import * as dbSchema from '../../db/schema';

export async function getBuilderRow(slug: string) {
  const db = pooledDb();
  const [row] = await db.select().from(dbSchema.builders).where(eq(dbSchema.builders.slug, slug));
  return row;
}

export async function getProjectData(slug: string) {
  const db = pooledDb();
  
  const [projectRow] = await db
    .select()
    .from(dbSchema.projects)
    .where(eq(dbSchema.projects.slug, slug));
    
  if (!projectRow) return null;

  const builderRows = await db
    .select({ builderId: dbSchema.projectBuilders.builderId })
    .from(dbSchema.projectBuilders)
    .where(eq(dbSchema.projectBuilders.projectId, projectRow.id));

  const builderSlugs = [];
  for (const row of builderRows) {
    const [b] = await db.select({ slug: dbSchema.builders.slug }).from(dbSchema.builders).where(eq(dbSchema.builders.id, row.builderId));
    if (b) builderSlugs.push(b.slug);
  }

  const citySlug = projectRow.cityId 
    ? (await db.select({slug: dbSchema.cities.slug}).from(dbSchema.cities).where(eq(dbSchema.cities.id, projectRow.cityId)))[0]?.slug 
    : '';

  return { projectRow, builderSlugs, citySlug };
}

export async function getPublicProjects() {
  const db = pooledDb();
  const projectRows = await db
    .select()
    .from(dbSchema.projects)
    .where(and(eq(dbSchema.projects.publicationStatus, 'published'), eq(dbSchema.projects.moderationState, 'clean')))
    .orderBy(dbSchema.projects.position);

  const allBuilderRows = await db.select({ projectId: dbSchema.projectBuilders.projectId, builderId: dbSchema.projectBuilders.builderId }).from(dbSchema.projectBuilders);
  const allBuilders = await db.select({ id: dbSchema.builders.id, slug: dbSchema.builders.slug }).from(dbSchema.builders);
  const allCities = await db.select({ id: dbSchema.cities.id, slug: dbSchema.cities.slug }).from(dbSchema.cities);

  return { projectRows, allBuilderRows, allBuilders, allCities };
}
