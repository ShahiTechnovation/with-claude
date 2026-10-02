#!/usr/bin/env node
/**
 * HOMEPAGE AND NAVIGATION JOURNEY — against a loopback dev server on an
 * isolated database. Checks what a screenshot cannot:
 *
 *   · `/` is the deployed composition, at 375 / 768 / 1440, with no sideways
 *     scroll, no broken images, no console errors and no error overlay;
 *   · the logo, the masthead (desktop row and phone drawer), the cover actions,
 *     a project card and the footer go where production sends them, and the
 *     browser's back/forward return to the right page;
 *   · deep links with query strings load directly;
 *   · project pages name the event they were built at, with the held date;
 *   · signed out, an account page shows its sign-in gate AT the requested URL;
 *     signed in, the same URL renders, and another member's project is a 404.
 *
 * The signed-in half uses a locally minted token (`scripts/dev/test-auth.mjs`)
 * verified by the server's real `verifyAccessToken()` path with a dev key. It
 * proves the server's guards and permissions; it does NOT prove Privy's own
 * login UI or production cookies.
 *
 * Production answers a no-slash path with Vercel's edge 308 (`trailingSlash:
 * true`); `astro dev` answers 404. The journey emulates the Vercel rule for
 * page navigations so links are judged by where production takes them.
 *
 *   BASE=http://127.0.0.1:4321 CHROME_PATH=… OUT=shots/home node scripts/dev/home-journey.mjs
 *
 * Writes one bootstrapped member and one draft project to the dev database.
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4321';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) {
  console.error('home-journey.mjs only runs against a loopback app.');
  process.exit(1);
}
const OUT = process.env.OUT ?? 'shots/home';
const IMPORTED = {
  impact: process.env.IMPACT_PROJECT ?? 'bhasha-hire',
  fable: process.env.FABLE_PROJECT ?? 'aftershock',
};
const SECTIONS = [
  'signal',
  'search',
  'next',
  'atlas',
  'builders',
  'projects',
  'practice',
  'stories',
  'with',
  'join',
  'record',
];
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
);
const results = [];
let failures = 0;
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  — ${detail}`}`);
  if (!ok) failures += 1;
};

/** Vercel's `trailingSlash: true`, for page navigations only. */
async function vercelSlash(context) {
  await context.route(`${BASE}/**`, (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      request.isNavigationRequest() &&
      !url.pathname.endsWith('/') &&
      !/\.[a-z0-9]+$/i.test(url.pathname)
    ) {
      url.pathname += '/';
      return route.fulfill({ status: 308, headers: { location: url.toString() } });
    }
    return route.continue();
  });
}

async function newPage(width, { cookie } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await vercelSlash(context);
  if (cookie)
    await context.addCookies([
      { name: 'privy-token', value: cookie, domain: new URL(BASE).hostname, path: '/' },
    ]);
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  return { page, context, errors };
}

const path = (page) => new URL(page.url()).pathname + new URL(page.url()).search;
const h1 = (page) =>
  page
    .locator('main h1, body > h1, header.hero h1')
    .first()
    .innerText()
    .catch(() => '');
async function clickTo(page, locator, expected, label) {
  await Promise.all([
    page.waitForURL((u) => u.pathname === expected, { timeout: 60_000 }).catch(() => {}),
    locator.click(),
  ]);
  check(label, path(page).split('?')[0] === expected, `landed on ${path(page)}`);
}

// ── 1. the homepage at three widths ───────────────────────────────────────
for (const width of [375, 768, 1440]) {
  const { page, context, errors } = await newPage(width);
  const res = await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 90_000 });
  check(
    `/ (${width}): 200, served directly`,
    res?.status() === 200 && path(page) === '/',
    `${res?.status()} ${path(page)}`,
  );
  const title = (await page.locator('h1').first().innerText()).replace(/\s+/g, ' ');
  check(
    `/ (${width}): the cover reads "India is building."`,
    /India is\s*building\./i.test(title),
    title,
  );
  const ids = await page.$$eval('main > section[id]', (els) => els.map((e) => e.id));
  check(
    `/ (${width}): the eleven deployed sections, in order`,
    JSON.stringify(ids) === JSON.stringify(SECTIONS),
    ids.join(','),
  );
  const actions = await page.$$eval('header.hero a.btn, header.hero a.link-arrow', (as) =>
    as.map((a) => `${a.textContent.replace(/\s+/g, ' ').trim()} ${a.getAttribute('href')}`),
  );
  check(
    `/ (${width}): cover actions keep their destinations`,
    actions.some((a) => /^Explore the community .* \/cities$/.test(a)) &&
      actions.some((a) => /^See what.s happening .* \/events$/.test(a)) &&
      actions.some((a) => /^Add your build .* \/submit\/$/.test(a)),
    actions.join(' | '),
  );
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 500) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 40));
    }
  });
  await page.waitForLoadState('networkidle');
  // Only rendered images: the cover photograph is `display: none` below the
  // desktop split, and an image that is never rendered is never decoded.
  const broken = await page.$$eval('img', (imgs) =>
    imgs
      .filter((i) => i.getClientRects().length > 0 && i.complete && i.naturalWidth === 0)
      .map((i) => i.currentSrc || i.src),
  );
  check(`/ (${width}): no broken images`, broken.length === 0, broken.join(' '));
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check(`/ (${width}): no horizontal overflow`, overflow <= 0, `${overflow}px`);
  check(
    `/ (${width}): no error overlay`,
    (await page.locator('vite-error-overlay, astro-dev-overlay').count()) === 0,
  );
  check(
    `/ (${width}): every preview card names its event`,
    (await page.locator('#projects .card-event').count()) ===
      (await page.locator('#projects .card').count()),
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${OUT}/home-${width}.png`, fullPage: true });
  check(`/ (${width}): no console errors`, errors.length === 0, errors.join(' | ').slice(0, 300));
  await context.close();
}

// ── 2. navigation, back and forward ──────────────────────────────────────
{
  const { page, context, errors } = await newPage(1440);
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  check(
    'logo links home',
    (await page.locator('header.masthead a.brand').getAttribute('href')) === '/',
  );
  await clickTo(
    page,
    page.locator('.nav-desktop a', { hasText: 'Projects' }),
    '/projects/',
    'masthead Projects → /projects/',
  );
  check(
    'the directory opens on its own heading',
    (await h1(page)) === 'Project Directory',
    await h1(page),
  );
  await page.goBack({ waitUntil: 'load' });
  check(
    'back returns to the homepage',
    path(page) === '/' && (await page.locator('#signal').count()) === 1,
    path(page),
  );
  await page.goForward({ waitUntil: 'load' });
  check('forward returns to the directory', path(page) === '/projects/', path(page));
  await page.goBack({ waitUntil: 'load' });

  for (const [text, to] of [
    ['Events', '/events/'],
    ['Cities', '/cities/'],
    ['Builders', '/builders/'],
  ]) {
    await clickTo(
      page,
      page.locator('.nav-desktop a', { hasText: text }),
      to,
      `masthead ${text} → ${to}`,
    );
    await page.goBack({ waitUntil: 'load' });
  }
  await clickTo(
    page,
    page.locator('header.masthead a.nav-search'),
    '/discover/',
    'masthead Search → /discover/',
  );
  await clickTo(page, page.locator('header.masthead a.brand'), '/', 'logo → /');

  await clickTo(
    page,
    page.locator('header.hero a', { hasText: 'Explore the community' }),
    '/cities/',
    'Explore the community → /cities/',
  );
  await page.goBack({ waitUntil: 'load' });
  await clickTo(
    page,
    page.locator('header.hero a', { hasText: 'See what' }),
    '/events/',
    'See what’s happening → /events/',
  );
  await page.goBack({ waitUntil: 'load' });
  // /submit/ is the legacy address of the project form: 308 in dev, meta refresh in a static build.
  await clickTo(
    page,
    page.locator('header.hero a', { hasText: 'Add your build' }),
    '/me/projects/new/',
    'Add your build → /submit/ → /me/projects/new/',
  );
  check(
    'signed out, the project form shows its sign-in gate in place',
    (await page.locator('#join-cta-root').count()) === 1,
  );
  await page.goBack({ waitUntil: 'load' });
  check('back from the gate returns home', path(page) === '/', path(page));

  const card = page.locator('#projects .card a').first();
  const href = await card.getAttribute('href');
  await clickTo(page, card, `${href}/`.replace(/\/\/$/, '/'), `homepage project card → ${href}/`);
  check(
    'the project page names its event',
    /Built at .+ · \d{1,2} \w{3} \d{4}/.test(await page.locator('main').innerText()),
  );
  await page.goBack({ waitUntil: 'load' });

  for (const [text, to] of [
    ['Projects', '/projects/'],
    ['Search the community', '/discover/'],
    ['The record', '/record/'],
  ]) {
    await clickTo(
      page,
      page.locator('footer a', { hasText: text }).first(),
      to,
      `footer ${text} → ${to}`,
    );
    await page.goBack({ waitUntil: 'load' });
  }
  check(
    'no console errors while navigating',
    errors.length === 0,
    errors.join(' | ').slice(0, 300),
  );
  await context.close();
}

// ── 3. the phone drawer ──────────────────────────────────────────────────
for (const width of [375, 768]) {
  const { page, context, errors } = await newPage(width);
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.locator('.nav-toggle').click();
  const drawerLink = page.locator('.nav-drawer a', { hasText: 'Projects' });
  await drawerLink.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
  check(
    `drawer (${width}): opens with the five destinations`,
    (await page.locator('.nav-drawer a:visible').count()) >= 5,
  );
  await page.screenshot({ path: `${OUT}/drawer-${width}.png` });
  await clickTo(page, drawerLink, '/projects/', `drawer (${width}): Projects → /projects/`);
  await page.goBack({ waitUntil: 'load' });
  check(`drawer (${width}): back returns home`, path(page) === '/', path(page));
  check(
    `drawer (${width}): no console errors`,
    errors.length === 0,
    errors.join(' | ').slice(0, 300),
  );
  await context.close();
}

// ── 4. deep links ─────────────────────────────────────────────────────────
{
  const { page, context, errors } = await newPage(1440);
  let res = await page.goto(`${BASE}/projects/?event=claude-impact-lab-september&sort=name`, {
    waitUntil: 'load',
  });
  check(
    'deep link: filtered directory loads directly',
    res?.status() === 200 &&
      path(page) === '/projects/?event=claude-impact-lab-september&sort=name',
    `${res?.status()} ${path(page)}`,
  );
  const badges = await page.locator('.dir-list .badge-event').allInnerTexts();
  check(
    'deep link: the filter is applied (every row is Impact Lab 2 · 15 Sep 2026)',
    badges.length > 0 && badges.every((b) => /Impact Lab 2 · 15 Sep 2026/.test(b)),
    badges.slice(0, 3).join(' | '),
  );
  for (const [slug, expected] of [
    [IMPORTED.impact, /Built at Impact Lab 2 · 15 Sep 2026/],
    [IMPORTED.fable, /Built at Fable 5\.1 Build Day · 20 Sep 2026/],
  ]) {
    res = await page.goto(`${BASE}/projects/${slug}/`, { waitUntil: 'load' });
    check(
      `deep link: /projects/${slug}/ answers 200 and names its event`,
      res?.status() === 200 && expected.test(await page.locator('main').innerText()),
      String(res?.status()),
    );
  }
  res = await page.goto(`${BASE}/projects/no-such-project/`, { waitUntil: 'load' });
  check(
    'deep link: a missing project is a 404 at its own URL',
    res?.status() === 404 && path(page) === '/projects/no-such-project/',
    `${res?.status()} ${path(page)}`,
  );
  res = await page.goto(`${BASE}/events/claude-impact-lab-september/`, { waitUntil: 'load' });
  check(
    'deep link: Impact Lab 2 says 15 September, rescheduled from 13 September',
    /15 September 2026/.test(await page.locator('main').innerText()) &&
      /13 September/.test(await page.locator('main').innerText()),
  );
  // The deliberate 404 above is logged by the browser as a failed document load.
  const unexpected = errors.filter((e) => !/status of 404/.test(e));
  check(
    'deep links: no console errors beyond the deliberate 404',
    unexpected.length === 0,
    unexpected.join(' | ').slice(0, 300),
  );
  await context.close();
}

// ── 5. accounts: signed out, then two real (locally minted) sessions ─────
const token = (did) =>
  execFileSync('node', ['scripts/dev/test-auth.mjs', 'token', did], { encoding: 'utf8' });
const run = Date.now().toString(36);
{
  const { page, context } = await newPage(1440);
  for (const url of [
    '/me/',
    '/me/projects/',
    '/me/profile/edit/',
    `/me/projects/claim/?project=${IMPORTED.impact}`,
  ]) {
    const res = await page.goto(`${BASE}${url}`, { waitUntil: 'load' });
    check(
      `signed out ${url}: gate rendered at the same URL, never cached`,
      res?.status() === 200 &&
        path(page) === url &&
        (await page.locator('#join-cta-root').count()) === 1 &&
        res.headers()['cache-control'] === 'private, no-store',
      `${res?.status()} ${path(page)}`,
    );
    const next = await page.locator('#join-cta-root').getAttribute('data-next');
    check(`signed out ${url}: signing in returns here`, next === url, String(next));
  }
  await context.close();
}

let ownedEdit;
{
  const { page, context, errors } = await newPage(1440, {
    cookie: token(`did:privy:home-owner-${run}`),
  });
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
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
  check('signed in: member bootstrap', boot === 200 || boot === 201, String(boot));
  let res = await page.goto(`${BASE}/me/`, { waitUntil: 'load' });
  check(
    'signed in /me/: the dashboard, not the gate',
    res?.status() === 200 && (await page.locator('#join-cta-root').count()) === 0,
    String(res?.status()),
  );
  const created = await page.evaluate(async () => {
    const r = await fetch('/api/projects/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Routing journey draft' }),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  });
  const id = created.body?.project?.id ?? created.body?.id;
  check(
    'signed in: a draft project can be created',
    (created.status === 200 || created.status === 201) && Boolean(id),
    JSON.stringify(created).slice(0, 200),
  );
  ownedEdit = `/me/projects/${id}/edit/`;
  res = await page.goto(`${BASE}${ownedEdit}`, { waitUntil: 'load' });
  check(
    'signed in: the owner opens the edit page',
    res?.status() === 200 && /Routing journey draft/.test(await page.locator('main').innerText()),
    String(res?.status()),
  );
  res = await page.goto(`${BASE}/submit/`, { waitUntil: 'load' });
  check(
    'signed in: /submit/ lands on the project form',
    path(page) === '/me/projects/new/' && (await page.locator('#join-cta-root').count()) === 0,
    path(page),
  );
  // A session makes the page load Privy, and Privy rejects the local app id —
  // the documented degraded mode of a locally minted session, not a site error.
  const unexpectedSignedIn = errors.filter((e) => !/invalid Privy app ID/.test(e));
  check(
    'signed in: no console errors beyond the local Privy app id',
    unexpectedSignedIn.length === 0,
    unexpectedSignedIn.join(' | ').slice(0, 300),
  );
  await context.close();
}
{
  const { page, context } = await newPage(1440, { cookie: token(`did:privy:home-other-${run}`) });
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.evaluate(async () =>
    fetch('/api/member/bootstrap/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }),
  );
  const res = await page.goto(`${BASE}${ownedEdit}`, { waitUntil: 'load' });
  check(
    "another member's project: 404 at the same URL, nothing of it shown",
    res?.status() === 404 &&
      path(page) === ownedEdit &&
      !/Routing journey draft/.test(await page.content()),
    `${res?.status()} ${path(page)}`,
  );
  await context.close();
}
{
  const { page, context } = await newPage(1440);
  const res = await page.goto(`${BASE}${ownedEdit}`, { waitUntil: 'load' });
  check(
    'signed out on an edit URL: the gate, at that URL, without the project',
    res?.status() === 200 &&
      path(page) === ownedEdit &&
      (await page.locator('#join-cta-root').count()) === 1 &&
      !/Routing journey draft/.test(await page.content()),
    `${res?.status()} ${path(page)}`,
  );
  check(
    'signed out on an edit URL: signing in returns to it',
    (await page.locator('#join-cta-root').getAttribute('data-next')) === ownedEdit,
  );
  await context.close();
}

await browser.close();
await writeFile(`${OUT}/report.json`, JSON.stringify(results, null, 2));
console.log(
  `\n${results.length - failures}/${results.length} checks passed; screenshots in ${OUT}/`,
);
process.exit(failures === 0 ? 0 : 1);
