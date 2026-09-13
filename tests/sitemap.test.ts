import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import * as schema from '../db/schema';

let db: TestDatabase;
vi.mock('../db/pool', () => ({
  pooledDb: () => db
}));

import { GET } from '../src/pages/sitemap.xml';

describe('dynamic sitemap', () => {
  beforeAll(async () => {
    db = await createTestDatabase();
    
    // Seed some test data
    const cityId = '00000000-0000-0000-0000-000000000001';
    await db.insert(schema.cities).values({
      id: cityId,
      slug: 'test-city',
      name: 'Test City',
      region: 'Test Region',
      lat: 0,
      lon: 0,
      blurb: 'A test city',
      status: 'published'
    });

    // Public builder
    await db.insert(schema.builders).values({
      id: '00000000-0000-0000-0000-000000000002',
      slug: 'public-builder',
      name: 'Public Builder',
      cityId,
      role: 'Builder',
      status: 'published',
      moderationState: 'clean'
    });

    // Private builder (draft)
    await db.insert(schema.builders).values({
      id: '00000000-0000-0000-0000-000000000003',
      slug: 'private-builder',
      name: 'Private Builder',
      cityId,
      role: 'Builder',
      status: 'draft',
      moderationState: 'clean'
    });

    // Archived builder
    await db.insert(schema.builders).values({
      id: '00000000-0000-0000-0000-000000000004',
      slug: 'archived-builder',
      name: 'Archived Builder',
      cityId,
      role: 'Builder',
      status: 'archived',
      moderationState: 'clean'
    });
    
    // Restricted builder
    await db.insert(schema.builders).values({
      id: '00000000-0000-0000-0000-000000000005',
      slug: 'restricted-builder',
      name: 'Restricted Builder',
      cityId,
      role: 'Builder',
      status: 'published',
      moderationState: 'restricted'
    });

    /**
     * §40, §63 — ambassadors belong in the sitemap, under the same visibility
     * predicate the pages use.
     *
     * The draft one is the point of the pair. `/ambassadors/[slug]` is
     * generated from `publicAmbassadors`, so a draft record has no page; a
     * sitemap that listed it would be handing a crawler a 404 and spending
     * somebody's crawl budget on it.
     */
    await db.insert(schema.ambassadors).values([
      {
        id: '00000000-0000-0000-0000-000000000006',
        slug: 'published-ambassador',
        name: 'Published Ambassador',
        cityId,
        verifiedVia: 'Confirmed for the test',
        status: 'published'
      },
      {
        id: '00000000-0000-0000-0000-000000000007',
        slug: 'draft-ambassador',
        name: 'Draft Ambassador',
        cityId,
        verifiedVia: 'Confirmed for the test',
        status: 'draft'
      }
    ]);
  });

  afterAll(async () => {
    await db?.$close();
  });

  it('generates a valid XML sitemap', async () => {
    const response = await GET({} as any);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/xml');
    
    const xml = await response.text();
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    
    // Includes static routes
    expect(xml).toContain('<loc>https://www.withclaude.in/</loc>');
    expect(xml).toContain('<loc>https://www.withclaude.in/builders/</loc>');
    
    // Includes public dynamic route
    expect(xml).toContain('<loc>https://www.withclaude.in/builders/public-builder/</loc>');
    
    // Excludes private/archived/restricted routes
    expect(xml).not.toContain('private-builder');
    expect(xml).not.toContain('archived-builder');
    expect(xml).not.toContain('restricted-builder');
  });

  it('lists public ambassadors and excludes unpublished ones', async () => {
    const xml = await (await GET({} as any)).text();

    expect(xml).toContain('<loc>https://www.withclaude.in/ambassadors/</loc>');
    expect(xml).toContain('<loc>https://www.withclaude.in/ambassadors/published-ambassador/</loc>');
    expect(xml).not.toContain('draft-ambassador');
  });

  it('never advertises a private or API route', async () => {
    // §40's exclusions, asserted on the output rather than trusted to the
    // route list staying short.
    const xml = await (await GET({} as any)).text();
    expect(xml).not.toMatch(/withclaude\.in\/me\//);
    expect(xml).not.toMatch(/withclaude\.in\/api\//);
    expect(xml).not.toContain('/admin');
  });
});
