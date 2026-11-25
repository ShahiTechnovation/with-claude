/**
 * SOURCE ADAPTER — the October 2026 Bhopal Impact Lab submission form, and
 * any later lab form of the same shape (a `LabForm`; October's is the default).
 *
 *   `Claude Impact Lab _ Bhopal (Responses).xlsx`, one Google Form export,
 *   held 11 Oct 2026 (`claude-code-impact-lab-october`).
 *
 * The September adapter's contract (`../event-archive-2026-09/index.ts`):
 * read by VERIFIED header position, apply the per-row decisions in
 * `editorial.ts`, produce `Candidate`s, and leave planning, the Baserow write,
 * the ledger, rollback and the projection to the shared pipeline.
 *
 * Private by construction (October's letters; each form names its own):
 *
 *   · Email columns (B, D, G, I, K, M), and a form's `unread` columns, are never read.
 *   · Member names (C, F, H, J, L) are read for two scans only, in memory: the
 *     roster count, and whether the team label holds a member's name. They are
 *     never copied into a result. `outputGuard` re-reads them to refuse any
 *     output that contains a multi-word member name.
 *   · Team size (N), timestamps (A), confirmations (W–Z) and "anything else"
 *     (AA) stay private review evidence.
 */
import type { Workbook } from '../../lib/workbook';
import { candidateIdentity, cleanText, identityText } from '../../lib/normalise';
import {
  comparableUrl,
  linksInCell,
  type CellLinks,
  type ClassifiedLink,
  type FieldRole,
} from '../../lib/links';
import type { Candidate } from '../../lib/candidates';
import type { Plan } from '../../lib/plan';
import type { Decision } from '../../lib/apply';
import { slugifyTitle } from '../../../../src/server/members/projects';
import {
  claudeUsageFrom,
  pickLinks,
  publishableUrls,
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

/** Everything that differs from one lab form export to the next. */
export interface LabForm {
  /** The adapter id: import batches and candidate sources carry it. */
  id: string;
  /** The CLI prefix: `<prefix>-seed-event`, `-verify-links`, `-plan` and `-report`. */
  prefix: string;
  /** The export's file name, as the plan records it. */
  file: string;
  source: {
    label: string;
    event: string;
    eventSlug: string;
    /** The event's stable key in the Baserow Events table. */
    eventKey: string;
    heldOn: string;
    sheet: string;
    checksum: string;
    headers: Record<number, string>;
    emailColumns: readonly number[];
    nameColumns: readonly number[];
    lastColumn: string;
  };
  /** Columns never read, as the emails are not: `text()` refuses them. */
  unread: readonly number[];
  /** Zero-based column of each field. Link fields may span cells (two video cells). */
  columns: {
    timestamp: number;
    team: number;
    size: number;
    title: number;
    track: number;
    problem: number;
    solution: number;
    stack: number;
    usage: number;
    repo: readonly number[];
    live: readonly number[];
    video: readonly number[];
    confirmations: readonly number[];
  };
  builtAt: string;
  /**
   * The track (a form option) → the tag it publishes, when the option is too long for a
   * tag (Baserow keeps 32 characters, `dto.ts`). A track missing from the map throws. With
   * no map, the track is the tag as written.
   */
  trackTags?: Record<string, string>;
  decisions: Record<number, LabEditorial>;
  report: {
    title: string;
    basis: string[];
    /** The "withheld everywhere" lines; `labels` lists the withheld team-label cells. */
    withheld: (labels: string) => string[];
    /** The plan's one-line list of withheld columns. */
    withheldColumns: string;
    /** Default output paths of `<prefix>-report` and its `--ts`. */
    out: string;
    ts: string;
  };
}

export const IMPACT_LAB_OCTOBER_FORM: LabForm = {
  id: 'impact-lab-2026-10',
  prefix: 'lab-oct',
  file: 'Claude Impact Lab _ Bhopal (Responses).xlsx',
  source: SOURCE,
  unread: [],
  columns: {
    timestamp: 0,
    team: 4,
    size: 13,
    title: 14,
    problem: 15,
    solution: 16,
    stack: 17,
    usage: 18,
    repo: [19],
    live: [20],
    video: [21],
    confirmations: [22, 23, 24, 25],
    track: 27,
  },
  builtAt: BUILT_AT,
  decisions: IMPACT_LAB_OCTOBER,
  report: {
    title: 'October Impact Lab import — reconciliation report',
    basis: [
      'Confirmed by Vishal 2026-10-17, 12:34: "yes they agree" — the participants agreed to their projects and names being public.',
      'The form’s four confirmations (W–Z) are not a permission to publish. This import still creates no person credits, so member names stay unpublished.',
    ],
    withheld: (labels) => [
      '- Every email column (B, D, G, I, K, M) — never read by the adapter.',
      '- Member names (C, F, H, J, L) — read in memory only, to count the roster and to refuse any output that contains one. No person credit is created.',
      `- Team labels that are not a publishable team name: ${labels}.`,
      '- Team size (N), submission timestamps (A), the four confirmations (W–Z) and "anything else" notes (AA) — private review evidence.',
    ],
    withheldColumns:
      'emails (B, D, G, I, K, M), member names (C, F, H, J, L), team size (N), timestamps (A), confirmations (W–Z), notes (AA)',
    out: 'docs/imports/2026-10-impact-lab.md',
    ts: '.batches/010-impact-lab-projects/projects-entries.ts',
  },
};

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
  /** Each link cell on its own, for notes that name the cell. */
  linkCells: { cell: string; links: ClassifiedLink[] }[];
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

function body(workbook: Workbook, form: LabForm): string[][] {
  const { source } = form;
  const sheet = workbook.sheets.find((s) => s.name === source.sheet);
  if (!sheet) throw new Error(`${source.label}: sheet "${source.sheet}" not found`);
  const [headers = [], ...rows] = sheet.rows;
  verifyHeaders(source, headers);
  return rows;
}

function readRows(workbook: Workbook, form: LabForm): LabRow[] {
  const { source, columns: c } = form;
  const unread = [...source.emailColumns, ...form.unread];
  const text = (row: string[], i: number) => {
    if (unread.includes(i)) throw new Error('private column read');
    return cleanText(row[i]) || null;
  };
  const records: LabRow[] = [];
  body(workbook, form).forEach((row, offset) => {
    const n = offset + 2;
    // By index, so a private cell's value is never even fetched.
    if ([...row.keys()].every((i) => unread.includes(i) || !cleanText(row[i]))) return;
    const slots = source.nameColumns.map((i) => ({ i, v: text(row, i) })).filter((s) => s.v);
    const people = slots.filter((s) => !PLACEHOLDER.test(s.v!));
    const nameWords = new Set(people.flatMap((s) => words(s.v!)));
    const linkCells = (['repo', 'live', 'video'] as const).flatMap((role) =>
      c[role].map((i) => ({ role, cell: `${column(i)}${n}`, ...linksInCell(text(row, i), role) })),
    );
    const cells = (role: 'repo' | 'live' | 'video'): CellLinks => {
      const parts = linkCells.filter((p) => p.role === role);
      return {
        links: parts.flatMap((p) => p.links),
        rejected: parts.flatMap((p) => p.rejected),
        nonLinkText: parts.some((p) => p.nonLinkText),
        duplicatedInCell: parts.some((p) => p.duplicatedInCell),
      };
    };
    records.push({
      row: n,
      coordinate: `${source.sheet}!A${n}:${source.lastColumn}${n}`,
      submittedAt: serialToIst(text(row, c.timestamp) ?? ''),
      team: text(row, c.team),
      title: text(row, c.title),
      problem: text(row, c.problem),
      solution: text(row, c.solution),
      stack: text(row, c.stack),
      usage: text(row, c.usage),
      track: text(row, c.track),
      cells: {
        repo: cells('repo'),
        live: cells('live'),
        video: cells('video'),
        attachment: linksInCell(null, 'attachment'),
        showcase: linksInCell(null, 'showcase'),
      },
      linkCells: linkCells.map(({ cell, links }) => ({ cell, links })),
      identityText: [...c.repo, ...c.live, ...c.video, c.title, c.team]
        .map((i) => text(row, i) ?? '')
        .join(' '),
      memberSlots: people.length,
      placeholderSlots: slots
        .filter((s) => PLACEHOLDER.test(s.v!))
        .map((s) => `${column(s.i)}${n}`),
      declaredSize: Number.isFinite(Number(text(row, c.size))) ? Number(text(row, c.size)) : null,
      multiNameSlot: people.some((s) => /,|\band\b|&/i.test(s.v!)),
      labelHasMemberName: words(text(row, c.team) ?? '').some((w) => nameWords.has(w)),
      confirmationsBlank: c.confirmations
        .filter((i) => !text(row, i))
        .map((i) => `${column(i)}${n}`),
    });
  });
  return records;
}

export const column = (i: number) =>
  i < 26 ? String.fromCharCode(65 + i) : `A${String.fromCharCode(65 + i - 26)}`;

/**
 * Refuses (throws on) any text that holds an email address or a multi-word
 * member name from this workbook — run on every report, plan and record
 * before it is written. The names stay in this closure; the error says
 * nothing about which name matched.
 */
export function outputGuard(
  workbook: Workbook,
  form: LabForm = IMPACT_LAB_OCTOBER_FORM,
): (text: string) => string {
  const flat = (s: string | undefined) => cleanText(s).toLowerCase().replace(/\s+/g, ' ');
  const names = new Set<string>();
  for (const row of body(workbook, form)) {
    for (const i of form.source.nameColumns) {
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
  form: LabForm = IMPACT_LAB_OCTOBER_FORM,
): LabResult {
  const { source, columns } = form;
  const cell = (i: number, row: number) => `${column(i)}${row}`;
  const trackTag = (track: string, at: string) => {
    if (!form.trackTags) return track;
    if (!Object.hasOwn(form.trackTags, track))
      throw new Error(`${source.label}: ${at} holds a track the form has no tag for`);
    return form.trackTags[track]!;
  };
  const rows = readRows(workbook, form);
  const result: LabResult = {
    candidates: [],
    rows: [],
    checksum: { expected: source.checksum, actual: workbook.checksum },
    totals: { sourceRows: rows.length, candidates: 0, publish: 0, hold: 0, dropped: 0, merged: 0 },
    pendingVerification: [],
  };

  // Every row must have a decision, and every decision must match its row.
  for (const r of rows) {
    const d = decisions[r.row];
    if (!d)
      throw new Error(
        `${source.label}: no editorial decision for row ${r.row} — the sheet has more rows than were reviewed`,
      );
    if (!r.identityText.toLowerCase().includes(d.expect.toLowerCase())) {
      throw new Error(
        `${source.label}: row ${r.row} no longer matches its decision (expected "${d.expect}") — the sheet was reordered or revised; re-review`,
      );
    }
  }
  for (const n of Object.keys(decisions).map(Number)) {
    if (!rows.some((r) => r.row === n))
      throw new Error(`${source.label}: decision for row ${n} has no row in the sheet`);
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
    if (!r.submittedAt)
      notes.push(`${cell(columns.timestamp, r.row)} is not a timestamp — submission time unknown`);
    if (r.confirmationsBlank.length)
      notes.push(`blank confirmation cell(s): ${r.confirmationsBlank.join(', ')}`);
    for (const [role, cell] of Object.entries(r.cells)) {
      for (const reason of cell.rejected)
        if (reason !== 'not-a-url')
          notes.push(`${role} cell: link rejected (${reason}) — not imported`);
    }
    if (d.disposition === 'dropped') {
      if (!d.holds?.length)
        throw new Error(`${source.label}: row ${r.row} is dropped without a reason`);
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
    for (const { cell: at, links } of r.linkCells) {
      for (const link of links) {
        seen.set(comparableUrl(link.url), [...(seen.get(comparableUrl(link.url)) ?? []), at]);
        if (link.flags.includes('scheme-added')) notes.push(`${at} had no scheme; https:// added`);
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
    if (!title) throw new Error(`${source.label}: row ${r.row} has no title`);
    if (title !== r.title)
      notes.push(`${cell(columns.title, r.row)}: markdown bold markers removed from the title`);
    if (!d.summary || !d.category)
      throw new Error(`${source.label}: row ${r.row} needs an editorial summary and category`);

    const withhold = d.withholdTeamLabel || r.labelHasMemberName;
    const team = teamLabel(r.team, { withholdTeamLabel: withhold });
    if (r.team && !team && r.labelHasMemberName)
      notes.push(`${cell(columns.team, r.row)} contains a member’s name — not published`);
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
      throw new Error(`${source.label}: row ${r.row} is held without a reason`);
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
        `${source.label}: rows ${twin.row} and ${r.row} are the same project (${identity.basis}) — merge or drop one in editorial.ts`,
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
      tags: r.track ? [trackTag(r.track, cell(columns.track, r.row))] : [],
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
      sources: [{ sheet: `${form.id}:${source.sheet}`, rows: [r.row] }],
      sourceRows: `${source.event} · ${source.sheet} · row ${r.row}`,
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
 * The links a plan would write that the link check has no entry for. `pickLinks` keeps such a
 * link, so the plan refuses to run until `verify-links --all` has checked every one.
 */
export function uncheckedUrls(candidates: Candidate[], verified: LinkVerification): string[] {
  return publishableUrls(candidates).filter((url) => !verified[comparableUrl(url)]);
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
