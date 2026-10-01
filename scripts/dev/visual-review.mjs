#!/usr/bin/env node
/**
 * VISUAL REVIEW — screenshots of the core pages at three widths, plus the
 * facts a screenshot cannot show: console errors, horizontal overflow, the
 * number of `<main>` landmarks, and images without reserved dimensions.
 *
 *   BASE=http://127.0.0.1:4321 OUT=shots/review node scripts/dev/visual-review.mjs
 *   TOKEN=<access token> … also captures the signed-in account pages
 *
 * Writes PNGs and a `report.json` to OUT. Development tool only.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4321';
const OUT = process.env.OUT ?? 'shots/review';
const TOKEN = process.env.TOKEN;
const WIDTHS = [
  ['375', 375, 812],
  ['768', 768, 1024],
  ['1440', 1440, 900],
];

const pages = (process.env.PAGES ?? '/,/projects/,/projects/?category=agent,/projects/?q=zzzz-no-match,/events/,/builders/,/about/,/projects/does-not-exist/')
  .split(',')
  .filter(Boolean);
const accountPages = (process.env.ACCOUNT_PAGES ?? '/me/,/me/profile/edit/,/me/projects/,/me/projects/new/').split(',').filter(Boolean);

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const report = [];

async function shoot(path, signedIn) {
  for (const [name, width, height] of WIDTHS) {
    const context = await browser.newContext({ viewport: { width, height } });
    if (signedIn && TOKEN) {
      const { hostname } = new URL(BASE);
      await context.addCookies([{ name: 'privy-token', value: TOKEN, domain: hostname, path: '/' }]);
    }
    const page = await context.newPage();
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 200)));
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 200)}`));
    const response = await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 45_000 }).catch((e) => {
      errors.push(`navigation: ${e.message.slice(0, 120)}`);
      return null;
    });
    await page.waitForTimeout(600);
    const facts = await page.evaluate(() => ({
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      mains: document.querySelectorAll('main').length,
      h1s: document.querySelectorAll('h1').length,
      unsizedImages: [...document.images].filter((i) => !i.getAttribute('width') && !i.closest('.cover, .plate')).length,
      title: document.title,
    }));
    const slug = (path === '/' ? 'home' : path.replace(/^\/|\/$/g, '').replace(/[/?=&]+/g, '-')) + (signedIn ? '-signed-in' : '');
    await page.screenshot({ path: `${OUT}/${slug}-${name}.png`, fullPage: true });
    report.push({ path, signedIn, width, status: response?.status() ?? null, ...facts, errors });
    await context.close();
  }
}

for (const path of pages) await shoot(path, false);
if (TOKEN) for (const path of accountPages) await shoot(path, true);

await browser.close();
await writeFile(`${OUT}/report.json`, JSON.stringify(report, null, 2));
for (const r of report) {
  const flags = [
    r.status !== 200 && `status ${r.status}`,
    r.overflowX && 'HORIZONTAL OVERFLOW',
    r.mains !== 1 && `${r.mains} <main>`,
    r.h1s !== 1 && `${r.h1s} <h1>`,
    r.errors.length && `${r.errors.length} console errors`,
  ].filter(Boolean);
  console.log(`${r.width}\t${r.path}${r.signedIn ? ' (signed in)' : ''}\t${flags.join(', ') || 'ok'}`);
}
