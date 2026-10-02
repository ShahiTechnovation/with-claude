/**
 * SOURCE ADAPTER — the two September 2026 Bhopal submission workbooks.
 *
 *   Impact Lab 2   `Bhopal _ Claude Code Impact Lab 2 (Projects).xlsx`
 *                  held 15 Sep 2026 (announced for 13 Sep — one event)
 *   Fable 5.1      `Build_Day_Projects_Fable5.1.xlsx`, held 20 Sep 2026
 *
 * The generic mapping importer (`../../lib/candidates.ts`) assumes one title
 * column and one person per row. These forms have neither: Impact Lab puts up
 * to four members in one row, and Fable has no title field at all. So this
 * adapter reads each sheet by VERIFIED header position, applies the
 * per-row decisions in `editorial.ts`, and produces the same `Candidate`
 * shape — after which planning, the Baserow write, the ledger, rollback and
 * the projection into Neon are exactly the shared pipeline.
 *
 * Private by construction:
 *
 *   · Email columns are never read. Their indexes are listed only so the
 *     header check can prove they are where we think they are.
 *   · Member names are counted (for the roster check), never copied out.
 *     No person credit is created: names wait for an explicit permission.
 *   · Timestamps, acknowledgements, "anything else" notes and showcase posts
 *     stay private review evidence; they are summarised, not exported.
 *   · Credential-bearing links are dropped inside `linksInCell()` and are
 *     only ever referred to by cell coordinate.
 */
import { readWorkbook, type Workbook } from '../../lib/workbook';
import { candidateIdentity, cleanText, looksPrivate } from '../../lib/normalise';
import { comparableUrl, linksInCell, type CellLinks, type ClassifiedLink, type FieldRole, type LinkFlag } from '../../lib/links';
import type { Candidate } from '../../lib/candidates';
import { FABLE_5_1, FABLE_REPEATS, IMPACT_LAB_2, type RepeatGroup, type RowEditorial } from './editorial';

export type SourceId = 'impact-lab-2' | 'fable-5-1';
type BuildStatus = NonNullable<Candidate['buildStatus']>;

export interface SourceSpec {
  id: SourceId;
  label: string;
  /** Short event label for reports. */
  event: string;
  /** The real, held date. */
  heldOn: string;
  sheet: string;
  /** Expected SHA-256 of the original file. A different file is reported, not refused. */
  checksum: string;
  /** Header prefix (lower-cased) at each column index we rely on. */
  headers: Record<number, string>;
  /** Columns that are never read. */
  privateColumns: number[];
  lastColumn: string;
}

export const SOURCES: Record<SourceId, SourceSpec> = {
  'impact-lab-2': {
    id: 'impact-lab-2',
    label: 'Bhopal | Claude Code Impact Lab 2',
    event: 'Impact Lab 2',
    heldOn: '2026-09-15',
    sheet: 'Form responses 1',
    checksum: 'cbf6e2e73437595f76fbdecd104dd2d180cf0c3196cc1076e23c10d81c70dfdf',
    headers: {
      0: 'timestamp',
      1: 'email address',
      2: 'email',
      3: 'team member 1',
      4: 'member 1 email',
      5: 'team name',
      6: 'member 2 name',
      7: 'member 2 email',
      8: 'member 3 name',
      9: 'member 3 email',
      10: 'member 4 name',
      11: 'member 4 email',
      12: 'number of team members',
      13: 'project name',
      14: 'what problem',
      15: 'tell us about your solution',
      16: 'what did you build it with',
      17: 'github repository',
      18: 'live or deployed project',
      19: 'demo video',
      20: 'drive link',
      21: 'want your project featured',
      22: 'github and hackathon work',
      23: 'our work',
      24: 'everything works',
      25: 'final confirmation',
      26: 'anything else',
    },
    privateColumns: [1, 2, 4, 7, 9, 11],
    lastColumn: 'AA',
  },
  'fable-5-1': {
    id: 'fable-5-1',
    label: 'Bhopal | Claude Code Build Day — Fable 5.1',
    event: 'Fable 5.1 Build Day',
    heldOn: '2026-09-20',
    sheet: 'Form responses 1',
    checksum: '4c5601944d19a5000de8ef45cc51ba96bbd112d225373801a46244a7f87da60f',
    headers: {
      0: 'timestamp',
      1: 'email address',
      2: 'team name',
      3: 'provide a publicly accessible link',
      4: 'provide the github repository',
      5: 'what problem did you identify',
      6: 'briefly explain your solution',
      7: 'a 2-minute screen recording',
      8: 'is your submitted project currently functional',
      9: 'public showcase requirement',
      10: 'final confirmation',
    },
    privateColumns: [1],
    lastColumn: 'K',
  },
};

export interface EventBinding {
  /** Stable key of the event's row in the Baserow Events table. */
  key: string;
  baserowRowId: number;
}

// ── reading ──────────────────────────────────────────────────────────────

interface RowRecord {
  source: SourceId;
  row: number;
  coordinate: string;
  /** IST wall time, or null when the cell is not a timestamp. */
  submittedAt: string | null;
  team: string | null;
  title: string | null;
  problem: string | null;
  solution: string | null;
  stack: string | null;
  cells: Record<FieldRole, CellLinks>;
  /** The raw text of link/title cells, for the identity check only. */
  identityText: string;
  status: BuildStatus | null;
  memberSlots: number;
  declaredSize: number | null;
  /** A member-name slot that contains a list of names. */
  multiNameSlot: boolean;
  showcase: 'post' | 'profile' | 'deployment' | 'text' | 'blank';
  notesPresent: boolean;
  acknowledgementsBlank: string[];
}

const COLUMN = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : `A${String.fromCharCode(65 + i - 26)}`);

/** Excel serial (1900 system) of a local wall-clock time → `YYYY-MM-DDTHH:MM:SS+05:30`. */
export function serialToIst(value: string): string | null {
  const serial = Number(value);
  if (!Number.isFinite(serial) || serial < 40000 || serial > 60000) return null;
  const wall = new Date(Math.round((serial - 25569) * 86_400_000));
  return `${wall.toISOString().slice(0, 19)}+05:30`;
}

/** The IST calendar day of an instant — what the organisers' records use. */
const istDay = (iso: string) => new Date(Date.parse(iso) + 5.5 * 3_600_000).toISOString().slice(0, 10);

const STATUS: Record<string, BuildStatus> = {
  'fully functional': 'functional',
  'partially functional': 'partial',
  'prototype / demonstration only': 'prototype',
};

function verifyHeaders(spec: SourceSpec, headers: string[]): void {
  for (const [index, prefix] of Object.entries(spec.headers)) {
    const actual = cleanText(headers[Number(index)]).toLowerCase();
    if (!actual.startsWith(prefix)) {
      throw new Error(
        `${spec.label}: column ${COLUMN(Number(index))} should start "${prefix}" but is "${actual.slice(0, 60)}" — the form changed; update the adapter`,
      );
    }
  }
}

function readRows(spec: SourceSpec, workbook: Workbook): RowRecord[] {
  const sheet = workbook.sheets.find((s) => s.name === spec.sheet);
  if (!sheet) throw new Error(`${spec.label}: sheet "${spec.sheet}" not found`);
  const [headers = [], ...body] = sheet.rows;
  verifyHeaders(spec, headers);
  const text = (row: string[], i: number) => {
    if (spec.privateColumns.includes(i)) throw new Error('private column read');
    return cleanText(row[i]) || null;
  };
  const records: RowRecord[] = [];
  body.forEach((row, offset) => {
    const excelRow = offset + 2;
    // A blank row is blank in every column we are allowed to read.
    if (row.every((v, i) => spec.privateColumns.includes(i) || !cleanText(v))) return;
    const coordinate = `${spec.sheet}!A${excelRow}:${spec.lastColumn}${excelRow}`;
    if (spec.id === 'impact-lab-2') {
      const slots = [3, 6, 8, 10].map((i) => text(row, i)).filter(Boolean) as string[];
      const cells = {
        repo: linksInCell(text(row, 17), 'repo'),
        live: linksInCell(text(row, 18), 'live'),
        video: linksInCell(text(row, 19), 'video'),
        attachment: linksInCell(text(row, 20), 'attachment'),
        showcase: linksInCell(null, 'showcase'),
      };
      records.push({
        source: spec.id,
        row: excelRow,
        coordinate,
        submittedAt: serialToIst(text(row, 0) ?? ''),
        team: text(row, 5),
        title: text(row, 13),
        problem: text(row, 14),
        solution: text(row, 15),
        stack: text(row, 16),
        cells,
        identityText: [17, 18, 19, 20, 13, 5].map((i) => text(row, i) ?? '').join(' '),
        status: null,
        memberSlots: slots.length,
        declaredSize: Number.isFinite(Number(text(row, 12))) ? Number(text(row, 12)) : null,
        multiNameSlot: slots.some((s) => /,|\band\b|&/i.test(s)),
        showcase: 'blank',
        notesPresent: Boolean(text(row, 26) && !/^(no|na|n\/a|none|-)$/i.test(text(row, 26)!)),
        acknowledgementsBlank: [22, 23, 24, 25].filter((i) => !text(row, i)).map((i) => `${COLUMN(i)}${excelRow}`),
      });
    } else {
      const showcase = linksInCell(text(row, 9), 'showcase');
      const showcaseKind: RowRecord['showcase'] = !text(row, 9)
        ? 'blank'
        : showcase.links.some((l) => l.kind === 'post')
          ? 'post'
          : showcase.links.some((l) => l.kind === 'live')
            ? 'deployment'
            : showcase.links.some((l) => l.kind === 'profile')
              ? 'profile'
              : 'text';
      records.push({
        source: spec.id,
        row: excelRow,
        coordinate,
        submittedAt: serialToIst(text(row, 0) ?? ''),
        team: text(row, 2),
        title: null,
        problem: text(row, 5),
        solution: text(row, 6),
        stack: null,
        cells: {
          live: linksInCell(text(row, 3), 'live'),
          repo: linksInCell(text(row, 4), 'repo'),
          video: linksInCell(text(row, 7), 'video'),
          attachment: linksInCell(null, 'attachment'),
          showcase,
        },
        identityText: [3, 4, 7, 2].map((i) => text(row, i) ?? '').join(' '),
        status: STATUS[(text(row, 8) ?? '').toLowerCase()] ?? null,
        memberSlots: 0,
        declaredSize: null,
        multiNameSlot: false,
        showcase: showcaseKind,
        notesPresent: false,
        acknowledgementsBlank: text(row, 10) ? [] : [`K${excelRow}`],
      });
    }
  });
  return records;
}

// ── claude usage ─────────────────────────────────────────────────────────

const MODEL_WORDS = /\b(claude|fable|anthropic|opus|sonnet)\b/i;
/** Mentions that name the event or a hashtag, not a use of the model. */
const NOT_USAGE = /#claude\w*|claude (code )?impact lab|claude community|claude bhopal/gi;

/**
 * "How Claude was used", in the team's own words: sentences that mention the
 * model. From the solution answer, any such sentence; from a stack answer,
 * only a sentence that says what the model DID ("Claude for planning…") —
 * a bare tool list ("Claude Code") is already shown under "Built with" and
 * says nothing about use. Verbatim apart from markdown emphasis; never
 * paraphrased, never inferred from the event the project came from.
 */
/**
 * Sentences, split on . ! ? followed by space and on line breaks — but never
 * inside parentheses or brackets, where a "?" is part of the sentence
 * ("cross-field logic (does the income match the statement?)").
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '(' || ch === '[') depth += 1;
    else if ((ch === ')' || ch === ']') && depth > 0) depth -= 1;
    if (ch === '\n') {
      out.push(current);
      current = '';
      depth = 0;
      continue;
    }
    current += ch;
    if (depth === 0 && /[.!?]/.test(ch) && /\s/.test(text[i + 1] ?? ' ')) {
      out.push(current);
      current = '';
    }
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

export function claudeUsageFrom(solution: string | null, stack: string | null = null): string | null {
  const sentences: string[] = [];
  const consider = (text: string | null, strict: boolean) => {
    if (!text) return;
    for (const raw of splitSentences(text.replace(/\*\*|__/g, ''))) {
      const s = raw
        .trim()
        .replace(/^#{1,6}\s+/, '')
        .replace(/^[-*•]\s+/, '')
        .replace(/\*\*|__/g, '')
        .replace(/^\*|\*$/g, '')
        .trim();
      if (s.length < 4 || !MODEL_WORDS.test(s.replace(NOT_USAGE, ''))) continue;
      // A lead-in to a list ("…tools, including:") is not a statement on its own.
      if (/[:;,]$/.test(s)) continue;
      // Unbalanced brackets mean a fragment.
      if ((s.match(/\(/g)?.length ?? 0) !== (s.match(/\)/g)?.length ?? 0)) continue;
      if (strict && (s.split(/\s+/).length < 10 || !STACK_USAGE.test(s))) continue;
      if (!sentences.includes(s)) sentences.push(s);
    }
  };
  consider(solution, false);
  consider(stack, true);
  if (sentences.length === 0) return null;
  let out = '';
  for (const s of sentences) {
    if ((out ? out.length + 1 : 0) + s.length > 1_000) break;
    out = out ? `${out}\n${s}` : s;
  }
  return out || null;
}

const STACK_USAGE = /\b(claude|fable|opus|sonnet)\b[^.]*\b(for|to|is used|are used|used|does|did|handles|powers)\b|\b(used|uses|using)\b[^.]*\b(claude|fable)\b[^.]*\bfor\b/i;

// ── building candidates ──────────────────────────────────────────────────

export type RowOutcome =
  | { kind: 'candidate'; key: string; title: string; disposition: 'publish' | 'hold' }
  | { kind: 'merged'; into: number; key: string; title: string }
  | { kind: 'quarantined'; reasons: string[] };

export interface RowReport {
  source: SourceId;
  row: number;
  coordinate: string;
  outcome: RowOutcome;
  notes: string[];
  /** Field → row it came from, for merged groups. */
  provenance?: Record<string, number>;
}

export interface LinkVerification {
  /** comparableUrl → result of a bounded public check. */
  [comparable: string]: { ok: boolean; status?: number; checkedAt: string };
}

export interface AdapterResult {
  candidates: Candidate[];
  rows: RowReport[];
  checksums: Record<SourceId, { expected: string; actual: string }>;
  totals: Record<SourceId, { sourceRows: number; candidates: number; publish: number; hold: number; merged: number; quarantined: number }>;
  /** Clean URLs (access parameters removed) that must verify before they are used. */
  pendingVerification: string[];
}

type Kind = 'live' | 'repo' | 'video' | 'download' | 'artifact';
const FIELD_ORDER: Record<Kind, FieldRole[]> = {
  live: ['live', 'repo', 'showcase'],
  repo: ['repo', 'live', 'showcase'],
  video: ['video', 'live'],
  download: ['live', 'repo', 'video'],
  artifact: ['video', 'repo', 'live', 'attachment'],
};

interface Picked {
  url: string;
  flags: LinkFlag[];
  role: FieldRole;
  row: number;
}

function pickLinks(rows: RowRecord[], order: number[], verified: LinkVerification) {
  const ordered = order.map((n) => rows.find((r) => r.row === n)!).filter(Boolean);
  const notes: string[] = [];
  const pending: string[] = [];
  const all: (ClassifiedLink & { role: FieldRole; row: number })[] = [];
  for (const r of ordered) {
    for (const role of ['live', 'repo', 'video', 'attachment', 'showcase'] as FieldRole[]) {
      for (const link of r.cells[role].links) all.push({ ...link, role, row: r.row });
    }
  }
  const usable = all.filter((l) => {
    if (l.flags.includes('tunnel')) return false;
    if (l.flags.includes('access-param-removed')) {
      const check = verified[comparableUrl(l.url)];
      if (!check?.ok) {
        pending.push(l.url);
        notes.push(
          check
            ? `${l.role} link in row ${l.row}: the clean URL (access parameter removed) did not verify as public (${check.status ?? 'unreachable'}) — withheld`
            : `${l.role} link in row ${l.row} had an access parameter removed; withheld until the clean URL verifies as public`,
        );
        return false;
      }
      notes.push(`${l.role} link in row ${l.row}: access parameter removed; the clean URL verified as public`);
      return true;
    }
    // A bounded public check, when one was run (`verify-links --all`). A link
    // that is definitively not public — gone, private, or a sign-in wall — is
    // not published (it would be a dead button). Anything inconclusive (a
    // timeout, a 5xx from a sleeping free-tier host) is kept and flagged.
    const check = verified[comparableUrl(l.url)];
    if (check && !check.ok) {
      const gone = check.status === 404 || check.status === 410;
      const wall = check.status !== undefined && check.status < 400;
      if (gone || wall) {
        // Withheld links are cited by field and row only — not even their host.
        notes.push(
          `${l.role} link in row ${l.row} is not publicly reachable (${gone ? `${check.status} — private or removed` : 'redirects to a sign-in page'}) on ${istDay(check.checkedAt)} — withheld; ask the team for a public link`,
        );
        return false;
      }
      notes.push(`${l.role} link in row ${l.row} (${l.host}) did not respond normally (${check.status ?? 'timeout'}) on ${istDay(check.checkedAt)} — kept; recheck`);
    }
    return true;
  });
  const used = new Set<string>();
  const take = (kind: Kind, wanted: ClassifiedLink['kind'] = kind): Picked | null => {
    for (const role of FIELD_ORDER[kind]) {
      const hit = usable.find((l) => l.kind === wanted && l.role === role && !used.has(comparableUrl(l.url)));
      if (hit) {
        used.add(comparableUrl(hit.url));
        return { url: hit.url, flags: hit.flags, role: hit.role, row: hit.row };
      }
    }
    return null;
  };
  // Order matters: a repository in the live field must become the repo, and
  // the same Drive file in three fields is shown once, as the demo.
  const repo = take('repo');
  const video = take('video');
  const altVideo = take('video');
  const download = take('download');
  const live = take('live');
  const artifact = take('artifact');
  return { live, repo, video, altVideo, download, artifact, notes, pending };
}

function teamLabel(raw: string | null, editorial: RowEditorial): string | null {
  const t = cleanText(raw);
  if (!t || /^(n\/?a|na|none|-|\.)$/i.test(t)) return null;
  if (editorial.withholdTeamLabel || looksPrivate(t)) return null;
  return t.slice(0, 120);
}

/** The reviewed decisions. Injectable so tests can use synthetic sheets, never real ones. */
export interface ArchiveDecisions {
  'impact-lab-2': Record<number, RowEditorial>;
  'fable-5-1': Record<number, RowEditorial>;
  repeats: RepeatGroup[];
}

export const REVIEWED_DECISIONS: ArchiveDecisions = {
  'impact-lab-2': IMPACT_LAB_2,
  'fable-5-1': FABLE_5_1,
  repeats: FABLE_REPEATS,
};

export function buildArchiveCandidates(
  workbooks: Record<SourceId, Workbook>,
  events: Record<SourceId, EventBinding>,
  verified: LinkVerification = {},
  reviewed: ArchiveDecisions = REVIEWED_DECISIONS,
): AdapterResult {
  const result: AdapterResult = {
    candidates: [],
    rows: [],
    checksums: {
      'impact-lab-2': { expected: SOURCES['impact-lab-2'].checksum, actual: workbooks['impact-lab-2'].checksum },
      'fable-5-1': { expected: SOURCES['fable-5-1'].checksum, actual: workbooks['fable-5-1'].checksum },
    },
    totals: {
      'impact-lab-2': { sourceRows: 0, candidates: 0, publish: 0, hold: 0, merged: 0, quarantined: 0 },
      'fable-5-1': { sourceRows: 0, candidates: 0, publish: 0, hold: 0, merged: 0, quarantined: 0 },
    },
    pendingVerification: [],
  };

  for (const source of ['impact-lab-2', 'fable-5-1'] as SourceId[]) {
    const spec = SOURCES[source];
    const decisions = reviewed[source];
    const groups: RepeatGroup[] = source === 'fable-5-1' ? reviewed.repeats : [];
    const rows = readRows(spec, workbooks[source]);
    const totals = result.totals[source];
    totals.sourceRows = rows.length;

    // Every row must have a decision, and every decision must match its row.
    for (const r of rows) {
      const d = decisions[r.row];
      if (!d) throw new Error(`${spec.label}: no editorial decision for row ${r.row} — the sheet has more rows than were reviewed`);
      if (!r.identityText.toLowerCase().includes(d.expect.toLowerCase())) {
        throw new Error(`${spec.label}: row ${r.row} no longer matches its decision (expected "${d.expect}") — the sheet was reordered or revised; re-review`);
      }
    }
    for (const n of Object.keys(decisions).map(Number)) {
      if (!rows.some((r) => r.row === n)) throw new Error(`${spec.label}: decision for row ${n} has no row in the sheet`);
    }

    const event = events[source];
    for (const r of rows) {
      const d = decisions[r.row];
      const notes = [...(d.notes ?? [])];
      if (!r.submittedAt && !notes.some((n) => n.startsWith(`A${r.row} `))) {
        notes.push(`A${r.row} is not a timestamp — submission time unknown`);
      }
      if (r.acknowledgementsBlank.length) notes.push(`blank acknowledgement cell(s): ${r.acknowledgementsBlank.join(', ')}`);
      for (const [role, cell] of Object.entries(r.cells)) {
        for (const reason of cell.rejected) {
          if (reason === 'not-a-url') continue; // covered by the editorial note where it matters
          notes.push(`${role} cell: link rejected (${reason}) — not imported`);
        }
      }

      if (d.disposition === 'quarantine') {
        totals.quarantined += 1;
        result.rows.push({ source, row: r.row, coordinate: r.coordinate, outcome: { kind: 'quarantined', reasons: d.holds ?? [] }, notes });
        continue;
      }
      if (d.disposition === 'merged') continue; // reported with its primary

      const group = groups.find((g) => g.primary === r.row);
      const members = group ? group.rows.map((n) => rows.find((x) => x.row === n)!) : [r];
      // Latest submission first for "latest non-empty" merges; row number breaks ties.
      const latestFirst = [...members].sort((a, b) => (b.submittedAt ?? '').localeCompare(a.submittedAt ?? '') || b.row - a.row);
      const provenance: Record<string, number> = {};
      const fieldFrom = <K extends 'team' | 'problem' | 'solution' | 'stack' | 'title'>(field: K, preferred?: number) => {
        const order = preferred ? [members.find((m) => m.row === preferred)!, ...latestFirst] : latestFirst;
        for (const m of order) {
          if (m && m[field]) {
            if (group) provenance[field] = m.row;
            return m[field];
          }
        }
        return null;
      };

      const problem = fieldFrom('problem', group?.narrativeFrom);
      const solution = fieldFrom('solution', group?.narrativeFrom);
      const stack = fieldFrom('stack');
      // A later blank never erases an earlier label.
      const rawTeam = fieldFrom('team');
      const statusRow = group ? members.find((m) => m.row === group.statusFrom)! : r;
      if (group) provenance.buildStatus = statusRow.row;

      const linkOrder = group
        ? [...(group.demoFrom ? [group.demoFrom] : []), ...latestFirst.map((m) => m.row)].filter((n, i, a) => a.indexOf(n) === i)
        : [r.row];
      const picked = pickLinks(members, linkOrder, verified);
      notes.push(...picked.notes);
      result.pendingVerification.push(...picked.pending);
      const override = d.links ?? {};
      const resolve = (kind: keyof NonNullable<RowEditorial['links']>, pick: Picked | null) =>
        kind in override ? (override[kind] ?? null) : (pick?.url ?? null);
      const liveUrl = resolve('live', picked.live);
      const repoUrl = resolve('repo', picked.repo);
      const videoUrl = resolve('video', picked.video);
      const altVideoUrl = resolve('altVideo', picked.altVideo);
      const downloadUrl = resolve('download', picked.download);
      const artifactUrl = resolve('artifact', picked.artifact);
      if (group) {
        for (const [k, p] of Object.entries({ live: picked.live, repo: picked.repo, video: picked.video, altVideo: picked.altVideo })) {
          if (p) provenance[`${k}Url`] = p.row;
        }
      }

      const title = (d.title ?? r.title ?? '').trim();
      if (!title) throw new Error(`${spec.label}: row ${r.row} has no title and no editorial title`);
      if (!d.summary || !d.category) throw new Error(`${spec.label}: row ${r.row} needs an editorial summary and category`);

      const team = teamLabel(rawTeam, d);
      if (rawTeam && !team && d.withholdTeamLabel) notes.push('team label is a personal name — not published');
      if (r.multiNameSlot || (r.declaredSize !== null && r.declaredSize !== r.memberSlots)) {
        if (!notes.some((n) => n.startsWith('roster'))) notes.push('roster: declared team size and name slots disagree — size not published');
      }
      if (r.showcase === 'deployment' && !notes.some((n) => n.includes('showcase'))) {
        notes.push('showcase field holds a deployment rather than a post');
      }

      const identity = candidateIdentity({
        eventKey: event.key,
        artifacts: [repoUrl, liveUrl, videoUrl, downloadUrl],
        title,
        teamName: rawTeam,
      });
      const claudeUsage = 'claudeUsage' in d ? (d.claudeUsage ?? null) : claudeUsageFrom(solution, stack);
      const holds = d.disposition === 'hold' ? [...(d.holds ?? [])] : [];
      if (d.disposition === 'hold' && holds.length === 0) throw new Error(`${spec.label}: row ${r.row} is held without a reason`);
      // A project left with no public artifact (every link withheld or failed
      // the check) cannot meet the archive contract: hold it, and say why.
      const noArtifact = !liveUrl && !repoUrl && !videoUrl && !downloadUrl;
      if (noArtifact && !holds.some((h) => h.startsWith('no usable'))) {
        holds.push('no usable public artifact after the link check — ask the team for a public repository, deployment or demo');
      }
      const disposition: 'publish' | 'hold' = holds.length ? 'hold' : 'publish';
      const rowList = members.map((m) => m.row);
      const sourceRows = `${spec.event} · ${spec.sheet} · ${rowList.length > 1 ? `rows ${rowList.join(', ')} (canonical ${r.row})` : `row ${r.row}`}`;
      // The same privacy-safe text as the committed reconciliation report:
      // decisions and cell coordinates, never a withheld value.
      const reviewNotes =
        [
          ...(disposition === 'hold' ? ['HELD FOR REVIEW — imported as a draft; not public until an organiser decides:', ...holds.map((h) => `- ${h}`)] : []),
          ...(group
            ? [
                `Merged repeat submissions (rows ${rowList.join(', ')}): ${group.reason}`,
                `Status: ${group.statusReason}`,
                `Field sources: ${Object.entries(provenance).map(([k, v]) => `${k}←${v}`).join(', ')}`,
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
        tags: [],
        liveUrl,
        repoUrl,
        videoUrl,
        claudeUsage,
        teamName: team,
        problem: problem?.slice(0, 12_000) ?? null,
        solution: solution?.slice(0, 12_000) ?? null,
        builtWith: stack?.slice(0, 2_000) ?? null,
        buildStatus: statusRow.status,
        downloadUrl,
        artifactUrl,
        altVideoUrl,
        credits: [],
        sources: [{ sheet: `${spec.id}:${spec.sheet}`, rows: members.map((m) => m.row) }],
        sourceRows,
        reviewNotes,
        problems: [],
        editorial: { disposition, reasons: holds },
      });
      totals.candidates += 1;
      totals[disposition] += 1;
      result.rows.push({
        source,
        row: r.row,
        coordinate: r.coordinate,
        outcome: { kind: 'candidate', key: identity.key, title, disposition },
        notes,
        ...(group ? { provenance } : {}),
      });
      if (group) {
        for (const m of members.filter((x) => x.row !== r.row)) {
          totals.merged += 1;
          result.rows.push({
            source,
            row: m.row,
            coordinate: m.coordinate,
            outcome: { kind: 'merged', into: r.row, key: identity.key, title },
            notes: [group.reason, `status: ${group.statusReason}`],
          });
        }
      }
    }
    result.rows.sort((a, b) => (a.source === b.source ? a.row - b.row : a.source.localeCompare(b.source)));
  }
  return result;
}

export async function readArchiveWorkbooks(paths: Record<SourceId, string>): Promise<Record<SourceId, Workbook>> {
  return {
    'impact-lab-2': await readWorkbook(paths['impact-lab-2']),
    'fable-5-1': await readWorkbook(paths['fable-5-1']),
  };
}

/** Every URL the plan would publish, for the bounded link check. Never a rejected one. */
export function publishableUrls(candidates: Candidate[]): string[] {
  const urls = new Set<string>();
  for (const c of candidates) {
    for (const u of [c.liveUrl, c.repoUrl, c.videoUrl, c.altVideoUrl, c.downloadUrl, c.artifactUrl]) if (u) urls.add(u);
  }
  return [...urls].sort();
}
