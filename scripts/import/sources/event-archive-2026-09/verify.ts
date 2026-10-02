/**
 * READ-BACK VERIFICATION AND THE 100-ROW RECONCILIATION.
 *
 * An import is not "done" because the API answered 200. This compares what
 * Baserow actually STORES — re-read in full, every page — against what the
 * plan said to write, and against the original workbook cells:
 *
 *   · each applied candidate exists exactly once, under its source key
 *   · every imported field equals the planned value, byte for byte, and the
 *     long answers keep every non-whitespace character of the source cell
 *   · the Event link resolves to the right canonical event row
 *   · editorial status is what the plan intended (held → draft)
 *   · held candidates were NOT written; no key appears twice
 *   · credits: none created without consent; none orphaned
 *   · nothing private is stored: emails, phone numbers, credential-bearing or
 *     local URLs, the withheld admin URL, personal names used as team labels
 *
 * Private values used for the check are read from the workbooks into memory
 * and compared there. They are never printed, written or returned: a hit is
 * reported as a category and a coordinate.
 */
import type { BaserowConfig } from '../../../../src/server/integrations/baserow/config';
import type { LiveField } from '../../../../src/server/integrations/baserow/spec';
import type { Candidate } from '../../lib/candidates';
import { comparable, type Decision } from '../../lib/apply';
import type { Plan } from '../../lib/plan';
import type { Workbook } from '../../lib/workbook';
import { cleanText } from '../../lib/normalise';
import { isBlankRow, privacyProblems } from '../../lib/workspace';
import { SOURCES, type AdapterResult, type EventBinding, type SourceId } from './index';

type Row = { id: number } & Record<string, unknown>;

export interface VerifyInput {
  config: BaserowConfig;
  plan: Plan;
  candidates: Candidate[];
  decisions: Record<string, Decision>;
  adapter: AdapterResult;
  workbooks: Record<SourceId, Workbook>;
  events: Record<SourceId, EventBinding & { expected: Record<string, unknown> }>;
  rows: { events: Row[]; projects: Row[]; credits: Row[] };
  projectFields: LiveField[];
  /** Was the batch applied with --publish? */
  publish: boolean;
  /** Optional: what the projection made of each Baserow project row. */
  neon?: Map<number, { slug: string; publication: string; moderation: string; authority: string }>;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ReconRow {
  source: SourceId;
  row: number;
  disposition:
    | 'imported-published'
    | 'imported-draft-held'
    | 'merged'
    | 'held-not-imported'
    | 'quarantined'
    | 'failed';
  title: string | null;
  key: string | null;
  baserowRowId: number | null;
  /** The earlier local project this candidate already was (matched by source key). */
  matchedLocalProject: string | null;
  mergedInto: number | null;
  reason: string;
  neon?: string;
}

const text = (v: unknown): string => {
  if (Array.isArray(v)) return v.map((o) => (o && typeof o === 'object' && 'value' in o ? String((o as { value: unknown }).value) : String(o))).join(', ');
  if (v && typeof v === 'object' && 'value' in (v as object)) return String((v as { value: unknown }).value);
  return v === null || v === undefined ? '' : String(v);
};
const linkIds = (v: unknown): number[] => (Array.isArray(v) ? v.map((o) => Number((o as { id: unknown }).id)).filter(Number.isInteger) : []);
const squash = (s: string) => s.replace(/[\s​-‍﻿]+/g, '');

/** Private strings from the workbooks, in memory only, lower-cased. */
function forbiddenValues(workbooks: Record<SourceId, Workbook>) {
  const emails = new Set<string>();
  const credential = new Set<string>();
  const personalNames = new Set<string>();
  const memberNames = new Set<string>();
  const impact = workbooks['impact-lab-2'].sheets.find((s) => s.name === SOURCES['impact-lab-2'].sheet)!;
  for (const r of impact.rows.slice(1)) {
    for (const i of SOURCES['impact-lab-2'].privateColumns) if (cleanText(r[i])) emails.add(cleanText(r[i]).toLowerCase());
    for (const i of [3, 6, 8, 10]) {
      const n = cleanText(r[i]).toLowerCase();
      if (n) memberNames.add(n);
      if (n.includes(' ')) personalNames.add(n);
    }
  }
  const fable = workbooks['fable-5-1'].sheets.find((s) => s.name === SOURCES['fable-5-1'].sheet)!;
  fable.rows.slice(1).forEach((r, i) => {
    const excelRow = i + 2;
    if (cleanText(r[1])) emails.add(cleanText(r[1]).toLowerCase());
    const live = cleanText(r[3]);
    // A person's name typed into the link field (Fable D10, D42, …).
    if (live && !/[./:]/.test(live) && /^[\p{L} .'-]{3,60}$/u.test(live) && live.includes(' ')) personalNames.add(live.toLowerCase());
    if (excelRow === 39 && live) {
      // The withheld credential-bearing admin URL: the URL and its secret values.
      credential.add(live.toLowerCase());
      try {
        const u = new URL(live);
        for (const v of u.searchParams.values()) if (v.length >= 6) credential.add(v.toLowerCase());
        if (u.pathname.length > 1) credential.add(`${u.hostname}${u.pathname}`.toLowerCase());
      } catch {
        /* not a URL */
      }
    }
  });
  return { emails, credential, personalNames, memberNames };
}

export function verifyImport(input: VerifyInput): { ok: boolean; checks: Check[]; reconciliation: ReconRow[]; warnings: string[] } {
  const { config, plan, candidates, decisions, adapter } = input;
  const pf = config.tables.projects.fields;
  const ef = config.tables.events.fields;
  const cf = config.tables.credits.fields;
  const get = (row: Row, id: number | undefined) => (id === undefined ? undefined : row[`field_${id}`]);
  const checks: Check[] = [];
  const warnings: string[] = [];
  const check = (name: string, problems: string[], okDetail: string) =>
    checks.push({ name, ok: problems.length === 0, detail: problems.length ? problems.slice(0, 25).join('; ') + (problems.length > 25 ? ` … (+${problems.length - 25})` : '') : okDetail });

  // ── events ──
  const eventProblems: string[] = [];
  const eventRowIdByKey = new Map<string, number>();
  for (const [id, binding] of Object.entries(input.events) as [SourceId, VerifyInput['events'][SourceId]][]) {
    const hits = input.rows.events.filter((r) => text(get(r, ef.key)) === binding.key);
    if (hits.length !== 1) {
      eventProblems.push(`${binding.key}: ${hits.length} rows (expected exactly 1)`);
      continue;
    }
    const row = hits[0];
    eventRowIdByKey.set(binding.key, row.id);
    if (row.id !== binding.baserowRowId) eventProblems.push(`${binding.key}: row ${row.id}, but projects were bound to row ${binding.baserowRowId}`);
    if (text(get(row, ef.date)) !== SOURCES[id].heldOn) eventProblems.push(`${binding.key}: date ${text(get(row, ef.date))}, expected ${SOURCES[id].heldOn}`);
    for (const [field, want] of Object.entries(binding.expected)) {
      // Write form (option ids, link ids) against read form, compared as such.
      if (JSON.stringify(comparable(row[field])) !== JSON.stringify(comparable(want))) {
        eventProblems.push(`${binding.key}: ${field} differs from the mirrored Neon value`);
      }
    }
  }
  check('events: one row per canonical event, held dates correct', eventProblems, `${eventRowIdByKey.size} canonical event rows; Impact Lab 2 on ${SOURCES['impact-lab-2'].heldOn}, Fable 5.1 on ${SOURCES['fable-5-1'].heldOn}`);

  // ── projects: identity ──
  const byKey = new Map<string, Row[]>();
  for (const r of input.rows.projects) {
    const k = text(get(r, pf.key));
    if (!k) continue;
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  const dupes = [...byKey.entries()].filter(([, rs]) => rs.length > 1).map(([k, rs]) => `${k} on rows ${rs.map((r) => r.id).join(', ')}`);
  check('projects: no duplicate source keys', dupes, `${byKey.size} distinct keys on ${input.rows.projects.length} rows`);

  const applied = candidates.filter((c) => decisions[c.key] === 'apply');
  const held = candidates.filter((c) => decisions[c.key] !== 'apply');
  const missing = applied.filter((c) => !byKey.get(c.key)).map((c) => `${c.title} (${c.sources.map((s) => `${s.sheet} ${s.rows.join('/')}`).join('; ')})`);
  check('projects: every applied candidate exists', missing, `${applied.length} of ${applied.length} present`);
  const leaked = held.filter((c) => byKey.get(c.key)).map((c) => c.title);
  check('projects: held candidates were not written', leaked, `${held.length} held candidate(s) absent, as planned`);
  const keySet = new Set(candidates.map((c) => c.key));
  const foreign = input.rows.projects.filter((r) => text(get(r, pf.key)) && !keySet.has(text(get(r, pf.key)))).map((r) => `row ${r.id}`);
  if (foreign.length) warnings.push(`${foreign.length} Projects row(s) carry a key this import does not know (left untouched): ${foreign.join(', ')}`);

  // ── projects: content ──
  const optionValue = new Map<number, string>();
  for (const f of input.projectFields) for (const o of f.select_options ?? []) optionValue.set(o.id, o.value.trim().toLowerCase().replace(/\s+/g, '-'));
  const contentProblems: string[] = [];
  const linkProblems: string[] = [];
  const statusProblems: string[] = [];
  const preserveProblems: string[] = [];
  const planned = new Map(plan.items.map((i) => [i.key, i]));
  const fields: [keyof Candidate, string][] = [
    ['title', 'title'], ['summary', 'summary'], ['problem', 'problem'], ['solution', 'solution'], ['builtWith', 'builtWith'],
    ['claudeUsage', 'claudeUsage'], ['teamName', 'teamName'], ['liveUrl', 'liveUrl'], ['repoUrl', 'repoUrl'], ['videoUrl', 'videoUrl'],
    ['altVideoUrl', 'altVideoUrl'], ['downloadUrl', 'downloadUrl'], ['artifactUrl', 'artifactUrl'], ['sourceRows', 'sourceRows'],
    ['reviewNotes', 'reviewNotes'], ['slug', 'slug'],
  ];
  const sheetRows = (id: SourceId) => input.workbooks[id].sheets.find((s) => s.name === SOURCES[id].sheet)!.rows;
  const narrativeCols: Record<SourceId, Partial<Record<'problem' | 'solution' | 'builtWith', number>>> = {
    'impact-lab-2': { problem: 14, solution: 15, builtWith: 16 },
    'fable-5-1': { problem: 5, solution: 6 },
  };
  let compared = 0;
  for (const c of applied) {
    const row = byKey.get(c.key)?.[0];
    if (!row) continue;
    const item = planned.get(c.key);
    const keptFields = new Set((item?.kept ?? []).map((k) => k.field as string));
    for (const [prop, logical] of fields) {
      if (pf[logical] === undefined || keptFields.has(logical)) continue;
      const want = (c[prop] as string | null | undefined) ?? '';
      if (!want) continue; // never written when empty
      const have = text(get(row, pf[logical]));
      compared += 1;
      if (have !== want) contentProblems.push(`${c.title}: ${logical} differs (${have.length} vs ${want.length} chars)`);
    }
    if (pf.key && text(get(row, pf.key)) !== c.key) contentProblems.push(`${c.title}: key differs`);
    if (pf.sourceKey && text(get(row, pf.sourceKey)) !== c.key) contentProblems.push(`${c.title}: source key differs`);
    const category = get(row, pf.category) as { id?: number } | null;
    if (pf.category && (category?.id === undefined ? '' : optionValue.get(category.id)) !== c.category) contentProblems.push(`${c.title}: category differs`);
    if (pf.buildStatus && c.buildStatus) {
      const bs = get(row, pf.buildStatus) as { id?: number } | null;
      if ((bs?.id === undefined ? '' : optionValue.get(bs.id)) !== c.buildStatus) contentProblems.push(`${c.title}: build status differs`);
    }
    // The long answers keep every non-whitespace character of their source cell.
    const [source] = c.sources;
    const sourceId = source.sheet.split(':')[0] as SourceId;
    const provenance = adapter.rows.find((r) => r.source === sourceId && r.outcome.kind === 'candidate' && r.outcome.key === c.key)?.provenance;
    for (const [field, col] of Object.entries(narrativeCols[sourceId]) as ['problem' | 'solution' | 'builtWith', number][]) {
      const stored = text(get(row, pf[field]));
      if (!stored) continue;
      const fromRow = provenance?.[field === 'builtWith' ? 'stack' : field] ?? source.rows[0];
      const cell = String(sheetRows(sourceId)[fromRow - 1]?.[col] ?? '');
      if (squash(cell) !== squash(stored)) preserveProblems.push(`${c.title}: ${field} does not keep every character of ${SOURCES[sourceId].sheet} row ${fromRow}`);
    }
    // Event link → the canonical event row for this candidate's event.
    const linked = linkIds(get(row, pf.event));
    const wantEvent = eventRowIdByKey.get(c.eventKey);
    if (linked.length !== 1 || linked[0] !== wantEvent) linkProblems.push(`${c.title}: Event link ${JSON.stringify(linked)}, expected [${wantEvent}]`);
    // Editorial status: published only when requested and the contract holds.
    const status = get(row, pf.editorialStatus) as { id?: number } | null;
    const statusValue = status?.id === undefined ? '' : optionValue.get(status.id);
    const isHeld = c.editorial?.disposition === 'hold';
    const wantStatus = input.publish && !isHeld && item?.publishable ? 'published' : 'draft';
    if (item?.action === 'create' || item?.action === 'review') {
      if (statusValue !== wantStatus) statusProblems.push(`${c.title}: editorial ${statusValue || '(empty)'}, expected ${wantStatus}`);
    } else if (isHeld && statusValue === 'published') {
      statusProblems.push(`${c.title}: held for review but published`);
    }
  }
  check('projects: stored fields equal the planned values', contentProblems, `${compared} field values compared on ${applied.length} rows — all equal`);
  check('projects: long answers keep every character of the source cell', preserveProblems, 'problem, solution and built-with match their workbook cells (whitespace normalised only)');
  check('projects: Event link resolves to the canonical event', linkProblems, `${applied.length} rows linked to the right event row`);
  check('projects: editorial status as planned (held → draft)', statusProblems, 'published only where publishable and not held');

  // ── credits ──
  const projectIds = new Set(input.rows.projects.map((r) => r.id));
  const importedIds = new Set(applied.map((c) => byKey.get(c.key)?.[0]?.id).filter(Boolean) as number[]);
  const creditProblems: string[] = [];
  let blankCredits = 0;
  for (const r of input.rows.credits) {
    if (isBlankRow(r)) {
      blankCredits += 1;
      continue;
    }
    const links = linkIds(get(r, cf.project));
    if (links.length === 0 || links.some((id) => !projectIds.has(id))) creditProblems.push(`credit row ${r.id} is orphaned`);
    if (links.some((id) => importedIds.has(id))) creditProblems.push(`credit row ${r.id} names a person on an imported project — no consent is on record`);
  }
  check('credits: no personal credits without consent, none orphaned', creditProblems, `0 credit rows on imported projects; ${blankCredits} pre-existing blank row(s) left untouched`);

  // ── privacy ──
  const forbidden = forbiddenValues(input.workbooks);
  const privacy: string[] = [];
  // Identifiers this importer generates (hex hashes, UUIDs) hold no submitter
  // content, and a run of digits in a hash is not a phone number.
  const generated = new Set(
    [pf.key, pf.sourceKey, pf.neonId, ef.key, ef.neonId].filter((id): id is number => id !== undefined).map((id) => `field_${id}`),
  );
  const scan = (table: string, rows: Row[]) => {
    for (const r of rows) {
      for (const [k, v] of Object.entries(r)) {
        if (!k.startsWith('field_') || generated.has(k)) continue;
        const value = text(v);
        if (!value) continue;
        const found = privacyProblems(value, [
          { label: 'contains a submitter email address', values: forbidden.emails },
          { label: 'contains the withheld credential-bearing URL', values: forbidden.credential },
          { label: 'contains a personal name from a link field', values: forbidden.personalNames },
        ]);
        for (const p of found) privacy.push(`${table} row ${r.id} ${k}: ${p}`);
      }
      if (table === 'projects' && pf.teamName) {
        const team = text(get(r, pf.teamName)).toLowerCase();
        if (team && forbidden.memberNames.has(team)) privacy.push(`projects row ${r.id}: team label is a member's personal name`);
      }
    }
  };
  scan('events', input.rows.events);
  scan('projects', input.rows.projects);
  scan('credits', input.rows.credits);
  check('privacy: no emails, phones, credential/local URLs or personal names stored', privacy, 'every stored value scanned — none found');

  // ── neon (optional) ──
  if (input.neon) {
    const problems: string[] = [];
    for (const c of applied) {
      const row = byKey.get(c.key)?.[0];
      const n = row ? input.neon.get(row.id) : undefined;
      if (!n) {
        problems.push(`${c.title}: no projection in the database`);
        continue;
      }
      const isHeld = c.editorial?.disposition === 'hold';
      if (isHeld && n.publication === 'published') problems.push(`${c.title}: held but public`);
    }
    check('sync: every imported row projected; nothing held is public', problems, `${applied.length} rows projected`);
  }

  // ── reconciliation: every source row ──
  const reconciliation: ReconRow[] = adapter.rows.map((r) => {
    const base = { source: r.source, row: r.row, matchedLocalProject: null, mergedInto: null } as const;
    if (r.outcome.kind === 'quarantined') {
      return { ...base, disposition: 'quarantined' as const, title: null, key: null, baserowRowId: null, reason: r.outcome.reasons.join('; ') || 'quarantined' };
    }
    if (r.outcome.kind === 'merged') {
      const into = byKey.get(r.outcome.key)?.[0]?.id ?? null;
      return { ...base, disposition: 'merged' as const, title: r.outcome.title, key: r.outcome.key, baserowRowId: into, mergedInto: r.outcome.into, reason: `merged into row ${r.outcome.into}; ${r.notes.join('; ')}` };
    }
    const c = candidates.find((x) => x.key === (r.outcome as { key: string }).key)!;
    const item = planned.get(c.key);
    const row = byKey.get(c.key)?.[0] ?? null;
    const neon = row && input.neon?.get(row.id);
    const neonText = neon ? `${neon.publication}${neon.moderation !== 'clean' ? ` (${neon.moderation})` : ''} /projects/${neon.slug}/` : undefined;
    if (decisions[c.key] !== 'apply') {
      return { ...base, disposition: 'held-not-imported' as const, title: c.title, key: c.key, baserowRowId: null, matchedLocalProject: item?.matchedProject ?? null, reason: (item?.reasons ?? []).join('; ') };
    }
    if (!row) {
      return { ...base, disposition: 'failed' as const, title: c.title, key: c.key, baserowRowId: null, matchedLocalProject: item?.matchedProject ?? null, reason: 'planned but not found in Baserow — re-run apply (it resumes)' };
    }
    const isHeld = c.editorial?.disposition === 'hold';
    return {
      ...base,
      disposition: isHeld ? ('imported-draft-held' as const) : ('imported-published' as const),
      title: c.title,
      key: c.key,
      baserowRowId: row.id,
      matchedLocalProject: item?.matchedProject ?? null,
      reason: isHeld ? (c.editorial?.reasons ?? []).join('; ') : '',
      ...(neonText ? { neon: neonText } : {}),
    };
  });
  const accounted = reconciliation.length;
  const sourceRows = Object.values(adapter.totals).reduce((n, t) => n + t.sourceRows, 0);
  check('reconciliation: every source row has a disposition', accounted === sourceRows ? [] : [`${accounted} of ${sourceRows}`], `${accounted} of ${sourceRows} source rows accounted for`);

  return { ok: checks.every((c) => c.ok), checks, reconciliation, warnings };
}

const LABEL: Record<ReconRow['disposition'], string> = {
  'imported-published': 'imported — published',
  'imported-draft-held': 'imported as draft — held for review',
  merged: 'merged into another submission',
  'held-not-imported': 'held for review — not imported',
  quarantined: 'held — junk submission (quarantined)',
  failed: 'failed (recoverable)',
};

/** The committed, privacy-safe reconciliation of all source rows. */
export function renderBaserowReconciliation(input: {
  /** What was verified where — real API, local clone, or a rehearsal file. */
  notes?: string[];
  generatedAt: string;
  rows: ReconRow[];
  checks: Check[];
  warnings: string[];
  counts: Record<string, number | string>;
  workspace: string;
}): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# Baserow migration — event archive reconciliation',
    '',
    `Generated ${input.generatedAt}. Destination: ${input.workspace}.`,
    'Row numbers are Excel rows of `Form responses 1` (header = row 1). Withheld values are referred to by cell coordinate only.',
    '',
    ...(input.notes?.length ? [...input.notes.map((n) => `- ${n}`), ''] : []),
    '## Counts',
    '',
    '| Measure | Count |',
    '| --- | ---: |',
    ...Object.entries(input.counts).map(([k, v]) => `| ${esc(k)} | ${v} |`),
    '',
    '## Read-back verification',
    '',
    '| Check | Result | Detail |',
    '| --- | --- | --- |',
    ...input.checks.map((c) => `| ${esc(c.name)} | ${c.ok ? 'pass' : '**FAIL**'} | ${esc(c.detail)} |`),
    '',
    ...(input.warnings.length ? ['Warnings:', '', ...input.warnings.map((w) => `- ${w}`), ''] : []),
  ];
  for (const source of ['impact-lab-2', 'fable-5-1'] as SourceId[]) {
    const spec = SOURCES[source];
    lines.push(`## ${spec.label} — held ${spec.heldOn}`, '', '| Row | Disposition | Title | Baserow row | Earlier local project | Website (local sync) | Reason / notes |', '| ---: | --- | --- | ---: | --- | --- | --- |');
    for (const r of input.rows.filter((x) => x.source === source)) {
      lines.push(
        `| ${r.row} | ${LABEL[r.disposition]}${r.mergedInto ? ` (row ${r.mergedInto})` : ''} | ${esc(r.title ?? '—')} | ${r.baserowRowId ?? '—'} | ${r.matchedLocalProject ? `/projects/${r.matchedLocalProject}/` : '—'} | ${esc(r.neon ?? '—')} | ${esc(r.reason || '')} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}
