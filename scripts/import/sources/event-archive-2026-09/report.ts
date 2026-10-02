/**
 * THE RECONCILIATION REPORT — every source row, accounted for.
 *
 * Safe to commit and to share: it contains project titles, team labels that
 * are published, public artifact URLs that are published, decisions and
 * coordinates. It never contains an email, a member name, a timestamp, the
 * withheld admin URL, an access parameter, a tunnel URL or a private note —
 * anything withheld is referred to by its cell coordinate only.
 */
import type { Candidate } from '../../lib/candidates';
import { SOURCES, type AdapterResult, type SourceId } from './index';

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export interface PublishedCounts {
  /** From the database after the projection ran; absent in a dry run. */
  [source: string]: { public: number; draft: number } | undefined;
}

export function renderReconciliation(result: AdapterResult, options: { generatedAt: string; published?: PublishedCounts } = { generatedAt: '' }): string {
  const byKey = new Map(result.candidates.map((c) => [c.key, c]));
  const lines: string[] = [
    '# Event-archive import — reconciliation report',
    '',
    `Generated ${options.generatedAt}. Source: the two original organiser workbooks (unchanged, not committed).`,
    'Row numbers are Excel rows with the header at row 1. Withheld values are referred to by cell coordinate only.',
    '',
    '## Totals',
    '',
    '| Event (held on) | Source rows | Candidates | Publish | Held | Merged repeats | Quarantined | Public after sync | Draft after sync |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  let all = { rows: 0, candidates: 0, publish: 0, hold: 0, merged: 0, quarantined: 0 };
  for (const id of Object.keys(result.totals) as SourceId[]) {
    const t = result.totals[id];
    const p = options.published?.[id];
    lines.push(
      `| ${SOURCES[id].event} (${SOURCES[id].heldOn}) | ${t.sourceRows} | ${t.candidates} | ${t.publish} | ${t.hold} | ${t.merged} | ${t.quarantined} | ${p ? p.public : '—'} | ${p ? p.draft : '—'} |`,
    );
    all = {
      rows: all.rows + t.sourceRows,
      candidates: all.candidates + t.candidates,
      publish: all.publish + t.publish,
      hold: all.hold + t.hold,
      merged: all.merged + t.merged,
      quarantined: all.quarantined + t.quarantined,
    };
  }
  const pub = options.published
    ? Object.values(options.published).reduce((n, v) => n + (v?.public ?? 0), 0)
    : null;
  const draft = options.published
    ? Object.values(options.published).reduce((n, v) => n + (v?.draft ?? 0), 0)
    : null;
  lines.push(
    `| **Both** | **${all.rows}** | **${all.candidates}** | **${all.publish}** | **${all.hold}** | **${all.merged}** | **${all.quarantined}** | **${pub ?? '—'}** | **${draft ?? '—'}** |`,
    '',
    `Every source row is one of: a candidate (${all.candidates}), a merged repeat of a candidate (${all.merged}), or quarantined (${all.quarantined}) — ${all.candidates + all.merged + all.quarantined} of ${all.rows}.`,
    '',
  );
  for (const [id, c] of Object.entries(result.checksums)) {
    lines.push(`- ${SOURCES[id as SourceId].label}: sha256 ${c.actual.slice(0, 16)}… ${c.actual === c.expected ? '(matches the reviewed file)' : '(DIFFERS from the reviewed file — re-review)'}`);
  }
  lines.push('');

  const held = result.rows.filter((r) => r.outcome.kind === 'candidate' && r.outcome.disposition === 'hold');
  lines.push('## Open decisions (held as drafts)', '', '| Source | Row | Proposed title | What is needed |', '| --- | ---: | --- | --- |');
  for (const r of held) {
    const c = r.outcome.kind === 'candidate' ? byKey.get(r.outcome.key) : undefined;
    lines.push(`| ${SOURCES[r.source].event} | ${r.row} | ${esc(c?.title ?? '')} | ${esc((c?.editorial?.reasons ?? []).join('; '))} |`);
  }
  lines.push('');

  for (const id of Object.keys(result.totals) as SourceId[]) {
    lines.push(`## ${SOURCES[id].label} — held ${SOURCES[id].heldOn}`, '', '| Row | Outcome | Title | Team label | Status | Links published | Notes |', '| ---: | --- | --- | --- | --- | --- | --- |');
    for (const r of result.rows.filter((x) => x.source === id)) {
      const o = r.outcome;
      if (o.kind === 'quarantined') {
        lines.push(`| ${r.row} | quarantined | — | — | — | — | ${esc([...o.reasons, ...r.notes].join('; '))} |`);
        continue;
      }
      if (o.kind === 'merged') {
        lines.push(`| ${r.row} | merged into row ${o.into} | ${esc(o.title)} | — | — | — | ${esc(r.notes.join('; '))} |`);
        continue;
      }
      const c = byKey.get(o.key) as Candidate;
      const links = [
        c.liveUrl && `live ${c.liveUrl}`,
        c.repoUrl && `repo ${c.repoUrl}`,
        c.videoUrl && `video ${c.videoUrl}`,
        c.altVideoUrl && `second video ${c.altVideoUrl}`,
        c.downloadUrl && `download ${c.downloadUrl}`,
        c.artifactUrl && `artifact ${c.artifactUrl}`,
      ].filter(Boolean);
      const provenance = r.provenance ? ` · field sources: ${Object.entries(r.provenance).map(([k, v]) => `${k}←${v}`).join(', ')}` : '';
      lines.push(
        `| ${r.row} | ${o.disposition === 'hold' ? '**held**' : 'publish'} | ${esc(c.title)} | ${esc(c.teamName ?? '—')} | ${c.buildStatus ?? 'not stated'} | ${esc(links.join('<br>') || 'none')} | ${esc(r.notes.join('; ') + provenance)} |`,
      );
    }
    lines.push('');
  }
  lines.push(
    '## What is withheld everywhere',
    '',
    '- Every email column (Impact Lab B, C, E, H, J, L; Fable B) — never read by the adapter.',
    '- Member names (Impact Lab D, G, I, K) — counted for the roster check only; no person credit is created until the team gives permission.',
    '- Team labels that are a person’s name (Fable rows 2, 13, 20, 27, 33, 43, 64, 66, 73).',
    '- Submission timestamps, acknowledgements (Impact Lab V–Z, Fable K), "anything else" notes (Impact Lab AA) and showcase-post links (Fable J) — private review evidence.',
    '- Fable D39 — a credential-bearing admin URL. Never fetched, printed or stored.',
    '- Temporary tunnels (Fable D13 first link, D33) and `_vercel_share` access parameters (Fable D22, D67).',
    '',
  );
  return lines.join('\n');
}
