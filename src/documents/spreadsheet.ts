import type { Section } from "./extract.js";
import { builtInFormat, formatDate, formatValue, fromIso, isDateFormat } from "./numberFormat.js";
import { attribute, attributes, mainPart, odfParagraphs, ofType, relationships, xmlText } from "./officeXml.js";
import type { ZipParts } from "./zipParts.js";

// Spreadsheets — Excel (.xlsx, .xlsm), OpenDocument (.ods), CSV and TSV —
// as passages a model can read and an answer can cite: each sheet on its
// own, cut into blocks of rows that each start with the sheet's name, the
// rows they hold and the header row, so that a block found alone still
// says what its columns are:
//
//   [Sheet "Ventes", rows 3–14 of 40]
//   | Row | Date | Client | Montant |
//   | --- | --- | --- | --- |
//   | 3 | 2026-01-05 | Claire Martin | 1250.00 € |
//
// Cells are what they show: the computed result of a formula, a date as a
// date, a number as its format writes it (numberFormat.ts). A sheet is
// read up to MAX_SHEET_ROWS rows, a workbook up to MAX_TABLE_CHARS
// characters; what is left out is said in the blocks themselves, so that
// no answer takes a part for the whole.

export interface Cell {
  text: string;
  kind: "text" | "number" | "date" | "bool" | "error" | "formula";
}

export interface SheetRow {
  /// 1-based, as the spreadsheet numbers it.
  number: number;
  cells: Map<number, Cell>;
}

export interface Sheet {
  /// Null for a CSV file: one table, named by the file.
  name: string | null;
  hidden?: boolean;
  rows: SheetRow[];
  /// The last row the file says the sheet uses, when it says it.
  lastRow: number | null;
  /// Rows were left out: past MAX_SHEET_ROWS, or past the size of XML read.
  cut: boolean;
  /// Merged cells, 1-based rows and 0-based columns.
  merges: Array<{ top: number; left: number; bottom: number; right: number }>;
}

/// Rows read in a sheet (rows with something in them).
export const MAX_SHEET_ROWS = 10_000;
/// What all the sheets of a file may take in the index together: under
/// the 2,000,000 characters a document may take (extract.ts).
export const MAX_TABLE_CHARS = 1_800_000;
const MAX_SHEETS = 200;
const MAX_COLUMNS = 64;
const MAX_CELL_CHARS = 300;
const MAX_HEADER_CHARS = 60;
/// A block holds about as much as another document's passage (chunk.ts).
const BLOCK_CHARS = 1_200;
const MAX_BLOCK_CHARS = 4_000;
const MAX_SHEET_XML_BYTES = 160 * 1024 * 1024;
const MAX_SHARED_STRINGS_BYTES = 96 * 1024 * 1024;
const MAX_PART_BYTES = 8 * 1024 * 1024;
/// An .ods is read whole (its tables are in one part), so less of it.
const MAX_ODS_XML_BYTES = 64 * 1024 * 1024;

// ─── Excel ──────────────────────────────────────────────────────────────────

export async function readXlsx(zip: ZipParts): Promise<Sheet[]> {
  const workbookPart = await mainPart(zip, "xl/workbook.xml");
  const workbook = (await zip.text(workbookPart, MAX_PART_BYTES))?.text ?? "";
  const relations = await relationships(zip, workbookPart);
  const date1904 = /<(?:\w+:)?workbookPr\b[^>]*\bdate1904="(?:1|true)"/.test(workbook);
  // A file written by a program that leaves the computing to Excel (a
  // script's export): its formulas' stored results may be mere zeros.
  const recalc = /<(?:\w+:)?calcPr\b[^>]*\bfullCalcOnLoad="(?:1|true)"/.test(workbook);
  const sharedPart = ofType(relations.values(), "sharedStrings")[0]?.target;
  const stylesPart = ofType(relations.values(), "styles")[0]?.target;
  const strings = sharedPart ? await sharedStrings(zip, sharedPart) : [];
  const formats = stylesPart ? await cellFormats(zip, stylesPart) : [];

  const sheets: Sheet[] = [];
  for (const match of workbook.matchAll(/<(?:\w+:)?sheet(?=[\s/>])([^>]*?)\/?>/g)) {
    if (sheets.length >= MAX_SHEETS) break;
    const attrs = attributes(match[1]!);
    const relation = relations.get(attribute(attrs, "id", true) ?? "");
    // Chart sheets and dialog sheets hold no cells.
    if (!relation || !relation.type.endsWith("/worksheet") || !zip.has(relation.target)) continue;
    const sheet = await readWorksheet(zip, relation.target, { strings, formats, date1904, recalc });
    sheets.push({ ...sheet, name: attrs.name ?? `Sheet${sheets.length + 1}`, hidden: /^(hidden|veryHidden)$/.test(attrs.state ?? "") });
  }
  return sheets;
}

/// The strings the cells point at (<si>), in order; rich text flattened,
/// phonetic guides left out.
async function sharedStrings(zip: ZipParts, part: string): Promise<string[]> {
  const strings: string[] = [];
  let buffer = "";
  const element = /<(?:\w+:)?si(?=[\s/>])[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g;
  await zip.stream(part, MAX_SHARED_STRINGS_BYTES, (chunk) => {
    buffer += chunk;
    element.lastIndex = 0;
    let consumed = 0;
    let match: RegExpExecArray | null;
    while ((match = element.exec(buffer))) {
      strings.push(richText(match[1] ?? ""));
      consumed = element.lastIndex;
    }
    buffer = tailFrom(buffer, consumed, /<(?:\w+:)?si(?=[\s/>])/);
  });
  return strings;
}

/// What is left of a buffer once its complete elements were read: from
/// the next element that has begun, or its last characters (a tag cut in
/// two).
function tailFrom(buffer: string, consumed: number, start: RegExp): string {
  const rest = buffer.slice(consumed);
  const at = rest.search(start);
  return at === -1 ? rest.slice(-256) : rest.slice(at);
}

function richText(xml: string): string {
  const visible = xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, "");
  let text = "";
  for (const match of visible.matchAll(/<(?:\w+:)?t(?=[\s>/])[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?t>)/g)) text += match[1] ?? "";
  return xmlText(text);
}

/// The number format of each cell style (<cellXfs>), by index: the code
/// the file defines, or Excel's built-in one.
async function cellFormats(zip: ZipParts, part: string): Promise<string[]> {
  const xml = (await zip.text(part, MAX_PART_BYTES))?.text ?? "";
  const custom = new Map<number, string>();
  for (const match of xml.matchAll(/<(?:\w+:)?numFmt(?=[\s/>])([^>]*?)\/?>/g)) {
    const attrs = attributes(match[1]!);
    if (attrs.numFmtId !== undefined && attrs.formatCode !== undefined) custom.set(Number(attrs.numFmtId), attrs.formatCode);
  }
  const xfs = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/.exec(xml)?.[1] ?? "";
  return [...xfs.matchAll(/<(?:\w+:)?xf(?=[\s/>])([^>]*?)\/?>/g)].map((match) => {
    const id = Number(attributes(match[1]!).numFmtId ?? 0);
    return custom.get(id) ?? builtInFormat(id);
  });
}

interface WorkbookContext {
  strings: string[];
  formats: string[];
  date1904: boolean;
  recalc: boolean;
}

const ROW = /<(?:\w+:)?row(?=[\s/>])([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g;
const CELL = /<(?:\w+:)?c(?=[\s/>])([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;

/// A worksheet's rows, streamed: only the first MAX_SHEET_ROWS rows that
/// hold something are kept, and the reading stops there.
async function readWorksheet(zip: ZipParts, part: string, context: WorkbookContext): Promise<Omit<Sheet, "name">> {
  const rows: SheetRow[] = [];
  const merges: Sheet["merges"] = [];
  let lastRow: number | null = null;
  let dimensionSeen = false;
  let rowsEnded = false;
  let cut = false;
  let previousRow = 0;
  let buffer = "";
  const outcome = await zip.stream(part, MAX_SHEET_XML_BYTES, (chunk) => {
    buffer += chunk;
    if (!dimensionSeen) {
      const dimension = /<(?:\w+:)?dimension\b[^>]*\bref="([^"]+)"/.exec(buffer);
      if (dimension) {
        dimensionSeen = true;
        const end = /(\d+)$/.exec(dimension[1]!);
        lastRow = end ? Number(end[1]) : null;
      } else if (/<(?:\w+:)?sheetData\b/.test(buffer)) dimensionSeen = true;
    }
    if (!rowsEnded) {
      ROW.lastIndex = 0;
      let consumed = 0;
      let match: RegExpExecArray | null;
      while ((match = ROW.exec(buffer))) {
        consumed = ROW.lastIndex;
        const attrs = attributes(match[1]!);
        const number = Number(attrs.r) > 0 ? Number(attrs.r) : previousRow + 1;
        previousRow = number;
        const cells = match[2] ? readCells(match[2], context) : new Map<number, Cell>();
        if (cells.size === 0) continue;
        if (rows.length >= MAX_SHEET_ROWS) {
          cut = true;
          return false;
        }
        rows.push({ number, cells });
      }
      const end = /<\/(?:\w+:)?sheetData>/.exec(buffer.slice(consumed));
      if (end) {
        rowsEnded = true;
        buffer = buffer.slice(consumed + end.index);
      } else buffer = tailFrom(buffer, consumed, /<(?:\w+:)?row(?=[\s/>])/);
    }
    if (rowsEnded) {
      // Merged cells come after the rows.
      let consumed = 0;
      for (const match of buffer.matchAll(/<(?:\w+:)?mergeCell\b[^>]*\bref="([A-Z]+)(\d+):([A-Z]+)(\d+)"[^>]*>/g)) {
        merges.push({ top: Number(match[2]), left: columnIndex(match[1]!), bottom: Number(match[4]), right: columnIndex(match[3]!) });
        consumed = match.index! + match[0].length;
      }
      buffer = buffer.slice(consumed).slice(-512);
    }
  });
  if (outcome?.truncated && !rowsEnded) cut = true;
  const last = rows[rows.length - 1]?.number ?? 0;
  return { rows, merges, lastRow: lastRow !== null && lastRow >= last ? lastRow : cut ? null : last || null, cut };
}

/// « AB » → 27 (0-based).
export function columnIndex(letters: string): number {
  let index = 0;
  for (const char of letters.toUpperCase()) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

/// 27 → « AB ».
export function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

function readCells(xml: string, context: WorkbookContext): Map<number, Cell> {
  const cells = new Map<number, Cell>();
  let previous = -1;
  CELL.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CELL.exec(xml))) {
    const attrs = attributes(match[1]!);
    const ref = /^([A-Z]+)\d*$/i.exec(attrs.r ?? "");
    const column = ref ? columnIndex(ref[1]!) : previous + 1;
    previous = column;
    const cell = cellOf(attrs, match[2] ?? "", context);
    if (cell && cell.text) cells.set(column, cell);
  }
  return cells;
}

function cellOf(attrs: Record<string, string>, inner: string, context: WorkbookContext): Cell | null {
  const value = /<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner)?.[1];
  const formula = /<(?:\w+:)?f\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?f>)/.exec(inner);
  const type = attrs.t ?? "n";
  const format = context.formats[Number(attrs.s ?? 0)] ?? "General";
  if (type === "inlineStr") {
    const inline = /<(?:\w+:)?is>([\s\S]*?)<\/(?:\w+:)?is>/.exec(inner)?.[1];
    return inline === undefined ? null : { text: richText(inline), kind: "text" };
  }
  if (value === undefined || (context.recalc && formula && /^0?$/.test(value.trim()))) {
    // A formula without its result: said as a formula.
    const text = formula?.[1] ? xmlText(formula[1]).trim() : "";
    return text ? { text: `=${text}`, kind: "formula" } : null;
  }
  switch (type) {
    case "s":
      return { text: context.strings[Number(value)] ?? "", kind: "text" };
    case "str":
      return { text: xmlText(value), kind: "text" };
    case "b":
      return { text: value.trim() === "1" || value.trim() === "true" ? "TRUE" : "FALSE", kind: "bool" };
    case "e":
      return { text: xmlText(value).trim(), kind: "error" };
    case "d": {
      const parts = fromIso(value);
      if (!parts) return { text: value.trim(), kind: "text" };
      const shown = isDateFormat(format) ? format : parts.hours || parts.minutes || parts.seconds ? "yyyy-mm-dd hh:mm" : "yyyy-mm-dd";
      return { text: formatDate(parts, shown), kind: "date" };
    }
    default: {
      const number = Number(value);
      if (value.trim() === "" || !Number.isFinite(number)) return { text: xmlText(value).trim(), kind: "text" };
      return { text: formatValue(number, format, context.date1904), kind: isDateFormat(format) ? "date" : "number" };
    }
  }
}

// ─── OpenDocument ───────────────────────────────────────────────────────────

/// An .ods file's tables. The text a cell shows is in the file itself
/// (<text:p>), as the program that saved it formatted it.
export async function readOds(zip: ZipParts): Promise<Sheet[]> {
  const found = await zip.text("content.xml", MAX_ODS_XML_BYTES);
  if (!found) return [];
  const xml = found.text;
  const sheets: Sheet[] = [];
  const start = /<table:table(?=[\s>])([^>]*)>/g;
  let match: RegExpExecArray | null;
  while ((match = start.exec(xml)) && sheets.length < MAX_SHEETS) {
    const end = xml.indexOf("</table:table>", start.lastIndex);
    const body = xml.slice(start.lastIndex, end === -1 ? undefined : end);
    if (end !== -1) start.lastIndex = end;
    const attrs = attributes(match[1]!);
    const sheet = readOdsTable(body);
    sheets.push({ ...sheet, name: attrs["table:name"] ?? `Sheet${sheets.length + 1}`, cut: sheet.cut || end === -1 });
  }
  return sheets;
}

function readOdsTable(xml: string): Omit<Sheet, "name"> {
  const rows: SheetRow[] = [];
  const merges: Sheet["merges"] = [];
  let number = 0;
  let cut = false;
  for (const row of xml.matchAll(/<table:table-row(?=[\s/>])([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-row>)/g)) {
    const repeat = Math.max(1, Number(attributes(row[1]!)["table:number-rows-repeated"] ?? 1));
    const cells = new Map<number, Cell>();
    let column = 0;
    for (const cell of (row[2] ?? "").matchAll(/<table:(table-cell|covered-table-cell)(?=[\s/>])([^>]*?)(?:\/>|>([\s\S]*?)<\/table:\1>)/g)) {
      const attrs = attributes(cell[2]!);
      const span = Math.max(1, Number(attrs["table:number-columns-repeated"] ?? 1));
      const value = cell[1] === "table-cell" ? odsCell(attrs, cell[3] ?? "") : null;
      if (value && column < 16_384) {
        // A cell repeated across columns holds the same thing in each.
        for (let k = 0; k < Math.min(span, MAX_COLUMNS); k += 1) cells.set(column + k, value);
        const across = Number(attrs["table:number-columns-spanned"] ?? 1);
        const down = Number(attrs["table:number-rows-spanned"] ?? 1);
        if (across > 1 || down > 1) merges.push({ top: number + 1, left: column, bottom: number + down, right: column + across - 1 });
      }
      column += span;
    }
    if (cells.size === 0) {
      number += repeat; // empty rows, often a million of them at the end
      continue;
    }
    for (let k = 0; k < repeat; k += 1) {
      number += 1;
      if (rows.length >= MAX_SHEET_ROWS) {
        cut = true;
        break;
      }
      rows.push({ number, cells });
    }
    if (cut) break;
  }
  return { rows, merges, lastRow: cut ? null : (rows[rows.length - 1]?.number ?? null), cut };
}

function odsCell(attrs: Record<string, string>, inner: string): Cell | null {
  // A comment on the cell is not what it shows.
  const shown = odfParagraphs(inner.replace(/<office:annotation\b[\s\S]*?<\/office:annotation>/g, "")).join("\n").trim();
  const type = attrs["office:value-type"] ?? attrs["calcext:value-type"] ?? "";
  const kind: Cell["kind"] = type === "float" || type === "percentage" || type === "currency" ? "number" : type === "date" || type === "time" ? "date" : type === "boolean" ? "bool" : "text";
  if (shown) return { text: shown, kind };
  const raw = attrs["office:date-value"] ?? attrs["office:time-value"] ?? attrs["office:value"] ?? attrs["office:boolean-value"] ?? attrs["office:string-value"];
  return raw ? { text: raw, kind } : null;
}

// ─── CSV and TSV ────────────────────────────────────────────────────────────

/// A CSV or TSV file as a table, its separator found (a comma, a
/// semicolon as French programs write them, a tab, a vertical bar); null
/// when it is no table — then it is read as text.
export function readDelimited(text: string, tab = false): Sheet | null {
  const source = text.replace(/^\uFEFF/, "");
  const separator = tab ? "\t" : guessSeparator(source);
  if (!separator) return null;
  const rows: SheetRow[] = [];
  let records = 0;
  let widths = 0;
  let wide = 0;
  for (const fields of csvRecords(source, separator)) {
    records += 1;
    const cells = new Map<number, Cell>();
    fields.forEach((field, column) => {
      const value = field.trim();
      if (value) cells.set(column, { text: value, kind: /^[-+]?\d[\d\s.,]*%?$/.test(value) ? "number" : "text" });
    });
    if (fields.length > 1) wide += 1;
    widths += 1;
    if (cells.size > 0 && rows.length < MAX_SHEET_ROWS) rows.push({ number: records, cells });
  }
  // Mostly rows of a single field: prose with commas in it, not a table.
  if (rows.length < 2 || wide < widths * 0.8) return null;
  return { name: null, rows, merges: [], lastRow: records, cut: rows.length >= MAX_SHEET_ROWS && records > rows[rows.length - 1]!.number };
}

function guessSeparator(text: string): string | null {
  const lines = text.split(/\r?\n/).filter((line) => line.trim()).slice(0, 50);
  if (lines.length === 0) return null;
  let best: { separator: string; score: number } | null = null;
  for (const separator of [";", ",", "\t", "|"]) {
    const counts = lines.map((line) => countOutsideQuotes(line, separator));
    const common = mode(counts);
    if (common === 0) continue;
    // A table's lines agree on their number of separators; prose does not.
    const agreeing = counts.filter((count) => count === common).length / counts.length;
    if (agreeing < (lines.length < 5 ? 1 : 0.8)) continue;
    const score = agreeing * Math.min(common, 20);
    if (!best || score > best.score) best = { separator, score };
  }
  return best?.separator ?? null;
}

function countOutsideQuotes(line: string, separator: string): number {
  let count = 0;
  let quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (char === separator && !quoted) count += 1;
  }
  return count;
}

function mode(values: number[]): number {
  const tally = new Map<number, number>();
  for (const value of values) tally.set(value, (tally.get(value) ?? 0) + 1);
  return [...tally.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 0;
}

/// The records of a CSV text (RFC 4180: quoted fields may hold the
/// separator, quotes doubled, line breaks).
function* csvRecords(text: string, separator: string): Generator<string[]> {
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += char;
    } else if (char === '"' && field.trim() === "") {
      quoted = true;
      field = "";
    } else if (char === separator) {
      fields.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      fields.push(field);
      if (fields.some((value) => value.trim())) yield fields;
      fields = [];
      field = "";
    } else field += char;
  }
  fields.push(field);
  if (fields.some((value) => value.trim())) yield fields;
}

// ─── Passages ───────────────────────────────────────────────────────────────

/// The line that starts each block: what the index searches for a sheet's
/// name, what a citation reads its sheet and rows from (location.ts).
export function sheetMarker(name: string | null, from: number, to: number, total: number | null, notes: string[], hidden = false): string {
  const rows = `${from}–${to}${total !== null && total >= to ? ` of ${total}` : ""}`;
  const head = name === null ? `Rows ${rows}` : `Sheet "${name.replace(/["\\]/g, (char) => `\\${char}`)}"${hidden ? " (hidden)" : ""}, rows ${rows}`;
  return `[${head}${notes.length ? `; ${notes.join("; ")}` : ""}]`;
}

/// A cell as it goes in a row of the table: on one line, its bars escaped.
function cellText(text: string, max = MAX_CELL_CHARS): string {
  const flat = text.replace(/\s*[\r\n]+\s*/g, " / ").replace(/\s+/g, " ").trim();
  const cut = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  return cut.replace(/\|/g, "\\|");
}

const isYear = (cell: Cell) => cell.kind === "number" && /^(1[89]|2[01])\d\d$/.test(cell.text);

/// Every sheet as its blocks of rows, within MAX_TABLE_CHARS for them all.
export function sheetSections(sheets: Sheet[]): Section[] {
  const sections: Section[] = [];
  let budget = MAX_TABLE_CHARS;
  const unread: string[] = [];
  for (const sheet of sheets) {
    if (budget <= 0) {
      if (sheet.rows.length > 0 && sheet.name !== null) unread.push(sheet.name);
      continue;
    }
    const blocks = sheetBlocks(sheet, budget);
    for (const text of blocks) {
      budget -= text.length + 2;
      sections.push({ page: null, text, table: true });
    }
  }
  if (unread.length > 0) {
    sections.push({ page: null, text: `[Sheets not read, the file being too large: ${unread.map((name) => `"${name}"`).join(", ")}]`, table: true });
  }
  return sections;
}

function sheetBlocks(source: Sheet, budget: number): string[] {
  if (source.rows.length === 0) return [];
  const sheet = withVerticalMerges(source);
  const used = [...new Set(sheet.rows.flatMap((row) => [...row.cells.keys()]))].sort((a, b) => a - b);
  const columns = used.slice(0, MAX_COLUMNS);
  const hiddenColumns = used.length - columns.length;
  const rows = sheet.rows.filter((row) => columns.some((column) => row.cells.has(column)));
  if (rows.length === 0) return [];

  // The header: among the first rows, the first of words only (years
  // allowed) that spans about as many columns as the table.
  const widest = Math.max(...rows.slice(0, 30).map((row) => row.cells.size));
  let headerAt = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i += 1) {
    const cells = columns.map((column) => rows[i]!.cells.get(column)).filter((cell): cell is Cell => !!cell);
    if (cells.length >= 2 && cells.length >= Math.ceil(widest / 2) && cells.every((cell) => cell.kind === "text" || isYear(cell)) && cells.some((cell) => cell.kind === "text")) {
      headerAt = i;
      break;
    }
  }
  let labels = columns.map((column) => columnName(column));
  let dataFrom = 0;
  const titles: string[] = [];
  if (headerAt !== -1) {
    const header = rows[headerAt]!;
    const across = (row: SheetRow) => sheet.merges.filter((merge) => merge.top <= row.number && merge.bottom >= row.number && merge.right > merge.left);
    const spread = (row: SheetRow) => {
      const cells = new Map(row.cells);
      for (const merge of across(row)) {
        const cell = cells.get(merge.left);
        if (cell) for (let column = merge.left + 1; column <= merge.right; column += 1) if (!cells.has(column)) cells.set(column, cell);
      }
      return cells;
    };
    let top = spread(header);
    dataFrom = headerAt + 1;
    // A header on two rows: « Montants » over three months.
    const next = rows[headerAt + 1];
    if (across(header).length > 0 && next && next.number === header.number + 1) {
      const below = columns.map((column) => next.cells.get(column)).filter((cell): cell is Cell => !!cell);
      if (below.length >= 2 && below.every((cell) => cell.kind === "text" || isYear(cell))) {
        const lower = spread(next);
        top = new Map(columns.map((column) => {
          const parts = [top.get(column)?.text, lower.get(column)?.text].filter((text): text is string => !!text);
          return [column, { text: [...new Set(parts)].join(" "), kind: "text" as const }];
        }));
        dataFrom = headerAt + 2;
      }
    }
    labels = columns.map((column) => cellText(top.get(column)?.text ?? "", MAX_HEADER_CHARS) || columnName(column));
    for (const row of rows.slice(0, headerAt)) titles.push(cellText(columns.map((column) => row.cells.get(column)?.text ?? "").filter(Boolean).join(" · "), 400));
  }
  const data = rows.slice(dataFrom);
  const headerLines = [`| Row | ${labels.join(" | ")} |`, `| --- | ${labels.map(() => "---").join(" | ")} |`];
  const lines = data.map((row) => {
    const line = `| ${row.number} | ${columns.map((column) => cellText(row.cells.get(column)?.text ?? "")).join(" | ")} |`;
    return line.length > MAX_BLOCK_CHARS - 600 ? `${line.slice(0, MAX_BLOCK_CHARS - 602)}…|` : line;
  });

  const total = sheet.lastRow;
  const lastRead = rows[rows.length - 1]!.number;
  const notes: string[] = [];
  if (sheet.cut) notes.push(`rows after ${lastRead} not read: the sheet is too large`);
  if (hiddenColumns > 0) notes.push(`${hiddenColumns} more columns not shown`);
  const target = Math.min(MAX_BLOCK_CHARS, Math.max(BLOCK_CHARS, headerLines[0]!.length * 2 + 300));
  const blocks: string[] = [];
  let spent = 0;
  let index = 0;
  const firstNumber = rows[0]!.number;
  do {
    const first = blocks.length === 0;
    const kept: string[] = [];
    let size = headerLines[0]!.length + headerLines[1]!.length + 80 + (first ? titles.join("\n").length : 0);
    const start = index;
    while (index < lines.length && (kept.length === 0 || size + lines[index]!.length + 1 <= target)) {
      size += lines[index]!.length + 1;
      kept.push(lines[index]!);
      index += 1;
    }
    const from = first ? firstNumber : data[start]!.number;
    const to = kept.length ? data[index - 1]!.number : first ? rows[Math.max(0, dataFrom - 1)]!.number : from;
    let blockNotes = notes;
    if (spent + size > budget) {
      // The workbook is too large for the rest: said in the last block.
      blockNotes = [...notes.filter((note) => !note.startsWith("rows after")), `rows after ${to} not read: the file is too large`];
      index = lines.length;
    }
    const text = [sheetMarker(sheet.name, from, to, total, blockNotes, sheet.hidden), ...(first ? titles : []), ...headerLines, ...kept].join("\n");
    blocks.push(text);
    spent += text.length + 2;
  } while (index < lines.length);
  return blocks;
}

/// A cell merged down several rows (a category beside its lines) counts
/// in each of them: a block of rows found alone still says it.
function withVerticalMerges(sheet: Sheet): Sheet {
  const down = sheet.merges.filter((merge) => merge.bottom > merge.top);
  if (down.length === 0) return sheet;
  const byNumber = new Map(sheet.rows.map((row) => [row.number, row]));
  const rows = sheet.rows.map((row) => ({ number: row.number, cells: new Map(row.cells) }));
  const copies = new Map(rows.map((row) => [row.number, row]));
  for (const merge of down) {
    const cell = byNumber.get(merge.top)?.cells.get(merge.left);
    if (!cell) continue;
    for (let number = merge.top + 1; number <= merge.bottom; number += 1) {
      const row = copies.get(number);
      if (row && !row.cells.has(merge.left)) row.cells.set(merge.left, cell);
    }
  }
  return { ...sheet, rows };
}
