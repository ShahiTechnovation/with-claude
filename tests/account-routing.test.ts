import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(path, 'utf8');

describe('account routing', () => {
  const guardedRoutes = [
    ['src/pages/me/index.astro', '/me/'],
    ['src/pages/me/profile/index.astro', '/me/profile/'],
    ['src/pages/me/profile/edit.astro', '/me/profile/edit/'],
    ['src/pages/me/projects/index.astro', '/me/projects/'],
    ['src/pages/me/projects/new.astro', '/me/projects/new/'],
    ['src/pages/me/settings.astro', '/me/settings/'],
  ] as const;

  it.each(guardedRoutes)('%s is server-side protected and falls back to AuthRequired', (file) => {
    const page = source(file);
    expect(page).not.toContain('/join');
    // Must contain the guardPage call
    expect(page).toContain('const guard = await guardPage(Astro)');
    // Must render AuthRequired on failure, passing the guard reason so each
    // failure mode shows the correct UI. No bare <AuthRequired /> — the reason
    // is always forwarded so a misconfigured server doesn't show "Sign in".
    expect(page).toContain('<AuthRequired reason={guard.reason} />');
  });

  it('sends the account menu to the actual profile, projects, and settings pages', () => {
    const menu = source('src/components/react/PrivyRoot.tsx');
    expect(menu).toContain('href="/me/profile/"');
    expect(menu).toContain('href="/me/projects/"');
    expect(menu).toContain('href="/me/settings/"');
  });

  it('does not use /join as an account-guard fallback', () => {
    const guard = source('src/server/http/page-guard.ts');
    // Guard must not redirect to /join — it renders AuthRequired in-place instead.
    expect(guard).not.toContain("redirect('/join");
    expect(guard).not.toContain('redirect("/join');
    // The old collapsed reason is gone; new named reasons exist.
    expect(guard).not.toContain("reason: 'authentication-required'");
    expect(guard).toContain("reason: 'unauthenticated'");
    expect(guard).toContain("reason: 'server-not-configured'");
  });

  it('server-not-configured is a distinct reason from unauthenticated', () => {
    const guard = source('src/server/http/page-guard.ts');
    // Both must appear in the switch so they are never conflated.
    expect(guard).toContain("'server-not-configured'");
    expect(guard).toContain("'unauthenticated'");
    // The old collapsed catch-all must not be returned.
    // We check for the return statement pattern, not any occurrence in comments.
    expect(guard).not.toContain("reason: 'authentication-required'");
  });

  it('no longer relies on client-side AccountArea rendering', () => {
    const root = source('src/components/react/PrivyRoot.tsx');
    expect(root).not.toContain('function AccountArea()');
    expect(root).not.toContain('data-page');
  });

  it('restores the exact safe /me destination using the AuthRequired target', () => {
    const root = source('src/components/react/PrivyRoot.tsx');
    expect(root).toContain("document.getElementById('join-cta-root')");
    expect(root).toContain("target?.dataset.next");
    expect(root).toContain("window.location.assign(");
  });

  it('/join is a compatibility redirect rather than an onboarding page', () => {
    expect(source('src/pages/join.astro')).toContain("Astro.redirect('/', 308)");
  });

  it('AuthRequired receives a reason prop from every guarded page', () => {
    // Every /me/* page must pass the guard reason to AuthRequired.
    // A bare <AuthRequired /> (no reason) would fall back to 'unauthenticated'
    // which would show a sign-in CTA for a misconfigured server — the regression.
    for (const [file] of guardedRoutes) {
      const page = source(file);
      expect(page).toContain('reason={guard.reason}');
    }
  });

  it('bootstrap failure distinguishes server-unavailable from auth-error', () => {
    const root = source('src/components/react/PrivyRoot.tsx');
    // The 503 path must show a service-unavailable message, not "signed you in" error.
    expect(root).toContain("'server-unavailable'");
    expect(root).toContain("'auth-error'");
    expect(root).toContain('server-unavailable');
  });
});
