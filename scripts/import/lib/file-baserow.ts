/**
 * A FILE-BACKED BASEROW, for local rehearsal only.
 *
 * Real Baserow credentials are not available in development, but the import
 * must still go through the real pipeline: importer → Baserow rows → ledger →
 * the sync queue → the projection → Neon. This stands in for the HTTP client
 * at exactly the interfaces those modules already accept (`Writer`,
 * `RowSource`, `listFields`) and speaks Baserow's wire shapes:
 *
 *   write  link_row → [rowId, …]      read  link_row → [{ id, value }, …]
 *   write  single_select → optionId   read  single_select → { id, value, color }
 *
 * so a shape bug shows up here the same way it would against the API. It is
 * NOT a second data source for the website: nothing deployed can read it, and
 * the CLI refuses to use it with a non-local database.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ConfigSchema, type BaserowConfig } from '../../../src/server/integrations/baserow/config';
import { SPEC, type FieldSpec, type LiveField, type TableKey } from '../../../src/server/integrations/baserow/spec';

type Row = { id: number } & Record<string, unknown>;

interface State {
  nextRowId: number;
  /** Per-table row ids, as Baserow numbers them. Absent in older fixture files. */
  nextRowIds?: Record<string, number>;
  tables: Record<string, { fields: LiveField[]; rows: Row[] }>;
}

const TABLE_IDS: Record<TableKey, number> = { cities: 9001, events: 9002, projects: 9003, credits: 9004 };

/** Deterministic table and field ids for the fixture, derived from the spec. */
export function fixtureConfig(): BaserowConfig {
  let next = 100;
  const tables = {} as Record<TableKey, { tableId: number; fields: Record<string, number> }>;
  for (const table of Object.keys(SPEC) as TableKey[]) {
    const fields: Record<string, number> = {};
    for (const key of Object.keys(SPEC[table])) fields[key] = next++;
    tables[table] = { tableId: TABLE_IDS[table], fields };
  }
  return ConfigSchema.parse({ tables });
}

function liveFields(config: BaserowConfig, table: TableKey): LiveField[] {
  let option = table === 'projects' ? 5000 : table === 'events' ? 6000 : 7000;
  const fields = config.tables[table]?.fields ?? {};
  return Object.entries(SPEC[table] as Record<string, FieldSpec>).filter(([key]) => fields[key] !== undefined).map(([key, spec]) => ({
    id: fields[key]!,
    name: spec.label,
    type: spec.types[0],
    ...(spec.linksTo && config.tables[spec.linksTo] ? { link_row_table_id: config.tables[spec.linksTo]!.tableId } : {}),
    ...(spec.options ? { select_options: spec.options.map((value) => ({ id: option++, value })) } : {}),
  }));
}

class NotFound extends Error {
  kind = 'not-found' as const;
}

export class FileBaserow {
  readonly config: BaserowConfig;
  private state: State;

  constructor(
    private readonly path: string,
    config: BaserowConfig = fixtureConfig(),
  ) {
    this.config = config;
    if (existsSync(path)) {
      this.state = JSON.parse(readFileSync(path, 'utf8')) as State;
    } else {
      this.state = { nextRowId: 1, tables: {} };
      for (const table of Object.keys(SPEC) as TableKey[]) {
        const t = config.tables[table];
        if (t) this.state.tables[String(t.tableId)] = { fields: liveFields(config, table), rows: [] };
      }
      this.save();
    }
  }

  /**
   * A fixture that MIRRORS a real workspace: its live field lists (ids,
   * types, select options, primary field) and its existing rows. Used to
   * rehearse an import against the exact schema the real API will see.
   */
  static mirror(path: string, config: BaserowConfig, tables: Record<number, { fields: LiveField[]; rows: Row[] }>): FileBaserow {
    const state: State = { nextRowId: 1, nextRowIds: {}, tables: {} };
    for (const [id, t] of Object.entries(tables)) {
      state.tables[id] = structuredClone(t);
      state.nextRowIds![id] = Math.max(0, ...t.rows.map((r) => r.id)) + 1;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2));
    return new FileBaserow(path, config);
  }

  private save() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.state, null, 2));
  }

  private table(tableId: number) {
    const t = this.state.tables[String(tableId)];
    if (!t) throw new NotFound(`table ${tableId} is not in the fixture`);
    return t;
  }

  /** Write shape → stored read shape, through the field definitions. */
  private toStored(tableId: number, fields: Record<string, unknown>): Record<string, unknown> {
    const { fields: defs } = this.table(tableId);
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      const def = defs.find((f) => `field_${f.id}` === key);
      if (!def) throw Object.assign(new Error(`unknown field ${key}`), { kind: 'client' });
      if (def.type === 'link_row') {
        out[key] = ((value as number[] | null) ?? []).map((id) => ({ id, value: String(id) }));
      } else if (def.type === 'single_select') {
        const option = value === null ? null : def.select_options?.find((o) => o.id === value);
        if (value !== null && !option) throw Object.assign(new Error(`invalid option ${String(value)} for ${key}`), { kind: 'client' });
        out[key] = option ? { ...option, color: 'blue' } : null;
      } else if (def.type === 'multiple_select') {
        out[key] = ((value as number[] | null) ?? []).map((id) => def.select_options?.find((o) => o.id === id)).filter(Boolean);
      } else if (def.type === 'url' && value !== null && value !== '') {
        // Baserow refuses what is not a URL (ERROR_REQUEST_BODY_VALIDATION).
        if (typeof value !== 'string' || !/^https?:\/\/\S+$/i.test(value)) throw Object.assign(new Error(`invalid url for ${key}`), { kind: 'bad-request' });
        out[key] = value;
      } else if (def.type === 'date' && value !== null) {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw Object.assign(new Error(`invalid date for ${key}`), { kind: 'bad-request' });
        out[key] = value;
      } else if (def.type === 'number' && value !== null) {
        // Baserow answers number fields as decimal strings.
        out[key] = String(value);
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  async listFields(tableId: number): Promise<LiveField[]> {
    return structuredClone(this.table(tableId).fields);
  }

  async getRow(tableId: number, rowId: number): Promise<Row> {
    const row = this.table(tableId).rows.find((r) => r.id === rowId);
    if (!row) throw new NotFound(`row ${rowId} not found`);
    return structuredClone(row);
  }

  async listAllRows(tableId: number): Promise<{ rows: Row[]; complete: boolean; pages: number }> {
    const rows = structuredClone(this.table(tableId).rows);
    return { rows, complete: true, pages: Math.max(1, Math.ceil(rows.length / 200)) };
  }

  async createRow(tableId: number, fields: Record<string, unknown>): Promise<Row> {
    const t = String(tableId);
    let id: number;
    if (this.state.nextRowIds) {
      id = this.state.nextRowIds[t] ?? Math.max(0, ...this.table(tableId).rows.map((r) => r.id)) + 1;
      this.state.nextRowIds[t] = id + 1;
    } else {
      id = this.state.nextRowId++;
    }
    const row: Row = { id, ...this.toStored(tableId, fields) };
    this.table(tableId).rows.push(row);
    this.save();
    return structuredClone(row);
  }

  async updateRow(tableId: number, rowId: number, fields: Record<string, unknown>): Promise<Row> {
    const row = this.table(tableId).rows.find((r) => r.id === rowId);
    if (!row) throw new NotFound(`row ${rowId} not found`);
    Object.assign(row, this.toStored(tableId, fields));
    this.save();
    return structuredClone(row);
  }

  async deleteRow(tableId: number, rowId: number): Promise<void> {
    const t = this.table(tableId);
    const before = t.rows.length;
    t.rows = t.rows.filter((r) => r.id !== rowId);
    if (t.rows.length === before) throw new NotFound(`row ${rowId} not found`);
    this.save();
  }

  /** Field id → `field_<id>` key, by logical name. */
  field(table: TableKey, key: string): string {
    const id = this.config.tables[table]?.fields[key];
    if (id === undefined) throw new Error(`no ${table}.${key} in the fixture config`);
    return `field_${id}`;
  }

  optionId(table: TableKey, key: string, value: string): number {
    const t = this.config.tables[table];
    if (!t) throw new Error(`no ${table} table in the fixture config`);
    const def = this.table(t.tableId).fields.find((f) => f.id === t.fields[key]);
    const option = def?.select_options?.find((o) => o.value === value);
    if (!option) throw new Error(`no option "${value}" on ${table}.${key}`);
    return option.id;
  }
}
