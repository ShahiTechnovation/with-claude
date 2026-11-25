/**
 * THE NOVEMBER 2026 BUILD DAY FORM — October's adapter with the November
 * `LabForm`, on synthetic rows only.
 *
 * The real form export never appears in the repository or its tests. These
 * sheets use the real HEADERS (so header verification is exercised) and
 * invented rows: fake people, `example.test` addresses, made-up links.
 */
import { describe, expect, it } from 'vitest';
import {
  assignSlugs,
  buildLabCandidates,
  outputGuard,
  uncheckedUrls,
  type LabForm,
} from '../scripts/import/sources/impact-lab-2026-10/index';
import type { LabEditorial } from '../scripts/import/sources/impact-lab-2026-10/editorial';
import {
  renderLabReport,
  renderProjectsEntries,
} from '../scripts/import/sources/impact-lab-2026-10/report';
import { BUILD_DAY_NOVEMBER, BUILT_AT } from '../scripts/import/sources/build-day-2026-11/index';
import { BUILD_DAY_NOVEMBER_DECISIONS } from '../scripts/import/sources/build-day-2026-11/editorial';
import { CATEGORIES } from '../scripts/import/lib/candidates';
import { publishableUrls } from '../scripts/import/sources/event-archive-2026-09/index';
import { comparableUrl } from '../scripts/import/lib/links';
import type { Workbook } from '../scripts/import/lib/workbook';

const HEADERS = [
  'Timestamp',
  'Email address',
  'Team member 1 (name)',
  'Member 1 Email',
  'Team Name',
  'Member 2 Name',
  'Member 2 Email',
  'Member 3 Name ',
  'Member 3 email',
  'Member 4 Name ',
  'Member 4 email',
  'Member 5 Name',
  'Member 5 Email',
  'Number of Team Members',
  'Project Name',
  'Which track did you pick?',
  'What problem are you solving?',
  'Tell us about your solution',
  'What did you build it with?',
  'How did you use Fable 5.2, and which new capability does your project lean on?',
  'Project link (GitHub repo, gist or deployed URL)',
  'Live or Deployed Project',
  'Demo video link (YouTube, Drive or Loom)',
  'Demo Video (optional)',
  'Built today',
  'Our Work',
  'Everything Works',
  'Final Confirmation',
  'Anything else you want us to know?',
];
const EMAILS = [1, 3, 6, 8, 10, 12];
const AC = 28;
const TRACK = 'Delight: something surprising, beautiful or fun';
const NOTE = 'Test login: demo / hunter2';

interface RowSpec {
  team: string;
  title: string;
  repo?: string;
  live?: string;
  video?: string;
  video2?: string;
  names?: string[];
}

function dayRow(o: RowSpec): string[] {
  const r = new Array<string>(29).fill('');
  r[0] = '46348.6';
  r[1] = 'lead@example.test';
  const names = o.names ?? ['Test Person'];
  [2, 5, 7, 9, 11].forEach((col, i) => (r[col] = names[i] ?? ''));
  [3, 6, 8, 10, 12].forEach((col, i) => (r[col] = names[i] ? `m${i}@example.test` : ''));
  r[4] = o.team;
  r[13] = String(names.length);
  r[14] = o.title;
  r[15] = TRACK;
  r[16] = `Problem of ${o.title}.`;
  r[17] = `Solution of ${o.title}.`;
  r[18] = 'Three.js and Claude Code';
  r[19] = `We used Fable 5.2 to build ${o.title}.`;
  r[20] = o.repo ?? '';
  r[21] = o.live ?? '';
  r[22] = o.video ?? '';
  r[23] = o.video2 ?? '';
  r[24] = r[25] = r[26] = r[27] = 'I confirm';
  r[AC] = NOTE;
  return r;
}

/** Email and AC cells throw when their value is fetched: the adapter must never touch them. */
const sealed = (row: string[]) => {
  for (const i of [...EMAILS, AC])
    Object.defineProperty(row, i, {
      get() {
        throw new Error(`private cell ${i} read`);
      },
    });
  return row;
};

const sheet = (rows: string[][]): Workbook => ({
  format: 'xlsx',
  sheets: [
    { name: 'Form responses 1', rows, dateCells: new Set(), formulaCells: 0, hidden: false },
  ],
  hasMacros: false,
  date1904: false,
  checksum: 'synthetic',
});

const EVENT = { key: 'evt-test-build-day', baserowRowId: 22 };

function fixture(seal = false) {
  const blank = new Array<string>(29).fill('');
  blank[1] = 'late@example.test';
  blank[AC] = NOTE;
  const rows = [
    dayRow({
      team: 'Orbit',
      title: 'Orbit Game',
      repo: 'https://github.com/orbit/orbit-game',
      live: 'https://orbit.example.org',
      video: 'https://youtu.be/AAA111',
      video2: 'https://drive.google.com/open?id=BBB222',
      names: ['Ann One', 'Bo Two'],
    }),
    dayRow({
      team: 'Twins',
      title: 'Twin Cells',
      repo: 'https://twin.example.org/',
      live: 'https://twin.example.org/',
    }),
    dayRow({ team: 'Bare', title: 'Bare Domain', live: 'bare-domain.vercel.app' }),
    dayRow({
      team: 'Eve Six',
      title: 'City Run',
      repo: 'https://github.com/city/run',
      live: 'https://city-run.example.org/',
      names: ['Eve Six'],
    }),
    dayRow({ team: 'Gamma', title: 'Gamma Tool', repo: 'https://github.com/gamma/gamma-tool' }),
    dayRow({
      team: 'Gamma',
      title: 'Gamma Tool',
      repo: 'https://github.com/gamma/gamma-tool',
      names: ['Dee Four', 'Fay Five'],
    }),
    blank,
  ];
  const workbook = sheet([[...HEADERS], ...(seal ? rows.map(sealed) : rows)]);
  const decisions: Record<number, LabEditorial> = {
    2: {
      expect: 'orbit/orbit-game',
      disposition: 'publish',
      summary: 'Orbit summary.',
      category: 'creative',
    },
    3: {
      expect: 'twin.example.org',
      disposition: 'publish',
      summary: 'Twin summary.',
      category: 'product',
    },
    4: {
      expect: 'bare-domain.vercel.app',
      disposition: 'publish',
      summary: 'Bare summary.',
      category: 'product',
    },
    5: {
      expect: 'city/run',
      disposition: 'publish',
      summary: 'City summary.',
      category: 'creative',
    },
    6: {
      expect: 'gamma/gamma-tool',
      disposition: 'dropped',
      holds: ['same repository as row 7, which came later — row 7 is kept'],
    },
    7: {
      expect: 'gamma/gamma-tool',
      disposition: 'hold',
      summary: 'Gamma summary.',
      category: 'product',
      holds: ['description: Q7 and R7 are one line each — ask the team for a short description'],
    },
  };
  const form: LabForm = { ...BUILD_DAY_NOVEMBER, decisions };
  return { workbook, decisions, form };
}

const run = (verified = {}) => {
  const { workbook, form } = fixture();
  return buildLabCandidates(workbook, EVENT, verified, form.decisions, form);
};
const row = (r: ReturnType<typeof run>, n: number) => r.rows.find((x) => x.row === n)!;
const byTitle = (r: ReturnType<typeof run>, title: string) =>
  r.candidates.find((c) => c.title === title)!;

describe('headers and reconciliation', () => {
  it('accounts for every row; a row holding only an email and an AC note is blank', () => {
    expect(run().totals).toEqual({
      sourceRows: 6,
      candidates: 5,
      publish: 4,
      hold: 1,
      dropped: 1,
      merged: 0,
    });
  });

  it('refuses a changed form (header check), the AC header included', () => {
    for (const col of [19, AC]) {
      const { workbook, form } = fixture();
      workbook.sheets[0]!.rows[0]![col] = 'Something else';
      expect(() => buildLabCandidates(workbook, EVENT, {}, form.decisions, form)).toThrow(
        /the form changed/,
      );
    }
  });
});

describe('privacy', () => {
  const { workbook, form } = fixture();
  const r = run();
  const everything =
    JSON.stringify(r) +
    renderLabReport(r, { generatedAt: 'test', form }) +
    renderProjectsEntries(r, assignSlugs(r.candidates, []), '../src/data/types', form);

  it('never fetches an email or AC cell, in the adapter, the guard or the report', () => {
    const sealedRun = fixture(true);
    const built = buildLabCandidates(
      sealedRun.workbook,
      EVENT,
      {},
      sealedRun.form.decisions,
      sealedRun.form,
    );
    expect(built.totals.candidates).toBe(5);
    const guard = outputGuard(sealedRun.workbook, sealedRun.form);
    expect(guard(renderLabReport(built, { generatedAt: 'test', form: sealedRun.form }))).toMatch(
      /Fable 5\.2 Build Day/,
    );
  });

  it('keeps emails, member names, AC, confirmations and timestamps out of every output', () => {
    expect(everything).not.toMatch(/@example\.test/);
    for (const name of ['Ann One', 'Bo Two', 'Eve Six', 'Dee Four', 'Fay Five', 'Test Person'])
      expect(everything).not.toContain(name);
    expect(everything).not.toContain(NOTE);
    expect(everything).not.toContain('hunter2');
    expect(everything).not.toContain('I confirm');
    expect(everything).not.toContain('46348');
    for (const c of r.candidates) expect(c.credits).toEqual([]);
  });

  it('the guard refuses an email or a member’s full name, whatever the case', () => {
    const guard = outputGuard(workbook, form);
    expect(guard(everything)).toBe(everything);
    expect(() => guard('mail someone@example.org')).toThrow(/email/);
    expect(() => guard('Built by DEE  FOUR')).toThrow(/member’s name/);
    expect(guard('Dee reviewed it')).toBe('Dee reviewed it');
  });

  it('withholds a team label that holds a member’s name', () => {
    expect(byTitle(r, 'City Run').teamName).toBeNull();
    expect(row(r, 5).notes).toContain('E5 contains a member’s name — not published');
    expect(byTitle(r, 'Orbit Game').teamName).toBe('Orbit');
    expect(r.rows.filter((x) => x.teamLabelWithheld).map((x) => x.row)).toEqual([5]);
  });
});

describe('links, the track and the outputs', () => {
  const { form } = fixture();
  const r = run();

  it('U is the repository, V the live site, W the demo and X the second video', () => {
    const orbit = byTitle(r, 'Orbit Game');
    expect(orbit.repoUrl).toBe('https://github.com/orbit/orbit-game');
    expect(orbit.liveUrl).toBe('https://orbit.example.org/');
    expect(orbit.videoUrl).toBe('https://youtu.be/AAA111');
    expect(orbit.altVideoUrl).toBe('https://drive.google.com/open?id=BBB222');
    expect(orbit.tags).toEqual(['Delight']);
  });

  it('every tag the November form emits is P before the colon, 32 characters or fewer', () => {
    // 32: the longest tag Baserow's DTO keeps (src/server/integrations/baserow/dto.ts).
    const tags = Object.entries(BUILD_DAY_NOVEMBER.trackTags!);
    expect(tags).toHaveLength(3);
    for (const [track, tag] of tags) {
      expect(tag).toBe(track.split(':')[0]);
      expect(tag.length).toBeLessThanOrEqual(32);
    }
    for (const c of r.candidates)
      for (const tag of c.tags) expect(tag.length).toBeLessThanOrEqual(32);
  });

  it('refuses a track the form has no tag for', () => {
    const { workbook, form } = fixture();
    workbook.sheets[0]!.rows[2]![15] = 'Something else: a new track';
    expect(() => buildLabCandidates(workbook, EVENT, {}, form.decisions, form)).toThrow(
      /P3 holds a track the form has no tag for/,
    );
  });

  it('lists every link the check never saw, so the plan can refuse to run', () => {
    expect(uncheckedUrls(r.candidates, {})).toEqual(publishableUrls(r.candidates));
    expect(uncheckedUrls(r.candidates, {}).length).toBeGreaterThan(0);
    const all = Object.fromEntries(
      publishableUrls(r.candidates).map((u) => [
        comparableUrl(u),
        { ok: true, status: 200, checkedAt: '2026-11-24T00:00:00Z' },
      ]),
    );
    expect(uncheckedUrls(r.candidates, all)).toEqual([]);
    // A link the check found gone is withheld, so nothing is left unchecked.
    const gone = {
      ...all,
      'github.com/gamma/gamma-tool': { ok: false, status: 404, checkedAt: '2026-11-24T00:00:00Z' },
    };
    expect(uncheckedUrls(run(gone).candidates, gone)).toEqual([]);
  });

  it('names the cells in its notes by the November columns', () => {
    expect(row(r, 3).notes).toContain('U3 and V3 hold the same link — shown once');
    expect(row(r, 4).notes).toContain('V4 had no scheme; https:// added');
    expect(byTitle(r, 'Bare Domain').liveUrl).toBe('https://bare-domain.vercel.app/');
  });

  it('a link the check found gone is withheld, and the row is held', () => {
    const checked = run({
      'github.com/gamma/gamma-tool': { ok: false, status: 404, checkedAt: '2026-11-24T00:00:00Z' },
    });
    expect(byTitle(checked, 'Gamma Tool').repoUrl).toBeNull();
    expect(byTitle(checked, 'Gamma Tool').editorial?.reasons.join(' ')).toMatch(
      /no usable public artifact/,
    );
  });

  it('the report quotes the November basis and keeps no October leftovers', () => {
    const report = renderLabReport(r, { generatedAt: 'test', form });
    expect(report).toContain('# Fable 5.2 Build Day import — reconciliation report');
    expect(report).toContain('`npm run import -- build-day-nov-report`');
    expect(report).toContain('Confirmed by Vishal 2026-11-24, 16:36: "Yes, with team names"');
    expect(report).toContain('| Fable 5.2 Build Day (2026-11-22) | 6 | 5 | 4 | 1 | 1 | 0 |');
    expect(report).toContain('Team labels that are not a publishable team name: E5.');
    expect(report).not.toMatch(/lab-oct|Impact Lab|2026-10|W–Z|blank confirmation|\bAA\b/);
  });

  it('writes the published rows with the Build Day card line, date and event', () => {
    const ts = renderProjectsEntries(r, assignSlugs(r.candidates, []), '../src/data/types', form);
    expect(ts.match(/^ {2}\{$/gm)).toHaveLength(4);
    expect(ts).toContain('// ── Fable 5.2 Build Day, 22 November 2026 — 4 published projects ──');
    expect(ts).toContain('build-day-nov-report --ts`; see docs/imports/2026-11-build-day.md.');
    expect(ts).toContain(`summary: '${BUILT_AT}',`);
    expect(BUILT_AT).toBe('Built at Fable 5.2 Build Day · 22 Nov 2026');
    expect(ts).toContain("createdAt: '2026-11-22',");
    expect(ts).toContain("builtAtEventSlug: 'claude-build-day-22-november',");
    expect(ts).not.toMatch(/Gamma Tool|lab-oct|Impact Lab|2026-10/);
  });
});

describe('the reviewed November decisions (no real data)', () => {
  const d = BUILD_DAY_NOVEMBER_DECISIONS;
  const rowsWith = (disposition: LabEditorial['disposition']) =>
    Object.entries(d)
      .filter(([, e]) => e.disposition === disposition)
      .map(([n]) => Number(n));

  it('cover rows 2–37 once each: 19 publish, 14 held, rows 8, 26 and 30 dropped', () => {
    expect(Object.keys(d).map(Number)).toEqual(Array.from({ length: 36 }, (_, i) => i + 2));
    expect(rowsWith('dropped')).toEqual([8, 26, 30]);
    expect(rowsWith('publish')).toEqual([
      4, 5, 6, 7, 9, 10, 12, 14, 19, 21, 22, 25, 27, 28, 29, 31, 34, 35, 37,
    ]);
    expect(rowsWith('hold')).toEqual([2, 3, 11, 13, 15, 16, 17, 18, 20, 23, 24, 32, 33, 36]);
  });

  it('holds Mesh (row 18) until the team confirms it was built on the day', () => {
    expect(d[18]!.holds!.join(' ')).toMatch(/SIH 2026.*built on the day/);
  });

  it('every kept row has a card line of 160 characters at most and a site category; nothing private', () => {
    for (const [n, e] of Object.entries(d)) {
      if (e.disposition === 'dropped') {
        expect(e.holds?.length, `row ${n}`).toBeGreaterThan(0);
        continue;
      }
      expect(e.summary, `row ${n}`).toBeTruthy();
      expect(e.summary!.length, `row ${n}`).toBeLessThanOrEqual(160);
      expect(e.summary, `row ${n}`).not.toMatch(/^Built at/);
      expect(CATEGORIES as readonly string[]).toContain(e.category);
    }
    expect(JSON.stringify(d)).not.toMatch(/@/);
  });

  it('no identity check is an opaque id (a file id would cite a withheld link)', () => {
    for (const [n, e] of Object.entries(d))
      expect(e.expect, `row ${n}`).not.toMatch(/^(?=.*[A-Z])(?=.*\d)[\w-]{25,}$/);
  });

  it('reads the November columns, and never AC', () => {
    expect(BUILD_DAY_NOVEMBER.unread).toEqual([AC]);
    expect(BUILD_DAY_NOVEMBER.source.headers[AC]).toBe('anything else');
    expect(BUILD_DAY_NOVEMBER.columns).toMatchObject({
      title: 14,
      track: 15,
      repo: [20],
      live: [21],
      video: [22, 23],
      confirmations: [24, 25, 26, 27],
    });
  });
});
