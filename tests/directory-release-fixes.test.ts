/**
 * Release fixes after review: the directory host, email local parts, IPv6
 * forms that wrap private IPv4, regional LinkedIn hosts, YouTube identity,
 * NUL bytes in search, and "How Claude was used" fragments.
 */
import { readFileSync } from 'node:fs';
import { getTransformedRoutes } from '@vercel/routing-utils';
import { describe, expect, it } from 'vitest';
import { routeDirectoryHost, DIRECTORY_HOST, homeHref, signInHref } from '../src/lib/directory-host';
import { isPrivateHost } from '../src/lib/url-safety';
import { classifyUrl, comparableUrl, extractUrlTokens, linksInCell } from '../scripts/import/lib/links';
import { normaliseDirectoryQuery, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from '../src/server/public/projects';
import { claudeUsageFrom, splitSentences } from '../scripts/import/sources/event-archive-2026-09/index';

describe('projects.withclaude.in', () => {
  it('serves the directory at the root, keeping the query string', () => {
    expect(routeDirectoryHost(DIRECTORY_HOST, '/', '')).toEqual({ kind: 'rewrite', to: '/projects/' });
    expect(routeDirectoryHost(DIRECTORY_HOST, '/', '?event=a&page=2')).toEqual({ kind: 'rewrite', to: '/projects/?event=a&page=2' });
  });

  it('serves project pages, assets and the report endpoint as they are', () => {
    for (const p of ['/projects/', '/projects/disha/', '/_astro/x.js', '/_image/', '/_server-islands/x/', '/api/reports/', '/favicon.svg', '/robots.txt']) {
      expect(routeDirectoryHost(DIRECTORY_HOST, p, ''), p).toEqual({ kind: 'pass' });
    }
  });

  it('sends everything else to the same path on www', () => {
    expect(routeDirectoryHost(DIRECTORY_HOST, '/events/claude-impact-lab-september/', '')).toEqual({
      kind: 'redirect',
      to: 'https://www.withclaude.in/events/claude-impact-lab-september/',
    });
    expect(routeDirectoryHost('PROJECTS.withclaude.in', '/me/projects/new/', '?x=1')).toEqual({
      kind: 'redirect',
      to: 'https://www.withclaude.in/me/projects/new/?x=1',
    });
    // Not a prefix trick: "/projectsX" is not the directory.
    expect(routeDirectoryHost(DIRECTORY_HOST, '/projectsx/', '').kind).toBe('redirect');
  });

  it('points home and sign-in at the main site from the directory host only', () => {
    expect(homeHref(DIRECTORY_HOST)).toBe('https://www.withclaude.in/');
    expect(signInHref('Projects.WithClaude.in')).toBe('https://www.withclaude.in/me/');
    for (const h of ['www.withclaude.in', 'withclaude.in', 'with-claude.vercel.app', 'localhost']) {
      expect(homeHref(h), h).toBe('/');
      expect(signInHref(h), h).toBe('/join/');
    }
  });

  it('never loads sign-in on the directory host (its account calls would be redirected cross-origin)', () => {
    const nav = readFileSync('src/components/AccountNav.astro', 'utf8');
    expect(nav).toContain('const appId = onDirectoryHost ? undefined :');
    expect(nav).toContain('href={signInHref(Astro.url.hostname)} data-account-signin');
    expect(readFileSync('src/components/Breadcrumbs.astro', 'utf8')).toContain("crumb.href === '/' ? homeHref(Astro.url.hostname)");
    expect(readFileSync('src/components/NotFound.astro', 'utf8')).toContain('href={homeHref(Astro.url.hostname)}');
  });

  it('the edge rule in vercel.json and the middleware agree on every path', () => {
    // Prerendered pages never reach the middleware, so the edge rule alone
    // routes them: the two pass-lists must be the same list.
    const vercel = JSON.parse(readFileSync('vercel.json', 'utf8'));
    const { routes, error } = getTransformedRoutes({ redirects: vercel.redirects });
    expect(error).toBeNull();
    type HostRule = { src: string; has?: { type: string; value?: unknown }[] };
    const rule = (routes ?? [])
      .filter((r): r is typeof r & HostRule => 'src' in r)
      .find((r) => r.has?.some((h) => h.type === 'host' && h.value === DIRECTORY_HOST));
    expect(rule).toBeDefined();
    const edgeRedirects = (path: string) => new RegExp(rule!.src).test(path);
    const paths = [
      '/projects/', '/projects/disha/', '/_astro/x.js', '/_image/', '/_image', '/_server-islands/x/', '/api/reports/',
      '/favicon.svg', '/apple-touch-icon.png', '/robots.txt', '/site.webmanifest', '/fonts/a.woff2',
      '/_vercel/insights/script.js', '/_vercel/insights/view',
      '/events/claude-impact-lab-september/', '/me/', '/join/', '/api/member/bootstrap/', '/builders/', '/projectsx/',
    ];
    for (const p of paths) {
      expect(edgeRedirects(p), p).toBe(routeDirectoryHost(DIRECTORY_HOST, p, '').kind === 'redirect');
    }
    // `/` is the directory itself, never sent to www.
    expect(edgeRedirects('/')).toBe(false);
  });

  it('sends Report to the www project page, where the session is', () => {
    const page = readFileSync('src/pages/projects/[slug].astro', 'utf8');
    expect(page).toContain('{isDirectoryHost(Astro.url.hostname) ? (');
    expect(page).toContain('href={`${MAIN_ORIGIN}/projects/${project.slug}/`}');
  });

  it('leaves every other host alone', () => {
    for (const h of ['www.withclaude.in', 'withclaude.in', 'with-claude.vercel.app', 'localhost', 'projects.withclaude.in.evil.com']) {
      expect(routeDirectoryHost(h, '/', '').kind, h).toBe('pass');
      expect(routeDirectoryHost(h, '/events/x/', '').kind, h).toBe('pass');
    }
  });
});

describe('the directory and event pages after review', () => {
  const script = readFileSync('src/scripts/directory.ts', 'utf8');

  it('back/forward follows the history entry, so a Forward replaces an in-flight Back', () => {
    expect(script).toMatch(/if \(here === rendered\) return;[\s\S]{0,200}rendered = here;\s*void navigate\(here, 'none'/);
  });

  it('a failed update never takes focus out of the search box', () => {
    expect(script).toContain("if (!document.activeElement?.matches('[data-dir-q]')) link.focus();");
  });

  it('a sidebar link that survives the swap keeps focus', () => {
    expect(script).toContain('if (!document.contains(link)) count()?.focus(');
  });

  it('the row meta strip does not cover the row link', () => {
    const css = readFileSync('src/styles/directory.css', 'utf8').replace(/\r\n/g, '\n');
    const rule = css.match(/\n\.prow-meta \{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toContain('display: flex');
    expect(rule).not.toMatch(/z-index|position/);
  });

  it("the directory is set in the site's editorial language, not a vocabulary of its own", () => {
    const css = readFileSync('src/styles/directory.css', 'utf8').replace(/\r\n/g, '\n');
    const tokens = readFileSync('src/styles/tokens.css', 'utf8').replace(/\r\n/g, '\n');
    const surfaces = tokens.slice(tokens.indexOf('DIRECTORY SURFACES'));

    // Colours and radii come from the site's tokens: no raw hex (the select's
    // chevron data-URI aside), no pill, and no radius the site does not have.
    expect(css.replace(/url\("data:[^"]*"\)/g, '')).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/border-radius:\s*(\d+px|999)/);
    expect(surfaces).toMatch(/--radius-lg: var\(--radius-sm\);/);
    expect(surfaces).toMatch(/--panel: var\(--paper\);/);
    expect(surfaces).not.toMatch(/#[0-9a-f]{3,8}\b/i);

    // Counts are mono tabular figures with no pill behind them.
    const count = css.match(/\n\.fopt-count,\n\.fall-count \{([^}]*)\}/)?.[1] ?? '';
    expect(count).toContain('font-family: var(--font-mono)');
    expect(count).toContain('tabular-nums');
    expect(count).not.toMatch(/background|border-radius/);

    // The card title takes the title face when the fonts change, Inter until then.
    expect(css.match(/\n\.prow-title \{([^}]*)\}/)?.[1]).toContain('font-family: var(--font-title, var(--font-body))');
  });

  it('small bold headings use the title face, because the display serif only ships light', () => {
    const css = readFileSync('src/styles/directory.css', 'utf8').replace(/\r\n/g, '\n');
    for (const selector of ['.dir-empty h2', '.js .dir-drawer-head h2']) {
      const rule = css.match(new RegExp(`\\n\\s*${selector.replace(/\./g, '\\.')} \\{([^}]*)\\}`))?.[1] ?? '';
      expect(rule, selector).toContain('font-family: var(--font-title, var(--font-body))');
    }
    // The display face is left to the page title alone.
    expect(css.match(/font-family: var\(--font-display\)/g)).toHaveLength(1);
  });

  it('an event page whose projects could not be read is never stored by the CDN', () => {
    const page = readFileSync('src/pages/events/[slug].astro', 'utf8').replace(/\r\n/g, '\n');
    expect(page).toMatch(/eventProjects\(event\.id, 12\)\.catch\([\s\S]{0,500}privateCache\(Astro, false\);\s*projectsFailed = true;/);
  });
});

describe('the directory page size', () => {
  it('is the largest bounded page', () => {
    expect(DEFAULT_PAGE_SIZE).toBe(60);
    expect(MAX_PAGE_SIZE).toBe(60);
  });
});

describe('search input', () => {
  it('drops control characters (a NUL used to fail the whole page)', () => {
    expect(normaliseDirectoryQuery(new URLSearchParams('q=%00')).q).toBeUndefined();
    expect(normaliseDirectoryQuery(new URLSearchParams('q=traffic%00%01ai')).q).toBe('traffic ai');
  });
});

describe('emails are never links', () => {
  it('no part of an address is extracted, whatever its local part looks like', () => {
    for (const email of ['first.dev@example.com', 'contact: priya.in@example.org', 'a.co.in@x.com', 'first+tag.dev@x.com', 'a.in_b@example.org', 'x.app%y@z.io']) {
      expect(linksInCell(email, 'live').links, email).toEqual([]);
      expect(extractUrlTokens(email).tokens, email).toEqual([]);
    }
  });

  it('real links next to or after an @ still work', () => {
    expect(linksInCell('https://medium.com/@user/post', 'live').links.map((l) => l.url)).toEqual(['https://medium.com/@user/post']);
    expect(linksInCell('pothole.akshat.fun', 'live').links.map((l) => l.url)).toEqual(['https://pothole.akshat.fun/']);
    expect(linksInCell('demo: vandanai.in — mail me@x.com', 'live').links.map((l) => l.url)).toEqual(['https://vandanai.in/']);
  });
});

describe('IPv6 forms that wrap a private address', () => {
  it('only ordinary global unicast is public', () => {
    for (const h of ['::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', '::127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::1', '2001:0:5ef5:79fd::1', '2001:db8::1', 'fe80::1', 'fec0::1', 'fc00::1', 'ff02::1', '[::1]', 'nonsense::zz']) {
      expect(isPrivateHost(h), h).toBe(true);
    }
    for (const h of ['2606:4700:4700::1111', '2a00:1450:4001:82a::200e', '[2606:4700::6810:84e5]']) {
      expect(isPrivateHost(h), h).toBe(false);
    }
  });

  it('a trailing dot does not make a local name public', () => {
    for (const url of ['http://localhost./', 'http://localhost../', 'http://app.localhost./', 'http://printer.local./', 'http://metadata.google.internal./']) {
      expect(isPrivateHost(new URL(url).hostname), url).toBe(true);
      expect(classifyUrl(url, 'live'), url).toBe('private-host');
    }
    expect(isPrivateHost('example.com.')).toBe(false);
  });

  it('URL hosts in those forms are refused by the classifier', () => {
    expect(classifyUrl('http://[::ffff:127.0.0.1]/', 'live')).toBe('private-host');
    expect(classifyUrl('http://[64:ff9b::a9fe:a9fe]/latest', 'live')).toBe('private-host');
    expect(classifyUrl('http://2130706433/', 'live')).toBe('private-host'); // decimal 127.0.0.1
  });
});

describe('link typing details', () => {
  it('regional LinkedIn hosts are social, not a live demo', () => {
    expect(classifyUrl('https://in.linkedin.com/posts/someone_x', 'showcase')).toMatchObject({ kind: 'post' });
    expect(classifyUrl('https://uk.linkedin.com/in/someone', 'live')).toMatchObject({ kind: 'profile' });
  });

  it('a YouTube video is its id: two different videos never compare equal', () => {
    expect(comparableUrl('https://www.youtube.com/watch?v=AAA&si=1')).toBe(comparableUrl('https://youtu.be/AAA'));
    expect(comparableUrl('https://youtube.com/watch?v=AAA')).not.toBe(comparableUrl('https://youtube.com/watch?v=BBB'));
  });
});

describe('"How Claude was used" keeps whole sentences only', () => {
  it('does not split inside parentheses', () => {
    expect(splitSentences('It reads the text (does the income match? does it add up?) and decides. Next.')).toEqual([
      'It reads the text (does the income match? does it add up?) and decides.',
      'Next.',
    ]);
  });

  it('drops list lead-ins and bracket fragments', () => {
    const solution =
      'Claude Opus reads the document — typography, OCR text, and cross-field logic (does the declared income match the bank statement? does the arithmetic hold?). Claude investigates the incident using simulated tools, including:\n* Log analysis';
    expect(claudeUsageFrom(solution)).toBe(
      'Claude Opus reads the document — typography, OCR text, and cross-field logic (does the declared income match the bank statement? does the arithmetic hold?).',
    );
  });
});
