import type { APIRoute } from 'astro';
import { eq, and, isNull, or, sql } from 'drizzle-orm';
import { publicProjectWhere } from '@/server/projects/lifecycle';
import { resolvableEvents } from '@/server/public/pages';
import { pooledDb } from '../../db/pool';
import * as schema from '../../db/schema';

export const prerender = false;

const ORIGIN = 'https://www.withclaude.in';

function escapeXml(unsafe: string) {
  return unsafe.replace(/[<>&'"]/g, function (c) {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case "'": return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

/**
 * Returns a safe ISO-8601 string, or undefined if the value is not a valid
 * Date. Guards against null/undefined updatedAt columns, and against
 * serialised dates that survived JSON round-trips as strings.
 */
function safeLastmod(v: Date | string | null | undefined): string | undefined {
  if (!v) return undefined;
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

/**
 * Returns undefined when the slug is missing/empty — those rows must be
 * silently dropped from the sitemap rather than generating a malformed URL
 * like `https://www.withclaude.in/builders//`.
 */
function builderUrl(slug: string | null | undefined): string | undefined {
  if (!slug?.trim()) return undefined;
  return `${ORIGIN}/builders/${slug}/`;
}
function projectUrl(slug: string | null | undefined): string | undefined {
  if (!slug?.trim()) return undefined;
  return `${ORIGIN}/projects/${slug}/`;
}
function eventUrl(slug: string | null | undefined): string | undefined {
  if (!slug?.trim()) return undefined;
  return `${ORIGIN}/events/${slug}/`;
}
function ambassadorUrl(slug: string | null | undefined): string | undefined {
  if (!slug?.trim()) return undefined;
  return `${ORIGIN}/ambassadors/${slug}/`;
}
function cityUrl(slug: string | null | undefined): string | undefined {
  if (!slug?.trim()) return undefined;
  return `${ORIGIN}/cities/${slug}/`;
}

export const GET: APIRoute = async () => {
  try {
    const db = pooledDb();

    // 1. Projects — the canonical predicate, shared with every public list.
    const projects = await db
      .select({ slug: schema.projects.slug, updatedAt: schema.projects.updatedAt })
      .from(schema.projects)
      .where(publicProjectWhere());

    // 2. Builders: public (published + clean + not deleted) AND not unlisted.
    //    Unlisted is direct-link only, so it is never offered to a crawler.
    const builders = await db
      .select({ slug: schema.builders.slug, updatedAt: schema.builders.updatedAt })
      .from(schema.builders)
      .leftJoin(schema.memberProfiles, eq(schema.builders.ownerMemberId, schema.memberProfiles.memberId))
      .where(
        and(
          eq(schema.builders.status, 'published'),
          eq(schema.builders.moderationState, 'clean'),
          isNull(schema.builders.deletedAt),
          or(
            isNull(schema.memberProfiles.visibility),
            eq(schema.memberProfiles.visibility, 'public')
          )
        )
      );

    // 3. Events — asked of the same reader `/events/[slug]` resolves through,
    //    so the sitemap cannot advertise a URL the route will refuse. See
    //    `resolvableEvents()` for why this is a shared reader and not a
    //    predicate copied into the query above.
    const events = await resolvableEvents(db);

    // 4. Ambassadors: status = 'published'
    const ambassadors = await db
      .select({ slug: schema.ambassadors.slug, updatedAt: schema.ambassadors.updatedAt })
      .from(schema.ambassadors)
      .where(eq(schema.ambassadors.status, 'published'));

    /**
     * 5. Cities — published, AND at least one public signal of the five the
     * city page itself uses (`isCityIndexable()` in src/lib/indexable.ts):
     * an ambassador, an event, a builder, a project or a story.
     *
     * This used to check builders and projects only, so a city with a real
     * published event or a verified ambassador — and nothing else yet — was
     * indexable on its own page and missing from the sitemap.
     */
    const cities = await db
      .selectDistinct({ slug: schema.cities.slug })
      .from(schema.cities)
      .where(
        and(
          eq(schema.cities.status, 'published'),
          sql`(
            exists (select 1 from ambassadors a where a.city_id = ${schema.cities.id} and a.status = 'published')
            or exists (select 1 from events e where e.city_id = ${schema.cities.id} and e.status = 'published')
            or exists (select 1 from builders b where b.city_id = ${schema.cities.id}
                         and b.status = 'published' and b.moderation_state = 'clean' and b.deleted_at is null)
            or exists (select 1 from projects p where p.city_id = ${schema.cities.id}
                         and p.publication_status = 'published' and p.moderation_state = 'clean'
                         and p.deleted_at is null)
            or exists (select 1 from stories s where s.city_id = ${schema.cities.id} and s.status = 'published')
          )`
        )
      );

    const staticPaths = [
      '/',
      '/builders/',
      '/projects/',
      '/events/',
      '/gallery/',
      '/cities/',
      '/ambassadors/',
      '/record/'
    ];

    const urls: { url: string; lastmod?: string }[] = [
      ...staticPaths.map((path) => ({ url: `${ORIGIN}${path}` })),

      // Cities — only those with public activity (mirrors isCityIndexable logic)
      ...cities.flatMap((c) => {
        const u = cityUrl(c.slug);
        return u ? [{ url: u }] : [];
      }),

      // Builders
      ...builders.flatMap((b) => {
        const u = builderUrl(b.slug);
        const lastmod = safeLastmod(b.updatedAt);
        return u ? [{ url: u, lastmod }] : [];
      }),

      // Projects
      ...projects.flatMap((p) => {
        const u = projectUrl(p.slug);
        const lastmod = safeLastmod(p.updatedAt);
        return u ? [{ url: u, lastmod }] : [];
      }),

      // Events
      ...events.flatMap((e) => {
        const u = eventUrl(e.slug);
        const lastmod = safeLastmod(e.updatedAt);
        return u ? [{ url: u, lastmod }] : [];
      }),

      // Ambassadors
      ...ambassadors.flatMap((a) => {
        const u = ambassadorUrl(a.slug);
        const lastmod = safeLastmod(a.updatedAt);
        return u ? [{ url: u, lastmod }] : [];
      }),
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
        'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=300',
      },
    });
  } catch (error) {
    // Log the actual error server-side so it appears in Vercel function logs.
    // The 500 body is deliberately terse — do not reflect internal state.
    console.error('[sitemap] Failed to generate sitemap:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
};
