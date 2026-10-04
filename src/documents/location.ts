import { extname } from "node:path";

// Where a passage is in its document, as a citation says it: the page of
// a PDF, the slide of a presentation, the sheet and rows of a spreadsheet.
// Read from what every passage already carries — its file's name, its
// page and its text, whose first line names a spreadsheet's sheet and
// rows (spreadsheet.ts sheetMarker) — so passages indexed, found on
// another of the person's computers or read back from history all say it
// the same way, with nothing more stored or sent.

export type PassageLocation =
  | { kind: "page"; page: number }
  | { kind: "slide"; slide: number }
  /// `sheet` null for a CSV file, a table of its own.
  | { kind: "sheet"; sheet: string | null; rows: [number, number] };

export const SPREADSHEET_EXTENSIONS = new Set([".xlsx", ".xlsm", ".ods", ".csv", ".tsv"]);
export const PRESENTATION_EXTENSIONS = new Set([".pptx", ".pptm", ".ppsx", ".odp"]);

const SHEET_LINE = /^\[(?:Sheet "((?:[^"\\]|\\.)*)"(?: \(hidden\))?, rows|Rows) (\d+)–(\d+)(?: of \d+)?(?:;[^\]\n]*)?\]$/;

export function passageLocation(name: string, page: number | null, text: string): PassageLocation | null {
  const ext = extname(name).toLowerCase();
  if (SPREADSHEET_EXTENSIONS.has(ext)) {
    const line = SHEET_LINE.exec(text.slice(0, 400).split("\n", 1)[0]!.trim());
    if (line) return { kind: "sheet", sheet: line[1] === undefined ? null : line[1].replace(/\\(.)/g, "$1"), rows: [Number(line[2]), Number(line[3])] };
  }
  if (page === null || !Number.isInteger(page) || page < 1) return null;
  return PRESENTATION_EXTENSIONS.has(ext) ? { kind: "slide", slide: page } : { kind: "page", page };
}

/// The place as the model is told it (« p. 4 », « slide 3 »); null when
/// the passage's own first line says it (a spreadsheet's) or there is none.
export function excerptPlace(name: string, page: number | null, text: string): string | null {
  const location = passageLocation(name, page, text);
  if (!location || location.kind === "sheet") return null;
  return location.kind === "slide" ? `slide ${location.slide}` : `p. ${location.page}`;
}
