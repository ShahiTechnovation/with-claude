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

  /**
   * A `/me/*` RESPONSE IS NEVER PUBLICLY CACHEABLE — INCLUDING THE GATE.
   *
   * Every one of these pages called `privateHeaders()` inside its own
   * `if (guard.ok)` branch, so an authenticated response was correctly
   * `private, no-store` while every unauthenticated one came back
   * `public, max-age=0, must-revalidate`. That was observed on production.
   *
   * It is the wrong way round for a URL whose body depends on who is asking:
   * `/me/profile` returns a sign-in gate to one visitor and a person's name,
   * city and email preference to the next, and a shared cache is not obliged
   * to tell them apart.
   *
   * The fix is structural — `guardPage()` sets the headers itself, on every
   * outcome, so no page can forget and the next account page inherits it. This
   * asserts the guarantee lives there rather than in seven copies.
   */
  it('sets private, no-store headers from the guard rather than per page', () => {
    const guard = source('src/server/http/page-guard.ts');

    // Called unconditionally, before any branch on the outcome.
    const body = guard.slice(guard.indexOf('export async function guardPage'));
    const callIndex = body.indexOf('privateHeaders(astro)');
    const firstBranch = body.indexOf('if (!identity.ok)');
    expect(callIndex, 'guardPage does not call privateHeaders').toBeGreaterThan(-1);
    expect(
      callIndex,
      'privateHeaders must run before the guard branches, so failures get it too',
    ).toBeLessThan(firstBranch);

    expect(guard).toContain("'Cache-Control', 'private, no-store'");
    expect(guard).toContain("'X-Robots-Tag', 'noindex, nofollow'");
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

  it('bootstrap failure distinguishes server configuration from a rejected session', () => {
    const root = source('src/components/react/PrivyRoot.tsx');
    // A 503 is the deployment's fault and must never read as a sign-in error;
    // a 401 is a session the server could not verify; a 403 is an account
    // that may not act. Each is its own state with its own message.
    expect(root).toContain("if (status === 503) return 'not-configured'");
    expect(root).toContain("if (status === 401) return 'session-rejected'");
    expect(root).toContain("if (status === 403) return 'account-unavailable'");
    const context = source('src/components/react/account-context.tsx');
    expect(context).toContain("case 'not-configured':");
    expect(context).toContain('Nothing is wrong with your account');
  });

  it('breaks the sign-in redirect loop instead of reloading forever', () => {
    const root = source('src/components/react/PrivyRoot.tsx');
    // Signed in client-side, still unauthorised server-side: redirect at most
    // once per guard window, then explain and offer retry / sign out.
    expect(root).toContain('RETURN_GUARD_MS');
    expect(root).toContain("describeAccountProblem('session-not-visible')");
    // And an account page the server could NOT authorise never trusts the
    // sessionStorage cache in place of a fresh bootstrap.
    expect(root).toContain("const serverNeedsProof = Boolean(document.getElementById('join-cta-root'))");
  });
});

/**
 * THE PROFILE SAVE REGRESSION.
 *
 * Production symptom: clicking "Save changes" on `/me/profile/edit` always
 * showed "Network error while saving.", for every account, every time. Root
 * cause: `ProfileEditor` (and `ProjectEditor`, and the now-deleted
 * `SignOutButton`) are mounted with `client:only="react"` — their own React
 * root, not a descendant of `PrivyRoot`'s one `<PrivyProvider>`. `usePrivy()`
 * there returns the SDK's DEFAULT context value, whose `getAccessToken` is
 * `() => { throw Error("You need to wrap your application with the
 * <PrivyProvider>…") }`. That throw was caught by `ProfileEditor`'s own
 * try/catch and reported as a generic network failure — no request was ever
 * sent.
 *
 * These assertions read source rather than mounting React (this repo has no
 * DOM test environment — see `vitest.config.ts`), which is the same approach
 * already used for every other guard-contract test in this file. What they
 * lock in is that the FIX stays in place: `getAccessToken()` is never called
 * unguarded again, and the two structural mismatches uncovered alongside it
 * — a missing `citySlug` resolution and a free-text field validated as a
 * closed enum — do not silently return.
 */
describe('the profile save regression', () => {
  it('renders the editors beneath the one provider, not as separate islands', () => {
    for (const file of [
      'src/components/react/ProfileEditor.tsx',
      'src/components/react/ProjectEditor.tsx',
    ]) {
      const code = source(file).replace(/\/\*[\s\S]*?\*\//g, '');
      // The account context comes from PrivyRoot's provider, so the request
      // helper and the session state are real — never a default context.
      expect(code, `${file} must use the provider-backed account API`).toContain('useAccount()');
      expect(code, `${file} must not reach for Privy directly`).not.toContain('usePrivy');
      expect(code, `${file} must not call getAccessToken() itself`).not.toContain('getAccessToken(');
    }
    // No account page mounts an editor as its own React root any more.
    for (const page of [
      'src/pages/me/profile/edit.astro',
      'src/pages/me/projects/new.astro',
      'src/pages/me/projects/[id]/edit.astro',
    ]) {
      const text = source(page);
      expect(text, `${page} mounts a separate island`).not.toContain('client:only');
      expect(text).toContain('<AccountIsland');
    }
    const root = source('src/components/react/PrivyRoot.tsx');
    expect(root).toContain("'profile-editor': lazy(() => import('./ProfileEditor'))");
    expect(root).toContain("'project-editor': lazy(() => import('./ProjectEditor'))");
  });

  it('accountFetch swallows a missing-provider throw rather than surfacing it as a network error', () => {
    const code = source('src/lib/account-fetch.ts');
    expect(code).toContain('export async function accountFetch');
    // The try/catch around getAccessToken() must not rethrow or return early —
    // it has to fall through to the fetch, relying on the cookie instead.
    const body = code.slice(code.indexOf('export async function accountFetch'));
    const tryIndex = body.indexOf('try {');
    const catchIndex = body.indexOf('} catch');
    const fetchIndex = body.indexOf('return fetch(');
    expect(tryIndex).toBeGreaterThan(-1);
    expect(catchIndex).toBeGreaterThan(tryIndex);
    expect(fetchIndex).toBeGreaterThan(catchIndex);
  });

  it('resolves citySlug server-side before handing the profile to the editor', () => {
    /**
     * The second bug: `edit.astro` used to pass `guard.profile` (a
     * `ProfileRow`, which has `cityId`, not `citySlug`) straight into
     * `ProfileEditor`, whose state initializer read a `citySlug` field that
     * never existed on that object. The dropdown opened blank regardless of
     * the member's real city, and saving without re-selecting it sent
     * `citySlug: ''` — which the server correctly reads as "clear the
     * city" — silently wiping a real city on an unrelated save.
     */
    const page = source('src/pages/me/profile/edit.astro');
    expect(page).toContain('citySlugFor(guard.profile.cityId, guard.db)');
    // Passed into the `profile` object literal as the shorthand `citySlug,`
    // — not the JSX attribute form, since it is a key inside that object
    // rather than a top-level prop of `<ProfileEditor>`.
    expect(page).toMatch(/profile: \{[^}]*\bcitySlug,/);
    // Must not pass the raw row straight through — that is the exact
    // mismatch this test exists to catch.
    expect(page).not.toContain('profile={guard.profile}');
  });

  it('"What you do" is validated against the same list on both sides', () => {
    /**
     * The third bug: the field was a free-text `<input>` on the client while
     * `profilePatchSchema` validated it against a closed enum server-side.
     * Every profile starts with `primaryRole: null`, the form defaulted
     * that to `''`, and `''` is not a member of the enum — so the very
     * first save from any new member failed validation, every time.
     */
    const editor = source('src/components/react/ProfileEditor.tsx');
    const server = source('src/server/members/profile.ts');
    expect(editor).toContain("import { SELECTABLE_ROLES } from '@/lib/roles'");
    // The regression, exactly: a free-text input bound to this field.
    expect(editor).not.toContain('<input value={form.primaryRole}');
    // The fix: a select over the same enum the server validates against.
    expect(editor).toMatch(/<select[^>]*?value=\{form\.primaryRole\}/);
    expect(editor).toContain('SELECTABLE_ROLES.map');
    // The server re-exports the same module rather than declaring a second list.
    expect(server).toContain("from '../../lib/roles'");
  });

  it('sends an emptied website or role so it can actually be cleared', () => {
    // The old editor deleted these keys when empty because the schema refused
    // `""` — so a saved website or role could never be removed. Now the
    // editor sends them, and the server reads empty as "clear".
    const editor = source('src/components/react/ProfileEditor.tsx');
    expect(editor).toContain('primaryRole: form.primaryRole || null');
    expect(editor).toContain('website: form.website.trim() || null');
    expect(editor).not.toContain('delete body.website');
  });

  it('the settings sign-out button is a real, working slot, not an unwrapped island', () => {
    /**
     * The fourth instance of the same root cause: a `SignOutButton` island,
     * also mounted with `client:only="react"` outside the provider, whose
     * `logout()` threw the identical "wrap your application" error on every
     * click — uncaught, so nothing visible happened at all. It has been
     * replaced with a portal into the ONE real provider, the same pattern
     * `AccountSlot` and `JoinCta` already used.
     */
    expect(() => source('src/components/react/SignOutButton.tsx')).toThrow();
    // Comments are allowed to explain the history; code must not import or
    // render the deleted island.
    const settings = source('src/pages/me/settings.astro').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    expect(settings).not.toContain('SignOutButton');
    expect(settings).toContain('id="signout-slot-root"');
    const root = source('src/components/react/PrivyRoot.tsx');
    expect(root).toContain('function SignOutSlot()');
    expect(root).toContain("getElementById('signout-slot-root')");
  });
});
