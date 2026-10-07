/**
 * ROUTING: the sign-in return address and the deployment rules.
 *
 * Split out of `homepage-routing.test.ts`; the assertions are unchanged except /join, which now
 * redirects to /me/.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// LF regardless of how the checkout was made (core.autocrlf on Windows).
const source = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

describe('signing in returns to the page that asked', () => {
  /**
   * The project page sends a signed-out visitor to `/me/projects/claim/?project=…`.
   * The gate's return address was the bare pathname, so after signing in the
   * claim page no longer knew which project it was for.
   */
  it('keeps the claim page query through sign-in', () => {
    expect(source('src/pages/projects/[slug].astro')).toContain(
      '/me/projects/claim/?project=${project.slug}',
    );
    expect(source('src/pages/me/projects/claim.astro')).toContain(
      '<AuthRequired reason={guard.reason} next={Astro.url.pathname + Astro.url.search} />',
    );
  });

  it('defaults every other gate to the server pathname, never a client-supplied URL', () => {
    expect(source('src/components/AuthRequired.astro')).toContain(
      'next = Astro.url.pathname } = Astro.props',
    );
  });
});

describe('deployment routing', () => {
  it('has no rewrites or redirects that could capture a public route', () => {
    const vercel = JSON.parse(source('vercel.json')) as Record<string, unknown>;
    expect(vercel.trailingSlash).toBe(true);
    // The only redirect allowed is scoped to the Project Directory's own host
    // (projects.withclaude.in → www for non-directory paths). Nothing may
    // apply to www.withclaude.in or the apex, and there are no rewrites.
    const redirects = (vercel.redirects ?? []) as { has?: { type: string; value: string }[] }[];
    for (const r of redirects) {
      expect(r.has).toEqual([{ type: 'host', value: 'projects.withclaude.in' }]);
    }
    expect(redirects.length).toBeLessThanOrEqual(1);
    expect(vercel.rewrites).toBeUndefined();
    expect(vercel.routes).toBeUndefined();
    expect(source('astro.config.mjs')).not.toMatch(/\bredirects\s*:/);
  });

  it('keeps the legacy paths as their documented redirects, none to the homepage directory', () => {
    expect(source('src/pages/submit.astro')).toContain("Astro.redirect('/me/projects/new/', 308)");
    expect(source('src/pages/city.astro')).toContain("Astro.redirect('/me/profile/edit/', 308)");
    expect(source('src/pages/join.astro')).toContain("Astro.redirect('/me/', 308)");
  });

  it('links content straight to the targets, not through the legacy redirects', () => {
    for (const file of [
      'src/components/CityIndex.astro',
      'src/components/Participation.astro',
      'src/components/SubmitPanel.astro',
      'src/pages/events/[slug].astro',
    ]) {
      expect(source(file), file).not.toMatch(/['"]\/(city|submit)\/['"]/);
    }
  });
});
