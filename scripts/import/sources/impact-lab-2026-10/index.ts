/**
 * SOURCE ADAPTER — the October 2026 Bhopal Impact Lab submission form.
 *
 *   `Claude Impact Lab _ Bhopal (Responses).xlsx`, one Google Form export,
 *   held 11 Oct 2026 (`claude-code-impact-lab-october`).
 *
 * The September adapter's contract (`../event-archive-2026-09/index.ts`):
 * read by VERIFIED header position, apply the per-row decisions in
 * `editorial.ts`, produce `Candidate`s, and leave planning, the Baserow write,
 * the ledger, rollback and the projection to the shared pipeline.
 *
 * Private by construction:
 *
 *   · Email columns (B, D, G, I, K, M) are never read.
 *   · Member names (C, F, H, J, L) are read for two scans only, in memory: the
 *     roster count, and whether the team label holds a member's name. They are
 *     never copied into a result. `outputGuard` re-reads them to refuse any
 *     output that contains a multi-word member name.
 *   · Team size (N), timestamps (A), confirmations (W–Z) and "anything else"
 *     (AA) stay private review evidence.
 */
import type { Workbook } from '../../lib/workbook';
import { candidateIdentity, cleanText, identityText } from '../../lib/normalise';
import { comparableUrl, linksInCell, type CellLinks, type FieldRole } from '../../lib/links';
import type { Candidate } from '../../lib/candidates';
import type { Plan } from '../../lib/plan';
import type { Decision } from '../../lib/apply';
import { slugifyTitle } from '../../../../src/server/members/projects';
import {
  claudeUsageFrom,
  pickLinks,
  serialToIst,
  teamLabel,
  verifyHeaders,
  type EventBinding,
  type LinkVerification,
} from '../event-archive-2026-09/index';
import { IMPACT_LAB_OCTOBER, type LabEditorial } from './editorial';

export const SOURCE = {
  label: 'Bhopal | Claude Impact Lab',
  event: 'Claude Impact Lab',
  eventSlug: 'claude-code-impact-lab-october',
  /** The event's stable key in the Baserow Events table. */
  eventKey: 'evt-bhopal-impact-lab-2026-10',
  heldOn: '2026-10-11',
  sheet: 'Form responses 1',
  checksum: '5ba06729c599b7ed9219ad262e8a05069755cef5124c3ad4356df914b8d753a5',
  headers: {
    0: 'timestamp',
    1: 'email address',
    2: 'team member 1',
    3: 'member 1 email',
    4: 'team name',
    5: 'member 2 name',
    6: 'member 2 email',
    7: 'member 3 name',
    8: 'member 3 email',
    9: 'member 4 name',
    10: 'member 4 email',
    11: 'member 5 name',
    12: 'member 5 email',
    13: 'number of team members',
    14: 'project name',
    15: 'what problem',
    16: 'tell us about your solution',
    17: 'what did you build it with',
    18: 'how did you use claude',
    19: 'github repository',
    20: 'live or deployed project',
    21: 'demo video',
    22: 'github and hackathon work',
    23: 'our work',
    24: 'everything works',
    25: 'final confirmation',
    26: 'anything else',
    27: 'selected track',
  } as Record<number, string>,
  emailColumns: [1, 3, 6, 8, 10, 12],
  nameColumns: [2, 5, 7, 9, 11],
  lastColumn: 'AB',
} as const;

/** The project-card line the static record carries, as September's do. */
export const BUILT_AT = 'Built at Claude Impact Lab · 11 Oct 2026';

/** The Baserow write limits (`src/server/integrations/baserow/dto.ts`). */
const LIMITS = { claudeUsage: 1_000, problem: 12_000, solution: 12_000, builtWith: 2_000 };

/** A name slot holding a tool or a filler instead of a person: not counted. */
const PLACEHOLDER = /^(claude|na|n\/a|none|nil|-)$/i;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;

interface LabRow {
  row: number;
  coordinate: string;
  submittedAt: string | null;
  team: string | null;
  title: string | null;
  problem: string | null;
  solution: string | null;
  stack: string | null;
  usage: string | null;
  track: string | null;
  cells: Record<FieldRole, CellLinks>;
  identityText: string;
  memberSlots: number;
  placeholderSlots: string[];
  declaredSize: number | null;
  multiNameSlot: boolean;
  /** A word of the team label is a word of one of this row's member names. */
  labelHasMemberName: boolean;
  confirmationsBlank: string[];
}

const words = (s: string | undefined) =>
  cleanText(s)
    .toLowerCase()
    .normalize('NFKC')
    .split(/[^\p{L}]+/u)
    .filter((t) => t.length >= 3);

function body(workbook: Workbook): string[][] {
  const sheet = workbook.sheets.find((s) => s.name === SOURCE.sheet);
  if (!sheet) throw new Error(`${SOURCE.label}: sheet "${SOURCE.sheet}" not found`);
  const [headers = [], ...rows] = sheet.rows;
  verifyHeaders(SOURCE, headers);
  return rows;
}

function readRows(workbook: Workbook): LabRow[] {
  const text = (row: string[], i: number) => {
    if ((SOURCE.emailColumns as readonly number[]).includes(i))
      throw new Error('private column read');
    return cleanText(row[i]) || null;
  };
  const records: LabRow[] = [];
  body(workbook).forEach((row, offset) => {
    const n = offset + 2;
    if (
      row.every((v, i) => (SOURCE.emailColumns as readonly number[]).includes(i) || !cleanText(v))
    )
      return;
    const slots = SOURCE.nameColumns.map((i) => ({ i, v: text(row, i) })).filter((s) => s.v);
    const people = slots.filter((s) => !PLACEHOLDER.test(s.v!));
    const nameWords = new Set(people.flatMap((s) => words(s.v!)));
    records.push({
      row: n,
      coordinate: `${SOURCE.sheet}!A${n}:${SOURCE.lastColumn}${n}`,
      submittedAt: serialToIst(text(row, 0) ?? ''),
      team: text(row, 4),
      title: text(row, 14),
      problem: text(row, 15),
      solution: text(row, 16),
      stack: text(row, 17),
      usage: text(row, 18),
      track: text(row, 27),
      cells: {
        repo: linksInCell(text(row, 19), 'repo'),
        live: linksInCell(text(row, 20), 'live'),
        video: linksInCell(text(row, 21), 'video'),
        attachment: linksInCell(null, 'attachment'),
        showcase: linksInCell(null, 'showcase'),
      },
      identityText: [19, 20, 21, 14, 4].map((i) => text(row, i) ?? '').join(' '),
      memberSlots: people.length,
      placeholderSlots: slots
        .filter((s) => PLACEHOLDER.test(s.v!))
        .map((s) => `${column(s.i)}${n}`),
      declaredSize: Number.isFinite(Number(text(row, 13))) ? Number(text(row, 13)) : null,
      multiNameSlot: people.some((s) => /,|\band\b|&/i.test(s.v!)),
      labelHasMemberName: words(text(row, 4) ?? '').some((w) => nameWords.has(w)),
      confirmationsBlank: [22, 23, 24, 25]
        .filter((i) => !text(row, i))
        .map((i) => `${column(i)}${n}`),
    });
  });
  return records;
}

const column = (i: number) =>
  i < 26 ? String.fromCharCode(65 + i) : `A${String.fromCharCode(65 + i - 26)}`;

/**
 * Refuses (throws on) any text that holds an email address or a multi-word
 * member name from this workbook — run on every report, plan and record
 * before it is written. The names stay in this closure; the error says
 * nothing about which name matched.
 */
export function outputGuard(workbook: Workbook): (text: string) => string {
  const flat = (s: string | undefined) => cleanText(s).toLowerCase().replace(/\s+/g, ' ');
  const names = new Set<string>();
  for (const row of body(workbook)) {
    for (const i of SOURCE.nameColumns) {
      const name = flat(row[i]);
      if (name.includes(' ')) names.add(name);
    }
  }
  return (text) => {
    if (EMAIL.test(text)) throw new Error('refused: the output contains an email address');
    const haystack = flat(text);
    for (const name of names)
      if (haystack.includes(name)) throw new Error('refused: the output contains a member’s name');
    return text;
  };
}

/** `text` within `max` characters, cut after the last whole sentence (or line) that fits. */
export function cutAtSentence(text: string | null, max: number): string | null {
  if (!text || text.length <= max) return text;
  let end = -1;
  for (const m of text.slice(0, max + 1).matchAll(/[.!?](?=\s)|\n/g)) {
    if (m.index < max) end = m[0] === '\n' ? m.index : m.index + 1;
  }
  if (end > 0) return text.slice(0, end).trimEnd();
  const space = text.lastIndexOf(' ', max - 1);
  return `${text.slice(0, space > 0 ? space : max - 1).trimEnd()}…`;
}

// ── building candidates ──────────────────────────────────────────────────

export type LabOutcome =
  | { kind: 'candidate'; key: string; title: string; disposition: 'publish' | 'hold' }
  | { kind: 'dropped'; title: string; reasons: string[] };

export interface LabRowReport {
  row: number;
  coordinate: string;
  outcome: LabOutcome;
  notes: string[];
  teamLabelWithheld: boolean;
}

export interface LabResult {
  candidates: Candidate[];
  rows: LabRowReport[];
  checksum: { expected: string; actual: string };
  totals: {
    sourceRows: number;
    candidates: number;
    publish: number;
    hold: number;
    dropped: number;
    merged: number;
  };
  /** Clean URLs (access parameters removed) that must verify before they are used. */
  pendingVerification: string[];
}

export function buildLabCandidates(
  workbook: Workbook,
  event: EventBinding,
  verified: LinkVerification = {},
  decisions: Record<number, LabEditorial> = IMPACT_LAB_OCTOBER,
): LabResult {
  const rows = readRows(workbook);
  const result: LabResult = {
    candidates: [],
    rows: [],
    checksum: { expected: SOURCE.checksum, actual: workbook.checksum },
    totals: { sourceRows: rows.length, candidates: 0, publish: 0, hold: 0, dropped: 0, merged: 0 },
    pendingVerification: [],
  };

  // Every row must have a decision, and every decision must match its row.
  for (const r of rows) {
    const d = decisions[r.row];
    if (!d)
      throw new Error(
        `${SOURCE.label}: no editorial decision for row ${r.row} — the sheet has more rows than were reviewed`,
      );
    if (!r.identityText.toLowerCase().includes(d.expect.toLowerCase())) {
      throw new Error(
        `${SOURCE.label}: row ${r.row} no longer matches its decision (expected "${d.expect}") — the sheet was reordered or revised; re-review`,
      );
    }
  }
  for (const n of Object.keys(decisions).map(Number)) {
    if (!rows.some((r) => r.row === n))
      throw new Error(`${SOURCE.label}: decision for row ${n} has no row in the sheet`);
  }

  const titleOf = (r: LabRow) => cleanText((r.title ?? '').replace(/\*\*|__/g, ''));
  // Same title, other rows: noted on each, never merged or renamed.
  const byTitle = new Map<string, number[]>();
  for (const r of rows) {
    if (decisions[r.row]!.disposition === 'dropped') continue;
    const t = identityText(titleOf(r));
    byTitle.set(t, [...(byTitle.get(t) ?? []), r.row]);
  }

  for (const r of rows) {
    const d = decisions[r.row]!;
    const notes = [...(d.notes ?? [])];
    if (!r.submittedAt) notes.push(`A${r.row} is not a timestamp — submission time unknown`);
    if (r.confirmationsBlank.length)
      notes.push(`blank confirmation cell(s): ${r.confirmationsBlank.join(', ')}`);
    for (const [role, cell] of Object.entries(r.cells)) {
      for (const reason of cell.rejected)
        if (reason !== 'not-a-url')
          notes.push(`${role} cell: link rejected (${reason}) — not imported`);
    }
    if (d.disposition === 'dropped') {
      if (!d.holds?.length)
        throw new Error(`${SOURCE.label}: row ${r.row} is dropped without a reason`);
      result.totals.dropped += 1;
      result.rows.push({
        row: r.row,
        coordinate: r.coordinate,
        outcome: { kind: 'dropped', title: titleOf(r), reasons: d.holds },
        notes,
        teamLabelWithheld: false,
      });
      continue;
    }

    // One link in two cells is shown once; a scheme-less domain gets https://.
    const seen = new Map<string, string[]>();
    for (const [role, col] of [
      ['repo', 'T'],
      ['live', 'U'],
      ['video', 'V'],
    ] as const) {
      for (const link of r.cells[role].links) {
        seen.set(comparableUrl(link.url), [
          ...(seen.get(comparableUrl(link.url)) ?? []),
          `${col}${r.row}`,
        ]);
        if (link.flags.includes('scheme-added'))
          notes.push(`${col}${r.row} had no scheme; https:// added`);
      }
    }
    for (const cells of seen.values())
      if (cells.length > 1) notes.push(`${cells.join(' and ')} hold the same link — shown once`);

    const picked = pickLinks([r], [r.row], verified);
    notes.push(...picked.notes);
    result.pendingVerification.push(...picked.pending);
    const override = d.links ?? {};
    const resolve = (kind: 'live' | 'repo' | 'video', pick: { url: string } | null) =>
      kind in override ? (override[kind] ?? null) : (pick?.url ?? null);
    const liveUrl = resolve('live', picked.live);
    const repoUrl = resolve('repo', picked.repo);
    const videoUrl = resolve('video', picked.video);
    const downloadUrl = picked.download?.url ?? null;

    const title = titleOf(r);
    if (!title) throw new Error(`${SOURCE.label}: row ${r.row} has no title`);
    if (title !== r.title) notes.push(`O${r.row}: markdown bold markers removed from the title`);
    if (!d.summary || !d.category)
      throw new Error(`${SOURCE.label}: row ${r.row} needs an editorial summary and category`);

    const withhold = d.withholdTeamLabel || r.labelHasMemberName;
    const team = teamLabel(r.team, { withholdTeamLabel: withhold });
    if (r.team && !team && r.labelHasMemberName)
      notes.push(`E${r.row} contains a member’s name — not published`);
    if (r.placeholderSlots.length)
      notes.push(`${r.placeholderSlots.join(', ')} hold a placeholder, not a name — not counted`);
    if (r.multiNameSlot || (r.declaredSize !== null && r.declaredSize !== r.memberSlots)) {
      notes.push('roster: declared team size and name slots disagree — size not published');
    }

    const usage =
      d.usageFromNarrative || !r.usage
        ? claudeUsageFrom(r.solution, r.stack)
        : cutAtSentence(r.usage, LIMITS.claudeUsage);
    const holds = d.disposition === 'hold' ? [...(d.holds ?? [])] : [];
    // Only two problem statements were set, so many teams named their project
    // after the track (decided 2026-10-17, 14:57): the title stands as written
    // and the team label tells the projects apart.
    const twins = byTitle.get(identityText(title))!.filter((n) => n !== r.row);
    if (twins.length) {
      notes.push(
        `same title as row${twins.length > 1 ? 's' : ''} ${twins.join(', ')} (other teams) — kept as written; ${team ? 'its team label tells it apart' : 'no published team label tells it apart'}`,
      );
    }
    if (d.disposition === 'hold' && holds.length === 0)
      throw new Error(`${SOURCE.label}: row ${r.row} is held without a reason`);
    if (!liveUrl && !repoUrl && !videoUrl && !downloadUrl)
      holds.push(
        'no usable public artifact after the link check — ask the team for a public repository, deployment or demo',
      );
    const disposition: 'publish' | 'hold' = holds.length ? 'hold' : 'publish';

    // The public label, never the withheld one: a title + team identity prints its basis.
    const identity = candidateIdentity({
      eventKey: event.key,
      artifacts: [repoUrl, liveUrl, videoUrl, downloadUrl],
      title,
      teamName: team,
    });
    const twin = result.rows.find(
      (x) => x.outcome.kind === 'candidate' && x.outcome.key === identity.key,
    );
    if (twin)
      throw new Error(
        `${SOURCE.label}: rows ${twin.row} and ${r.row} are the same project (${identity.basis}) — merge or drop one in editorial.ts`,
      );
    const reviewNotes =
      [
        ...(disposition === 'hold'
          ? [
              'HELD FOR REVIEW — imported as a draft; not public until an organiser decides:',
              ...holds.map((h) => `- ${h}`),
            ]
          : []),
        ...(notes.length ? ['Import notes:', ...notes.map((n) => `- ${n}`)] : []),
      ].join('\n') || null;

    result.candidates.push({
      key: identity.key,
      strength: identity.strength,
      basis: identity.basis,
      eventKey: event.key,
      eventRowId: event.baserowRowId,
      title: title.slice(0, 100),
      summary: d.summary.slice(0, 300),
      description: null,
      category: d.category,
      tags: r.track ? [r.track] : [],
      liveUrl,
      repoUrl,
      videoUrl,
      claudeUsage: usage,
      teamName: team,
      problem: cutAtSentence(r.problem, LIMITS.problem),
      solution: cutAtSentence(r.solution, LIMITS.solution),
      builtWith: cutAtSentence(r.stack, LIMITS.builtWith),
      buildStatus: null,
      downloadUrl,
      artifactUrl: picked.artifact?.url ?? null,
      altVideoUrl: picked.altVideo?.url ?? null,
      credits: [],
      sources: [{ sheet: `impact-lab-2026-10:${SOURCE.sheet}`, rows: [r.row] }],
      sourceRows: `${SOURCE.event} · ${SOURCE.sheet} · row ${r.row}`,
      reviewNotes,
      problems: [],
      editorial: { disposition, reasons: holds },
    });
    result.totals.candidates += 1;
    result.totals[disposition] += 1;
    result.rows.push({
      row: r.row,
      coordinate: r.coordinate,
      outcome: { kind: 'candidate', key: identity.key, title, disposition },
      notes,
      teamLabelWithheld: Boolean(r.team && !team),
    });
  }
  return result;
}

/**
 * One slug per candidate:
 * - Unique titles keep the title's slug (stepping past taken slugs with `-2`…)
 * - Same-title projects take a team-based suffix from the team label
 *   (e.g. `bhumi-vikas-sahayak-mavericks`).
 * - When a row's team label is withheld (or absent), it keeps the plain base
 *   slug if free; if two withheld-label rows collide, it falls back to `-2`…
 * Published rows go first, so a held draft never takes the plain slug from a
 * project that is public. Slugs are unique across `taken` (the static record).
 */
export function assignSlugs(candidates: Candidate[], taken: Iterable<string>): Map<string, string> {
  const used = new Set(taken);
  const out = new Map<string, string>();
  const order = [...candidates].sort(
    (a, b) =>
      Number(a.editorial?.disposition === 'hold') - Number(b.editorial?.disposition === 'hold'),
  );

  const titleCounts = new Map<string, number>();
  for (const c of candidates) {
    const base = slugifyTitle(c.title);
    titleCounts.set(base, (titleCounts.get(base) ?? 0) + 1);
  }

  for (const c of order) {
    const base = slugifyTitle(c.title);
    const isSameTitle = (titleCounts.get(base) ?? 0) > 1;
    const teamSlug = c.teamName ? slugifyTitle(c.teamName) : '';
    const hasTeam = Boolean(teamSlug && teamSlug !== 'project');

    let slug: string;
    if (isSameTitle && hasTeam) {
      const candidateSlug = `${base}-${teamSlug}`;
      slug = candidateSlug;
      for (let n = 2; used.has(slug); n += 1) {
        slug = `${candidateSlug}-${n}`;
      }
    } else {
      slug = base;
      for (let n = 2; used.has(slug); n += 1) {
        slug = `${base}-${n}`;
      }
    }
    used.add(slug);
    out.set(c.key, slug);
  }
  return out;
}

/**
 * What `apply` does with each planned item. The planner's same-title flag is
 * expected here: this event set two problem statements and the titles stand
 * (decided 2026-10-17, 14:57). Held rows are written to Baserow as DRAFTS so
 * they can be resolved there, a weak identity included. Anything else the
 * planner flags (a possible duplicate of an existing project, or a weak
 * identity on a row that would be published) waits in `decisions.json`.
 */
export function planDecisions(plan: Plan, candidates: Candidate[]): Record<string, Decision> {
  const held = new Set(
    candidates.filter((c) => c.editorial?.disposition === 'hold').map((c) => c.key),
  );
  const accepted = (key: string, r: string) =>
    r.startsWith('held:') ||
    r.startsWith('another project in this event has the same title') ||
    (held.has(key) && r.startsWith('weak identity'));
  return Object.fromEntries(
    plan.items.map((i): [string, Decision] => {
      if (i.action === 'unchanged') return [i.key, 'skip'];
      if (i.action !== 'review') return [i.key, 'apply'];
      return [i.key, i.reasons.every((r) => accepted(i.key, r)) ? 'apply' : 'hold'];
    }),
  );
}
