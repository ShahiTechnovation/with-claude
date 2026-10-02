/**
 * THE DRY RUN — what an import would do, before it does anything.
 *
 * For each candidate it decides one of:
 *
 *   create      no known row: a new Baserow project row (draft by default)
 *   update      a known row (crosswalk, or a Baserow row with this key):
 *               only the fields that differ, listed before → after. An empty
 *               cell in a revised sheet means MISSING, not "clear it".
 *   unchanged   a known row with nothing new
 *   review      a person must decide: a weak identity (title + team only), a
 *               possible duplicate of an existing project, or a same-title
 *               clash inside the event
 *
 * Nothing is written to Baserow here. The plan and an editable decisions file
 * are written locally (under `imports/`, git-ignored) for `apply`.
 */
import type { Candidate, BuildStats } from './candidates';
import { artifactKey, identityText } from './normalise';

export interface ExistingBaserowProject {
  rowId: number;
  key: string | null;
  /** Current values in the candidate's vocabulary, for diffing. */
  values: Partial<Record<DiffField, string>>;
  creditNames: string[];
}

export interface ExistingNeonProject {
  slug: string;
  title: string;
  artifacts: (string | null)[];
  /** The Baserow row this project is projected from, if any. */
  baserowRowId: number | null;
  /** …and that row's table, so a row id from another table never matches. */
  baserowTableId?: number | null;
  /**
   * The import candidate this project was projected from, when the import
   * ledger says so. A project that IS an earlier import of the same
   * submission is a match, not a duplicate.
   */
  candidateKey?: string | null;
  contentAuthority: string;
}

export const DIFF_FIELDS = [
  'title',
  'summary',
  'description',
  'category',
  'tags',
  'liveUrl',
  'repoUrl',
  'videoUrl',
  'claudeUsage',
  'teamName',
  'problem',
  'solution',
  'builtWith',
  'buildStatus',
  'downloadUrl',
  'artifactUrl',
  'altVideoUrl',
  'slug',
  'sourceRows',
  'reviewNotes',
] as const;
export type DiffField = (typeof DIFF_FIELDS)[number];

/** Field values this importer last wrote to a Baserow row, from the ledger. */
export type LastWritten = Map<number, Partial<Record<DiffField, string>>>;

export type Action = 'create' | 'update' | 'unchanged' | 'review';

export interface PlannedItem {
  key: string;
  action: Action;
  title: string;
  basis: string;
  targetRowId: number | null;
  diff: { field: DiffField; before: string; after: string }[];
  /**
   * Fields an organiser changed in Baserow after the import wrote them (or
   * that were never the import's): the organiser's value stands.
   */
  kept: { field: DiffField; current: string; source: string }[];
  /** The existing Neon project this candidate already is (an earlier import). */
  matchedProject: string | null;
  newCredits: string[];
  missing: string[];
  publishable: boolean;
  reasons: string[];
  sources: Candidate['sources'];
  problems: string[];
}

export interface PlanTotals {
  sourceRows: number;
  candidates: number;
  groupedRows: number;
  create: number;
  update: number;
  unchanged: number;
  review: number;
  /** Candidates that are already a Neon project through an earlier import. */
  matchedExisting: number;
  /** Fields kept as an organiser edited them. */
  keptEdits: number;
  suspectedDuplicates: number;
  weakIdentity: number;
  missing: Record<string, number>;
  invalidLinks: number;
  withheldColumns: number;
  withheldPublicValues: number;
  creditsWithoutConsent: number;
}

export interface Plan {
  label: string;
  file: string;
  checksum: string;
  createdAt: string;
  totals: PlanTotals;
  items: PlannedItem[];
  withheldColumns: string[];
  errors: string[];
}

export function candidateValue(c: Candidate, field: DiffField): string {
  const v = c[field];
  return Array.isArray(v) ? v.join(', ') : (v ?? '');
}

/** The historical-archive contract, mirrored from the projection. */
export function missingForArchive(c: Candidate): string[] {
  return [
    !c.summary && 'summary',
    !c.liveUrl && !c.repoUrl && !c.videoUrl && !c.downloadUrl && 'artifact link',
  ].filter(Boolean) as string[];
}

export function buildPlan(input: {
  label: string;
  file: string;
  checksum: string;
  candidates: Candidate[];
  stats: BuildStats;
  errors: string[];
  crosswalk: Map<string, number | null>;
  baserowRows: ExistingBaserowProject[];
  neonProjects: ExistingNeonProject[];
  /** What the importer last wrote per row; without it, only empty fields are filled. */
  lastWritten?: LastWritten;
}): Plan {
  // One key, one row. Two Baserow rows claiming the same key — or two
  // candidates with the same key — would make every later write ambiguous.
  const seenKeys = new Map<string, number>();
  for (const r of input.baserowRows) {
    if (!r.key) continue;
    if (seenKeys.has(r.key)) {
      throw new Error(`Baserow rows ${seenKeys.get(r.key)} and ${r.rowId} carry the same key ${r.key} — resolve the duplicate before importing`);
    }
    seenKeys.set(r.key, r.rowId);
  }
  const candidateKeys = new Set<string>();
  for (const c of input.candidates) {
    if (candidateKeys.has(c.key)) throw new Error(`two candidates share the key ${c.key} — the source adapter must merge or distinguish them`);
    candidateKeys.add(c.key);
  }
  const byKey = new Map(input.baserowRows.filter((r) => r.key).map((r) => [r.key!, r]));
  const byRowId = new Map(input.baserowRows.map((r) => [r.rowId, r]));
  const neonByArtifact = new Map<string, ExistingNeonProject>();
  for (const p of input.neonProjects) {
    for (const a of p.artifacts.map(artifactKey)) if (a) neonByArtifact.set(a, p);
  }
  // Same normalised title within one event, different identities: suspicious.
  const titleCount = new Map<string, number>();
  for (const c of input.candidates) {
    const t = `${c.eventKey}|${identityText(c.title)}`;
    titleCount.set(t, (titleCount.get(t) ?? 0) + 1);
  }

  const items: PlannedItem[] = input.candidates.map((c) => {
    const reasons: string[] = [];
    const crossRow = input.crosswalk.get(c.key) ?? null;
    const existing = (crossRow ? byRowId.get(crossRow) : undefined) ?? byKey.get(c.key);

    // The earlier projection of this same submission: a match, not a duplicate.
    const matched = input.neonProjects.find((p) => p.candidateKey === c.key) ?? null;
    // Possible duplicate: an artifact we already have, under a different row.
    for (const a of [c.repoUrl, c.liveUrl, c.videoUrl].map(artifactKey)) {
      const hit = a ? neonByArtifact.get(a) : undefined;
      if (hit && hit.candidateKey === c.key) continue;
      if (hit && (!existing || hit.baserowRowId !== existing.rowId)) {
        reasons.push(
          `possible duplicate of /projects/${hit.slug}/ (${hit.contentAuthority === 'member' ? 'a member-owned project' : 'an existing project'}) — same artifact ${a}`,
        );
        break;
      }
    }
    if (c.strength === 'title-team' && !existing) {
      reasons.push(`weak identity (${c.basis}): no submission id or artifact link to match on`);
    }
    if ((titleCount.get(`${c.eventKey}|${identityText(c.title)}`) ?? 0) > 1) {
      reasons.push('another project in this event has the same title');
    }

    const missing = missingForArchive(c);
    if (c.editorial?.disposition === 'hold') {
      reasons.push(...c.editorial.reasons.map((r) => `held: ${r}`));
    }
    const base = {
      key: c.key,
      title: c.title,
      basis: c.basis,
      matchedProject: matched?.slug ?? null,
      missing,
      publishable: missing.length === 0 && c.editorial?.disposition !== 'hold',
      sources: c.sources,
      problems: c.problems,
    };

    if (existing) {
      // THREE-WAY: a field is updated only when it is empty in Baserow, or
      // still holds exactly what this importer last wrote there. Anything else
      // is an organiser's edit (or was never ours) and stands.
      const last = input.lastWritten?.get(existing.rowId);
      const diff: PlannedItem['diff'] = [];
      const kept: PlannedItem['kept'] = [];
      for (const field of DIFF_FIELDS) {
        const after = candidateValue(c, field);
        const before = existing.values[field] ?? '';
        // Missing in the sheet is not a request to clear.
        if (!after || after === before) continue;
        if (!before || (last?.[field] !== undefined && last[field] === before)) diff.push({ field, before, after });
        else kept.push({ field, current: before, source: after });
      }
      const known = new Set(existing.creditNames.map((n) => n.toLowerCase()));
      const newCredits = c.credits.map((cr) => cr.displayName).filter((n) => !known.has(n.toLowerCase()));
      // An editorial hold is information on an existing row, not a blocker:
      // the row is already a draft, and updates never change its status.
      const blocking = reasons.filter((r) => !r.startsWith('held:'));
      const action: Action = blocking.length ? 'review' : diff.length || newCredits.length ? 'update' : 'unchanged';
      return { ...base, action, targetRowId: existing.rowId, diff, kept, newCredits, reasons };
    }
    return {
      ...base,
      action: reasons.length ? 'review' : 'create',
      targetRowId: null,
      kept: [],
      diff: DIFF_FIELDS.flatMap((field) => {
        const after = candidateValue(c, field);
        return after ? [{ field, before: '', after }] : [];
      }),
      newCredits: c.credits.map((cr) => cr.displayName),
      reasons,
    };
  });

  const missingCounts: Record<string, number> = {};
  for (const item of items) for (const m of item.missing) missingCounts[m] = (missingCounts[m] ?? 0) + 1;
  const count = (a: Action) => items.filter((i) => i.action === a).length;

  return {
    label: input.label,
    file: input.file,
    checksum: input.checksum,
    createdAt: new Date().toISOString(),
    items,
    errors: input.errors,
    withheldColumns: input.stats.withheldColumns,
    totals: {
      sourceRows: input.stats.sourceRows,
      candidates: items.length,
      groupedRows: input.stats.groupedRows,
      create: count('create'),
      update: count('update'),
      unchanged: count('unchanged'),
      review: count('review'),
      matchedExisting: items.filter((i) => i.matchedProject).length,
      keptEdits: items.reduce((n, i) => n + i.kept.length, 0),
      suspectedDuplicates: items.filter((i) => i.reasons.some((r) => r.startsWith('possible duplicate'))).length,
      weakIdentity: items.filter((i) => i.reasons.some((r) => r.startsWith('weak identity'))).length,
      missing: missingCounts,
      invalidLinks: input.stats.invalidLinks,
      withheldColumns: input.stats.withheldColumns.length,
      withheldPublicValues: input.stats.withheldPublicValues,
      creditsWithoutConsent: input.stats.creditsWithoutConsent,
    },
  };
}

/** A human-readable report for the organiser. No private values appear in it. */
export function renderPlan(plan: Plan): string {
  const t = plan.totals;
  const lines = [
    `# Import plan — ${plan.label}`,
    '',
    `File: ${plan.file} (sha256 ${plan.checksum.slice(0, 12)}…) · planned ${plan.createdAt}`,
    '',
    '## Totals',
    '',
    `| Source rows | Candidates | Rows grouped into a project | Create | Update | Unchanged | Needs review |`,
    `| --- | --- | --- | --- | --- | --- | --- |`,
    `| ${t.sourceRows} | ${t.candidates} | ${t.groupedRows} | ${t.create} | ${t.update} | ${t.unchanged} | ${t.review} |`,
    '',
    `- Already a project through an earlier import (matched by source key, not duplicated): ${t.matchedExisting ?? 0}`,
    `- Fields kept as an organiser edited them in Baserow: ${t.keptEdits ?? 0}`,
    `- Suspected duplicates: ${t.suspectedDuplicates}`,
    `- Weak identities (title + team only): ${t.weakIdentity}`,
    `- Missing for publication: ${Object.entries(t.missing).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`,
    `- Invalid links dropped: ${t.invalidLinks}`,
    `- Columns withheld (not imported): ${t.withheldColumns}${plan.withheldColumns.length ? ` — ${plan.withheldColumns.join('; ')}` : ''}`,
    `- Values withheld because they looked like contact details: ${t.withheldPublicValues}`,
    `- Person credits withheld for lack of consent: ${t.creditsWithoutConsent}`,
    '',
  ];
  if (plan.errors.length) {
    lines.push('## Errors (not imported)', '', ...plan.errors.map((e) => `- ${e}`), '');
  }
  for (const section of ['review', 'create', 'update', 'unchanged'] as Action[]) {
    const rows = plan.items.filter((i) => i.action === section);
    if (!rows.length) continue;
    lines.push(`## ${section[0].toUpperCase()}${section.slice(1)} (${rows.length})`, '');
    for (const item of rows) {
      lines.push(`### ${item.title}`, '');
      lines.push(`- key \`${item.key}\` · ${item.basis}${item.targetRowId ? ` · Baserow row ${item.targetRowId}` : ''}`);
      lines.push(`- from ${item.sources.map((s) => `${s.sheet} rows ${s.rows.join(', ')}`).join('; ')}`);
      if (item.matchedProject) lines.push(`- matches the existing project /projects/${item.matchedProject}/ (earlier import of this submission)`);
      if (item.reasons.length) lines.push(...item.reasons.map((r) => `- **review:** ${r}`));
      if (item.kept.length) lines.push(...item.kept.map((k) => `- kept organiser edit: ${k.field}`));
      if (item.missing.length) lines.push(`- missing for publication: ${item.missing.join(', ')}`);
      if (item.problems.length) lines.push(...item.problems.map((p) => `- note: ${p}`));
      if (section !== 'create' && item.diff.length) {
        lines.push('', '| Field | Before | After |', '| --- | --- | --- |');
        for (const d of item.diff) lines.push(`| ${d.field} | ${d.before.replace(/\|/g, '\\|').slice(0, 80)} | ${d.after.replace(/\|/g, '\\|').slice(0, 80)} |`);
      }
      if (item.newCredits.length) lines.push(`- credits to add: ${item.newCredits.join(', ')}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}
