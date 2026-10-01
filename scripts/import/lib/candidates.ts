/**
 * SPREADSHEET ROWS → IMPORT CANDIDATES.
 *
 * The mapping file says, per sheet, which column means what. Nothing is
 * guessed: a column the mapping does not name is NOT imported, and is counted
 * as withheld in the report — that is how registration emails, phone numbers
 * and private answers stay out of a public dataset by default.
 *
 * Two sheet shapes:
 *
 *   per-project  one row is one project
 *   per-person   one row per team member; rows with the same identity are
 *                consolidated into ONE project with several credits. Rows
 *                that merely share a team name but describe different
 *                artifacts are NOT merged.
 *
 * Credits are public names, so the mapping must state how consent to show a
 * name was given: a consent column, or an explicit organiser declaration that
 * the listed names were already public (e.g. announced at the demo).
 */
import { z } from 'zod';
import type { Workbook } from './workbook';
import { candidateIdentity, cleanText, cleanUrl, looksPrivate, type IdentityStrength } from './normalise';

export const CATEGORIES = [
  'product',
  'agent',
  'developer-tool',
  'research',
  'creative',
  'campus',
  'experiment',
  'startup',
] as const;

const EventRef = z.object({
  /** The event's stable key in the Baserow Events table. */
  key: z.string().min(1),
  baserowRowId: z.number().int().positive(),
});

const Columns = z
  .object({
    title: z.string(),
    summary: z.string().optional(),
    description: z.string().optional(),
    category: z.string().optional(),
    tags: z.string().optional(),
    liveUrl: z.string().optional(),
    repoUrl: z.string().optional(),
    videoUrl: z.string().optional(),
    claudeUsage: z.string().optional(),
    teamName: z.string().optional(),
    submissionId: z.string().optional(),
    personName: z.string().optional(),
    personRole: z.string().optional(),
    personPublicUrl: z.string().optional(),
    publicCreditConsent: z.string().optional(),
  })
  .strict();

const Sheet = z
  .object({
    name: z.string(),
    headerRow: z.number().int().min(1).default(1),
    shape: z.enum(['per-project', 'per-person']).default('per-project'),
    event: EventRef.optional(),
    columns: Columns,
    categoryMap: z.record(z.string(), z.enum(CATEGORIES)).default({}),
    defaultCategory: z.enum(CATEGORIES).default('experiment'),
    creditPolicy: z.enum(['consent-column', 'listed-names-are-public', 'no-person-credits']).default('no-person-credits'),
    consentValues: z.array(z.string()).default(['yes', 'y', 'true', '1', 'agree', 'i agree']),
  })
  .strict()
  .superRefine((sheet, ctx) => {
    if (sheet.creditPolicy === 'consent-column' && !sheet.columns.publicCreditConsent) {
      ctx.addIssue({ code: 'custom', message: `sheet "${sheet.name}": creditPolicy consent-column needs columns.publicCreditConsent` });
    }
    if (sheet.shape === 'per-person' && !sheet.columns.personName) {
      ctx.addIssue({ code: 'custom', message: `sheet "${sheet.name}": per-person sheets need columns.personName` });
    }
  });

export const MappingSchema = z
  .object({
    label: z.string().min(3).max(120),
    event: EventRef,
    sheets: z.array(Sheet).min(1),
  })
  .strict();

export type Mapping = z.infer<typeof MappingSchema>;

export interface CandidateCredit {
  displayName: string;
  role: string | null;
  publicUrl: string | null;
}

export interface Candidate {
  key: string;
  strength: IdentityStrength;
  basis: string;
  eventKey: string;
  eventRowId: number;
  title: string;
  summary: string | null;
  description: string | null;
  category: (typeof CATEGORIES)[number];
  tags: string[];
  liveUrl: string | null;
  repoUrl: string | null;
  videoUrl: string | null;
  claudeUsage: string | null;
  teamName: string | null;
  credits: CandidateCredit[];
  sources: { sheet: string; rows: number[] }[];
  problems: string[];
}

export interface BuildStats {
  sourceRows: number;
  blankRows: number;
  groupedRows: number;
  invalidLinks: number;
  withheldColumns: string[];
  withheldPublicValues: number;
  creditsWithoutConsent: number;
}

export interface BuildResult {
  candidates: Candidate[];
  stats: BuildStats;
  errors: string[];
}

function headerIndex(headers: string[], wanted: string): number {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  return headers.findIndex((h) => norm(h) === norm(wanted));
}

export function buildCandidates(workbook: Workbook, mapping: Mapping): BuildResult {
  const errors: string[] = [];
  const stats: BuildStats = {
    sourceRows: 0,
    blankRows: 0,
    groupedRows: 0,
    invalidLinks: 0,
    withheldColumns: [],
    withheldPublicValues: 0,
    creditsWithoutConsent: 0,
  };
  const byKey = new Map<string, Candidate>();
  const withheld = new Set<string>();

  for (const sheetMap of mapping.sheets) {
    const sheet = workbook.sheets.find((s) => s.name === sheetMap.name);
    if (!sheet) {
      errors.push(`sheet "${sheetMap.name}" is not in the workbook (has: ${workbook.sheets.map((s) => s.name).join(', ')})`);
      continue;
    }
    const headers = sheet.rows[sheetMap.headerRow - 1] ?? [];
    const index: Partial<Record<keyof typeof sheetMap.columns, number>> = {};
    for (const [field, header] of Object.entries(sheetMap.columns) as [keyof typeof sheetMap.columns, string][]) {
      const i = headerIndex(headers, header);
      if (i < 0) errors.push(`sheet "${sheet.name}": column "${header}" (for ${field}) not found; headers are: ${headers.join(' | ')}`);
      else index[field] = i;
    }
    const used = new Set(Object.values(index));
    headers.forEach((h, i) => {
      if (!used.has(i) && h.trim()) withheld.add(`${sheet.name}: ${h.trim()}`);
    });
    if (errors.length) continue;

    const event = sheetMap.event ?? mapping.event;
    const cell = (row: string[], field: keyof typeof sheetMap.columns) =>
      index[field] === undefined ? '' : cleanText(row[index[field]!]);

    for (let r = sheetMap.headerRow; r < sheet.rows.length; r += 1) {
      const row = sheet.rows[r];
      const rowNumber = r + 1;
      if (!row || row.every((v) => !cleanText(v))) {
        stats.blankRows += 1;
        continue;
      }
      stats.sourceRows += 1;
      const problems: string[] = [];

      const title = cell(row, 'title');
      if (!title) {
        problems.push(`row ${rowNumber}: no project title`);
      }
      const links = (['liveUrl', 'repoUrl', 'videoUrl'] as const).map((f) => {
        const { url, invalid } = cleanUrl(cell(row, f));
        if (invalid) {
          stats.invalidLinks += 1;
          problems.push(`row ${rowNumber}: ${f} "${invalid}" is not a usable http(s) link`);
        }
        return url;
      });
      const [liveUrl, repoUrl, videoUrl] = links;
      const teamName = cell(row, 'teamName') || null;

      // Public free text must not carry contact details.
      const publicText = (value: string, field: string) => {
        if (value && looksPrivate(value)) {
          stats.withheldPublicValues += 1;
          problems.push(`row ${rowNumber}: ${field} looks like it contains an email or phone number — withheld`);
          return null;
        }
        return value || null;
      };

      const rawCategory = cell(row, 'category');
      const category =
        sheetMap.categoryMap[rawCategory] ??
        (CATEGORIES as readonly string[]).find((c) => c === rawCategory.toLowerCase()) ??
        sheetMap.defaultCategory;

      const identity = candidateIdentity({
        eventKey: event.key,
        submissionId: cell(row, 'submissionId'),
        artifacts: [repoUrl, liveUrl, videoUrl],
        title,
        teamName,
      });

      // Person credit for this row, if the policy allows publishing the name.
      let credit: CandidateCredit | null = null;
      const personName = cell(row, 'personName');
      if (personName && sheetMap.creditPolicy !== 'no-person-credits') {
        const consented =
          sheetMap.creditPolicy === 'listed-names-are-public' ||
          sheetMap.consentValues.map((v) => v.toLowerCase()).includes(cell(row, 'publicCreditConsent').toLowerCase());
        if (!consented) stats.creditsWithoutConsent += 1;
        else if (looksPrivate(personName)) stats.withheldPublicValues += 1;
        else {
          const profile = cleanUrl(cell(row, 'personPublicUrl'));
          credit = {
            displayName: personName.slice(0, 120),
            role: publicText(cell(row, 'personRole'), 'personRole')?.slice(0, 80) ?? null,
            publicUrl: profile.url,
          };
        }
      }

      const existing = byKey.get(identity.key);
      if (existing) {
        // The same project seen again — another team member's row, or a
        // duplicate submission. Fill gaps; never overwrite what is there.
        stats.groupedRows += 1;
        existing.sources.find((s) => s.sheet === sheet.name)?.rows.push(rowNumber) ??
          existing.sources.push({ sheet: sheet.name, rows: [rowNumber] });
        if (credit && !existing.credits.some((c) => c.displayName.toLowerCase() === credit!.displayName.toLowerCase())) {
          existing.credits.push(credit);
        }
        existing.summary ??= publicText(cell(row, 'summary'), 'summary');
        existing.description ??= publicText(cell(row, 'description'), 'description');
        existing.claudeUsage ??= publicText(cell(row, 'claudeUsage'), 'claudeUsage');
        existing.liveUrl ??= liveUrl;
        existing.repoUrl ??= repoUrl;
        existing.videoUrl ??= videoUrl;
        existing.problems.push(...problems);
        continue;
      }
      if (!title) {
        // No title: reported, not imported.
        errors.push(...problems);
        continue;
      }

      byKey.set(identity.key, {
        key: identity.key,
        strength: identity.strength,
        basis: identity.basis,
        eventKey: event.key,
        eventRowId: event.baserowRowId,
        title: title.slice(0, 100),
        summary: publicText(cell(row, 'summary'), 'summary')?.slice(0, 300) ?? null,
        description: publicText(cell(row, 'description'), 'description')?.slice(0, 10_000) ?? null,
        category,
        tags: [
          ...new Set(
            cell(row, 'tags')
              .split(/[,;\n]/)
              .map((t) => t.trim())
              .filter((t) => t && t.length <= 32),
          ),
        ].slice(0, 12),
        liveUrl,
        repoUrl,
        videoUrl,
        claudeUsage: publicText(cell(row, 'claudeUsage'), 'claudeUsage')?.slice(0, 1_000) ?? null,
        teamName: teamName?.slice(0, 120) ?? null,
        credits: credit ? [credit] : [],
        sources: [{ sheet: sheet.name, rows: [rowNumber] }],
        problems,
      });
    }
  }

  stats.withheldColumns = [...withheld].sort();
  return { candidates: [...byKey.values()], stats, errors };
}
