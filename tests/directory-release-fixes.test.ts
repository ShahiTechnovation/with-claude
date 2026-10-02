/**
 * Release fixes after review: the directory host, email local parts, IPv6
 * forms that wrap private IPv4, regional LinkedIn hosts, YouTube identity,
 * NUL bytes in search, and "How Claude was used" fragments.
 */
import { describe, expect, it } from 'vitest';
import { routeDirectoryHost, DIRECTORY_HOST } from '../src/lib/directory-host';
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

  it('leaves every other host alone', () => {
    for (const h of ['www.withclaude.in', 'withclaude.in', 'with-claude.vercel.app', 'localhost', 'projects.withclaude.in.evil.com']) {
      expect(routeDirectoryHost(h, '/', '').kind, h).toBe('pass');
      expect(routeDirectoryHost(h, '/events/x/', '').kind, h).toBe('pass');
    }
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
