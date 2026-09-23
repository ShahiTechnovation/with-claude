import type { APIRoute } from 'astro';
import { eq, and, isNull, or, exists } from 'drizzle-orm';
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

    // 2. Builders: status = 'published' AND moderationState = 'clean'
    //    AND (no member profile linked, OR profile visibility = 'public')
    const builders = await db
      .select({ slug: schema.builders.slug, updatedAt: schema.builders.updatedAt })
      .from(schema.builders)
      .leftJoin(schema.memberProfiles, eq(schema.builders.ownerMemberId, schema.memberProfiles.memberId))
      .where(
        and(
          eq(schema.builders.status, 'published'),
          eq(schema.builders.moderationState, 'clean'),
          or(
            isNull(schema.memberProfiles.visibility),
            eq(schema.memberProfiles.visibility, 'public')
          )
        )
      );

    // 3. Events: status = 'published'
    const events = await db
      .select({ slug: schema.events.slug, updatedAt: schema.events.updatedAt })
      .from(schema.events)
      .where(eq(schema.events.status, 'published'));

    // 4. Ambassadors: status = 'published'
    //    The pages for /ambassadors/[slug] are generated from publicAmbassadors,
    //    which only includes status='published'. A sitemap entry for a draft
    //    ambassador would hand crawlers a 404.
    const ambassadors = await db
      .select({ slug: schema.ambassadors.slug, updatedAt: schema.ambassadors.updatedAt })
      .from(schema.ambassadors)
      .where(eq(schema.ambassadors.status, 'published'));

    // 5. Cities: status = 'published' AND has at least one published+clean
    //    builder OR published project in that city.
    //
    // NOTE: We intentionally query the DB here rather than calling
    // indexableCityPaths() from src/lib/indexable.ts. That helper reads the
    // build-time snapshot via readFileSync(.astro/dataset.json), which does not
    // exist in the serverless runtime — only at build time. Calling it from an
    // SSR route unconditionally throws in production, which was the root cause
    // of the sitemap 500.
    const cities = await db
      .selectDistinct({ slug: schema.cities.slug })
      .from(schema.cities)
      .where(
        and(
          eq(schema.cities.status, 'published'),
          or(
            exists(
              db
                .select({ one: schema.builders.id })
                .from(schema.builders)
                .where(
                  and(
                    eq(schema.builders.cityId, schema.cities.id),
                    eq(schema.builders.status, 'published'),
                    eq(schema.builders.moderationState, 'clean')
                  )
                )
            ),
            exists(
              db
                .select({ one: schema.projects.id })
                .from(schema.projects)
                .where(
                  and(
                    eq(schema.projects.cityId, schema.cities.id),
                    eq(schema.projects.publicationStatus, 'published'),
                    eq(schema.projects.moderationState, 'clean')
                  )
                )
            )
          )
        )
      );

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
        'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=86400',
      },
    });
  } catch (error) {
    // Log the actual error server-side so it appears in Vercel function logs.
    // The 500 body is deliberately terse — do not reflect internal state.
    console.error('[sitemap] Failed to generate sitemap:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
};
