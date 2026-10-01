/**
 * ONE ENTRY POINT FOR "THE ORGANISER'S SPREADSHEET", WHATEVER THEY SAVED.
 *
 * The format is chosen by extension, never by sniffing, so what the CLI does
 * with a file is predictable from its name. Every format comes back in the
 * same shape — a list of sheets, each a dense grid of strings — so the
 * mapping step has one input to understand, not two.
 *
 * The checksum is of the exact bytes read. It lets an import run record what
 * it imported, and lets a re-run of the same file be recognised as such.
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { parseCsv } from './csv';
import { DEFAULT_XLSX_LIMITS, readXlsx, type Sheet, type XlsxLimits } from './xlsx';

export type { Sheet } from './xlsx';

export interface WorkbookLimits extends XlsxLimits {
  /** Refuse files larger than this before reading them into memory. */
  maxFileBytes?: number;
}

export interface Workbook {
  format: 'csv' | 'xlsx';
  sheets: Sheet[];
  hasMacros: boolean;
  /** Needed to turn date serials into dates; always false for CSV. */
  date1904: boolean;
  /** sha256 of the file bytes, hex. */
  checksum: string;
}

const DEFAULT_MAX_FILE_BYTES = DEFAULT_XLSX_LIMITS.maxUncompressedBytes;

const CSV_EXTENSIONS: ReadonlySet<string> = new Set(['.csv', '.tsv', '.txt']);
const XLSX_EXTENSIONS: ReadonlySet<string> = new Set(['.xlsx', '.xlsm']);

export async function readWorkbook(path: string, limits: WorkbookLimits = {}): Promise<Workbook> {
  const ext = extname(path).toLowerCase();
  const fileName = basename(path);
  assertSupportedExtension(ext, fileName);

  // Sized before it is read: a mistyped path to a disk image should fail
  // here, not after the process has tried to hold it in memory.
  const maxFileBytes = limits.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const { size } = await stat(path);
  if (size > maxFileBytes) {
    throw new Error(`"${fileName}" is ${size.toLocaleString('en')} bytes, more than the ${maxFileBytes.toLocaleString('en')}-byte import limit.`);
  }

  const bytes = await readFile(path);
  const checksum = createHash('sha256').update(bytes).digest('hex');

  if (CSV_EXTENSIONS.has(ext)) {
    const rows = trimTrailingEmptyRows(parseCsv(decodeCsvBytes(bytes, fileName), ext === '.tsv' ? { delimiter: '\t' } : {}));
    const sheet: Sheet = { name: basename(path, extname(path)), rows, dateCells: new Set(), formulaCells: 0, hidden: false };
    return { format: 'csv', sheets: [sheet], hasMacros: false, date1904: false, checksum };
  }

  const workbook = readXlsx(bytes, limits);
  return { format: 'xlsx', ...workbook, checksum };
}

function assertSupportedExtension(ext: string, fileName: string): void {
  if (CSV_EXTENSIONS.has(ext) || XLSX_EXTENSIONS.has(ext)) return;
  if (ext === '.xls') {
    throw new Error(
      `"${fileName}" is a legacy binary Excel (.xls) file, which the importer does not read. ` +
        'Open it in Excel or Google Sheets and save as .xlsx or .csv.',
    );
  }
  throw new Error(`"${fileName}" is not a supported spreadsheet. Use .xlsx, .xlsm, .csv, .tsv or .txt.`);
}

/**
 * CSV has no declared encoding, so this has to decide — and it refuses to
 * guess. A file that is not valid UTF-8 is almost always Excel's legacy
 * "CSV (Comma delimited)", written in the Windows code page; decoding it as
 * UTF-8 anyway would import every accented name as mojibake. UTF-16 with a
 * byte-order mark is accepted because that is what Excel's "Unicode Text"
 * export writes.
 */
function decodeCsvBytes(bytes: Buffer, fileName: string): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(
      `"${fileName}" is not UTF-8 text. In Excel choose "Save As → CSV UTF-8 (Comma delimited)", ` +
        'or in Google Sheets "Download → Comma-separated values".',
    );
  }
}

/** Matches the XLSX reader, which never returns trailing blank rows. */
function trimTrailingEmptyRows(rows: string[][]): string[][] {
  let end = rows.length;
  while (end > 0 && (rows[end - 1] ?? []).every((cell) => cell === '')) end--;
  return rows.slice(0, end);
}
