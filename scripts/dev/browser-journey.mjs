#!/usr/bin/env node
/**
 * BROWSER JOURNEY through the account editors, against a loopback dev server
 * on an isolated database, signed in with a locally minted token cookie.
 *
 * What it proves: the editors mount beneath the single provider, save drafts,
 * clear fields, publish, and that the results appear on the public pages.
 * What it does NOT prove: Privy's real login UI and production cookies. Start
 * the server with the test app id for the client too, so the provider runs in
 * its degraded mode and requests carry the cookie only. With the real
 * PUBLIC_PRIVY_APP_ID from .env the SDK loads signed out and Save stays disabled.
 *
 *   PRIVY_APP_ID=wc-local-test PUBLIC_PRIVY_APP_ID=wc-local-test \
 *     PRIVY_VERIFICATION_KEY="$(cat .dev-auth/public.pem)" npx astro dev --port 4322 --host 127.0.0.1
 *   BASE=http://127.0.0.1:4322 CHROME_PATH=… node scripts/dev/browser-journey.mjs
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4321';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) {
  console.error('browser-journey.mjs only runs against a loopback app.');
  process.exit(1);
}
const OUT = process.env.OUT ?? 'shots/journey';
await mkdir(OUT, { recursive: true });

const run = Date.now().toString(36);
const token = execFileSync(
  'node',
  ['scripts/dev/test-auth.mjs', 'token', `did:privy:browser-${run}`],
  { encoding: 'utf8' },
);
const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' },
);
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.addCookies([
  { name: 'privy-token', value: token, domain: new URL(BASE).hostname, path: '/' },
]);
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  — ${detail}`}`);
  if (!ok) failures += 1;
};

// Provision the member the way the client would after login.
await page.goto(`${BASE}/`);
const boot = await page.evaluate(
  async () =>
    (
      await fetch('/api/member/bootstrap/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
);
check('bootstrap from the browser', boot === 201 || boot === 200, String(boot));

// ── profile ────────────────────────────────────────────────────────────
await page.goto(`${BASE}/me/profile/edit/`);
await page.waitForSelector('#pe-displayName', { timeout: 20_000 });
check('profile editor mounts', true);
await page.fill('#pe-displayName', 'Browser Builder');
await page.fill('#pe-username', `browser${run}`.slice(0, 24));
await page.waitForFunction(() => document.querySelectorAll('#pe-city option').length > 2);
await page.selectOption('#pe-city', 'bhopal');
await page.selectOption('#pe-role', { index: 1 });
await page.fill('#pe-website', 'https://browser.example');
await page.fill('#pe-bio', 'Written in a real browser.');
await page.click('button[type=submit]');
await page.waitForSelector('.notice--success', { timeout: 15_000 });
check(
  'save draft shows success',
  (await page.textContent('.notice--success'))?.includes('draft') ?? false,
);
await page.screenshot({ path: `${OUT}/profile-saved.png`, fullPage: true });

await page.reload();
await page.waitForSelector('#pe-website');
check(
  'saved values survive a reload',
  (await page.inputValue('#pe-website')) === 'https://browser.example',
);
await page.fill('#pe-website', '');
await page.click('button[type=submit]');
await page.waitForSelector('.notice--success');
await page.reload();
await page.waitForSelector('#pe-website');
check('the website field can be cleared', (await page.inputValue('#pe-website')) === '');

await page.click('button.button--primary:has-text("Publish profile")');
await page.waitForSelector('.notice--success:has-text("Published")', { timeout: 15_000 });
check('publish shows success', true);
const slug = `browser${run}`.slice(0, 24);
const pub = await page.goto(`${BASE}/builders/${slug}/`);
check('public builder page exists', pub?.status() === 200, String(pub?.status()));
check('public page shows the bio', (await page.content()).includes('Written in a real browser.'));
await page.screenshot({ path: `${OUT}/builder-public.png`, fullPage: true });

// ── project ────────────────────────────────────────────────────────────
await page.goto(`${BASE}/me/projects/new/`);
await page.waitForSelector('#pj-title', { timeout: 20_000 });
await page.fill('#pj-title', `Browser Project ${run}`);
await page.click('button[type=submit]');
await page.waitForURL(/\/me\/projects\/[0-9a-f-]+\/edit\/$/, { timeout: 15_000 });
check('draft created and URL becomes the edit page', true);
await page.click('button.button--primary:has-text("Publish")');
await page.waitForSelector('.field-error', { timeout: 15_000 });
const blockerCount = await page.locator('.field-error').count();
check('publish blockers are shown beside their fields', blockerCount >= 3, String(blockerCount));
await page.screenshot({ path: `${OUT}/project-blockers.png`, fullPage: true });

await page.fill('#pj-summary', 'Made in a real browser session.');
await page.waitForFunction(() => document.querySelectorAll('#pj-cityId option').length > 2);
await page.selectOption('#pj-cityId', { label: 'Bhopal' });
await page.fill('#pj-description', 'It checks that the editor works.');
await page.fill('#pj-claudeUsage', 'Claude helped write the checks.');
await page.fill('#pj-tags', 'Playwright, Claude Code');
await page.click('button.button--primary:has-text("Publish")');
await page.waitForSelector('.notice--success:has-text("Published")', { timeout: 15_000 });
check('project publishes from the editor', true);
const link = await page.getAttribute('.notice--success a', 'href');
const detail = await page.goto(`${BASE}${link}`);
check('public project page exists', detail?.status() === 200, `${link} ${detail?.status()}`);
const html = await page.content();
check('project page credits the builder', html.includes('Browser Builder'));
check(
  'project page shows its tile and no cover art',
  (await page.locator('.pd-head .pd-icon').count()) === 1 &&
    (await page.locator('.pd-head img').count()) === 0,
);
check('project page shows the tagline', html.includes('Made in a real browser session.'));
await page.screenshot({ path: `${OUT}/project-public.png`, fullPage: true });

check('no uncaught page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
await browser.close();
console.log(
  failures === 0 ? '\nBrowser journey passed.' : `\n${failures} browser check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
