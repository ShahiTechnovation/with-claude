/**
 * THE OCTOBER IMPACT LAB REPORT — every source row, accounted for — and the
 * published rows as `src/data/projects.ts` entries.
 *
 * Safe to commit: project titles, published team labels, public links,
 * decisions and cell coordinates. Never an email, a member name, a timestamp
 * or a private note; `commands.ts` passes both outputs through `outputGuard`
 * before writing them.
 */
import { BUILT_AT, SOURCE, type LabResult } from './index';

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderLabReport(result: LabResult, options: { generatedAt: string }): string {
  const byKey = new Map(result.candidates.map((c) => [c.key, c]));
  const t = result.totals;
  const { actual, expected } = result.checksum;
  const lines = [
    '# October Impact Lab import — reconciliation report',
    '',
    `Generated ${options.generatedAt} by \`npm run import -- lab-oct-report\`. Source: the organiser’s Google Form export (unchanged, not committed).`,
    'Row numbers are Excel rows with the header at row 1. Withheld values are referred to by cell coordinate only.',
    '',
    '## Publishing basis',
    '',
    'Confirmed by Vishal 2026-10-17, 12:34: "yes they agree" — the participants agreed to their projects and names being public.',
    'The form’s four confirmations (W–Z) are not a permission to publish. This import still creates no person credits, so member names stay unpublished.',
    '',
    '## Totals',
    '',
    '| Event (held on) | Source rows | Candidates | Publish | Held | Dropped | Merged |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    `| ${SOURCE.event} (${SOURCE.heldOn}) | ${t.sourceRows} | ${t.candidates} | ${t.publish} | ${t.hold} | ${t.dropped} | ${t.merged} |`,
    '',
    `Every source row is a candidate (${t.candidates}) or dropped (${t.dropped}) — ${t.candidates + t.dropped} of ${t.sourceRows}.`,
    '',
    `- ${SOURCE.label}: sha256 ${actual.slice(0, 16)}… ${actual === expected ? '(matches the reviewed file)' : '(DIFFERS from the reviewed file — re-review)'}`,
    '',
    '## Open decisions (held as drafts)',
    '',
    'Held rows are written to Baserow as drafts and are never published by `--publish`.',
    '',
    '| Row | Proposed title | What is needed |',
    '| ---: | --- | --- |',
  ];
  for (const r of result.rows) {
    if (r.outcome.kind !== 'candidate' || r.outcome.disposition !== 'hold') continue;
    const c = byKey.get(r.outcome.key)!;
    lines.push(`| ${r.row} | ${esc(c.title)} | ${esc((c.editorial?.reasons ?? []).join('; '))} |`);
  }
  lines.push(
    '',
    `## ${SOURCE.label} — held ${SOURCE.heldOn}`,
    '',
    '| Row | Outcome | Title | Team label | Track | Links published | Notes |',
    '| ---: | --- | --- | --- | --- | --- | --- |',
  );
  for (const r of result.rows) {
    const o = r.outcome;
    if (o.kind === 'dropped') {
      lines.push(
        `| ${r.row} | dropped | ${esc(o.title)} | — | — | — | ${esc([...o.reasons, ...r.notes].join('; '))} |`,
      );
      continue;
    }
    const c = byKey.get(o.key)!;
    const links = [
      c.liveUrl && `live ${c.liveUrl}`,
      c.repoUrl && `repo ${c.repoUrl}`,
      c.videoUrl && `video ${c.videoUrl}`,
      c.altVideoUrl && `second video ${c.altVideoUrl}`,
      c.downloadUrl && `download ${c.downloadUrl}`,
      c.artifactUrl && `artifact ${c.artifactUrl}`,
    ].filter(Boolean);
    lines.push(
      `| ${r.row} | ${o.disposition === 'hold' ? '**held**' : 'publish'} | ${esc(c.title)} | ${esc(c.teamName ?? '—')} | ${esc(c.tags.join(', ') || '—')} | ${esc(links.join('<br>') || 'none')} | ${esc(r.notes.join('; '))} |`,
    );
  }
  const labels = result.rows.filter((r) => r.teamLabelWithheld).map((r) => `E${r.row}`);
  lines.push(
    '',
    '## What is withheld everywhere',
    '',
    '- Every email column (B, D, G, I, K, M) — never read by the adapter.',
    '- Member names (C, F, H, J, L) — read in memory only, to count the roster and to refuse any output that contains one. No person credit is created.',
    `- Team labels that are not a publishable team name: ${labels.join(', ') || 'none'}.`,
    '- Team size (N), submission timestamps (A), the four confirmations (W–Z) and "anything else" notes (AA) — private review evidence.',
    '',
  );
  return lines.join('\n');
}

/**
 * The published rows in September's `src/data/projects.ts` shape: the card
 * line is the editorial summary, the summary is the "Built at" line, no
 * image (each project gets a drawn tile under its slug).
 */
export function renderProjectsEntries(
  result: LabResult,
  slugs: Map<string, string>,
  typesImport: string,
): string {
  const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const published = result.candidates.filter((c) => c.editorial?.disposition === 'publish');
  const lines = [
    `import type { Project } from ${q(typesImport)};`,
    '',
    `// ── ${SOURCE.event}, 11 October 2026 — ${published.length} published projects ──`,
    '// Generated by `npm run import -- lab-oct-report --ts`; see docs/imports/2026-10-impact-lab.md.',
    'export const entries: Project[] = [',
  ];
  for (const c of published) {
    const slug = slugs.get(c.key)!;
    lines.push(
      '  {',
      `    id: ${q(`prj-${slug}`)},`,
      `    slug: ${q(slug)},`,
      "    status: 'published',",
      `    title: ${q(c.title)},`,
      '    builderSlugs: [],',
      "    citySlug: 'bhopal',",
      `    summary: ${q(BUILT_AT)},`,
      `    createdAt: ${q(SOURCE.heldOn)},`,
      `    description: ${q(c.summary ?? '')},`,
      `    category: ${q(c.category)},`,
      ...(c.liveUrl ? [`    url: ${q(c.liveUrl)},`] : []),
      ...(c.repoUrl ? [`    repoUrl: ${q(c.repoUrl)},`] : []),
      ...(c.videoUrl ? [`    videoUrl: ${q(c.videoUrl)},`] : []),
      `    builtAtEventSlug: ${q(SOURCE.eventSlug)},`,
      '  },',
    );
  }
  lines.push('];', '');
  return lines.join('\n');
}
