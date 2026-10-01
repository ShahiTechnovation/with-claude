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
] as const;
export type DiffField = (typeof DIFF_FIELDS)[number];

export type Action = 'create' | 'update' | 'unchanged' | 'review';

export interface PlannedItem {
  key: string;
  action: Action;
  title: string;
  basis: string;
  targetRowId: number | null;
  diff: { field: DiffField; before: string; after: string }[];
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
    !c.teamName && c.credits.length === 0 && 'team credit',
    !c.liveUrl && !c.repoUrl && !c.videoUrl && 'artifact link',
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
}): Plan {
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

    // Possible duplicate: an artifact we already have, under a different row.
    for (const a of [c.repoUrl, c.liveUrl, c.videoUrl].map(artifactKey)) {
      const hit = a ? neonByArtifact.get(a) : undefined;
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
    const base = {
      key: c.key,
      title: c.title,
      basis: c.basis,
      missing,
      publishable: missing.length === 0,
      sources: c.sources,
      problems: c.problems,
    };

    if (existing) {
      const diff = DIFF_FIELDS.flatMap((field) => {
        const after = candidateValue(c, field);
        const before = existing.values[field] ?? '';
        // Missing in the sheet is not a request to clear.
        return after && after !== before ? [{ field, before, after }] : [];
      });
      const known = new Set(existing.creditNames.map((n) => n.toLowerCase()));
      const newCredits = c.credits.map((cr) => cr.displayName).filter((n) => !known.has(n.toLowerCase()));
      const action: Action = reasons.length ? 'review' : diff.length || newCredits.length ? 'update' : 'unchanged';
      return { ...base, action, targetRowId: existing.rowId, diff, newCredits, reasons };
    }
    return {
      ...base,
      action: reasons.length ? 'review' : 'create',
      targetRowId: null,
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
      if (item.reasons.length) lines.push(...item.reasons.map((r) => `- **review:** ${r}`));
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
