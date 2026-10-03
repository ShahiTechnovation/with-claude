/**
 * VISUAL REVIEW — screenshots of the core pages at three widths, plus the
 * facts a screenshot cannot show: console errors, horizontal overflow, the
 * number of `<main>` landmarks, and images without reserved dimensions.
 *
 *   BASE=http://127.0.0.1:4321 OUT=shots/review node scripts/dev/visual-review.mjs
 *   TOKEN=<access token> … also captures the signed-in account pages
 *   STRICT=1 … exits 1 when a page fails (see `strictFailures`) — the preview smoke check
 *   EXTRA_HEADERS="name: value" … one per line, sent to BASE's own origin only (see `scopeHeaders`)
 *
 * Writes PNGs and a `report.json` to OUT. A development tool, and the script
 * `.github/workflows/preview-smoke.yml` runs against each preview deployment.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/**
 * What STRICT=1 fails a page on: what a visitor would hit, and a page that
 * ended up anywhere but BASE's `origin`. Vercel's login page answers 200 with
 * one `<main>` and one `<h1>`, so without that check a protected preview the
 * run never got into would pass. Plain `console.error` output is reported but
 * never fails the run, because on a preview most of it comes from third
 * parties.
 */
export function strictFailures(r, origin) {
  return [
    r.status !== 200 && `status ${r.status}`,
    new URL(r.url).origin !== origin && `ended on ${r.url}`,
    r.overflowX && 'HORIZONTAL OVERFLOW',
    r.mains !== 1 && `${r.mains} <main>`,
    r.h1s !== 1 && `${r.h1s} <h1>`,
    r.pageErrors > 0 && `${r.pageErrors} uncaught page error(s)`,
  ].filter(Boolean);
}

/** `name: value` per line. A header with no value is dropped, so an unset secret sends nothing. */
export function parseHeaders(raw) {
  return Object.fromEntries(
    (raw ?? '')
      .split('\n')
      .filter((line) => line.includes(':'))
      .map((line) => [line.slice(0, line.indexOf(':')).trim(), line.slice(line.indexOf(':') + 1).trim()])
      .filter(([name, value]) => name && value),
  );
}

/**
 * Adds `headers` to requests for `origin`, and to nothing else: a
 * deployment-protection secret must not ride along to fonts, embeds or
 * analytics, or to wherever a redirect points. `route.continue({ headers })`
 * would carry them across a redirect to any origin, so each request is
 * fetched with redirects off and the answer handed to the browser, which then
 * follows a redirect itself, without them. That holds for a redirect back to
 * `origin` as well (Playwright does not route redirect hops). On Vercel, also
 * sending `x-vercel-set-bypass-cookie: true` gives the browser a cookie for
 * the preview's host alone, and the cookie carries those hops.
 */
export function scopeHeaders(context, origin, headers) {
  return context.route(
    (url) => url.origin === origin,
    async (route) => {
      try {
        const response = await route.fetch({ headers: { ...route.request().headers(), ...headers }, maxRedirects: 0 });
        await route.fulfill({ response });
      } catch {
        // The network failed, or the page closed mid-request. The browser
        // reports the aborted request, and the page view records it.
        await route.abort().catch(() => {});
      }
    },
  );
}

async function main() {
  // Imported here so the helpers above can be tested without a browser installed.
  const { chromium } = await import('playwright');

  const BASE = (process.env.BASE ?? 'http://127.0.0.1:4321').replace(/\/$/, '');
  const { hostname, origin } = new URL(BASE);
  const OUT = process.env.OUT ?? 'shots/review';
  const TOKEN = process.env.TOKEN;
  const STRICT = process.env.STRICT === '1';
  const HEADERS = parseHeaders(process.env.EXTRA_HEADERS);
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
        await context.addCookies([{ name: 'privy-token', value: TOKEN, domain: hostname, path: '/' }]);
      }
      if (Object.keys(HEADERS).length > 0) await scopeHeaders(context, origin, HEADERS);
      const page = await context.newPage();
      const errors = [];
      let pageErrors = 0;
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 200)));
      page.on('pageerror', (e) => {
        pageErrors += 1;
        errors.push(`pageerror: ${e.message.slice(0, 200)}`);
      });
      // The status comes from the document itself. Waiting for the network to
      // go quiet is best-effort: an embed that keeps polling must not turn a
      // page that loaded into a failed navigation.
      const response = await page.goto(BASE + path, { waitUntil: 'load', timeout: 45_000 }).catch((e) => {
        errors.push(`navigation: ${e.message.slice(0, 120)}`);
        return null;
      });
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
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
      report.push({ path, signedIn, width, status: response?.status() ?? null, url: page.url(), ...facts, pageErrors, errors });
      await context.close();
    }
  }

  for (const path of pages) await shoot(path, false);
  if (TOKEN) for (const path of accountPages) await shoot(path, true);

  await browser.close();
  await writeFile(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  for (const r of report) {
    const flags = [...strictFailures(r, origin), r.errors.length && `${r.errors.length} console errors`].filter(Boolean);
    console.log(`${r.width}\t${r.path}${r.signedIn ? ' (signed in)' : ''}\t${flags.join(', ') || 'ok'}`);
  }

  const failed = report.filter((r) => strictFailures(r, origin).length > 0);
  if (STRICT && failed.length > 0) {
    console.error(`\nSTRICT: ${failed.length} of ${report.length} page views failed.`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
