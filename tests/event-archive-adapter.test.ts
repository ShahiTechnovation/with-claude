/**
 * THE SEPTEMBER 2026 SOURCE ADAPTER — synthetic workbooks only.
 *
 * The real organiser workbooks never appear in the repository or its tests.
 * These sheets use the real HEADERS (so header verification is exercised)
 * and invented rows: fake people, `example.test` addresses, and links that
 * exercise every repair and refusal the adapter makes.
 */
import { describe, expect, it } from 'vitest';
import {
  buildArchiveCandidates,
  claudeUsageFrom,
  serialToIst,
  type ArchiveDecisions,
  type EventBinding,
  type SourceId,
} from '../scripts/import/sources/event-archive-2026-09/index';
import { renderReconciliation } from '../scripts/import/sources/event-archive-2026-09/report';
import type { Workbook } from '../scripts/import/lib/workbook';
import { candidateIdentity } from '../scripts/import/lib/normalise';

const IL_HEADERS = [
  'Timestamp', 'Email address', 'Email', 'Team member 1 (name)', 'Member 1 Email', 'Team Name', 'Member 2 Name',
  'Member 2 Email', 'Member 3 Name', 'Member 3 email', 'Member 4 Name', 'Member 4 email', 'Number of Team Members',
  'Project Name', 'What problem are you solving?', 'Tell us about your solution', 'What did you build it with?',
  'GitHub Repository', 'Live or Deployed Project', 'Demo Video', 'Drive link', 'Want Your Project Featured by Claude?',
  'GitHub and Hackathon Work', 'Our Work', 'Everything Works', 'Final Confirmation', 'Anything else you want us to know?',
];
const FABLE_HEADERS = [
  'Timestamp', 'Email address', 'Team Name', 'Provide a publicly accessible link to your working project.',
  'Provide the Github repository containing your project source code.  ', 'What problem did you identify, and who experiences it?  ',
  'Briefly explain your solution, its core functionality, and how it solves the problem.',
  'A 2-minute screen recording of your product demo.\nYouTube/Loom/Google Drive URL (optional but good to have)',
  'Is your submitted project currently functional?', 'Public Showcase Requirement: Teams must publish a public post…',
  '  Final Confirmation  ',
];

const sheet = (rows: string[][]): Workbook => ({
  format: 'xlsx',
  sheets: [{ name: 'Form responses 1', rows, dateCells: new Set(), formulaCells: 0, hidden: false }],
  hasMacros: false,
  date1904: false,
  checksum: 'synthetic',
});

/** An Impact Lab row: [team, title, problem, solution, stack, repo, live, demo, drive, size, names…]. */
function ilRow(o: { team: string; title: string; repo: string; live?: string; demo?: string; drive?: string; stack?: string; names?: string[]; size?: string }) {
  const r = new Array(27).fill('');
  r[0] = '46280.68';
  r[1] = 'lead@example.test';
  r[2] = 'lead@example.test';
  const names = o.names ?? ['Test Person'];
  [3, 6, 8, 10].forEach((col, i) => (r[col] = names[i] ?? ''));
  [4, 7, 9, 11].forEach((col, i) => (r[col] = names[i] ? `m${i}@example.test` : ''));
  r[5] = o.team;
  r[12] = o.size ?? String(names.length);
  r[13] = o.title;
  r[14] = `Problem of ${o.title}.`;
  r[15] = `Solution of ${o.title}. Claude drafts the plan for each user.`;
  r[16] = o.stack ?? 'React, Claude API';
  r[17] = o.repo;
  r[18] = o.live ?? '';
  r[19] = o.demo ?? '';
  r[20] = o.drive ?? '';
  r[21] = 'Done';
  r[22] = r[23] = r[24] = r[25] = 'I confirm';
  r[26] = 'Private note for organisers';
  return r;
}

function fbRow(o: { ts?: string; team: string; live: string; repo: string; problem?: string; solution?: string; demo?: string; status?: string; showcase?: string }) {
  return [
    o.ts ?? '46285.67',
    'person@example.test',
    o.team,
    o.live,
    o.repo,
    o.problem ?? 'People struggle with a real problem.',
    o.solution ?? 'Our tool fixes it. Fable 5.1 wrote the parser.',
    o.demo ?? '',
    o.status ?? 'Fully functional',
    o.showcase ?? '',
    'I confirm that the links and information submitted above are accurate',
  ];
}

const EVENTS: Record<SourceId, EventBinding> = {
  'impact-lab-2': { key: 'evt-test-il2', baserowRowId: 11 },
  'fable-5-1': { key: 'evt-test-f51', baserowRowId: 12 },
};

const ADMIN_URL = 'https://keys.example.test/admin?key=SECRET-ADMIN-KEY-123';

function fixture() {
  const impact = sheet([
    [...IL_HEADERS],
    ilRow({ team: 'Team Alpha', title: 'Alpha Tool', repo: 'alpha-owner/alpha-tool', live: 'alpha-tool.vercel.app', names: ['Ann One', 'Bo Two'] }),
    ilRow({ team: 'Team Beta', title: 'R', repo: 'https://github.com/beta/beta-app', live: 'https://vercel.com/beta-team/beta-app', drive: 'Ask me' }),
    ilRow({ team: 'Team Gamma', title: 'Gamma', repo: 'https://github.com/gamma/g', live: 'https://github.com/gamma/g', names: ['Cy Three', 'Di Four, Ed Five'], size: '3' }),
  ]);
  const fable = sheet([
    [...FABLE_HEADERS],
    fbRow({ team: 'Delta Name', live: 'https://delta.example.test/?_vercel_share=SHARETOKEN', repo: 'https://github.com/delta/delta' }),
    fbRow({ team: 'Junk', live: 'GJHKGVJHVK', repo: 'DVVDV XC' }),
    fbRow({ ts: 'V', team: 'Epsilon', live: ADMIN_URL, repo: 'https://github.com/eps/eps', demo: 'https://youtu.be/abc123' }),
    fbRow({ team: 'Zeta', live: 'https://github.com/zeta/zeta', repo: 'https://github.com/zeta/zeta', status: 'Prototype / demonstration only' }),
    fbRow({ team: '', live: 'https://github.com/zeta/zeta', repo: 'https://github.com/zeta/zeta', status: 'Partially functional', demo: 'https://drive.google.com/file/d/ZZ/view?usp=sharing\\\\', problem: 'Revised problem.' }),
    fbRow({ team: 'Eta', live: 'http://localhost:8765/', repo: 'Some Person', demo: '' }),
    fbRow({ team: 'Theta', live: 'Some Person', repo: 'https://theta.github.io/app/', showcase: 'https://x.com/someone/status/1' }),
  ]);
  const decisions: ArchiveDecisions = {
    'impact-lab-2': {
      2: { expect: 'alpha-owner/alpha-tool', disposition: 'publish', summary: 'Alpha summary for the card.', category: 'product' },
      3: {
        expect: 'beta/beta-app',
        disposition: 'hold',
        title: 'Beta App',
        titleEvidence: 'repository name',
        summary: 'Beta summary for the card.',
        category: 'product',
        holds: ['title: N3 is "R"'],
      },
      4: { expect: 'gamma/g', disposition: 'publish', summary: 'Gamma summary for the card.', category: 'research' },
    },
    'fable-5-1': {
      2: { expect: 'delta/delta', disposition: 'publish', title: 'Delta', titleEvidence: 't', summary: 'Delta summary text.', category: 'product', withholdTeamLabel: true },
      3: { expect: 'GJHKGVJHVK', disposition: 'quarantine', holds: ['suspected test entry'] },
      4: { expect: 'eps/eps', disposition: 'publish', title: 'Epsilon', titleEvidence: 't', summary: 'Epsilon summary text.', category: 'agent', links: { live: null } },
      5: { expect: 'zeta/zeta', disposition: 'publish', title: 'Zeta', titleEvidence: 't', summary: 'Zeta summary text.', category: 'creative' },
      6: { expect: 'zeta/zeta', disposition: 'merged', mergeInto: 5 },
      7: { expect: 'localhost:8765', disposition: 'publish', title: 'Eta', titleEvidence: 't', summary: 'Eta summary text.', category: 'product' },
      8: { expect: 'theta.github.io', disposition: 'publish', title: 'Theta', titleEvidence: 't', summary: 'Theta summary text.', category: 'product' },
    },
    repeats: [{ primary: 5, rows: [5, 6], narrativeFrom: 6, statusFrom: 6, statusReason: 'later revision', demoFrom: 6, reason: 'same repo' }],
  };
  return { workbooks: { 'impact-lab-2': impact, 'fable-5-1': fable }, decisions };
}

const run = (verified = {}) => {
  const { workbooks, decisions } = fixture();
  return buildArchiveCandidates(workbooks, EVENTS, verified, decisions);
};
const byTitle = (r: ReturnType<typeof run>, title: string) => r.candidates.find((c) => c.title === title)!;

describe('every source row is reconciled', () => {
  it('counts candidates, holds, merged repeats and quarantine per source', () => {
    const r = run();
    expect(r.totals['impact-lab-2']).toEqual({ sourceRows: 3, candidates: 3, publish: 2, hold: 1, merged: 0, quarantined: 0 });
    // Eta has no usable artifact at all → an automatic hold.
    expect(r.totals['fable-5-1']).toEqual({ sourceRows: 7, candidates: 5, publish: 4, hold: 1, merged: 1, quarantined: 1 });
    expect(r.rows).toHaveLength(10);
    expect(r.rows.find((x) => x.source === 'fable-5-1' && x.row === 6)?.outcome).toMatchObject({ kind: 'merged', into: 5 });
    expect(r.rows.find((x) => x.source === 'fable-5-1' && x.row === 3)?.outcome.kind).toBe('quarantined');
  });

  it('refuses a sheet whose rows no longer match their reviewed decisions (reordered or revised)', () => {
    const { workbooks, decisions } = fixture();
    const rows = workbooks['fable-5-1'].sheets[0]!.rows;
    [rows[1], rows[4]] = [rows[4]!, rows[1]!];
    expect(() => buildArchiveCandidates(workbooks, EVENTS, {}, decisions)).toThrow(/no longer matches its decision/);
  });

  it('refuses a sheet with an unreviewed extra row', () => {
    const { workbooks, decisions } = fixture();
    workbooks['impact-lab-2'].sheets[0]!.rows.push(ilRow({ team: 'New', title: 'New', repo: 'new/new' }));
    expect(() => buildArchiveCandidates(workbooks, EVENTS, {}, decisions)).toThrow(/no editorial decision/);
  });

  it('refuses a changed form (header check)', () => {
    const { workbooks, decisions } = fixture();
    workbooks['fable-5-1'].sheets[0]!.rows[0]![4] = 'Something else';
    expect(() => buildArchiveCandidates(workbooks, EVENTS, {}, decisions)).toThrow(/the form changed/);
  });

  it('identity is by artifact, so re-keyed reordered rows produce the same projects', () => {
    const a = run();
    const { workbooks, decisions } = fixture();
    const il = workbooks['impact-lab-2'].sheets[0]!.rows;
    [il[1], il[3]] = [il[3]!, il[1]!];
    const swapped = { ...decisions, 'impact-lab-2': { 2: decisions['impact-lab-2'][4]!, 3: decisions['impact-lab-2'][3]!, 4: decisions['impact-lab-2'][2]! } };
    const b = buildArchiveCandidates(workbooks, EVENTS, {}, swapped);
    expect(b.candidates.map((c) => c.key).sort()).toEqual(a.candidates.map((c) => c.key).sort());
  });
});

describe('privacy', () => {
  const r = run();
  const everything = JSON.stringify(r) + renderReconciliation(r, { generatedAt: 'test' });

  it('never reads or emits an email, a member name, a timestamp or a private note', () => {
    expect(everything).not.toMatch(/@example\.test/);
    for (const name of ['Ann One', 'Bo Two', 'Cy Three', 'Di Four', 'Test Person']) expect(everything).not.toContain(name);
    expect(everything).not.toContain('Private note for organisers');
    expect(everything).not.toContain('46280');
    for (const c of r.candidates) expect(c.credits).toEqual([]);
  });

  it('never emits the credential-bearing admin URL, the key, or the access token — anywhere', () => {
    expect(everything).not.toContain('SECRET-ADMIN-KEY-123');
    expect(everything).not.toContain('keys.example.test');
    expect(everything).not.toContain('SHARETOKEN');
    expect(byTitle(r, 'Epsilon').liveUrl).toBeNull();
  });

  it('withholds a team label that is a person’s name, and blank/"N/A" labels', () => {
    expect(byTitle(r, 'Delta').teamName).toBeNull();
    expect(byTitle(r, 'Alpha Tool').teamName).toBe('Team Alpha');
  });

  it('flags a roster whose name slots disagree with the declared size, without publishing a size', () => {
    const gamma = r.rows.find((x) => x.source === 'impact-lab-2' && x.row === 4)!;
    expect(gamma.notes.join(' ')).toMatch(/roster/);
  });
});

describe('links are typed, repaired and refused honestly', () => {
  it('expands owner/repo shorthand and scheme-less domains (and says so)', () => {
    const alpha = byTitle(run(), 'Alpha Tool');
    expect(alpha.repoUrl).toBe('https://github.com/alpha-owner/alpha-tool');
    expect(alpha.liveUrl).toBe('https://alpha-tool.vercel.app/');
  });

  it('a hosting dashboard is not a live demo; "Ask me" is not a link', () => {
    const beta = byTitle(run(), 'Beta App');
    expect(beta.liveUrl).toBeNull();
    expect(beta.artifactUrl).toBeNull();
    expect(beta.editorial).toEqual({ disposition: 'hold', reasons: ['title: N3 is "R"'] });
  });

  it('the same repository in the live and repo fields is one repository action', () => {
    const gamma = byTitle(run(), 'Gamma');
    expect(gamma.repoUrl).toBe('https://github.com/gamma/g');
    expect(gamma.liveUrl).toBeNull();
  });

  it('a _vercel_share link is withheld until the CLEAN URL verifies as public', () => {
    expect(byTitle(run(), 'Delta').liveUrl).toBeNull();
    expect(run().pendingVerification).toEqual(['https://delta.example.test/']);
    const verified = run({ 'delta.example.test': { ok: true, status: 200, checkedAt: '2026-10-01T00:00:00Z' } });
    expect(byTitle(verified, 'Delta').liveUrl).toBe('https://delta.example.test/');
  });

  it('a link the check found private or gone is withheld; an inconclusive one is kept and flagged', () => {
    const r = run({
      'github.com/delta/delta': { ok: false, status: 404, checkedAt: '2026-10-01T00:00:00Z' },
      'github.com/eps/eps': { ok: false, checkedAt: '2026-10-01T00:00:00Z' },
    });
    expect(byTitle(r, 'Delta').repoUrl).toBeNull();
    expect(byTitle(r, 'Epsilon').repoUrl).toBe('https://github.com/eps/eps');
    expect(r.rows.find((x) => x.row === 4 && x.source === 'fable-5-1')!.notes.join(' ')).toMatch(/kept; recheck/);
  });

  it('localhost is never used and a project left with no artifact is held, not published', () => {
    const eta = byTitle(run(), 'Eta');
    expect([eta.liveUrl, eta.repoUrl, eta.videoUrl]).toEqual([null, null, null]);
    expect(eta.editorial?.disposition).toBe('hold');
    expect(eta.editorial?.reasons.join(' ')).toMatch(/no usable public artifact/);
  });

  it('a GitHub Pages site in the repo field is the live demo, not a repository', () => {
    const theta = byTitle(run(), 'Theta');
    expect(theta.liveUrl).toBe('https://theta.github.io/app/');
    expect(theta.repoUrl).toBeNull();
  });

  it('showcase posts are not imported as project links', () => {
    expect(JSON.stringify(run().candidates)).not.toContain('x.com/someone');
  });
});

describe('repeat submissions merge field by field', () => {
  const zeta = byTitle(run(), 'Zeta');
  it('a later blank team label does not erase the earlier one', () => {
    expect(zeta.teamName).toBe('Zeta');
  });
  it('status and narrative come from the stated revision; the repaired demo is kept', () => {
    expect(zeta.buildStatus).toBe('partial');
    expect(zeta.problem).toBe('Revised problem.');
    expect(zeta.videoUrl).toBe('https://drive.google.com/file/d/ZZ/view?usp=sharing');
    expect(zeta.sources).toEqual([{ sheet: 'fable-5-1:Form responses 1', rows: [5, 6] }]);
  });
  it('records where each field came from', () => {
    const row = run().rows.find((x) => x.source === 'fable-5-1' && x.row === 5)!;
    expect(row.provenance).toMatchObject({ problem: 6, buildStatus: 6, team: 5 });
  });
});

describe('details', () => {
  it('an invalid timestamp ("V") is unknown, not an error, and the event is unaffected', () => {
    expect(serialToIst('V')).toBeNull();
    expect(serialToIst('46280.683421724534')).toBe('2026-09-15T16:24:07+05:30');
    const eps = byTitle(run(), 'Epsilon');
    expect(eps.eventKey).toBe('evt-test-f51');
    expect(run().rows.find((x) => x.source === 'fable-5-1' && x.row === 4)!.notes.join(' ')).toMatch(/A4 is not a timestamp/);
  });

  it('build status is the team’s own answer; Impact Lab (no question) is null, never "functional"', () => {
    expect(byTitle(run(), 'Alpha Tool').buildStatus).toBeNull();
    expect(byTitle(run(), 'Delta').buildStatus).toBe('functional');
  });

  it('"How Claude was used" quotes only sentences about the model; a bare tool list is not usage', () => {
    expect(claudeUsageFrom('We built a map. Claude reads each PDF and extracts figures.', 'Claude Code')).toBe(
      'Claude reads each PDF and extracts figures.',
    );
    expect(claudeUsageFrom('Nothing about models here.', 'React, Claude API')).toBeNull();
    expect(claudeUsageFrom(null, 'I built it with Perplexity for research, V0 for UI, Claude for planning and development.')).toMatch(/Claude for planning/);
    expect(claudeUsageFrom('Deployed for the Claude Impact Lab. #ClaudeBhopal', null)).toBeNull();
  });

  it('candidate identity never depends on the row number', () => {
    const a = candidateIdentity({ eventKey: 'e', artifacts: ['https://github.com/x/y'], title: 'T' });
    const b = candidateIdentity({ eventKey: 'e', artifacts: ['https://github.com/X/Y.git'], title: 'Other' });
    expect(a.key).toBe(b.key);
  });
});
