#!/usr/bin/env node
/**
 * ROUTE AUDIT — every public route's status, redirect and canonical, against
 * a loopback dev server, plus every internal link on the homepage.
 *
 *   BASE=http://127.0.0.1:4321 node scripts/dev/route-audit.mjs
 *
 * Requests are made WITHOUT following redirects, so a redirect is reported as
 * itself rather than as wherever it lands. Exits non-zero on any mismatch.
 *
 * Two things differ from production by design, and the expectations say so:
 *
 *   · No-slash paths (`/events`). Production answers them with Vercel's edge
 *     308 to the slash form (`trailingSlash: true` in vercel.json); `astro dev`
 *     answers 404. Links are therefore resolved under the Vercel rule.
 *   · `/submit/`, `/join/`, `/city/` are prerendered redirects: a real 308 in
 *     dev, a 200 meta-refresh page to the same destination in a static build.
 *
 * Slugs default to the September 2026 archive rehearsal database; override
 * with the environment variables PROJECT, IMPORTED, EVENT, BUILDER, CITY,
 * AMBASSADOR and HIDDEN.
 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:4321';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) {
  console.error('route-audit.mjs only runs against a loopback app.');
  process.exit(1);
}
const S = {
  PROJECT: 'navdisha',
  IMPORTED: 'bhasha-hire',
  EVENT: 'claude-impact-lab-september',
  BUILDER: 'aniket-sahu',
  CITY: 'bhopal',
  AMBASSADOR: 'aniket-sahu',
  HIDDEN: 'nagar-setu',
};
for (const key of Object.keys(S)) if (process.env[key]) S[key] = process.env[key];

/** [path, expected status, expected Location (redirects only)] */
const ROUTES = [
  ['/', 200],
  ['/?utm_source=audit', 200],
  ['/events/', 200],
  [`/events/${S.EVENT}/`, 200],
  ['/events/claude-community/', 200],
  ['/events/no-such-event/', 404],
  ['/gallery/', 200],
  ['/cities/', 200],
  [`/cities/${S.CITY}/`, 200],
  ['/cities/no-such-city/', 404],
  ['/builders/', 200],
  [`/builders/${S.BUILDER}/`, 200],
  ['/builders/no-such-builder/', 404],
  ['/projects/', 200],
  ['/projects/?q=civic', 200],
  [`/projects/?event=${S.EVENT}&sort=name&page=2`, 200],
  [`/projects/${S.PROJECT}/`, 200],
  [`/projects/${S.IMPORTED}/`, 200],
  [`/projects/${S.HIDDEN}/`, 404],
  ['/projects/no-such-project/', 404],
  ['/ambassadors/', 200],
  [`/ambassadors/${S.AMBASSADOR}/`, 200],
  ['/ambassadors/no-such/', 404],
  ['/discover/', 200],
  ['/discover/?q=Bhopal', 200],
  ['/about/', 200],
  ['/community/', 200],
  ['/practice/', 200],
  ['/record/', 200],
  ['/use-cases/', 200],
  ['/use-cases/no-such/', 404],
  ['/guides/', 200],
  ['/guides/no-such/', 404],
  ['/stories/', 200],
  ['/stories/no-such/', 404],
  ['/submit/', 308, '/me/projects/new/'],
  ['/join/', 308, '/'],
  ['/city/', 308, '/me/profile/edit/'],
  ['/definitely-missing/', 404],
  ['/sitemap.xml', 200],
  ['/robots.txt', 200],
  ['/me/', 200],
  ['/me/profile/', 200],
  ['/me/profile/edit/', 200],
  ['/me/projects/', 200],
  ['/me/projects/new/', 200],
  ['/me/projects/claim/', 200],
  ['/me/settings/', 200],
];

let failures = 0;
const report = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const get = (path) =>
  fetch(BASE + path, { redirect: 'manual', signal: AbortSignal.timeout(90_000) });

for (const [path, status, location] of ROUTES) {
  const res = await get(path);
  const body = (res.headers.get('content-type') ?? '').includes('html') ? await res.text() : '';
  const where = res.headers.get('location')?.replace(/^https?:\/\/[^/]+/, '');
  const canonical = body.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
  const problems = [];
  if (res.status !== status) problems.push(`status ${res.status}, expected ${status}`);
  if (location && where !== location) problems.push(`Location ${where}, expected ${location}`);
  const raw = res.headers.get('location');
  if (raw && /^https?:/.test(raw) && new URL(raw).origin !== new URL(BASE).origin)
    problems.push(`redirects off-site to ${raw}`);
  if (status === 200 && body && canonical) {
    const expected = new URL(path, 'https://www.withclaude.in').pathname;
    if (new URL(canonical).pathname !== expected) problems.push(`canonical ${canonical}`);
  }
  if (path.startsWith('/me/') && res.headers.get('cache-control') !== 'private, no-store')
    problems.push('account page is cacheable');
  report(
    problems.length === 0,
    `${String(res.status).padEnd(3)} ${path}${where ? ` → ${where}` : ''}`,
    problems.join('; '),
  );
}

// ── every internal link on the homepage, header and footer included ──────
const home = await (await get('/')).text();
const hrefs = [
  ...new Set([...home.matchAll(/<a\b[^>]*\bhref="(\/[^"#]*)(?:#[^"]*)?"/g)].map((m) => m[1])),
];
const vercelSlash = (href) => {
  const [path, query] = href.split('?');
  const withSlash = /\.[a-z0-9]+$/i.test(path) || path.endsWith('/') ? path : `${path}/`;
  return query ? `${withSlash}?${query}` : withSlash;
};
let checked = 0;
for (const href of hrefs) {
  let target = vercelSlash(href);
  let res = await get(target);
  // Follow at most the documented legacy redirects, never a chain.
  if (res.status === 308 && ['/submit/', '/join/', '/city/'].includes(target)) {
    target = res.headers.get('location');
    res = await get(target);
  }
  checked += 1;
  if (res.status !== 200)
    report(false, `homepage link ${href}`, `→ ${target} answered ${res.status}`);
}
report(checked > 40, `homepage internal links resolve (${checked} unique)`);

console.log(failures === 0 ? '\nRoute audit passed.' : `\n${failures} route check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
