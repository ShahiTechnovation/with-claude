#!/usr/bin/env node
/**
 * CORE JOURNEYS, END TO END, OVER HTTP — against a dev server on an ISOLATED
 * database, using locally minted tokens (see scripts/dev/test-auth.mjs).
 *
 *   BASE=http://127.0.0.1:4321 DATABASE_URL=postgresql://…local… node scripts/dev/journey.mjs
 *
 * Refuses to run against anything but a loopback base URL and a loopback
 * database, because it creates members and writes content.
 *
 * Exits non-zero on the first failed expectation and prints what it saw.
 */
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4321';
const DB = process.env.DATABASE_URL ?? '';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE) || !/@(127\.0\.0\.1|localhost)[:/]/.test(DB)) {
  console.error('journey.mjs only runs against a loopback app and a loopback database.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DB });
const run = Date.now().toString(36);
const token = (did) => execFileSync('node', ['scripts/dev/test-auth.mjs', 'token', did], { encoding: 'utf8' });
let failures = 0;

function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  — ${detail}`}`);
  if (!ok) failures += 1;
}

async function call(path, { method = 'GET', tok, body, origin = BASE, cookieOnly = false } = {}) {
  const headers = { Origin: origin };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (tok) {
    headers.Cookie = `privy-token=${tok}`;
    if (!cookieOnly) headers.Authorization = `Bearer ${tok}`;
  }
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, cache: res.headers.get('cache-control') ?? '' };
}

const alice = token(`did:privy:journey-alice-${run}`);
const bob = token(`did:privy:journey-bob-${run}`);
const mod = token(`did:privy:journey-mod-${run}`);

// ── signup / bootstrap ─────────────────────────────────────────────────
let r = await call('/api/member/bootstrap/', { method: 'POST', tok: alice, body: {} });
check('fresh signup bootstraps a member (201)', r.status === 201, `${r.status} ${r.text.slice(0, 120)}`);
r = await call('/api/member/bootstrap/', { method: 'POST', tok: alice, body: {} });
check('repeat bootstrap is idempotent (200)', r.status === 200, String(r.status));
r = await call('/api/member/bootstrap/', { method: 'POST', tok: alice, body: {}, origin: 'https://evil.example' });
check('cross-origin bootstrap is refused (403)', r.status === 403, String(r.status));
r = await call('/api/member/bootstrap/', { method: 'POST', tok: 'not.a.token', body: {} });
check('a forged token is refused (401)', r.status === 401, String(r.status));
await call('/api/member/bootstrap/', { method: 'POST', tok: bob, body: {} });
await call('/api/member/bootstrap/', { method: 'POST', tok: mod, body: {} });

r = await call('/me/', { tok: alice, cookieOnly: true });
check('direct /me/ entry with the cookie renders the dashboard', r.status === 200 && r.text.includes('Hello,'), String(r.status));
check('/me/ is private, no-store', r.cache.includes('private') && r.cache.includes('no-store'), r.cache);
r = await call('/me/');
check('anonymous /me/ shows the sign-in panel, privately', r.text.includes('join-cta-root') && r.cache.includes('no-store'), r.cache);

// ── profile: draft, clear, publish ─────────────────────────────────────
const username = `alice${run}`.slice(0, 24);
r = await call('/api/member/profile/', {
  method: 'PATCH',
  tok: alice,
  body: { username, displayName: 'Alice Journey', citySlug: 'bhopal', primaryRole: 'Developer', website: 'https://alice.example', bio: 'Builds things.' },
});
check('profile draft saves', r.status === 200, `${r.status} ${r.text.slice(0, 160)}`);
r = await call('/api/member/profile/', { method: 'PATCH', tok: alice, body: { website: '', bio: '' } });
check('website and bio can be cleared', r.status === 200 && r.json?.profile?.website === null && r.json?.profile?.bio === null, r.text.slice(0, 160));
r = await call('/api/member/profile/', { method: 'PATCH', tok: alice, body: { website: 'http://insecure.example' } });
check('an insecure website is still refused (422)', r.status === 422, String(r.status));
r = await call('/api/member/profile/', { method: 'PATCH', tok: alice, body: { ownerMemberId: 'x' } });
check('a permission-bearing key is refused (422)', r.status === 422, String(r.status));
r = await call('/api/member/profile/', { method: 'POST', tok: alice, body: {} });
check('profile publishes', r.status === 201 || r.status === 200, `${r.status} ${r.text.slice(0, 160)}`);
const builderSlug = r.json?.slug;
r = await call(`/builders/${builderSlug}/`);
check('public builder page is live', r.status === 200 && r.text.includes('Alice Journey'), String(r.status));
r = await call('/builders/');
check('builder is listed in the directory', r.text.includes(`/builders/${builderSlug}`), 'not in listing');

await call('/api/member/profile/', { method: 'PATCH', tok: alice, body: { visibility: 'unlisted' } });
await call('/api/member/profile/', { method: 'POST', tok: alice, body: {} });
r = await call('/builders/');
check('unlisted builder leaves the directory', !r.text.includes(`/builders/${builderSlug}/`), 'still listed');
r = await call(`/builders/${builderSlug}/`);
check('unlisted builder is still reachable by link, and noindexed', r.status === 200 && r.text.includes('noindex'), String(r.status));
r = await call('/sitemap.xml');
check('unlisted builder is not in the sitemap', !r.text.includes(`/builders/${builderSlug}/`), 'in sitemap');
await call('/api/member/profile/', { method: 'PATCH', tok: alice, body: { visibility: 'public' } });
await call('/api/member/profile/', { method: 'POST', tok: alice, body: {} });

// ── projects: create, edit, publish, permissions ───────────────────────
const { rows: [city] } = await pool.query(`select id from cities where slug = 'bhopal'`);
r = await call('/api/projects/', { method: 'POST', tok: alice, body: { title: `Journey Project ${run}` } });
check('project draft is created from a name alone (201)', r.status === 201, `${r.status} ${r.text.slice(0, 160)}`);
const projectId = r.json?.id;
const projectSlug = r.json?.slug;
r = await call(`/projects/${projectSlug}/`);
check('a draft is a real 404 publicly', r.status === 404, String(r.status));
r = await call(`/api/projects/${projectId}/publish/`, { method: 'POST', tok: alice, body: {} });
check('publishing an incomplete project returns every blocker (422)', r.status === 422 && (r.json?.blockers?.length ?? 0) >= 3, r.text.slice(0, 160));
r = await call(`/api/projects/${projectId}/`, { method: 'PUT', tok: alice, body: { imagePath: 'https://evil.example/x.png' } });
check('an arbitrary imagePath is refused (422)', r.status === 422, String(r.status));
r = await call(`/api/projects/${projectId}/`, {
  method: 'PUT',
  tok: alice,
  body: { summary: 'A tagline that is long enough.', description: 'What it does.', claudeUsage: 'Claude wrote the parser.', cityId: city.id, url: 'https://journey.example', tags: ['Claude Code', 'MCP'] },
});
check('project edits save', r.status === 200, `${r.status} ${r.text.slice(0, 160)}`);
r = await call(`/api/projects/${projectId}/`, { method: 'PUT', tok: bob, body: { title: 'Hijacked' } });
check("a stranger cannot edit someone else's project (404)", r.status === 404, String(r.status));

// Bob is credited as a contributor: may read, may not edit or archive.
const { rows: [bobRow] } = await pool.query(`select id from members where privy_user_id = $1`, [`did:privy:journey-bob-${run}`]);
await pool.query(`insert into project_members (project_id, member_id, role) values ($1, $2, 'contributor')`, [projectId, bobRow.id]);
r = await call(`/api/projects/${projectId}/`, { method: 'PUT', tok: bob, body: { title: 'Contributor edit' } });
check('a contributor cannot edit (403)', r.status === 403, String(r.status));
r = await call(`/api/projects/${projectId}/publish/`, { method: 'POST', tok: bob, body: {} });
check('a contributor cannot publish (403)', r.status === 403, String(r.status));

r = await call(`/api/projects/${projectId}/publish/`, { method: 'POST', tok: alice, body: {} });
check('owner publishes', r.status === 200, `${r.status} ${r.text.slice(0, 160)}`);
r = await call(`/projects/${projectSlug}/`);
check('published project detail is live and publicly cached (bounded)', r.status === 200 && r.cache.includes('s-maxage=30') && r.cache.includes('stale-while-revalidate=30'), `${r.status} ${r.cache}`);
check('project credits its owner', r.text.includes('Alice Journey'), 'owner not credited');
r = await call(`/projects/?q=${encodeURIComponent(`Journey Project ${run}`)}`);
check('archive search finds it server-side', r.text.includes(`/projects/${projectSlug}/`), 'not found');
r = await call(`/builders/${builderSlug}/`);
check('builder page lists the project', r.text.includes(`/projects/${projectSlug}/`), 'not listed');
r = await call('/sitemap.xml');
check('sitemap lists the project', r.text.includes(`/projects/${projectSlug}/`), 'missing');
r = await call(`/api/projects/${projectId}/`, { method: 'PUT', tok: alice, body: { description: '' } });
check('a live project cannot be stripped of a required field (422)', r.status === 422, String(r.status));

// ── moderation ─────────────────────────────────────────────────────────
r = await call(`/api/moderation/projects/${projectId}/`, { method: 'PATCH', tok: alice, body: { action: 'hide' } });
check('a non-moderator cannot moderate (403)', r.status === 403, String(r.status));
await pool.query(`update members set role = 'moderator' where privy_user_id = $1`, [`did:privy:journey-mod-${run}`]);
r = await call(`/api/moderation/projects/${projectId}/`, { method: 'PATCH', tok: mod, body: { action: 'hide' }, origin: 'https://evil.example' });
check('cross-origin moderation is refused (403)', r.status === 403, String(r.status));
r = await call(`/api/moderation/projects/${projectId}/`, { method: 'PATCH', tok: mod, body: { action: 'hide' } });
check('moderator hides the project', r.status === 200, `${r.status} ${r.text.slice(0, 120)}`);
r = await call(`/projects/${projectSlug}/`);
check('hidden project is a real 404 to the public', r.status === 404, String(r.status));
r = await call(`/projects/${projectSlug}/`, { tok: mod, cookieOnly: true });
check('moderator view of a hidden project is private, no-store', r.status === 200 && r.cache.includes('no-store'), `${r.status} ${r.cache}`);
r = await call(`/projects/?q=${encodeURIComponent(`Journey Project ${run}`)}`);
check('hidden project leaves the archive', !r.text.includes(`/projects/${projectSlug}/`), 'still listed');
r = await call(`/api/projects/${projectId}/publish/`, { method: 'POST', tok: alice, body: {} });
check('owner cannot republish their way out of moderation', r.status === 409 || r.status === 403, String(r.status));
r = await call(`/api/moderation/projects/${projectId}/`, { method: 'PATCH', tok: mod, body: { action: 'restore' } });
check('moderator restores', r.status === 200, String(r.status));
r = await call(`/projects/${projectSlug}/`);
check('restored project is public again, as it was', r.status === 200, String(r.status));

// ── archive / restore ──────────────────────────────────────────────────
r = await call(`/api/projects/${projectId}/archive/`, { method: 'POST', tok: bob, body: {} });
check('a contributor cannot archive (403)', r.status === 403, String(r.status));
r = await call(`/api/projects/${projectId}/archive/`, { method: 'POST', tok: alice, body: {} });
check('owner archives', r.status === 200 && r.json?.status === 'archived', r.text.slice(0, 120));
r = await call(`/projects/${projectSlug}/`);
check('archived project is a 404', r.status === 404, String(r.status));
r = await call(`/api/projects/${projectId}/restore/`, { method: 'POST', tok: alice, body: {} });
check('restore returns it to draft, not published', r.status === 200 && r.json?.status === 'draft', r.text.slice(0, 120));
const { rows: [state] } = await pool.query(`select publication_status, status from projects where id = $1`, [projectId]);
check('legacy status follows publication status', state.publication_status === 'draft' && state.status === 'draft', JSON.stringify(state));

// ── account switch ─────────────────────────────────────────────────────
r = await call('/api/member/me/', { tok: bob });
check("a second account sees only its own profile", r.status === 200 && r.json?.profile?.displayName !== 'Alice Journey', r.text.slice(0, 120));

await pool.end();
console.log(failures === 0 ? '\nAll journey checks passed.' : `\n${failures} journey check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
