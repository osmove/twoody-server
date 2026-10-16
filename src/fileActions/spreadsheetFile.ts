import { strToU8, zipSync } from "fflate";

// An Excel workbook (.xlsx) from Markdown tables, for « Agir dans vos
// dossiers » (docs/agent-in-chat.md of twoody-desktop): a copy of the
// Desktop's « Exporter en Excel » writer (twoody-desktop
// src/main/spreadsheetFile.ts, 16/10/2026) — the server writes it without
// the Desktop (a Pi, `twoody serve`), and the Desktop's is not shared code.
// One sheet per table, its header row in bold and frozen, with a filter;
// numbers as numbers, dates as dates. Keep both in step.

export type MainLocale = "en" | "fr" | "de" | "es" | "it" | "pt" | "ja" | "zh" | "ko" | "nl";

export interface SheetTable {
  name: string;
  header: string[];
  rows: string[][];
}

type Cell =
  | { kind: "text"; text: string; bold?: boolean }
  | { kind: "number"; value: number; format: string; bold?: boolean; shown: string };

const CURRENCIES = "€|\\$|£|CHF|EUR|USD|GBP";
const CURRENCY_AFTER = new RegExp(`^(.+?)\\s*(${CURRENCIES})$`);
const CURRENCY_BEFORE = new RegExp(`^(${CURRENCIES})\\s*(.+)$`);
const CITATIONS = /(?:\s*\[\d+(?:\s*,\s*\d+)*\])+$/;

interface ReadNumber {
  value: number;
  decimals: number;
  grouped: boolean;
}

/// A number written for people: « 1 250,50 », « 1,250.50 », « 3,5 »,
/// « 12 345 ». `decimal` settles « 1,250 » (one separator, three digits
/// after it): the table's way, else the language's.
export function readNumber(text: string, decimal: "," | "."): ReadNumber | null {
  const source = text.trim();
  if (!/^\d/.test(source) || /^0\d/.test(source)) return null; // « 0612… », « 007 »: codes, kept as written
  let integer: string;
  let fraction = "";
  let grouped = false;
  let match: RegExpExecArray | null;
  if ((match = /^(\d{1,3}(?:[ \u00a0\u202f']\d{3})+)(?:[.,](\d+))?$/.exec(source))) {
    integer = match[1]!.replace(/[ \u00a0\u202f']/g, "");
    fraction = match[2] ?? "";
    grouped = true;
  } else if ((match = /^(\d{1,3}([.,])\d{3}(?:\2\d{3})*)(?:([.,])(\d+))?$/.exec(source))) {
    const group = match[2]!;
    const point = match[3];
    const groups = match[1]!.split(group).length - 1;
    if (point && point === group) return null;
    if (!point && groups === 1 && group === decimal) {
      // « 1,250 » in French: one and a quarter.
      integer = match[1]!.split(group)[0]!;
      fraction = match[1]!.split(group)[1]!;
    } else {
      integer = match[1]!.split(group).join("");
      fraction = match[4] ?? "";
      grouped = true;
    }
  } else if ((match = /^(\d+)(?:[.,](\d+))?$/.exec(source))) {
    integer = match[1]!;
    fraction = match[2] ?? "";
  } else return null;
  if (integer.replace(/^0+/, "").length + fraction.length > 15) return null; // past what a number keeps
  return { value: Number(`${integer}.${fraction || "0"}`), decimals: Math.min(fraction.length, 10), grouped };
}

/// Numbers that can only be read one way: « 1,250.50 », « 1 250.50 »,
/// « 12.25 » have a decimal point; « 1.250,50 », « 1 250,50 », « 3,5 » a
/// decimal comma.
const DECIMAL_POINT = /^\d{1,3}(?:(?:,\d{3})+|(?:[ \u00a0\u202f']\d{3})+)\.\d+$|^\d+\.(?:\d{1,2}|\d{4,})$/;
const DECIMAL_COMMA = /^\d{1,3}(?:(?:\.\d{3})+|(?:[ \u00a0\u202f']\d{3})+),\d+$|^\d+,(?:\d{1,2}|\d{4,})$/;

/// The decimal mark a table uses, from its numbers that say it; the
/// language's otherwise.
/// The languages that write « 3,5 » and the day before the month.
const commaDecimal = (language: MainLocale) => language !== "en" && language !== "ja" && language !== "zh" && language !== "ko";

export function decimalMark(tables: string[][][], language: MainLocale): "," | "." {
  let points = 0;
  let commas = 0;
  for (const table of tables) {
    for (const row of table) {
      for (const raw of row) {
        const text = numberPart(raw);
        if (text === null) continue;
        if (DECIMAL_POINT.test(text)) points += 1;
        else if (DECIMAL_COMMA.test(text)) commas += 1;
      }
    }
  }
  if (commas !== points) return commas > points ? "," : ".";
  return commaDecimal(language) ? "," : ".";
}

/// A cell's number with its sign, without its currency, percent and
/// citations; null when it is no number.
function numberPart(raw: string): string | null {
  let text = raw.replace(CITATIONS, "").replace(/\*\*/g, "").trim().replace(/^[−–]/, "-");
  if (text.startsWith("-") || text.startsWith("+")) text = text.slice(1).trim();
  text = text.replace(/\s*%$/, "");
  const after = CURRENCY_AFTER.exec(text);
  if (after) text = after[1]!;
  const before = CURRENCY_BEFORE.exec(text);
  if (before) text = before[2]!;
  return /^\d[\d \u00a0\u202f'.,]*$/.test(text.trim()) ? text.trim() : null;
}

function quoted(symbol: string): string {
  return `"${symbol}"`;
}

/// What a cell of the answer becomes in the workbook.
export function cellOf(raw: string, decimal: "," | ".", language: MainLocale): Cell {
  const bold = /^\*\*[^*]+\*\*$/.test(raw.trim());
  const text = raw.trim().replace(/^\*\*([^*]+)\*\*$/, "$1");
  const date = dateOf(text, language);
  if (date) return { kind: "number", value: date.serial, format: date.format, bold, shown: text };

  let body = text.replace(CITATIONS, "").trim().replace(/^[−–]/, "-");
  let sign = 1;
  if (body.startsWith("-") || body.startsWith("+")) {
    sign = body.startsWith("-") ? -1 : 1;
    body = body.slice(1).trim();
  }
  let percent = false;
  let currency: { symbol: string; before: boolean } | null = null;
  if (/\s*%$/.test(body)) {
    percent = true;
    body = body.replace(/\s*%$/, "");
  } else {
    const after = CURRENCY_AFTER.exec(body);
    const before = CURRENCY_BEFORE.exec(body);
    if (after) {
      currency = { symbol: after[2]!, before: false };
      body = after[1]!;
    } else if (before) {
      currency = { symbol: before[1]!, before: true };
      body = before[2]!;
    }
  }
  const number = readNumber(body, decimal);
  if (!number) return { kind: "text", text: plain(text), bold };
  const decimals = number.decimals ? `.${"0".repeat(number.decimals)}` : "";
  // 37,2 % is 0.372, not 0.37200000000000005.
  if (percent) return { kind: "number", value: Number(((sign * number.value) / 100).toPrecision(15)), format: `0${decimals}%`, bold, shown: text };
  if (currency) {
    const amount = `#,##0${decimals}`;
    const symbol = currency.symbol === "EUR" ? "€" : currency.symbol === "USD" ? "$" : currency.symbol === "GBP" ? "£" : currency.symbol;
    return { kind: "number", value: sign * number.value, format: currency.before ? `${quoted(symbol)}${amount}` : `${amount} ${quoted(symbol)}`, bold, shown: text };
  }
  return { kind: "number", value: sign * number.value, format: `${number.grouped ? "#,##0" : "0"}${decimals}`, bold, shown: text };
}

/// 2026-01-03 always; 03/01/2026 where the day comes first (French,
/// German, Spanish, Italian, Portuguese, Dutch). Null otherwise.
function dateOf(text: string, language: MainLocale): { serial: number; format: string } | null {
  let year: number;
  let month: number;
  let day: number;
  let format: string;
  let match: RegExpExecArray | null;
  if ((match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text))) {
    [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    format = "yyyy-mm-dd";
  } else if (commaDecimal(language) && (match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text))) {
    [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
    format = "dd/mm/yyyy";
  } else return null;
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || year < 1900) return null;
  return { serial: (time - Date.UTC(1899, 11, 30)) / 86_400_000, format };
}

/// Markdown in a cell as text (the window sends the table as written).
function plain(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/!?\[([^\]]*)\]\([^)\s]+\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(?<![\p{L}\p{N}*])\*([^*\s][^*]*?)\*(?!\*)/gu, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, "$1");
}

/// A name Excel takes for a sheet: 31 characters at most, none of
/// \ / ? * [ ] :, not empty, not « History », and not one already given.
export function sheetName(wanted: string, taken: Set<string>, fallback: string): string {
  let name = withoutControls(wanted).replace(/[\\/?*[\]:]/g, " ").replace(/\s+/g, " ").trim().replace(/^'+|'+$/g, "").slice(0, 31).trim();
  if (!name || /^history$/i.test(name)) name = fallback.slice(0, 31);
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) candidate = `${name.slice(0, 31 - ` (${n})`.length)} (${n})`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

/// Without the control characters XML refuses (tabs and line breaks stay).
function withoutControls(text: string, keep = ""): string {
  return [...text].filter((char) => char.charCodeAt(0) >= 0x20 || keep.includes(char)).join("");
}

function xml(text: string): string {
  return withoutControls(text, "\t\n\r")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/// « A », « B », … « AA ».
function column(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const RELS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export function spreadsheetFile(tables: SheetTable[], options: { language: MainLocale; title: string }, now = new Date()): Uint8Array {
  const decimal = decimalMark(tables.map((table) => table.rows), options.language);
  const strings: string[] = [];
  const stringIndex = new Map<string, number>();
  const shared = (text: string) => {
    let index = stringIndex.get(text);
    if (index === undefined) {
      index = strings.length;
      strings.push(text);
      stringIndex.set(text, index);
    }
    return index;
  };
  // Styles: a number format, bold or not, header or not, wrapped or not.
  const formats: string[] = [];
  const styles: string[] = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  const styleIndex = new Map<string, number>([["0|0|0|0", 0]]);
  const style = (format: string | null, bold: boolean, header: boolean, wrap: boolean) => {
    let id = 0;
    if (format) {
      let at = formats.indexOf(format);
      if (at === -1) at = formats.push(format) - 1;
      id = 164 + at;
    }
    const key = `${id}|${bold || header ? 1 : 0}|${header ? 1 : 0}|${wrap ? 1 : 0}`;
    let index = styleIndex.get(key);
    if (index === undefined) {
      index = styles.length;
      styles.push(
        `<xf numFmtId="${id}" fontId="${bold || header ? 1 : 0}" fillId="${header ? 2 : 0}" borderId="${header ? 1 : 0}" xfId="0"${id ? ' applyNumberFormat="1"' : ""}${bold || header ? ' applyFont="1"' : ""}${header ? ' applyFill="1" applyBorder="1"' : ""}${wrap ? ' applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' : "/>"}`,
      );
      styleIndex.set(key, index);
    }
    return index;
  };

  const taken = new Set<string>();
  const sheets = tables.map((table, sheetIndex) => {
    const name = sheetName(table.name, taken, `Sheet${sheetIndex + 1}`);
    const width = Math.max(1, table.header.length, ...table.rows.map((row) => row.length));
    const widths = Array.from({ length: width }, () => 8);
    const cellXml = (ref: string, cell: Cell, header: boolean) => {
      if (cell.kind === "number") {
        widths[columnOf(ref)] = Math.max(widths[columnOf(ref)]!, Math.min(60, cell.shown.length + 2));
        return `<c r="${ref}" s="${style(cell.format, !!cell.bold, header, false)}"><v>${cell.value}</v></c>`;
      }
      if (!cell.text) return "";
      const longest = Math.max(...cell.text.split("\n").map((line) => line.length));
      widths[columnOf(ref)] = Math.max(widths[columnOf(ref)]!, Math.min(60, longest + 2));
      return `<c r="${ref}" s="${style(null, !!cell.bold, header, cell.text.includes("\n") || longest > 60)}" t="s"><v>${shared(cell.text)}</v></c>`;
    };
    const columnOf = (ref: string) => {
      let index = 0;
      for (const char of ref.replace(/\d+$/, "")) index = index * 26 + (char.charCodeAt(0) - 64);
      return index - 1;
    };
    const rows: string[] = [];
    const headerCells = Array.from({ length: width }, (_, k) => cellXml(`${column(k)}1`, { kind: "text", text: plain(table.header[k] ?? "") }, true)).join("");
    rows.push(`<row r="1">${headerCells}</row>`);
    table.rows.forEach((row, r) => {
      const cells = Array.from({ length: width }, (_, k) => cellXml(`${column(k)}${r + 2}`, cellOf(row[k] ?? "", decimal, options.language), false)).join("");
      rows.push(`<row r="${r + 2}">${cells}</row>`);
    });
    const last = `${column(width - 1)}${table.rows.length + 1}`;
    const cols = widths.map((value, k) => `<col min="${k + 1}" max="${k + 1}" width="${value}" customWidth="1"/>`).join("");
    const xmlText =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${MAIN}" xmlns:r="${RELS}"><dimension ref="A1:${last}"/>` +
      `<sheetViews><sheetView${sheetIndex === 0 ? ' tabSelected="1"' : ""} workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>` +
      `<sheetFormatPr defaultRowHeight="15"/><cols>${cols}</cols><sheetData>${rows.join("")}</sheetData>` +
      `<autoFilter ref="A1:${last}"/><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
    return { name, xml: xmlText, range: `'${name.replace(/'/g, "''")}'!$A$1:$${column(width - 1)}$${table.rows.length + 1}` };
  });

  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const numFmts = formats.length ? `<numFmts count="${formats.length}">${formats.map((code, k) => `<numFmt numFmtId="${164 + k}" formatCode="${xml(code)}"/>`).join("")}</numFmts>` : "";
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, k) => `<Override PartName="/xl/worksheets/sheet${k + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RELS}/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${RELS}/extended-properties" Target="docProps/app.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="${MAIN}" xmlns:r="${RELS}"><bookViews><workbookView/></bookViews><sheets>${sheets.map((sheet, k) => `<sheet name="${xml(sheet.name)}" sheetId="${k + 1}" r:id="rId${k + 1}"/>`).join("")}</sheets><definedNames>${sheets.map((sheet, k) => `<definedName name="_xlnm._FilterDatabase" localSheetId="${k}" hidden="1">${xml(sheet.range)}</definedName>`).join("")}</definedNames></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, k) => `<Relationship Id="rId${k + 1}" Type="${RELS}/worksheet" Target="worksheets/sheet${k + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="${RELS}/styles" Target="styles.xml"/><Relationship Id="rId${sheets.length + 2}" Type="${RELS}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    ),
    "xl/sharedStrings.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="${MAIN}" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((text) => `<si><t xml:space="preserve">${xml(text)}</t></si>`).join("")}</sst>`,
    ),
    "xl/styles.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="${MAIN}">${numFmts}<fonts count="2"><font><sz val="11"/><name val="Arial"/><family val="2"/></font><font><b/><sz val="11"/><name val="Arial"/><family val="2"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEFEFEF"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF808080"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${styles.length}">${styles.join("")}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    ),
    "docProps/core.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(options.title)}</dc:title><dc:creator>Twoody</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified></cp:coreProperties>`,
    ),
    "docProps/app.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Twoody</Application></Properties>`,
    ),
  };
  sheets.forEach((sheet, k) => {
    files[`xl/worksheets/sheet${k + 1}.xml`] = strToU8(sheet.xml);
  });
  return zipSync(files, { level: 6 });
}
