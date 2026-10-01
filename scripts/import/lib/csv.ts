/**
 * AN RFC 4180 CSV PARSER, STRICT WHERE GUESSING WOULD CORRUPT DATA.
 *
 * Organisers export CSVs from Excel, Google Sheets, Numbers and whatever
 * their registration tool produces, so the input varies in exactly three
 * ways that matter: a UTF-8 byte-order mark (Excel adds one), the line ending
 * (CRLF from Windows, LF from everything else), and the delimiter (`;` from
 * any locale that writes decimals with a comma, tab from "Unicode Text").
 * All three are absorbed here so the mapping step never sees them.
 *
 * What is NOT absorbed is a malformed quote. An unterminated quote, or text
 * glued onto a closing quote (`"abc"def`), means the file does not say what
 * the organiser thinks it says — and every "lenient" recovery silently moves
 * data into the wrong column or swallows the rest of the file into one cell.
 * For an import that writes to the database, refusing with the row number is
 * the kinder failure: the organiser can open the file and fix that line.
 *
 * A field that begins with `=` is returned as the literal text it is. Nothing
 * in this module (or anywhere in the import) evaluates cell contents.
 */

export interface CsvOptions {
  /** One character. When omitted it is detected from the first line. */
  delimiter?: string;
}

/** Detection candidates, in tie-break order: comma wins a tie. */
const CANDIDATE_DELIMITERS = [',', ';', '\t'] as const;

export function parseCsv(text: string, opts: CsvOptions = {}): string[][] {
  const input = text.startsWith('﻿') ? text.slice(1) : text;
  const delimiter = opts.delimiter ?? detectDelimiter(input);
  assertValidDelimiter(delimiter);
  return tokenize(input, delimiter);
}

/**
 * Picks `,`, `;` or tab by counting each in the first record, outside quotes.
 *
 * Only the first record is used because it is the header row: it is the line
 * most likely to be pure delimiters-and-labels, and the one whose shape the
 * rest of the file has to match anyway.
 */
export function detectDelimiter(text: string): string {
  const counts = new Map<string, number>(CANDIDATE_DELIMITERS.map((d) => [d, 0]));
  let inQuotes = false;
  for (const ch of text) {
    if (ch === '"') {
      // A doubled quote toggles twice, which is the correct net effect.
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (ch === '\n' || ch === '\r') break;
    const seen = counts.get(ch);
    if (seen !== undefined) counts.set(ch, seen + 1);
  }
  let best: string = CANDIDATE_DELIMITERS[0];
  for (const candidate of CANDIDATE_DELIMITERS) {
    if ((counts.get(candidate) ?? 0) > (counts.get(best) ?? 0)) best = candidate;
  }
  return best;
}

function assertValidDelimiter(delimiter: string): void {
  if (delimiter.length !== 1 || delimiter === '"' || delimiter === '\r' || delimiter === '\n') {
    throw new Error(`CSV delimiter must be a single character other than a quote or newline, got ${JSON.stringify(delimiter)}.`);
  }
}

function isLineBreak(ch: string | undefined): boolean {
  return ch === '\n' || ch === '\r';
}

/**
 * The record loop. One field per iteration; after each field we are at a
 * delimiter (next field), a line break (next record) or the end of input.
 *
 * A trailing line break ends the last record rather than starting an empty
 * one, so `a,b\n` is one row, not two.
 */
function tokenize(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  if (text.length === 0) return rows;

  let row: string[] = [];
  let pos = 0;
  let line = 1;

  for (;;) {
    let value: string;
    if (text[pos] === '"') {
      const quoted = readQuotedField(text, pos, rows.length + 1, line);
      value = quoted.value;
      pos = quoted.end;
      line = quoted.line;
      const after = text[pos];
      if (pos < text.length && after !== delimiter && !isLineBreak(after)) {
        throw new Error(
          `CSV row ${rows.length + 1} (line ${line}): unexpected text after a closing quote. ` +
            'A quoted field must be followed by a delimiter or the end of the line; ' +
            'to put a quote inside a field, double it ("").',
        );
      }
    } else {
      let end = pos;
      while (end < text.length && text[end] !== delimiter && !isLineBreak(text[end])) end++;
      // A stray quote inside an unquoted field (5'10") is kept literally:
      // there is no ambiguity about where the field ends.
      value = text.slice(pos, end);
      pos = end;
    }
    row.push(value);

    if (pos >= text.length) {
      rows.push(row);
      return rows;
    }
    if (text[pos] === delimiter) {
      pos++;
      continue;
    }
    // A line break: CRLF, LF, or a lone CR from old Mac exports.
    pos += text[pos] === '\r' && text[pos + 1] === '\n' ? 2 : 1;
    line++;
    rows.push(row);
    row = [];
    if (pos >= text.length) return rows;
  }
}

interface QuotedField {
  value: string;
  /** Index just past the closing quote. */
  end: number;
  /** Physical line number at `end`, for error messages further on. */
  line: number;
}

/**
 * Reads a quoted field starting at the opening quote.
 *
 * Embedded line breaks are kept but normalised to `\n`, so the same cell
 * exported from Windows and from macOS imports as the same string.
 */
function readQuotedField(text: string, start: number, rowNumber: number, startLine: number): QuotedField {
  let value = '';
  let segmentStart = start + 1;
  for (;;) {
    const quote = text.indexOf('"', segmentStart);
    if (quote === -1) {
      throw new Error(
        `CSV row ${rowNumber} (line ${startLine}): unterminated quoted field — ` +
          'the quote that opens it is never closed, so the rest of the file would be read as one cell.',
      );
    }
    value += text.slice(segmentStart, quote);
    if (text[quote + 1] === '"') {
      value += '"';
      segmentStart = quote + 2;
      continue;
    }
    const raw = text.slice(start, quote + 1);
    return {
      value: value.replace(/\r\n?/g, '\n'),
      end: quote + 1,
      line: startLine + countLineBreaks(raw),
    };
  }
}

function countLineBreaks(text: string): number {
  return text.match(/\r\n|\r|\n/g)?.length ?? 0;
}
