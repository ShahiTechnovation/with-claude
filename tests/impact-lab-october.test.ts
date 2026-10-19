/**
 * THE OCTOBER 2026 IMPACT LAB SOURCE ADAPTER — synthetic rows only.
 *
 * The real form export never appears in the repository or its tests. These
 * sheets use the real HEADERS (so header verification is exercised) and
 * invented rows: fake people, `example.test` addresses, made-up links.
 */
import { describe, expect, it } from 'vitest';
import {
  assignSlugs,
  buildLabCandidates,
  BUILT_AT,
  cutAtSentence,
  outputGuard,
  planDecisions,
  SOURCE,
} from '../scripts/import/sources/impact-lab-2026-10/index';
import {
  IMPACT_LAB_OCTOBER,
  type LabEditorial,
} from '../scripts/import/sources/impact-lab-2026-10/editorial';
import {
  renderLabReport,
  renderProjectsEntries,
} from '../scripts/import/sources/impact-lab-2026-10/report';
import { CATEGORIES, type Candidate } from '../scripts/import/lib/candidates';
import { buildPlan } from '../scripts/import/lib/plan';
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
  'What problem are you solving?',
  'Tell us about your solution',
  'What did you build it with?',
  'How did you use Claude or Claude Code?',
  'GitHub Repository',
  'Live or Deployed Project',
  'Demo Video',
  'GitHub and Hackathon Work',
  'Our Work',
  'Everything Works',
  'Final Confirmation',
  'Anything else you want us to know?',
  'Selected track',
];

interface RowSpec {
  team: string;
  title: string;
  repo?: string;
  live?: string;
  video?: string;
  names?: string[];
  size?: string;
  solution?: string;
  stack?: string;
  usage?: string;
}

function labRow(o: RowSpec): string[] {
  const r = new Array<string>(28).fill('');
  r[0] = '46306.62';
  r[1] = 'lead@example.test';
  const names = o.names ?? ['Test Person'];
  [2, 5, 7, 9, 11].forEach((col, i) => (r[col] = names[i] ?? ''));
  [3, 6, 8, 10, 12].forEach((col, i) => (r[col] = names[i] ? `m${i}@example.test` : ''));
  r[4] = o.team;
  r[13] = o.size ?? String(names.length);
  r[14] = o.title;
  r[15] = `Problem of ${o.title}.`;
  r[16] = o.solution ?? `Solution of ${o.title}. Claude drafts the plan for each officer.`;
  r[17] = o.stack ?? 'Python, Claude API';
  r[18] = o.usage ?? `We used Claude Code to build ${o.title}.`;
  r[19] = o.repo ?? '';
  r[20] = o.live ?? '';
  r[21] = o.video ?? '';
  r[22] = r[23] = r[24] = r[25] = 'I confirm';
  r[26] = 'Private note for organisers';
  r[27] = 'Track 2: Visarjan Ghat Watch';
  return r;
}

const sheet = (rows: string[][]): Workbook => ({
  format: 'xlsx',
  sheets: [
    { name: 'Form responses 1', rows, dateCells: new Set(), formulaCells: 0, hidden: false },
  ],
  hasMacros: false,
  date1904: false,
  checksum: 'synthetic',
});

const LONG_USAGE = `${'Claude Code wrote the scoring module and its tests. '.repeat(25)}The end.`;
const LONG_STACK = `${'Python and pandas clean the readings for the dashboard. '.repeat(40)}Done.`;
const EVENT = { key: 'evt-test-lab-oct', baserowRowId: 21 };

function fixture() {
  const workbook = sheet([
    [...HEADERS],
    labRow({
      team: 'Team Alpha',
      title: 'Alpha Tool',
      repo: 'https://github.com/alpha/alpha-tool',
      live: 'alpha-tool.vercel.app',
      video: 'https://drive.google.com/open?id=AAA',
      names: ['Ann One', 'Bo Two'],
      size: '3',
      usage: LONG_USAGE,
    }),
    labRow({
      team: 'Cy Three (solo)',
      title: 'Beta Board',
      repo: 'https://github.com/beta/beta-board',
      names: ['Cy Three'],
    }),
    labRow({ team: 'Gamma', title: 'Ghat Watch', repo: 'https://github.com/gamma/ghat-watch' }),
    labRow({
      team: 'Delta',
      title: 'ghat-watch',
      repo: 'https://github.com/delta/gw',
      live: 'https://github.com/delta/gw',
    }),
    labRow({
      team: 'Hawks',
      title: 'Epsilon AI',
      repo: 'https://github.com/eps/eps',
      live: 'http://localhost:3000',
    }),
    labRow({
      team: 'Hawks',
      title: 'Zeta Tool',
      repo: 'https://github.com/zeta/zeta',
      live: 'zeta-app.vercal.app',
    }),
    labRow({
      team: 'https://eta.example.org',
      title: 'Eta',
      repo: 'https://github.com/eta/eta',
      usage: '',
      stack: LONG_STACK,
    }),
    labRow({
      team: 'Theta',
      title: '**Theta’s Tool**',
      live: 'https://theta.example.org/',
      names: ['Test Person', 'Claude', 'Claude'],
      size: '1',
      usage: 'Yes',
    }),
  ]);
  const decisions: Record<number, LabEditorial> = {
    2: {
      expect: 'alpha/alpha-tool',
      disposition: 'publish',
      summary: 'Alpha summary for the card.',
      category: 'product',
    },
    3: {
      expect: 'beta/beta-board',
      disposition: 'publish',
      summary: 'Beta summary for the card.',
      category: 'product',
    },
    4: {
      expect: 'gamma/ghat-watch',
      disposition: 'publish',
      summary: 'Gamma summary.',
      category: 'product',
    },
    5: {
      expect: 'delta/gw',
      disposition: 'publish',
      summary: 'Delta summary.',
      category: 'research',
    },
    6: {
      expect: 'eps/eps',
      disposition: 'dropped',
      holds: ['same team as row 7 — the later row is kept'],
    },
    7: {
      expect: 'zeta/zeta',
      disposition: 'hold',
      summary: 'Zeta summary.',
      category: 'product',
      holds: ['title: confirm the name'],
      links: { live: 'https://zeta-app.vercel.app/' },
    },
    8: {
      expect: 'eta/eta',
      disposition: 'publish',
      summary: 'Eta summary.',
      category: 'product',
      withholdTeamLabel: true,
    },
    9: {
      expect: 'theta.example.org',
      disposition: 'publish',
      summary: "It's Theta's summary.",
      category: 'agent',
      usageFromNarrative: true,
    },
  };
  return { workbook, decisions };
}

const run = (verified = {}) => {
  const { workbook, decisions } = fixture();
  return buildLabCandidates(workbook, EVENT, verified, decisions);
};
const row = (r: ReturnType<typeof run>, n: number) => r.rows.find((x) => x.row === n)!;
const byTitle = (r: ReturnType<typeof run>, title: string) =>
  r.candidates.find((c) => c.title === title)!;

describe('headers and reconciliation', () => {
  it('accounts for every row: candidates, holds and dropped rows; nothing merged', () => {
    expect(run().totals).toEqual({
      sourceRows: 8,
      candidates: 7,
      publish: 6,
      hold: 1,
      dropped: 1,
      merged: 0,
    });
  });

  it('refuses a changed form (header check)', () => {
    const { workbook, decisions } = fixture();
    workbook.sheets[0]!.rows[0]![18] = 'Something else';
    expect(() => buildLabCandidates(workbook, EVENT, {}, decisions)).toThrow(/the form changed/);
  });

  it('refuses an unreviewed extra row, and a row that no longer matches its decision', () => {
    const extra = fixture();
    extra.workbook.sheets[0]!.rows.push(
      labRow({ team: 'New', title: 'New', repo: 'https://github.com/new/new' }),
    );
    expect(() => buildLabCandidates(extra.workbook, EVENT, {}, extra.decisions)).toThrow(
      /no editorial decision/,
    );
    const swapped = fixture();
    const rows = swapped.workbook.sheets[0]!.rows;
    [rows[1], rows[2]] = [rows[2]!, rows[1]!];
    expect(() => buildLabCandidates(swapped.workbook, EVENT, {}, swapped.decisions)).toThrow(
      /no longer matches its decision/,
    );
  });

  it('refuses two rows that are the same project (one artifact)', () => {
    const { workbook, decisions } = fixture();
    workbook.sheets[0]!.rows[3]![19] = 'https://github.com/alpha/alpha-tool';
    decisions[4]!.expect = 'alpha/alpha-tool';
    expect(() => buildLabCandidates(workbook, EVENT, {}, decisions)).toThrow(/same project/);
  });
});

describe('privacy', () => {
  const { workbook } = fixture();
  const r = run();
  const slugs = assignSlugs(r.candidates, []);
  const everything =
    JSON.stringify(r) +
    renderLabReport(r, { generatedAt: 'test' }) +
    renderProjectsEntries(r, slugs, '../src/data/types');

  it('never reads or emits an email, a member name, a team size, a timestamp, a confirmation or a private note', () => {
    expect(everything).not.toMatch(/@example\.test/);
    for (const name of ['Ann One', 'Bo Two', 'Cy Three', 'Test Person'])
      expect(everything).not.toContain(name);
    expect(everything).not.toContain('Private note for organisers');
    expect(everything).not.toContain('I confirm');
    expect(everything).not.toContain('46306');
    for (const c of r.candidates) expect(c.credits).toEqual([]);
  });

  it('the output guard refuses an email or a multi-word member name, whatever the case', () => {
    const guard = outputGuard(workbook);
    expect(guard(everything)).toBe(everything);
    expect(() => guard('write to someone@example.org')).toThrow(/email/);
    expect(() => guard('Built by ANN  ONE and friends')).toThrow(/member’s name/);
    expect(guard('Ann reviewed it')).toBe('Ann reviewed it');
    const { workbook: typed, decisions } = fixture();
    typed.sheets[0]!.rows[1]![16] = 'Bo Two wrote the parser. It works.';
    expect(() => guard(JSON.stringify(buildLabCandidates(typed, EVENT, {}, decisions)))).toThrow(
      /member’s name/,
    );
  });

  it('withholds a team label that holds a member’s name, and one that is a URL', () => {
    expect(byTitle(r, 'Beta Board').teamName).toBeNull();
    expect(row(r, 3).notes).toContain('E3 contains a member’s name — not published');
    expect(byTitle(r, 'Eta').teamName).toBeNull();
    expect(byTitle(r, 'Alpha Tool').teamName).toBe('Team Alpha');
    expect(r.rows.filter((x) => x.teamLabelWithheld).map((x) => x.row)).toEqual([3, 8]);
  });

  it('counts the roster without publishing a size; a placeholder slot is not a member', () => {
    expect(row(r, 2).notes).toContain(
      'roster: declared team size and name slots disagree — size not published',
    );
    expect(row(r, 9).notes).toContain('F9, H9 hold a placeholder, not a name — not counted');
    expect(row(r, 9).notes.join(' ')).not.toMatch(/roster/);
  });
});

describe('holds and withholds', () => {
  const r = run();

  it('publishes rows that share a title, noting the other rows', () => {
    expect(byTitle(r, 'Ghat Watch').editorial).toEqual({
      disposition: 'publish',
      reasons: [],
    });
    expect(byTitle(r, 'ghat-watch').editorial).toEqual({
      disposition: 'publish',
      reasons: [],
    });
    expect(row(r, 4).notes).toContain(
      'same title as row 5 (other teams) — kept as written; its team label tells it apart',
    );
    expect(row(r, 5).notes).toContain(
      'same title as row 4 (other teams) — kept as written; its team label tells it apart',
    );
  });

  it('refuses a hold or drop without a reason', () => {
    const bare = fixture();
    bare.decisions[7] = { ...bare.decisions[7]!, holds: [] };
    expect(() => buildLabCandidates(bare.workbook, EVENT, {}, bare.decisions)).toThrow(
      /held without a reason/,
    );
    const drop = fixture();
    drop.decisions[6] = { ...drop.decisions[6]!, holds: [] };
    expect(() => buildLabCandidates(drop.workbook, EVENT, {}, drop.decisions)).toThrow(
      /dropped without a reason/,
    );
  });

  it('a dropped row is not imported at all, and its localhost link is never used', () => {
    expect(r.candidates.some((c) => c.title === 'Epsilon AI')).toBe(false);
    expect(row(r, 6).outcome).toEqual({
      kind: 'dropped',
      title: 'Epsilon AI',
      reasons: ['same team as row 7 — the later row is kept'],
    });
    expect(row(r, 6).notes).toContain('live cell: link rejected (private-host) — not imported');
    expect(JSON.stringify(r.candidates)).not.toContain('localhost');
  });

  it('a corrected link replaces the typo; a link the check found gone is withheld', () => {
    expect(byTitle(r, 'Zeta Tool').liveUrl).toBe('https://zeta-app.vercel.app/');
    const checked = run({
      'github.com/beta/beta-board': { ok: false, status: 404, checkedAt: '2026-10-17T00:00:00Z' },
    });
    expect(byTitle(checked, 'Beta Board').repoUrl).toBeNull();
    expect(byTitle(checked, 'Beta Board').editorial?.reasons.join(' ')).toMatch(
      /no usable public artifact/,
    );
  });

  it('one link in two cells is shown once, as what it is', () => {
    const delta = byTitle(r, 'ghat-watch');
    expect([delta.repoUrl, delta.liveUrl]).toEqual(['https://github.com/delta/gw', null]);
    expect(row(r, 5).notes).toContain('T5 and U5 hold the same link — shown once');
    expect(byTitle(r, 'Alpha Tool').liveUrl).toBe('https://alpha-tool.vercel.app/');
  });
});

describe('the narrative and the caps', () => {
  const r = run();

  it('P–S are the team’s words; the track is the tag; markdown is stripped from a title', () => {
    const alpha = byTitle(r, 'Alpha Tool');
    expect(alpha.problem).toBe('Problem of Alpha Tool.');
    expect(alpha.solution).toBe('Solution of Alpha Tool. Claude drafts the plan for each officer.');
    expect(alpha.builtWith).toBe('Python, Claude API');
    expect(alpha.tags).toEqual(['Track 2: Visarjan Ghat Watch']);
    expect(byTitle(r, 'Theta’s Tool')).toBeDefined();
    expect(row(r, 9).notes).toContain('O9: markdown bold markers removed from the title');
  });

  it('cuts S at 1,000 and R at 2,000 characters, after a whole sentence', () => {
    const usage = byTitle(r, 'Alpha Tool').claudeUsage!;
    expect(usage.length).toBeLessThanOrEqual(1_000);
    expect(LONG_USAGE.startsWith(usage)).toBe(true);
    expect(usage.endsWith('tests.')).toBe(true);
    const stack = byTitle(r, 'Eta').builtWith!;
    expect(stack.length).toBeLessThanOrEqual(2_000);
    expect(stack.endsWith('dashboard.')).toBe(true);
  });

  it('a blank S, or one that is not an answer, takes the team’s own sentences about Claude', () => {
    expect(byTitle(r, 'Eta').claudeUsage).toBe('Claude drafts the plan for each officer.');
    expect(byTitle(r, 'Theta’s Tool').claudeUsage).toBe('Claude drafts the plan for each officer.');
    expect(byTitle(r, 'Beta Board').claudeUsage).toBe('We used Claude Code to build Beta Board.');
  });

  it('cutAtSentence keeps short text, cuts at a sentence or line, and only then at a word', () => {
    expect(cutAtSentence(null, 5)).toBeNull();
    expect(cutAtSentence('Short.', 10)).toBe('Short.');
    expect(cutAtSentence('One. Two. Three.', 10)).toBe('One. Two.');
    expect(cutAtSentence('Line one\nLine two', 12)).toBe('Line one');
    const words = cutAtSentence('word word word word word', 12)!;
    expect(words).toBe('word word…');
    expect(words.length).toBeLessThanOrEqual(12);
  });
});

describe('slugs, the static record and the plan', () => {
  const r = run();

  it('gives same-title rows team-based slugs, keeps plain slug for withheld labels, and steps past taken ones', () => {
    const slugs = assignSlugs(r.candidates, ['alpha-tool']);
    expect(slugs.get(byTitle(r, 'Alpha Tool').key)).toBe('alpha-tool-2');
    expect(slugs.get(byTitle(r, 'Ghat Watch').key)).toBe('ghat-watch-gamma');
    expect(slugs.get(byTitle(r, 'ghat-watch').key)).toBe('ghat-watch-delta');

    const withWithheld = assignSlugs(
      [
        {
          key: 'w1',
          title: 'Shared Name',
          teamName: null,
          editorial: { disposition: 'publish', reasons: [] },
        } as unknown as Candidate,
        {
          key: 't1',
          title: 'Shared Name',
          teamName: 'Mavericks',
          editorial: { disposition: 'publish', reasons: [] },
        } as unknown as Candidate,
      ],
      [],
    );
    expect(withWithheld.get('w1')).toBe('shared-name');
    expect(withWithheld.get('t1')).toBe('shared-name-mavericks');

    const same = (key: string, disposition: 'publish' | 'hold') =>
      ({ key, title: 'Same', editorial: { disposition, reasons: [] } }) as unknown as Candidate;
    const order = assignSlugs([same('held', 'hold'), same('public', 'publish')], []);
    expect([order.get('public'), order.get('held')]).toEqual(['same', 'same-2']);
  });

  it('writes the published rows only, in September’s shape, with no image', () => {
    const slugs = assignSlugs(r.candidates, []);
    const ts = renderProjectsEntries(r, slugs, '../src/data/types');
    expect(ts.match(/^ {2}\{$/gm)).toHaveLength(6);
    expect(ts).toContain("import type { Project } from '../src/data/types';");
    expect(ts).toContain(`summary: '${BUILT_AT}',`);
    expect(ts).toContain("createdAt: '2026-10-11',");
    expect(ts).toContain(`builtAtEventSlug: '${SOURCE.eventSlug}',`);
    expect(ts).toContain("    id: 'prj-alpha-tool',\n    slug: 'alpha-tool',");
    expect(ts).toContain("description: 'It\\'s Theta\\'s summary.',");
    expect(ts).not.toMatch(/image:|Zeta Tool/);
  });

  it('writes held rows as drafts even with a same-title clash; a possible duplicate waits', () => {
    const plan = buildPlan({
      label: 'test',
      file: 'synthetic',
      checksum: 'synthetic',
      candidates: r.candidates,
      stats: {
        sourceRows: 8,
        blankRows: 0,
        groupedRows: 0,
        invalidLinks: 0,
        withheldColumns: [],
        withheldPublicValues: 0,
        creditsWithoutConsent: 0,
      },
      errors: [],
      crosswalk: new Map(),
      baserowRows: [],
      neonProjects: [
        {
          slug: 'alpha-old',
          title: 'Alpha',
          artifacts: ['https://github.com/alpha/alpha-tool'],
          baserowRowId: null,
          contentAuthority: 'static',
        },
      ],
    });
    const decisions = planDecisions(plan, r.candidates);
    expect(decisions[byTitle(r, 'Ghat Watch').key]).toBe('apply');
    expect(decisions[byTitle(r, 'Zeta Tool').key]).toBe('apply');
    expect(decisions[byTitle(r, 'Eta').key]).toBe('apply');
    expect(decisions[byTitle(r, 'Alpha Tool').key]).toBe('hold');
  });
});

describe('the reviewed October decisions (no real data)', () => {
  const d = IMPACT_LAB_OCTOBER;
  const rowsWith = (disposition: LabEditorial['disposition']) =>
    Object.entries(d)
      .filter(([, e]) => e.disposition === disposition)
      .map(([n]) => Number(n));

  it('cover rows 2–69 once each: 61 publish, 6 held, row 57 dropped', () => {
    expect(Object.keys(d).map(Number)).toEqual(Array.from({ length: 68 }, (_, i) => i + 2));
    expect([rowsWith('publish').length, rowsWith('hold').length, rowsWith('dropped')]).toEqual([
      61,
      6,
      [57],
    ]);
  });

  it('publishes the same-title rows, row 61 among them', () => {
    const sameTitle = [2, 11, 25, 26, 41, 61, 3, 6, 39, 43, 22, 36, 45, 19, 48, 53, 40, 56];
    expect(sameTitle.filter((n) => d[n]!.disposition !== 'publish')).toEqual([]);
  });

  it('holds only rows held for other reasons (one-line entries, contradicted titles, row 35 title)', () => {
    expect(rowsWith('hold')).toEqual([31, 35, 49, 51, 60, 68]);
  });

  it('keeps row 35 held, with the corrected vercel.app link that loaded', () => {
    expect(d[35]!.disposition).toBe('hold');
    expect(d[35]!.links).toEqual({ live: 'https://jaldrishti-lyart.vercel.app/' });
  });

  it('every kept row has a summary and a site category, a public one fits the card line; nothing private', () => {
    for (const [n, e] of Object.entries(d)) {
      if (e.disposition === 'dropped') continue;
      expect(e.summary, `row ${n}`).toBeTruthy();
      // The card shows 160 characters of it (`cardText`); a draft is not on a card.
      expect(e.summary!.length, `row ${n}`).toBeLessThanOrEqual(
        e.disposition === 'publish' ? 160 : 300,
      );
      expect(e.summary, `row ${n}`).not.toMatch(/^Built at/);
      expect(CATEGORIES as readonly string[]).toContain(e.category);
    }
    expect(JSON.stringify(d)).not.toMatch(/[^\s@"]+@[^\s@"]+\.[^\s@"]+/);
    expect([38, 49].every((n) => d[n]!.withholdTeamLabel)).toBe(true);
  });
});
