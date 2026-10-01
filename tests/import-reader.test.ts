/**
 * The organiser-import spreadsheet reader, tested against packages built in
 * the test itself.
 *
 * No binary fixtures live in the repo: every XLSX here is assembled by the
 * small ZIP writer below, so each test shows the exact XML it feeds in and a
 * reviewer can see why the assertion should hold. The writer computes real
 * CRC32s and real deflate streams, so these are files Excel would open — the
 * reader is not being tested against a format only it understands.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectDelimiter, parseCsv } from '../scripts/import/lib/csv';
import { readWorkbook } from '../scripts/import/lib/workbook';
import { columnLettersToIndex, decodeEntities, excelSerialToIsoDate, readXlsx } from '../scripts/import/lib/xlsx';

/* ───────────────────────────── a tiny ZIP writer ─────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipInput {
  name: string;
  data: string | Buffer;
  method?: 0 | 8;
  flags?: number;
  /** Lie about the uncompressed size, to simulate a hostile archive. */
  declaredSize?: number;
}

function zip(inputs: ZipInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const input of inputs) {
    const raw = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data, 'utf8');
    const method = input.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(input.name, 'utf8');
    const crc = crc32(raw);
    const size = input.declaredSize ?? raw.length;
    const flags = input.flags ?? 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(inputs.length, 8);
  eocd.writeUInt16LE(inputs.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

/* ───────────────────────────── XLSX fixtures ────────────────────────────── */

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

interface SheetSpec {
  name: string;
  xml: string;
  state?: 'hidden' | 'veryHidden';
}

interface XlsxSpec {
  sheets: SheetSpec[];
  sharedStrings?: string[];
  styles?: string;
  date1904?: boolean;
  extra?: ZipInput[];
}

function worksheet(sheetData: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${MAIN_NS}"><sheetData>${sheetData}</sheetData></worksheet>`;
}

function xlsxEntries(spec: XlsxSpec): ZipInput[] {
  const sheetTags = spec.sheets
    .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"${s.state ? ` state="${s.state}"` : ''}/>`)
    .join('');
  const workbookPr = spec.date1904 ? '<workbookPr date1904="1"/>' : '<workbookPr/>';
  const rels = spec.sheets
    .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL_TYPE}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
    .concat(
      `<Relationship Id="rIdS" Type="${REL_TYPE}/sharedStrings" Target="sharedStrings.xml"/>`,
      `<Relationship Id="rIdT" Type="${REL_TYPE}/styles" Target="/xl/styles.xml"/>`,
    )
    .join('');
  const entries: ZipInput[] = [
    { name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>', method: 0 },
    { name: 'xl/workbook.xml', data: `<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">${workbookPr}<sheets>${sheetTags}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`, method: 0 },
    ...spec.sheets.map((s, i): ZipInput => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: s.xml })),
  ];
  if (spec.sharedStrings) {
    const items = spec.sharedStrings.join('');
    entries.push({ name: 'xl/sharedStrings.xml', data: `<sst xmlns="${MAIN_NS}" count="${spec.sharedStrings.length}">${items}</sst>` });
  }
  if (spec.styles) entries.push({ name: 'xl/styles.xml', data: spec.styles });
  return entries.concat(spec.extra ?? []);
}

function buildXlsx(spec: XlsxSpec): Buffer {
  return zip(xlsxEntries(spec));
}

const SHARED_STRINGS = [
  '<si><t>Name</t></si>',
  // Rich text: two runs, plus a phonetic guide Excel does not display.
  '<si><r><rPr><b/></rPr><t>Hel</t></r><r><t xml:space="preserve">lo world</t></r><rPh sb="0" eb="1"><t>ignored</t></rPh></si>',
  '<si><t>R&amp;D &#x263A; &#65;</t></si>',
  '<si><t>Line1_x000D__x000A_Line2</t></si>',
];

// xf 0: General · xf 1: built-in 14 (m/d/yyyy) · xf 2: custom dd/mm/yyyy · xf 3: custom h:mm (time, not a date)
const STYLES = `<styleSheet xmlns="${MAIN_NS}">
  <numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="h:mm"/></numFmts>
  <cellStyleXfs count="1"><xf numFmtId="14"/></cellStyleXfs>
  <cellXfs count="4">
    <xf numFmtId="0" fontId="0"/>
    <xf numFmtId="14" fontId="0" applyNumberFormat="1"/>
    <xf numFmtId="164" fontId="0" applyNumberFormat="1"><alignment horizontal="left"/></xf>
    <xf numFmtId="165" fontId="0" applyNumberFormat="1"/>
  </cellXfs>
</styleSheet>`;

const PEOPLE_SHEET = worksheet(
  '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Inline</t></is></c></row>' +
    '<row r="2"><c r="A2" t="b"><v>1</v></c><c r="B2"><v>42.5</v></c><c r="C2"><f>B2*2</f><v>85</v></c><c r="D2" t="str"><f>UPPER(B1)</f><v>HELLO WORLD</v></c></row>' +
    '<row r="3"><c r="A3" s="1"><v>45536</v></c><c r="B3" t="e"><v>#DIV/0!</v></c><c r="C3" s="2"><v>45537</v></c><c r="D3" s="1" t="s"><v>2</v></c><c r="E3" s="3"><v>0.5</v></c></row>' +
    '<row r="5"><c r="A5" t="s"><v>3</v></c><c r="B5" t="b"><v>0</v></c></row>' +
    // A styled-but-empty cell far below the data: must not create rows.
    '<row r="900"><c r="A900" s="1"/></row>',
);

const SPARSE_SHEET = worksheet(
  '<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c><c r="D1"><v>4</v></c></row>' +
    // No `r` on the row or its cells: positions follow the previous ones.
    '<row><c t="inlineStr"><is><t>x</t></is></c><c><v>2</v></c></row>',
);

function standardWorkbook(extra: ZipInput[] = []): Buffer {
  return buildXlsx({
    sheets: [
      { name: 'People', xml: PEOPLE_SHEET },
      { name: 'Sparse &amp; Co', xml: SPARSE_SHEET, state: 'hidden' },
    ],
    sharedStrings: SHARED_STRINGS,
    styles: STYLES,
    extra,
  });
}

/* ──────────────────────────────── XLSX tests ────────────────────────────── */

describe('readXlsx', () => {
  const book = readXlsx(standardWorkbook());
  const [people, sparse] = book.sheets;

  it('returns both worksheets in workbook order, names entity-decoded', () => {
    expect(book.sheets.map((s) => s.name)).toEqual(['People', 'Sparse & Co']);
    expect(book.sheets.map((s) => s.hidden)).toEqual([false, true]);
    expect(book.date1904).toBe(false);
    expect(book.hasMacros).toBe(false);
  });

  it('decodes shared strings (rich-text runs joined, phonetic guide dropped), inline strings, booleans, numbers and errors', () => {
    expect(people?.rows[0]).toEqual(['Name', 'Hello world', 'Inline', '', '']);
    expect(people?.rows[1]?.slice(0, 2)).toEqual(['TRUE', '42.5']);
    expect(people?.rows[2]?.[1]).toBe(''); // #DIV/0!
    expect(people?.rows[4]?.slice(0, 2)).toEqual(['Line1\r\nLine2', 'FALSE']);
  });

  it('decodes XML entities and numeric references', () => {
    expect(people?.rows[2]?.[3]).toBe('R&D ☺ A');
    expect(decodeEntities('&lt;a&gt; &quot;b&quot; &apos;c&apos; &#169; &#x1F600; &nbsp;')).toBe('<a> "b" \'c\' © \u{1F600} &nbsp;');
  });

  it('uses the cached value of formula cells and counts them, never evaluating', () => {
    expect(people?.rows[1]?.[2]).toBe('85');
    expect(people?.rows[1]?.[3]).toBe('HELLO WORLD');
    expect(people?.formulaCells).toBe(2);
    expect(sparse?.formulaCells).toBe(0);
  });

  it('marks numeric cells with built-in or custom date formats, but not text or time-only cells', () => {
    expect([...(people?.dateCells ?? [])].sort()).toEqual(['2:0', '2:2']);
    expect(people?.rows[2]?.[0]).toBe('45536'); // not auto-converted
    expect(excelSerialToIsoDate(Number(people?.rows[2]?.[0]))).toBe('2024-09-01');
    expect(excelSerialToIsoDate(45536)).toBe('2024-09-01');
  });

  it('places sparse cells and trims trailing empty rows and columns', () => {
    expect(people?.rows).toHaveLength(5);
    expect(people?.rows[3]).toEqual(['', '', '', '', '']);
    expect(sparse?.rows).toEqual([
      ['a', '', '', '4'],
      ['x', '2', '', ''],
    ]);
  });

  it('reports hasMacros for an .xlsm without ever reading vbaProject.bin', () => {
    // Stored as garbage bytes, and in the second package deflated with a
    // lying declared size: if the reader ever inflated it, that would throw.
    const vba = { name: 'xl/vbaProject.bin', data: Buffer.from([0xde, 0xad, 0xbe, 0xef, 1, 2, 3]), method: 8 } as const;
    const macroBook = readXlsx(
      zip([...xlsxEntries({ sheets: [{ name: 'People', xml: PEOPLE_SHEET }], sharedStrings: SHARED_STRINGS, styles: STYLES }), { ...vba, method: 0 }]),
    );
    expect(macroBook.hasMacros).toBe(true);
    expect(macroBook.sheets[0]?.rows[0]?.[0]).toBe('Name');

    const corruptVba = buildXlsx({ sheets: [{ name: 'S', xml: worksheet('<row r="1"><c r="A1"><v>1</v></c></row>') }], extra: [{ ...vba, declaredSize: 999 }] });
    expect(readXlsx(corruptVba).hasMacros).toBe(true);
  });

  it('detects the 1904 date system', () => {
    const mac = readXlsx(buildXlsx({ sheets: [{ name: 'S', xml: worksheet('') }], date1904: true }));
    expect(mac.date1904).toBe(true);
    expect(mac.sheets[0]?.rows).toEqual([]);
  });

  it('accepts namespace-prefixed elements and comments without importing commented-out cells', () => {
    const xml =
      `<x:worksheet xmlns:x="${MAIN_NS}"><x:sheetData><x:row r="1"><x:c r="B1" t="inlineStr"><x:is><x:t>prefixed</x:t></x:is></x:c>` +
      '<!-- <x:c r="Z1"><x:v>hidden</x:v></x:c> --></x:row></x:sheetData></x:worksheet>';
    expect(readXlsx(buildXlsx({ sheets: [{ name: 'S', xml }] })).sheets[0]?.rows).toEqual([['', 'prefixed']]);
  });

  it('returns an empty string for a formula that was never calculated', () => {
    const xml = worksheet('<row r="1"><c r="A1"><f>NOW()</f></c><c r="B1"><v>7</v></c></row>');
    const sheet = readXlsx(buildXlsx({ sheets: [{ name: 'S', xml }] })).sheets[0];
    expect(sheet?.rows).toEqual([['', '7']]);
    expect(sheet?.formulaCells).toBe(1);
  });

  it('refuses to inflate past maxUncompressedBytes (zip bomb)', () => {
    expect(() => readXlsx(standardWorkbook(), { maxUncompressedBytes: 100 })).toThrow(/zip bomb/i);
  });

  it('refuses an entry that inflates past its declared size', () => {
    const lying = zip(xlsxEntries({ sheets: [{ name: 'S', xml: PEOPLE_SHEET }] }).map((e) => (e.name.endsWith('sheet1.xml') ? { ...e, declaredSize: 16 } : e)));
    expect(() => readXlsx(lying)).toThrow(/inflates past its declared size/);
  });

  it('refuses archives with too many entries', () => {
    expect(() => readXlsx(standardWorkbook(), { maxEntries: 3 })).toThrow(/more than the limit of 3/);
  });

  it('refuses a sheet whose dense grid would exceed maxCells', () => {
    const xml = worksheet('<row r="1048576"><c r="XFD1048576"><v>1</v></c></row>');
    expect(() => readXlsx(buildXlsx({ sheets: [{ name: 'Far', xml }] }))).toThrow(/cell limit/);
  });

  it('rejects encrypted entries, ZIP64, non-ZIP and OLE (password-protected / .xls) files', () => {
    const encrypted = zip(xlsxEntries({ sheets: [{ name: 'S', xml: worksheet('') }] }).map((e) => ({ ...e, flags: 1 })));
    expect(() => readXlsx(encrypted)).toThrow(/encrypted/);

    const zip64 = Buffer.from(standardWorkbook());
    zip64.writeUInt32LE(0xffffffff, zip64.length - 22 + 16);
    expect(() => readXlsx(zip64)).toThrow(/ZIP64/);

    expect(() => readXlsx(Buffer.from('name,email\n'))).toThrow(/ZIP header/);
    const ole = Buffer.alloc(512);
    ole.writeUInt32BE(0xd0cf11e0, 0);
    expect(() => readXlsx(ole)).toThrow(/password-protected/);
  });

  it('rejects a dangling shared-string index', () => {
    const xml = worksheet('<row r="1"><c r="A1" t="s"><v>9</v></c></row>');
    expect(() => readXlsx(buildXlsx({ sheets: [{ name: 'S', xml }], sharedStrings: ['<si><t>only</t></si>'] }))).toThrow(/shared string 9/);
  });
});

describe('excelSerialToIsoDate and columnLettersToIndex', () => {
  it('handles the 1900 leap-year bug and the 1904 system', () => {
    expect(excelSerialToIsoDate(1)).toBe('1900-01-01');
    expect(excelSerialToIsoDate(59)).toBe('1900-02-28');
    expect(excelSerialToIsoDate(61)).toBe('1900-03-01');
    expect(excelSerialToIsoDate(45536.75)).toBe('2024-09-01');
    expect(() => excelSerialToIsoDate(60)).toThrow(/does not exist/);
    expect(() => excelSerialToIsoDate(0)).toThrow(RangeError);
    expect(excelSerialToIsoDate(0, true)).toBe('1904-01-01');
    expect(excelSerialToIsoDate(45536 - 1462, true)).toBe('2024-09-01');
  });

  it('maps column letters to 0-based indices', () => {
    expect(['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA', 'XFD'].map(columnLettersToIndex)).toEqual([0, 25, 26, 51, 52, 701, 702, 16383]);
    expect(() => columnLettersToIndex('XFE')).toThrow();
  });
});

/* ──────────────────────────────── CSV tests ─────────────────────────────── */

describe('parseCsv', () => {
  it('parses quoted fields and doubled quotes', () => {
    expect(parseCsv('name,quote\n"Smith, J","He said ""hi"""\n')).toEqual([
      ['name', 'quote'],
      ['Smith, J', 'He said "hi"'],
    ]);
  });

  it('keeps embedded newlines (normalised to LF) and accepts CRLF records', () => {
    expect(parseCsv('a,b\r\n"line1\r\nline2","x\ny"\r\n3,4')).toEqual([
      ['a', 'b'],
      ['line1\nline2', 'x\ny'],
      ['3', '4'],
    ]);
  });

  it('strips a UTF-8 BOM and does not add a row for the trailing newline', () => {
    expect(parseCsv('﻿id,name\n1,Asha\n')).toEqual([
      ['id', 'name'],
      ['1', 'Asha'],
    ]);
  });

  it('detects semicolon and tab delimiters from the first line, ignoring quoted ones', () => {
    expect(detectDelimiter('"a,b";c;d\n1,2;3;4')).toBe(';');
    expect(parseCsv('name;amount\n"Rao, K";1,5\n')).toEqual([
      ['name', 'amount'],
      ['Rao, K', '1,5'],
    ]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(detectDelimiter('single')).toBe(',');
    expect(parseCsv('a;b,c', { delimiter: ',' })).toEqual([['a;b', 'c']]);
  });

  it('keeps empty fields, including a trailing one', () => {
    expect(parseCsv('a,,c,\n,,,')).toEqual([
      ['a', '', 'c', ''],
      ['', '', '', ''],
    ]);
    expect(parseCsv('')).toEqual([]);
  });

  it('throws on an unterminated quote, naming the row', () => {
    expect(() => parseCsv('a,b\n1,2\n3,"oops\n4,5\n')).toThrow(/row 3 \(line 3\).*unterminated/);
  });

  it('throws on text glued to a closing quote', () => {
    expect(() => parseCsv('a,b\n"x"y,2')).toThrow(/row 2.*after a closing quote/);
  });
});

/* ───────────────────────────── readWorkbook tests ───────────────────────── */

describe('readWorkbook', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'import-reader-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a CSV as one sheet named after the file, with a sha256 checksum', async () => {
    const bytes = Buffer.from('﻿name,city\nAsha,Bhopal\n\n\n', 'utf8');
    const path = join(dir, 'members.csv');
    await writeFile(path, bytes);
    const book = await readWorkbook(path);
    expect(book.format).toBe('csv');
    expect(book.hasMacros).toBe(false);
    expect(book.sheets).toHaveLength(1);
    expect(book.sheets[0]?.name).toBe('members');
    expect(book.sheets[0]?.rows).toEqual([
      ['name', 'city'],
      ['Asha', 'Bhopal'],
    ]);
    expect(book.checksum).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('forces tab for .tsv and refuses CSV that is not UTF-8', async () => {
    const tsv = join(dir, 'list.tsv');
    await writeFile(tsv, 'a,b\tc\n');
    expect((await readWorkbook(tsv)).sheets[0]?.rows).toEqual([['a,b', 'c']]);

    const latin1 = join(dir, 'legacy.csv');
    await writeFile(latin1, Buffer.from([0x4e, 0x61, 0x6d, 0xe9, 0x0a]));
    await expect(readWorkbook(latin1)).rejects.toThrow(/not UTF-8/);
  });

  it('reads .xlsm through the XLSX reader and reports macros', async () => {
    const path = join(dir, 'events.xlsm');
    await writeFile(path, standardWorkbook([{ name: 'xl/vbaProject.bin', data: Buffer.from('not really vba'), method: 0 }]));
    const book = await readWorkbook(path);
    expect(book.format).toBe('xlsx');
    expect(book.hasMacros).toBe(true);
    expect(book.sheets.map((s) => s.name)).toEqual(['People', 'Sparse & Co']);
  });

  it('refuses .xls with a save-as hint, and unknown extensions', async () => {
    await expect(readWorkbook(join(dir, 'old.xls'))).rejects.toThrow(/save as \.xlsx or \.csv/);
    await expect(readWorkbook(join(dir, 'sheet.ods'))).rejects.toThrow(/not a supported spreadsheet/);
  });

  it('refuses files over maxFileBytes before reading them', async () => {
    const path = join(dir, 'big.csv');
    await writeFile(path, 'x'.repeat(2048));
    await expect(readWorkbook(path, { maxFileBytes: 1024 })).rejects.toThrow(/import limit/);
  });
});
