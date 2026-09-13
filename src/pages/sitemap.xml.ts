import type { APIRoute } from 'astro';
import { eq, and, inArray } from 'drizzle-orm';
import { pooledDb } from '../../db/pool';
import * as schema from '../../db/schema';
import { indexableCityPaths } from '@/lib/indexable';

export const prerender = false;

const ORIGIN = 'https://www.withclaude.in';

function escapeXml(unsafe: string) {
  return unsafe.replace(/[<>&'"]/g, function (c) {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

export const GET: APIRoute = async () => {
  try {
    const db = pooledDb();

    // 1. Projects: publicationStatus = 'published' AND moderationState = 'clean'
    const projects = await db
      .select({ slug: schema.projects.slug, updatedAt: schema.projects.updatedAt })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.publicationStatus, 'published'),
          eq(schema.projects.moderationState, 'clean')
        )
      );

    // 2. Builders: status = 'published' AND moderationState IN ('clean', 'reported')
    const builders = await db
      .select({ slug: schema.builders.slug, updatedAt: schema.builders.updatedAt })
      .from(schema.builders)
      .where(
        and(
          eq(schema.builders.status, 'published'),
          inArray(schema.builders.moderationState, ['clean', 'reported'])
        )
      );

    // 3. Events: status = 'published'
    const events = await db
      .select({ slug: schema.events.slug, updatedAt: schema.events.updatedAt })
      .from(schema.events)
      .where(eq(schema.events.status, 'published'));

    /**
     * 4. Ambassadors — §40.
     *
     * The same visibility predicate the pages use: `/ambassadors/[slug]` is
     * generated from `publicAmbassadors`, which is `status IN ('published',
     * 'featured')`, and `published` is the only one of those an ambassador row
     * can hold. A sitemap that advertised a draft ambassador would be offering
     * a crawler a 404, and §40 asks specifically for the same predicate rather
     * than a second one that happens to agree today.
     */
    const ambassadors = await db
      .select({ slug: schema.ambassadors.slug, updatedAt: schema.ambassadors.updatedAt })
      .from(schema.ambassadors)
      .where(eq(schema.ambassadors.status, 'published'));

    // 5. Cities (using existing indexability logic which checks if they have public activity)
    const cityPaths = indexableCityPaths();

    const staticPaths = [
      '/',
      '/builders/',
      '/projects/',
      '/events/',
      '/cities/',
      '/ambassadors/',
      '/record/'
    ];

    const urls: { url: string; lastmod?: string }[] = [
      ...staticPaths.map((path) => ({ url: `${ORIGIN}${path}` })),
      ...cityPaths.map((path) => ({ url: `${ORIGIN}${path}/` })),
      ...builders.map((b) => ({
        url: `${ORIGIN}/builders/${b.slug}/`,
        lastmod: b.updatedAt?.toISOString()
      })),
      ...projects.map((p) => ({
        url: `${ORIGIN}/projects/${p.slug}/`,
        lastmod: p.updatedAt?.toISOString()
      })),
      ...events.map((e) => ({
        url: `${ORIGIN}/events/${e.slug}/`,
        lastmod: e.updatedAt?.toISOString()
      })),
      ...ambassadors.map((a) => ({
        url: `${ORIGIN}/ambassadors/${a.slug}/`,
        lastmod: a.updatedAt?.toISOString()
      }))
    ];

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (item) => `  <url>
    <loc>${escapeXml(item.url)}</loc>${
      item.lastmod ? `\n    <lastmod>${escapeXml(item.lastmod)}</lastmod>` : ''
    }
  </url>`
  )
  .join('\n')}
</urlset>`;

    return new Response(xml, {
      status: 200,
      headers: {
        'Content-Type': 'application/xml',
        'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=86400',
      },
    });
  } catch (error) {
    console.error('Failed to generate sitemap:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
};
