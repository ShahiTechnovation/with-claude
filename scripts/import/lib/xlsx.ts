/**
 * A MINIMAL, READ-ONLY XLSX READER THAT ONLY EVER SEES CACHED VALUES.
 *
 * An .xlsx file is a ZIP of XML parts. Everything needed to import a grid of
 * values is in four of them — the workbook (sheet names), its relationships
 * (where each sheet lives), the shared-string table, and the sheets — plus
 * the style table, read only to say which numbers are formatted as dates.
 * This module reads exactly those parts and nothing else.
 *
 * Three decisions carry the safety of the import, and each is deliberate:
 *
 *   1. Formulas are never evaluated. Excel stores the last computed result of
 *      every formula cell in `<v>` next to the formula in `<f>`. We return
 *      that cached value and count the formula. Evaluating it would mean
 *      implementing a spreadsheet engine — and `WEBSERVICE()`, `HYPERLINK()`,
 *      DDE and external references mean a "formula engine" is also a network
 *      client. The cached value is what the organiser saw on screen, which is
 *      the value they meant to import.
 *
 *   2. Macros are never read. `xl/vbaProject.bin` (and Excel 4.0 macro
 *      sheets) are detected by name and reported as `hasMacros`, but their
 *      bytes are never inflated, let alone interpreted. An .xlsm imports
 *      exactly like an .xlsx.
 *
 *   3. Every size is bounded before memory is spent on it. A ZIP's sizes are
 *      claims made by whoever wrote the file: a 40 KB "zip bomb" can declare,
 *      or simply inflate to, gigabytes. So the entry count is capped before
 *      the directory is walked, each part's declared size is checked against
 *      the remaining budget before it is inflated, the inflater is hard-capped
 *      at that declared size (so a lie fails instead of allocating), and a
 *      sheet's dense grid is capped before it is allocated — one cell at
 *      XFD1048576 would otherwise ask for 17 billion strings.
 *
 * The XML is read with regular expressions over a deliberately small
 * vocabulary, not a general parser. That also means no DTD is ever processed:
 * only the five predefined entities and numeric references are decoded, so
 * external-entity (XXE) and "billion laughs" attacks have nothing to expand.
 */
import { inflateRawSync } from 'node:zlib';

/* ────────────────────────────── public types ────────────────────────────── */

export interface XlsxLimits {
  /** Total bytes inflated across every part actually read. */
  maxUncompressedBytes?: number;
  /** ZIP central-directory entries. A real workbook has dozens. */
  maxEntries?: number;
  /** Cells in one sheet's dense grid (rows × columns). */
  maxCells?: number;
}

export const DEFAULT_XLSX_LIMITS: Readonly<Required<XlsxLimits>> = Object.freeze({
  maxUncompressedBytes: 50 * 1024 * 1024,
  maxEntries: 2000,
  maxCells: 2_000_000,
});

export interface Sheet {
  name: string;
  /** Dense grid of display strings, trailing empty rows and columns trimmed. */
  rows: string[][];
  /** `"row:col"` (0-based, into `rows`) of numeric cells styled as dates. */
  dateCells: Set<string>;
  /** How many cells carried a formula (their cached value was used). */
  formulaCells: number;
  /** Hidden or very-hidden in Excel: the organiser may not know it is there. */
  hidden: boolean;
}

export interface XlsxWorkbook {
  sheets: Sheet[];
  /** Serial dates count from 1904-01-01 (old Mac Excel) instead of 1900. */
  date1904: boolean;
  /** A VBA project or Excel 4.0 macro sheet is present. Never read. */
  hasMacros: boolean;
}

export function readXlsx(buffer: Buffer, limits: XlsxLimits = {}): XlsxWorkbook {
  const resolved = resolveLimits(limits);
  assertLooksLikeZip(buffer);
  const pkg = openPackage(buffer, resolved);

  const workbookXml = pkg.readXml('xl/workbook.xml');
  if (workbookXml === undefined) {
    throw new Error('Not an Excel workbook: the package has no xl/workbook.xml.');
  }
  const workbook = parseWorkbookXml(workbookXml);

  const relsXml = pkg.readXml('xl/_rels/workbook.xml.rels');
  if (relsXml === undefined) throw corrupt('xl/_rels/workbook.xml.rels is missing');
  const rels = parseRelationships(relsXml, 'xl');

  const sharedStrings = parseSharedStrings(pkg.readXml(partOfType(rels, 'sharedStrings', 'xl/sharedStrings.xml')));
  const dateStyles = parseDateStyles(pkg.readXml(partOfType(rels, 'styles', 'xl/styles.xml')));

  const sheets: Sheet[] = [];
  for (const ref of workbook.sheets) {
    const rel = rels.get(ref.relId);
    if (rel === undefined) throw corrupt(`sheet "${ref.name}" points at relationship ${ref.relId}, which does not exist`);
    // Chart sheets, dialog sheets and macro sheets have no cell grid to import.
    if (!rel.type.endsWith('/worksheet')) continue;
    const xml = pkg.readXml(rel.target);
    if (xml === undefined) throw corrupt(`sheet "${ref.name}" (${rel.target}) is missing from the package`);
    const grid = parseWorksheet(xml, { sharedStrings, dateStyles, maxCells: resolved.maxCells, sheetName: ref.name });
    sheets.push({ name: ref.name, hidden: ref.hidden, ...grid });
  }

  const hasMacroSheets = [...rels.values()].some((r) => /\/xl(?:Intl)?Macrosheet$/i.test(r.type));
  return { sheets, date1904: workbook.date1904, hasMacros: pkg.has('xl/vbaProject.bin') || hasMacroSheets };
}

/* ──────────────────────────────── dates ─────────────────────────────────── */

const MS_PER_DAY = 86_400_000;
/** Day 0 of the 1900 system once the phantom leap day is accounted for. */
const EPOCH_1900 = Date.UTC(1899, 11, 30);
const EPOCH_1904 = Date.UTC(1904, 0, 1);
/** 9999-12-31, the last date Excel can represent, in the 1900 system. */
const MAX_SERIAL_1900 = 2_958_465;
const SERIAL_1904_OFFSET = 1462;

/**
 * Excel serial day number → `YYYY-MM-DD`. Any time-of-day fraction is dropped.
 *
 * The 1900 system inherits Lotus 1-2-3's bug of treating 1900 as a leap year:
 * serial 60 is "1900-02-29", a day that never happened, and every serial
 * before it is one day off from naive arithmetic. Serial 60 is refused rather
 * than mapped to a neighbour, because either neighbour would be a guess.
 */
export function excelSerialToIsoDate(n: number, date1904 = false): string {
  if (!Number.isFinite(n)) throw new RangeError(`${n} is not an Excel date serial.`);
  const day = Math.floor(n);
  if (date1904) {
    if (day < 0 || day > MAX_SERIAL_1900 - SERIAL_1904_OFFSET) throw outOfRange(n);
    return isoDate(EPOCH_1904 + day * MS_PER_DAY);
  }
  if (day < 1 || day > MAX_SERIAL_1900) throw outOfRange(n);
  if (day === 60) {
    throw new RangeError('Excel serial 60 is 1900-02-29, a date that does not exist (the Lotus 1-2-3 leap-year bug).');
  }
  return isoDate(EPOCH_1900 + (day < 60 ? day + 1 : day) * MS_PER_DAY);
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function outOfRange(n: number): RangeError {
  return new RangeError(`Excel date serial ${n} is outside the range Excel can represent.`);
}

/* ───────────────────────────────── ZIP ──────────────────────────────────── */

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_OLE = 0xd0cf11e0;

const EOCD_SIZE = 22;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;
const ZIP64_LOCATOR_SIZE = 20;
const MAX_ZIP_COMMENT = 0xffff;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8_NAME = 0x0800;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

function resolveLimits(limits: XlsxLimits): Required<XlsxLimits> {
  return {
    maxUncompressedBytes: limits.maxUncompressedBytes ?? DEFAULT_XLSX_LIMITS.maxUncompressedBytes,
    maxEntries: limits.maxEntries ?? DEFAULT_XLSX_LIMITS.maxEntries,
    maxCells: limits.maxCells ?? DEFAULT_XLSX_LIMITS.maxCells,
  };
}

function corrupt(detail: string): Error {
  return new Error(`This XLSX file is damaged or not a real workbook: ${detail}.`);
}

/**
 * The two wrong files people most often hand us, named precisely. A
 * password-protected .xlsx is not a ZIP at all — Excel wraps it in an OLE
 * compound document — and so is a legacy .xls renamed to .xlsx.
 */
function assertLooksLikeZip(buffer: Buffer): void {
  if (buffer.length >= 4 && buffer.readUInt32BE(0) === SIG_OLE) {
    throw new Error(
      'This file is an OLE compound document, not an XLSX package: either a password-protected workbook ' +
        'or a legacy .xls with the wrong extension. Remove the password, or save it as .xlsx or .csv.',
    );
  }
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== SIG_LOCAL) {
    throw new Error('Not an XLSX file: it does not start with a ZIP header.');
  }
}

function findEndOfCentralDirectory(buf: Buffer): number {
  const stop = Math.max(0, buf.length - EOCD_SIZE - MAX_ZIP_COMMENT);
  for (let i = buf.length - EOCD_SIZE; i >= stop; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD && i + EOCD_SIZE + buf.readUInt16LE(i + 20) <= buf.length) return i;
  }
  throw corrupt('the ZIP end-of-central-directory record is missing (is the file truncated?)');
}

function zip64Error(): Error {
  return new Error('This XLSX uses ZIP64 (an archive over 4 GB or 65,535 entries), which is far beyond any import and is not supported.');
}

/**
 * Walks the central directory — the authoritative index at the end of the
 * archive — rather than scanning local headers from the front. Scanning is
 * how two readers come to disagree about what a file contains; the central
 * directory is what Excel itself trusts.
 */
function readCentralDirectory(buf: Buffer, maxEntries: number): Map<string, ZipEntry> {
  const eocd = findEndOfCentralDirectory(buf);
  const diskNumber = buf.readUInt16LE(eocd + 4);
  const directoryDisk = buf.readUInt16LE(eocd + 6);
  const entriesOnDisk = buf.readUInt16LE(eocd + 8);
  const totalEntries = buf.readUInt16LE(eocd + 10);
  const directorySize = buf.readUInt32LE(eocd + 12);
  const directoryOffset = buf.readUInt32LE(eocd + 16);

  const hasZip64Locator = eocd >= ZIP64_LOCATOR_SIZE && buf.readUInt32LE(eocd - ZIP64_LOCATOR_SIZE) === SIG_ZIP64_LOCATOR;
  if (totalEntries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff || hasZip64Locator) {
    throw zip64Error();
  }
  if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw new Error('This XLSX is a split (multi-volume) ZIP archive, which is not supported.');
  }
  // Checked before the walk: the count is the cheapest thing to lie about.
  if (totalEntries > maxEntries) {
    throw new Error(`This XLSX contains ${totalEntries} ZIP entries, more than the limit of ${maxEntries}. Refusing to read it.`);
  }
  const directoryEnd = directoryOffset + directorySize;
  if (directoryEnd > eocd) throw corrupt('the ZIP central directory overruns the end of the archive');

  const entries = new Map<string, ZipEntry>();
  let pos = directoryOffset;
  for (let i = 0; i < totalEntries; i++) {
    const { entry, next } = readCentralEntry(buf, pos, directoryEnd, i + 1);
    // OPC part names are case-insensitive. Two entries that differ only by
    // case are the setup for "Excel shows one, the importer reads the other".
    const key = entry.name.toLowerCase();
    if (entries.has(key)) throw corrupt(`the archive contains "${entry.name}" twice`);
    entries.set(key, entry);
    pos = next;
  }
  return entries;
}

function readCentralEntry(buf: Buffer, pos: number, directoryEnd: number, ordinal: number): { entry: ZipEntry; next: number } {
  if (pos + CENTRAL_HEADER_SIZE > directoryEnd || buf.readUInt32LE(pos) !== SIG_CENTRAL) {
    throw corrupt(`ZIP central directory entry ${ordinal} is malformed`);
  }
  const flags = buf.readUInt16LE(pos + 8);
  const nameLength = buf.readUInt16LE(pos + 28);
  const nameEnd = pos + CENTRAL_HEADER_SIZE + nameLength;
  if (nameEnd > directoryEnd) throw corrupt(`ZIP central directory entry ${ordinal} is truncated`);
  const name = buf.toString(flags & FLAG_UTF8_NAME ? 'utf8' : 'latin1', pos + CENTRAL_HEADER_SIZE, nameEnd);

  if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) {
    throw new Error(`This XLSX contains an encrypted ZIP entry ("${name}"). Remove the protection and save it again.`);
  }
  const compressedSize = buf.readUInt32LE(pos + 20);
  const uncompressedSize = buf.readUInt32LE(pos + 24);
  const localHeaderOffset = buf.readUInt32LE(pos + 42);
  if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
    throw zip64Error();
  }
  const next = nameEnd + buf.readUInt16LE(pos + 30) + buf.readUInt16LE(pos + 32);
  const entry = { name, method: buf.readUInt16LE(pos + 10), compressedSize, uncompressedSize, localHeaderOffset };
  return { entry, next };
}

/**
 * Inflates one entry, spending from the shared budget.
 *
 * The declared size is checked against the budget first (an honest bomb is
 * refused without inflating a byte), and then used as the inflater's hard
 * output cap (a dishonest one fails at the cap instead of filling memory).
 */
function inflateEntry(buf: Buffer, entry: ZipEntry, budget: number, limit: number): Buffer {
  if (entry.uncompressedSize > budget) {
    throw new Error(
      `Refusing to read "${entry.name}": the workbook would inflate past the ${limit.toLocaleString('en')}-byte limit. ` +
        'This guards against "zip bomb" files; raise maxUncompressedBytes if the spreadsheet really is that large.',
    );
  }
  const local = entry.localHeaderOffset;
  if (local + LOCAL_HEADER_SIZE > buf.length || buf.readUInt32LE(local) !== SIG_LOCAL) {
    throw corrupt(`the local header for "${entry.name}" is missing`);
  }
  // Sizes come from the central directory: a local header written with a
  // trailing data descriptor legitimately records zeros here.
  const dataStart = local + LOCAL_HEADER_SIZE + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buf.length) throw corrupt(`"${entry.name}" is truncated`);
  const data = buf.subarray(dataStart, dataEnd);

  let out: Buffer;
  if (entry.method === METHOD_STORED) {
    out = data;
  } else if (entry.method === METHOD_DEFLATE) {
    try {
      out = inflateRawSync(data, { maxOutputLength: Math.max(1, entry.uncompressedSize) });
    } catch (err) {
      const reason = err instanceof RangeError ? 'it inflates past its declared size' : 'its compressed data is invalid';
      throw corrupt(`"${entry.name}" could not be decompressed (${reason})`);
    }
  } else {
    throw new Error(`"${entry.name}" uses ZIP compression method ${entry.method}; only stored and deflate are supported.`);
  }
  if (out.length !== entry.uncompressedSize) throw corrupt(`"${entry.name}" does not match its declared size`);
  return out;
}

interface Package {
  has(name: string): boolean;
  /** The decoded XML of a part, or undefined when the part does not exist. */
  readXml(name: string): string | undefined;
}

function openPackage(buf: Buffer, limits: Required<XlsxLimits>): Package {
  const entries = readCentralDirectory(buf, limits.maxEntries);
  let remaining = limits.maxUncompressedBytes;
  return {
    has: (name) => entries.has(name.toLowerCase()),
    readXml(name) {
      const entry = entries.get(name.toLowerCase());
      if (entry === undefined) return undefined;
      const bytes = inflateEntry(buf, entry, remaining, limits.maxUncompressedBytes);
      remaining -= bytes.length;
      return stripComments(decodeXmlBytes(bytes));
    },
  };
}

/** Excel writes UTF-8; the spec also allows UTF-16 with a byte-order mark. */
function decodeXmlBytes(bytes: Buffer): string {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  return new TextDecoder(encoding).decode(bytes);
}

/* ──────────────────────────────── XML ───────────────────────────────────── */

/** An optional namespace prefix: some generators write `<x:c>` for `<c>`. */
const NS = '(?:[A-Za-z_][\\w.-]*:)?';
/**
 * Attributes, allowing `>` and `/` inside quoted values. The alternatives
 * cannot overlap, so the match is linear rather than backtracking.
 */
const ATTRS = `((?:[^>"'/]|/(?!>)|"[^"]*"|'[^']*')*)`;

interface XmlElement {
  attrs: Record<string, string>;
  inner: string;
}

const elementPatterns = new Map<string, RegExp>();

/**
 * `<tag …/>` or `<tag …>inner</tag>`, where the inner text may not contain
 * another `<tag` or `</tag`. That restriction is what keeps a file full of
 * unclosed elements from turning every match attempt into a scan to the end
 * of the document. None of the elements read here nest inside themselves.
 */
function elementPattern(tag: string): RegExp {
  let pattern = elementPatterns.get(tag);
  if (pattern === undefined) {
    const inner = `((?:[^<]|<(?!/?${NS}${tag}[\\s/>]))*)`;
    pattern = new RegExp(`<${NS}${tag}(?=[\\s/>])${ATTRS}(?:/>|>${inner}</${NS}${tag}\\s*>)`, 'g');
    elementPatterns.set(tag, pattern);
  }
  return pattern;
}

function* elements(xml: string, tag: string): Generator<XmlElement> {
  for (const match of xml.matchAll(elementPattern(tag))) {
    yield { attrs: parseAttributes(match[1] ?? ''), inner: match[2] ?? '' };
  }
}

function firstElement(xml: string, tag: string): XmlElement | undefined {
  for (const element of elements(xml, tag)) return element;
  return undefined;
}

function removeElements(xml: string, tag: string): string {
  return xml.replace(elementPattern(tag), '');
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of source.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const name = match[1];
    if (name !== undefined) attrs[name] = decodeEntities(match[2] ?? match[3] ?? '');
  }
  return attrs;
}

/**
 * Comments are removed before anything is matched, so a `<c>` hidden inside
 * `<!-- -->` cannot be imported when Excel would never show it.
 */
function stripComments(xml: string): string {
  if (!xml.includes('<!--')) return xml;
  let out = '';
  let pos = 0;
  for (;;) {
    const start = xml.indexOf('<!--', pos);
    if (start === -1) return out + xml.slice(pos);
    const end = xml.indexOf('-->', start + 4);
    if (end === -1) return out + xml.slice(pos, start);
    out += xml.slice(pos, start);
    pos = end + 3;
  }
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * The five predefined entities and numeric character references. Anything
 * else (`&nbsp;`, or an entity a DOCTYPE tries to define) is left as written:
 * no DTD is ever consulted.
 */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#[xX][0-9A-Fa-f]+|#[0-9]+|[A-Za-z]+);/g, (whole: string, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      const valid = code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
      return valid ? String.fromCodePoint(code) : '�';
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/**
 * OOXML's own escape for characters XML cannot carry: Excel writes a
 * carriage return inside a cell as `_x000D_`. `_x005F_` escapes the
 * underscore itself, which a single left-to-right pass handles correctly.
 */
function decodeOoxmlEscapes(text: string): string {
  if (!text.includes('_x')) return text;
  return text.replace(/_x([0-9A-Fa-f]{4})_/g, (_whole: string, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeText(raw: string): string {
  return decodeOoxmlEscapes(decodeEntities(raw));
}

/**
 * The visible text of an `<si>` or `<is>`: plain `<t>`, or rich-text runs
 * `<r><t>…</t></r>` concatenated. `<rPh>` holds phonetic guides (Japanese
 * furigana) that Excel does not display in the cell, so it is dropped.
 */
function richText(xml: string): string {
  let raw = '';
  for (const t of elements(removeElements(xml, 'rPh'), 't')) raw += t.inner;
  return decodeText(raw);
}

/* ───────────────────────────── workbook parts ───────────────────────────── */

interface SheetRef {
  name: string;
  relId: string;
  hidden: boolean;
}

function parseWorkbookXml(xml: string): { sheets: SheetRef[]; date1904: boolean } {
  const sheets: SheetRef[] = [];
  for (const sheet of elements(firstElement(xml, 'sheets')?.inner ?? '', 'sheet')) {
    // The relationship id is `r:id`, but the prefix is the writer's choice.
    const relId = Object.entries(sheet.attrs).find(([key]) => key.endsWith(':id'))?.[1];
    const name = sheet.attrs['name'];
    if (name === undefined || relId === undefined) throw corrupt('a <sheet> in xl/workbook.xml has no name or relationship id');
    const state = sheet.attrs['state'];
    sheets.push({ name, relId, hidden: state === 'hidden' || state === 'veryHidden' });
  }
  const flag = firstElement(xml, 'workbookPr')?.attrs['date1904'];
  return { sheets, date1904: flag === '1' || flag === 'true' };
}

interface Relationship {
  target: string;
  type: string;
}

function parseRelationships(xml: string, baseDir: string): Map<string, Relationship> {
  const rels = new Map<string, Relationship>();
  for (const rel of elements(xml, 'Relationship')) {
    const { Id: id, Target: target, Type: type, TargetMode: mode } = rel.attrs;
    // External targets (linked workbooks, URLs) are never followed.
    if (id === undefined || target === undefined || type === undefined || mode === 'External') continue;
    rels.set(id, { target: resolvePartName(baseDir, target), type });
  }
  return rels;
}

/**
 * A relationship target is relative to the source part's folder unless it
 * starts with `/`. This only names a part inside the in-memory archive —
 * nothing is ever written to or read from disk by this path.
 */
function resolvePartName(baseDir: string, target: string): string {
  const raw = target.startsWith('/') ? target.slice(1) : `${baseDir}/${target}`;
  const parts: string[] = [];
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

function partOfType(rels: Map<string, Relationship>, typeSuffix: string, fallback: string): string {
  for (const rel of rels.values()) if (rel.type.endsWith(`/${typeSuffix}`)) return rel.target;
  return fallback;
}

function parseSharedStrings(xml: string | undefined): string[] {
  if (xml === undefined) return [];
  return Array.from(elements(xml, 'si'), (si) => richText(si.inner));
}

/** Built-in number formats that render a serial as a date or time. */
const BUILTIN_DATE_FORMATS: ReadonlySet<number> = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Indices into `cellXfs` (a cell's `s` attribute) whose format is a date. */
function parseDateStyles(xml: string | undefined): Set<number> {
  const dateStyles = new Set<number>();
  if (xml === undefined) return dateStyles;
  const customFormats = new Map<number, string>();
  for (const fmt of elements(firstElement(xml, 'numFmts')?.inner ?? '', 'numFmt')) {
    customFormats.set(Number(fmt.attrs['numFmtId']), fmt.attrs['formatCode'] ?? '');
  }
  let index = 0;
  for (const xf of elements(firstElement(xml, 'cellXfs')?.inner ?? '', 'xf')) {
    const id = Number(xf.attrs['numFmtId'] ?? '0');
    const code = customFormats.get(id);
    if (BUILTIN_DATE_FORMATS.has(id) || (code !== undefined && isDateFormatCode(code))) dateStyles.add(index);
    index++;
  }
  return dateStyles;
}

/**
 * Whether a custom format code displays a date. Literal text ("…", \x),
 * bracketed sections ([Red], [$-409], [h]) and padding (_x, *x) are removed
 * first, then the first section is checked for d/m/y. A bare `m` with h or s
 * beside it is minutes (h:mm), not months.
 */
function isDateFormatCode(code: string): boolean {
  const firstSection = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[_*]./g, '')
    .split(';')[0] ?? '';
  if (/[dy]/i.test(firstSection)) return true;
  return /m/i.test(firstSection) && !/[hs]/i.test(firstSection);
}

/* ─────────────────────────────── worksheets ─────────────────────────────── */

/** Excel's own grid bounds; a reference outside them is a corrupt file. */
const MAX_ROWS = 1_048_576;
const MAX_COLUMNS = 16_384;

const FORMULA = new RegExp(`<${NS}f(?=[\\s/>])`);
const CELL_REF = /^([A-Za-z]{1,3})([0-9]{1,7})$/;

/** `A` → 0, `Z` → 25, `AA` → 26, `XFD` → 16383. */
export function columnLettersToIndex(letters: string): number {
  if (!/^[A-Za-z]{1,3}$/.test(letters)) throw new Error(`"${letters}" is not a column reference.`);
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  if (n > MAX_COLUMNS) throw new Error(`Column ${letters} is beyond Excel's last column (XFD).`);
  return n - 1;
}

function parseCellRef(ref: string, sheetName: string): { row: number; col: number } {
  const match = CELL_REF.exec(ref);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw corrupt(`sheet "${sheetName}" has a cell with the reference "${ref}"`);
  }
  return { row: parseRowNumber(match[2], sheetName), col: columnLettersToIndex(match[1]) };
}

/** 1-based row number as written in the file → 0-based index. */
function parseRowNumber(text: string, sheetName: string): number {
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1 || n > MAX_ROWS) throw corrupt(`sheet "${sheetName}" has a row numbered "${text}"`);
  return n - 1;
}

interface SheetContext {
  sharedStrings: readonly string[];
  dateStyles: ReadonlySet<number>;
  maxCells: number;
  sheetName: string;
}

interface PlacedCell {
  row: number;
  col: number;
  value: string;
  isDate: boolean;
}

type SheetGrid = Pick<Sheet, 'rows' | 'dateCells' | 'formulaCells'>;

/**
 * Rows and cells may be sparse and may omit their `r` reference; a missing
 * one means "the next one after the previous". Empty cells are dropped while
 * reading, so styled-but-empty cells far down the sheet (common in real
 * files) neither trigger the cell limit nor survive as trailing blank rows.
 */
function parseWorksheet(xml: string, ctx: SheetContext): SheetGrid {
  const sheetData = firstElement(xml, 'sheetData')?.inner ?? '';
  const cells: PlacedCell[] = [];
  let formulaCells = 0;
  let rowIndex = -1;

  for (const row of elements(sheetData, 'row')) {
    const rowRef = row.attrs['r'];
    rowIndex = rowRef !== undefined ? parseRowNumber(rowRef, ctx.sheetName) : rowIndex + 1;
    let colIndex = -1;
    for (const cell of elements(row.inner, 'c')) {
      const ref = cell.attrs['r'];
      const pos = ref !== undefined ? parseCellRef(ref, ctx.sheetName) : { row: rowIndex, col: colIndex + 1 };
      colIndex = pos.col;
      if (FORMULA.test(cell.inner)) formulaCells++;
      const value = cellValue(cell, ctx, ref ?? `row ${pos.row + 1}`);
      if (value === '') continue;
      cells.push({ ...pos, value, isDate: isDateCell(cell.attrs, ctx.dateStyles) });
    }
  }
  return toGrid(cells, formulaCells, ctx);
}

/**
 * The display string of one cell, from its cached `<v>` only.
 *
 * When `<f>` is present this is the result Excel computed the last time the
 * file was saved — exactly what the organiser saw. The formula text itself
 * is never looked at. A formula that was never calculated has no `<v>` and
 * yields an empty string, which is honest: we do not know its value.
 */
function cellValue(cell: XmlElement, ctx: SheetContext, ref: string): string {
  const raw = firstElement(cell.inner, 'v')?.inner;
  switch (cell.attrs['t']) {
    case 's':
      return sharedString(raw, ctx, ref);
    case 'inlineStr':
      return richText(firstElement(cell.inner, 'is')?.inner ?? '');
    case 'b':
      return raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : '';
    case 'e':
      // #DIV/0!, #N/A, #REF!: an error is not data.
      return '';
    case 'str':
    case 'd':
      return raw === undefined ? '' : decodeText(raw);
    default:
      return raw === undefined ? '' : normalizeNumber(decodeEntities(raw));
  }
}

function sharedString(raw: string | undefined, ctx: SheetContext, ref: string): string {
  if (raw === undefined) return '';
  const index = Number(raw);
  const value = Number.isInteger(index) && index >= 0 ? ctx.sharedStrings[index] : undefined;
  if (value === undefined) throw corrupt(`cell ${ref} in sheet "${ctx.sheetName}" refers to shared string ${raw}, which does not exist`);
  return value;
}

/**
 * Excel stores doubles with up to 17 significant digits (`0.30000000000000004`
 * for what it displays as 0.3). JavaScript's shortest round-trip form is the
 * closest honest equivalent to what the organiser saw.
 */
function normalizeNumber(raw: string): string {
  const text = raw.trim();
  if (text === '') return '';
  const n = Number(text);
  return Number.isFinite(n) ? String(n) : text;
}

/** Only numeric cells can be serial dates; a styled text cell is still text. */
function isDateCell(attrs: Record<string, string>, dateStyles: ReadonlySet<number>): boolean {
  const type = attrs['t'];
  return (type === undefined || type === 'n') && dateStyles.has(Number(attrs['s'] ?? '0'));
}

function toGrid(cells: readonly PlacedCell[], formulaCells: number, ctx: SheetContext): SheetGrid {
  let height = 0;
  let width = 0;
  for (const cell of cells) {
    height = Math.max(height, cell.row + 1);
    width = Math.max(width, cell.col + 1);
  }
  // Checked before allocating: the grid is rows × columns, not the number of
  // cells in the file, and a single far-away cell makes it enormous.
  if (height * width > ctx.maxCells) {
    throw new Error(
      `Sheet "${ctx.sheetName}" spans ${height.toLocaleString('en')} rows × ${width.toLocaleString('en')} columns, ` +
        `more than the ${ctx.maxCells.toLocaleString('en')}-cell limit. Delete stray cells far from the data and save again.`,
    );
  }
  const rows = Array.from({ length: height }, () => new Array<string>(width).fill(''));
  const dateCells = new Set<string>();
  for (const cell of cells) {
    const row = rows[cell.row];
    if (row !== undefined) row[cell.col] = cell.value;
    // A duplicated reference: the last occurrence wins, for value and date alike.
    const key = `${cell.row}:${cell.col}`;
    if (cell.isDate) dateCells.add(key);
    else dateCells.delete(key);
  }
  return { rows, dateCells, formulaCells };
}
