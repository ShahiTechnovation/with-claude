/**
 * The share-card audit sends the deployment-protection secret to the
 * deployment under test and nowhere else, redirects included.
 *
 * `fetch` with `redirect: 'follow'` re-sends custom headers to wherever a
 * redirect points; it strips only `authorization`, `cookie` and a few others.
 * So a deployment that redirects `/sitemap.xml` to another site would hand that
 * site `x-vercel-protection-bypass`. `scripts/dev/visual-review.mjs` closes the
 * same hole for the browser; this pins it for the audit.
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { get } from '../scripts/dev/share-cards-audit.mjs';

const SECRET = { 'x-vercel-protection-bypass': 's3cret' };

let deployment: Server;
let elsewhere: Server;
let base = '';
let other = '';
const seen: { where: string; path: string; headers: IncomingHttpHeaders }[] = [];

function listen(server: Server): Promise<string> {
  return new Promise((done) =>
    server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)),
  );
}

beforeAll(async () => {
  deployment = createServer((req, res) => {
    seen.push({ where: 'deployment', path: req.url ?? '', headers: req.headers });
    if (req.url === '/away') return res.writeHead(302, { location: `${other}/landing` }).end();
    if (req.url === '/moved') return res.writeHead(307, { location: '/here' }).end();
    res.writeHead(200).end('ok');
  });
  elsewhere = createServer((req, res) => {
    seen.push({ where: 'elsewhere', path: req.url ?? '', headers: req.headers });
    res.writeHead(200).end('ok');
  });
  base = await listen(deployment);
  other = await listen(elsewhere);
});

afterAll(() => {
  deployment.close();
  elsewhere.close();
});

describe('the audit fetch', () => {
  it('follows a redirect to another origin without the secret', async () => {
    seen.length = 0;
    const res = await get(`${base}/away`, SECRET, new URL(base).origin);
    expect(res.status).toBe(200);

    const landing = seen.find((s) => s.where === 'elsewhere');
    expect(landing, 'the redirect was followed').toBeTruthy();
    expect(landing!.headers['x-vercel-protection-bypass']).toBeUndefined();
    expect(seen.find((s) => s.path === '/away')!.headers['x-vercel-protection-bypass']).toBe('s3cret');
  });

  it('keeps the secret on a redirect within the deployment', async () => {
    seen.length = 0;
    const res = await get(`${base}/moved`, SECRET, new URL(base).origin);
    expect(res.status).toBe(200);
    expect(seen.map((s) => s.path)).toEqual(['/moved', '/here']);
    expect(seen.every((s) => s.headers['x-vercel-protection-bypass'] === 's3cret')).toBe(true);
  });
});
