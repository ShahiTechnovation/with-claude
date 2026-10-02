/**
 * LINKS, THE SAFE FETCHER, FAVICONS AND THE LOGO BOX.
 *
 * Every network call here goes through injected `resolve`/`transport`
 * functions — no test touches the network, and no participant site.
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { classifyUrl, comparableUrl, extractUrlTokens, isPrivateHost, linksInCell } from '../scripts/import/lib/links';
import { artifactKey } from '../scripts/import/lib/normalise';
import { assertSafeUrl, safeFetch, UnsafeTarget, type SafeFetchOptions } from '../scripts/import/lib/safe-fetch';
import { decodeIcon, iconCandidates, isPlatformIconHost, readIco } from '../scripts/media/logos';
import { resolveLogoSource, PLACEHOLDER_VARIANTS } from '../src/lib/project-logo';
import { artifactAction, artifactActions, buildStatusLabel, excerpt, narrativeBlocks } from '../src/lib/project-display';

describe('link classification', () => {
  it('rejects credential-bearing and admin URLs whole', () => {
    expect(classifyUrl('https://x.example.com/admin?key=abc', 'live')).toBe('credential-bearing');
    expect(classifyUrl('https://x.example.com/admin/panel', 'live')).toBe('admin-route');
    expect(classifyUrl('https://user:pw@x.example.com/', 'live')).toBe('credential-bearing');
    expect(classifyUrl('https://x.example.com/?token=t', 'live')).toBe('credential-bearing');
  });

  it('rejects private, loopback and link-local hosts', () => {
    for (const u of ['http://localhost:8765/', 'http://127.0.0.1/', 'http://10.0.0.5/', 'http://192.168.1.2/', 'http://169.254.169.254/latest', 'http://[::1]/']) {
      expect(classifyUrl(u, 'repo')).toBe('private-host');
    }
    expect(isPrivateHost('100.64.0.1')).toBe(true);
    expect(isPrivateHost('8.8.8.8')).toBe(false);
  });

  it('a hosting dashboard is not a demo', () => {
    expect(classifyUrl('https://vercel.com/team/project', 'live')).toBe('hosting-dashboard');
  });

  it('types GitHub links: repo, release download, README → repo, profile', () => {
    expect(classifyUrl('https://github.com/a/b.git', 'repo')).toMatchObject({ kind: 'repo', url: 'https://github.com/a/b' });
    expect(classifyUrl('https://github.com/a/b/releases/tag/v1.0', 'live')).toMatchObject({ kind: 'download' });
    expect(classifyUrl('https://github.com/a/b/blob/main/README.md', 'live')).toMatchObject({ kind: 'repo', url: 'https://github.com/a/b', flags: ['readme-to-repo'] });
    expect(classifyUrl('https://github.com/someone', 'repo')).toMatchObject({ kind: 'profile' });
    expect(classifyUrl('https://someone.github.io/app/', 'repo')).toMatchObject({ kind: 'live' });
  });

  it('removes _vercel_share and flags tunnels', () => {
    const shared = classifyUrl('https://app.vercel.app/?_vercel_share=abc', 'live');
    expect(shared).toMatchObject({ url: 'https://app.vercel.app/', flags: ['access-param-removed'] });
    expect(classifyUrl('https://abc.ngrok-free.dev/', 'live')).toMatchObject({ flags: ['tunnel'] });
    expect(classifyUrl('https://a-b-c.trycloudflare.com', 'live')).toMatchObject({ flags: ['tunnel'] });
  });

  it('slides, Drive folders and videos are typed by the field they were submitted in', () => {
    expect(classifyUrl('https://docs.google.com/presentation/d/x/edit', 'video')).toMatchObject({ kind: 'artifact' });
    expect(classifyUrl('https://drive.google.com/drive/folders/x', 'video')).toMatchObject({ kind: 'video' });
    expect(classifyUrl('https://drive.google.com/file/d/x/view', 'attachment')).toMatchObject({ kind: 'artifact' });
    expect(classifyUrl('https://youtu.be/abc', 'live')).toMatchObject({ kind: 'video' });
    expect(classifyUrl('https://x.com/a/status/1', 'showcase')).toMatchObject({ kind: 'post' });
  });

  it('extracts URLs from prose, splits pasted-twice URLs, repairs trailing backslashes', () => {
    const twice = 'https://docs.google.com/videos/d/1/edit?usp=drive_linkhttps://docs.google.com/videos/d/1/edit?usp=drive_link';
    const cell = linksInCell(twice, 'video');
    expect(cell.links).toHaveLength(1);
    expect(cell.duplicatedInCell).toBe(true);
    const prose = linksInCell('The demo 👇  https://headroom-x.vercel.app  #ClaudeBhopal', 'live');
    expect(prose.links.map((l) => l.url)).toEqual(['https://headroom-x.vercel.app/']);
    expect(prose.links[0]!.flags).toContain('embedded');
    const slash = linksInCell('https://drive.google.com/file/d/Z/view?usp=sharing\\\\', 'video');
    expect(slash.links[0]!.url).toBe('https://drive.google.com/file/d/Z/view?usp=sharing');
    expect(slash.links[0]!.flags).toContain('trimmed');
    const two = linksInCell('https://affectedly.ngrok-free.dev/, https://pothole.example.fun', 'live');
    expect(two.links.map((l) => l.host)).toEqual(['affectedly.ngrok-free.dev', 'pothole.example.fun']);
  });

  it('handles shorthand and scheme-less input, and never treats a name or an email as a link', () => {
    expect(linksInCell('owner-1/repo.name', 'repo').links[0]).toMatchObject({ url: 'https://github.com/owner-1/repo.name', flags: ['shorthand-repo'] });
    expect(linksInCell('GitHub.com/A/B', 'repo').links[0]).toMatchObject({ url: 'https://github.com/A/B', flags: ['scheme-added'] });
    expect(linksInCell('Some Person', 'live')).toMatchObject({ links: [], nonLinkText: true });
    expect(linksInCell('@handle', 'repo').links).toEqual([]);
    expect(extractUrlTokens('mail me at person@example.com').tokens).toEqual([]);
  });

  it('artifact identity keeps the parameter that IS the identity (Drive id, YouTube v)', () => {
    expect(artifactKey('https://drive.google.com/open?id=A')).not.toBe(artifactKey('https://drive.google.com/open?id=B'));
    expect(artifactKey('https://drive.google.com/open?id=A')).toBe(artifactKey('https://drive.google.com/file/d/A/view?usp=sharing'));
    expect(artifactKey('https://www.youtube.com/watch?v=X&si=1')).toBe(artifactKey('https://youtu.be/X'));
    expect(artifactKey('https://www.youtube.com/watch?v=X')).not.toBe(artifactKey('https://youtube.com/watch?v=Y'));
    expect(artifactKey('https://github.com/A/B.git')).toBe(artifactKey('https://github.com/a/b/'));
    expect(comparableUrl('https://drive.google.com/open?id=A')).toBe(comparableUrl('https://drive.google.com/file/d/A/view'));
  });
});

// ── the safe fetcher ─────────────────────────────────────────────────────

function fakeNet(routes: Record<string, { status: number; headers?: Record<string, string>; body?: string | Buffer }>, dns: Record<string, string[]> = {}) {
  const calls: string[] = [];
  const opts: Pick<SafeFetchOptions, 'resolve' | 'transport'> = {
    resolve: async (host) => dns[host] ?? ['93.184.216.34'],
    transport: async (url, address) => {
      calls.push(`${url.toString()}@${address}`);
      const r = routes[url.toString()] ?? { status: 404 };
      const body = Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.body ?? '');
      return { status: r.status, headers: r.headers ?? {}, body, truncated: false };
    },
  };
  return { opts, calls };
}

describe('safeFetch', () => {
  it('refuses unsafe targets before connecting', () => {
    for (const u of ['ftp://x.example.com/', 'http://localhost/', 'https://10.1.1.1/', 'https://x.example.com:8443/', 'https://u:p@x.example.com/', 'https://x.example.com/admin?key=1', 'https://intranet/']) {
      expect(() => assertSafeUrl(u), u).toThrow(UnsafeTarget);
    }
  });

  it('refuses a public name that resolves to a private address (DNS rebinding)', async () => {
    const { opts, calls } = fakeNet({}, { 'evil.example.com': ['127.0.0.1'] });
    await expect(safeFetch('https://evil.example.com/', opts)).rejects.toThrow(/private address/);
    expect(calls).toEqual([]);
  });

  it('connects to the validated address and follows a bounded, re-validated redirect chain', async () => {
    const { opts, calls } = fakeNet({
      'https://a.example.com/': { status: 301, headers: { location: 'https://b.example.com/x' } },
      'https://b.example.com/x': { status: 200, body: 'ok' },
    });
    const res = await safeFetch('https://a.example.com/', opts);
    expect(res.status).toBe(200);
    expect(res.finalUrl).toBe('https://b.example.com/x');
    expect(calls).toEqual(['https://a.example.com/@93.184.216.34', 'https://b.example.com/x@93.184.216.34']);
  });

  it('refuses a redirect into a private network', async () => {
    const { opts } = fakeNet({ 'https://a.example.com/': { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } } });
    await expect(safeFetch('https://a.example.com/', opts)).rejects.toThrow(UnsafeTarget);
  });

  it('stops after too many redirects', async () => {
    const loop = { status: 302, headers: { location: 'https://a.example.com/' } };
    const { opts } = fakeNet({ 'https://a.example.com/': loop });
    await expect(safeFetch('https://a.example.com/', { ...opts, maxRedirects: 3 })).rejects.toThrow(/too many redirects/);
  });
});

// ── favicons ─────────────────────────────────────────────────────────────

const png = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 4, background: { r: 158, g: 69, b: 38, alpha: 1 } } }).png().toBuffer();

function icoWithPng(inner: Buffer, size: number): Buffer {
  const head = Buffer.alloc(6 + 16);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(1, 4);
  head[6] = size >= 256 ? 0 : size;
  head[7] = size >= 256 ? 0 : size;
  head.writeUInt16LE(1, 10);
  head.writeUInt16LE(32, 12);
  head.writeUInt32LE(inner.length, 14);
  head.writeUInt32LE(22, 18);
  return Buffer.concat([head, inner]);
}

describe('favicon discovery and decoding', () => {
  it('reads declared icons as text: largest first, never SVG, data: or script URLs; falls back to /favicon.ico', () => {
    const html = `<head>
      <link rel="icon" href="/small.png" sizes="16x16">
      <link rel="apple-touch-icon" href="/apple.png">
      <link rel="icon" type="image/svg+xml" href="/logo.svg">
      <link rel="icon" href="data:image/png;base64,xx">
      <link rel="icon" href="javascript:alert(1)">
      <script>document.write('<link rel=icon href=/evil.png>')</script>
    </head>`;
    const c = iconCandidates(html, 'https://site.example.com/app/');
    expect(c.map((x) => x.url)).toEqual([
      'https://site.example.com/apple.png',
      'https://site.example.com/small.png',
      'https://site.example.com/favicon.ico',
    ]);
  });

  it('accepts a real raster and re-encodes it to PNG', async () => {
    const icon = await decodeIcon(await png(64, 64), 'image/png');
    expect(typeof icon).toBe('object');
    if (typeof icon === 'object') {
      expect([icon.width, icon.height]).toEqual([64, 64]);
      expect(icon.png.subarray(1, 4).toString()).toBe('PNG');
    }
  });

  it('reads the PNG inside an ICO container', async () => {
    const ico = icoWithPng(await png(48, 48), 48);
    expect(readIco(ico)).toHaveProperty('png');
    const icon = await decodeIcon(ico, 'image/x-icon');
    expect(typeof icon === 'object' && icon.width).toBe(48);
  });

  it('refuses SVG (even mislabelled), HTML, corrupt bytes and unusably small icons — and never upscales', async () => {
    expect(await decodeIcon(Buffer.from('<svg onload="alert(1)"></svg>'), 'image/png')).toBe('svg');
    expect(await decodeIcon(Buffer.from('<svg/>'), 'image/svg+xml')).toBe('svg');
    expect(await decodeIcon(Buffer.from('<!doctype html><title>404</title>'), 'text/html')).toBe('not-an-image');
    expect(await decodeIcon(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), 'image/png')).toBe('not-an-image');
    expect(await decodeIcon(await png(16, 16), 'image/png')).toBe('too-small');
    const big = await decodeIcon(await png(512, 512), 'image/png');
    expect(typeof big === 'object' && big.width).toBe(256);
  });

  it('a hosting platform’s icon is never a project brand', () => {
    for (const h of ['github.com', 'drive.google.com', 'www.youtube.com', 'claude.ai', 'nagar-setu.streamlit.app', 'vercel.com']) expect(isPlatformIconHost(h), h).toBe(true);
    expect(isPlatformIconHost('my-project.vercel.app')).toBe(false);
  });
});

// ── the logo box ─────────────────────────────────────────────────────────

describe('resolveLogoSource', () => {
  const media = (provenance: string | null) => ({ url: 'https://store.example/blob/logo.png', provenance, width: 256, height: 256 });
  it('prefers an owner or organiser logo, then the cover, then a favicon, then the placeholder', () => {
    expect(resolveLogoSource({ slug: 's', logoPath: null, logoMedia: media('upload'), cover: 'https://store.example/c.png' })).toMatchObject({ kind: 'logo', origin: 'upload' });
    expect(resolveLogoSource({ slug: 's', logoPath: 'logos/x.png', logoMedia: null, cover: 'https://store.example/c.png' })).toMatchObject({ kind: 'logo', origin: 'organiser' });
    expect(resolveLogoSource({ slug: 's', logoPath: null, logoMedia: media('favicon'), cover: 'https://store.example/c.png' })).toMatchObject({ kind: 'cover' });
    expect(resolveLogoSource({ slug: 's', logoPath: null, logoMedia: media('favicon'), cover: null })).toMatchObject({ kind: 'logo', origin: 'favicon' });
    expect(resolveLogoSource({ slug: 's', logoPath: null, logoMedia: null, cover: null })).toMatchObject({ kind: 'placeholder' });
  });
  it('never returns an arbitrary non-https URL or a traversal path', () => {
    expect(resolveLogoSource({ slug: 's', logoPath: '../secret', logoMedia: { url: 'http://x/y.png', provenance: 'upload' }, cover: 'javascript:alert(1)' }).kind).toBe('placeholder');
  });
  it('the placeholder variant is stable per slug and in range', () => {
    const a = resolveLogoSource({ slug: 'alpha', logoPath: null, logoMedia: null, cover: null });
    const b = resolveLogoSource({ slug: 'alpha', logoPath: null, logoMedia: null, cover: null });
    expect(a).toEqual(b);
    if (a.kind === 'placeholder') expect(a.variant).toBeLessThan(PLACEHOLDER_VARIANTS);
  });
});

describe('display helpers', () => {
  it('labels typed artifacts honestly and omits absent ones', () => {
    expect(artifactAction('repo', 'https://github.com/a/b')?.label).toBe('GitHub repository');
    expect(artifactAction('video', 'https://youtu.be/x')?.label).toBe('Watch demo (YouTube)');
    expect(artifactAction('artifact', 'https://docs.google.com/presentation/d/x')?.label).toBe('View slides');
    expect(artifactAction('download', 'https://github.com/a/b/releases/tag/v1')?.label).toBe('Download (GitHub release)');
    expect(artifactAction('live', 'javascript:alert(1)')).toBeNull();
    expect(artifactActions({ url: null, repoUrl: 'https://github.com/a/b', videoUrl: '' }).map((a) => a.kind)).toEqual(['repo']);
  });
  it('build status has no "unknown" label — absent means not stated', () => {
    expect(buildStatusLabel(null)).toBeNull();
    expect(buildStatusLabel('partial')).toBe('Partially functional');
  });
  it('shapes submission text without changing words, and never produces markup', () => {
    const blocks = narrativeBlocks('Intro line\n\n### Who\n* **Customers:** shop\n- Engineers\n\n5 * 3 * 4 and <script>x</script>');
    expect(blocks).toEqual([
      { type: 'p', content: [{ text: 'Intro line' }] },
      { type: 'h', content: [{ text: 'Who' }] },
      { type: 'ul', items: [[{ text: 'Customers:', strong: true }, { text: ' shop' }], [{ text: 'Engineers' }]] },
      { type: 'p', content: [{ text: '5 * 3 * 4 and <script>x</script>' }] },
    ]);
  });
  it('excerpts on a word boundary', () => {
    expect(excerpt('a '.repeat(200), 20).length).toBeLessThanOrEqual(21);
  });
});
