/**
 * The organisers' three-table workspace: field discovery by name, and the
 * privacy scan the read-back verification relies on. Pure functions; no
 * network, no database.
 */
import { describe, expect, it } from 'vitest';
import { mapFields, WORKSPACE_FIELDS, type Table } from '../scripts/baserow/lib/workspace-fields';
import { isBlankRow, privacyProblems } from '../scripts/import/lib/workspace';
import { SPEC, type FieldSpec, type LiveField } from '../src/server/integrations/baserow/spec';

const IDS: Record<Table, number> = { projects: 1236064, events: 1236080, credits: 1236082 };

/** A workspace with every field this import needs, named as the setup guide says. */
function workspace(): Record<Table, LiveField[]> {
  let id = 100;
  const out = {} as Record<Table, LiveField[]>;
  for (const table of ['events', 'projects', 'credits'] as Table[]) {
    const spec = SPEC[table] as Record<string, FieldSpec>;
    out[table] = [
      { id: id++, name: 'Name', type: 'text', primary: true } as LiveField,
      { id: id++, name: 'Notes', type: 'long_text' },
      ...WORKSPACE_FIELDS[table]
        .filter((w) => w.type !== 'primary')
        .map((w) => ({
          id: id++,
          name: ` ${spec[w.key].label.toUpperCase()} `,
          type: w.type,
          ...(w.type === 'link_row' ? { link_row_table_id: IDS[w.key === 'event' ? 'events' : 'projects'] } : {}),
          ...(spec[w.key].options ? { select_options: spec[w.key].options!.map((value, i) => ({ id: id * 100 + i, value })) } : {}),
        })),
    ];
  }
  return out;
}

describe('field discovery', () => {
  it('maps the primary field to the title and every other field by its label, case-insensitively', () => {
    const live = workspace();
    const { config, problems } = mapFields(live, IDS);
    expect(problems).toEqual([]);
    expect(config.tables.projects.fields.title).toBe(live.projects[0].id);
    expect(config.tables.credits.fields.displayName).toBe(live.credits[0].id);
    expect(config.tables.events.tableId).toBe(IDS.events);
    expect(config.tables.cities).toBeUndefined();
    // "Notes" is not in the spec: never mapped, never written.
    expect(Object.values(config.tables.events.fields)).not.toContain(live.events[1].id);
  });

  it('refuses a workspace with a required field missing, mistyped, or a link to the wrong table', () => {
    const missing = workspace();
    missing.projects = missing.projects.filter((f) => f.name.trim() !== 'THE PROBLEM');
    expect(mapFields(missing, IDS).problems.join('\n')).toContain('no field named "The problem"');

    const mistyped = workspace();
    mistyped.events.find((f) => f.name.trim() === 'DATE')!.type = 'text';
    expect(mapFields(mistyped, IDS).problems.join('\n')).toMatch(/date: .* is text; expected date/);

    const mislinked = workspace();
    mislinked.projects.find((f) => f.name.trim() === 'EVENT')!.link_row_table_id = 999;
    expect(mapFields(mislinked, IDS).problems.join('\n')).toContain('must link to the events table');

    const cityLink = workspace();
    Object.assign(cityLink.events.find((f) => f.name.trim() === 'CITY')!, { type: 'link_row', link_row_table_id: 5 });
    expect(mapFields(cityLink, IDS).problems.join('\n')).toContain('no cities table is configured');
  });

  it('an optional field may be absent', () => {
    const live = workspace();
    live.projects = live.projects.filter((f) => f.name.trim() !== 'FEATURED');
    const { problems, notes } = mapFields(live, IDS);
    expect(problems).toEqual([]);
    expect(notes.join('\n')).toContain('Featured');
  });
});

describe('privacy scan', () => {
  it('names the category, never the value', () => {
    expect(privacyProblems('write to someone@example.com')).toEqual(['looks like an email address or phone number']);
    expect(privacyProblems('call +91 98765 43210')).toEqual(['looks like an email address or phone number']);
    expect(privacyProblems('https://app.example.com/admin/keys?key=abc123secret')).toEqual(
      expect.arrayContaining(['URL carries a credential-like or access parameter', 'URL is an admin route']),
    );
    expect(privacyProblems('https://demo.vercel.app/?_vercel_share=x')).toContain('URL carries a credential-like or access parameter');
    expect(privacyProblems('http://localhost:8765/repo')).toContain('URL points at a local or private host');
    expect(privacyProblems('http://192.168.1.4:3000')).toContain('URL points at a local or private host');
    expect(privacyProblems('https://abc.trycloudflare.com')).toContain('URL is a temporary tunnel');
    expect(privacyProblems('javascript:alert(1)')).toContain('unsafe URL scheme');
    const found = privacyProblems('Built by Asha Rao', [{ label: 'contains a personal name', values: new Set(['asha rao']) }]);
    expect(found).toEqual(['contains a personal name']);
    expect(JSON.stringify(found)).not.toContain('Asha');
  });

  it('passes ordinary public content', () => {
    expect(privacyProblems('https://github.com/team/repo and https://team.vercel.app/')).toEqual([]);
    expect(privacyProblems('A tool for 15 September 2026 — 3,000 users.')).toEqual([]);
  });

  it('recognises Baserow default blank rows', () => {
    expect(isBlankRow({ id: 1, order: '1.0', field_1: '', field_2: false, field_3: null, field_4: [] })).toBe(true);
    expect(isBlankRow({ id: 2, order: '2.0', field_1: 'x' })).toBe(false);
  });
});

describe('field discovery is forgiving about names, strict about types', () => {
  it('accepts a label without its parenthetical, and refuses rich text', () => {
    const live = workspace();
    live.events.find((f) => f.name.trim() === 'SHORT TITLE (BADGES)')!.name = 'Short title';
    live.projects.find((f) => f.name.trim() === 'BUILD STATUS (SELF-REPORTED)')!.name = 'Build status';
    expect(mapFields(live, IDS).problems).toEqual([]);
    Object.assign(live.projects.find((f) => f.name.trim() === 'THE SOLUTION')!, { long_text_enable_rich_text: true });
    expect(mapFields(live, IDS).problems.join('\n')).toContain('rich text formatting on');
  });
});

describe('field discovery catches what an assistant may get wrong', () => {
  it('refuses duplicate names, a date with time, and a multi-relationship link', () => {
    const dup = workspace();
    const key = dup.events.find((f) => f.name.trim() === 'KEY')!;
    dup.events.push({ ...key, id: 99_999 });
    expect(mapFields(dup, IDS).problems.join('\n')).toContain('2 fields are named "Key"');

    const timed = workspace();
    Object.assign(timed.events.find((f) => f.name.trim() === 'DATE')!, { date_include_time: true });
    expect(mapFields(timed, IDS).problems.join('\n')).toContain('includes a time');

    const multi = workspace();
    Object.assign(multi.projects.find((f) => f.name.trim() === 'EVENT')!, { link_row_multiple_relationships: true });
    expect(mapFields(multi, IDS).problems.join('\n')).toContain('allows multiple relationships');

    const single = workspace();
    Object.assign(single.projects.find((f) => f.name.trim() === 'EVENT')!, { link_row_multiple_relationships: false });
    expect(mapFields(single, IDS).problems).toEqual([]);
  });
});
