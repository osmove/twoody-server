import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { extractText, getDocumentProxy } from "unpdf";
import { ocrPages } from "./ocr.js";

// Text extraction for the document index. Pure JavaScript on purpose:
// the server has to work on a stock Mac (no pdftotext, no ripgrep) and,
// later, on Windows. Each extractor returns sections; a PDF yields one
// per page so an answer can cite "contract.pdf, p. 4".

export interface Section {
  /// 1-based page number, or null for formats without pages.
  page: number | null;
  text: string;
  /// Read by OCR from a scanned page (./ocr.ts), not from the file's text.
  ocr?: boolean;
}

const PLAIN_TEXT = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".log", ".srt", ".vtt", ".yml", ".yaml"]);
const MARKUP = new Set([".html", ".htm", ".xml"]);

export const SUPPORTED_EXTENSIONS = new Set([...PLAIN_TEXT, ...MARKUP, ".pdf", ".docx", ".odt", ".rtf"]);

/// Files above this are skipped: they are almost never prose, and the
/// extractors hold the whole file in memory.
export const MAX_FILE_BYTES = 40 * 1024 * 1024;
/// A single document cannot take over the index.
const MAX_DOCUMENT_CHARS = 2_000_000;

export function isSupported(path: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extname(path).toLowerCase());
}

export async function extractSections(path: string): Promise<Section[]> {
  const ext = extname(path).toLowerCase();
  const bytes = await readFile(path);

  let sections: Section[];
  if (ext === ".pdf") sections = await extractPdf(path, bytes);
  else if (ext === ".docx") sections = [{ page: null, text: extractDocx(bytes) }];
  else if (ext === ".odt") sections = [{ page: null, text: extractOdt(bytes) }];
  else if (ext === ".rtf") sections = [{ page: null, text: stripRtf(decodeText(bytes)) }];
  else if (MARKUP.has(ext)) sections = [{ page: null, text: stripMarkup(decodeText(bytes)) }];
  else sections = [{ page: null, text: decodeText(bytes) }];

  let budget = MAX_DOCUMENT_CHARS;
  const kept: Section[] = [];
  for (const section of sections) {
    const text = tidy(section.text).slice(0, budget);
    budget -= text.length;
    if (text) kept.push({ page: section.page, text, ...(section.ocr ? { ocr: true } : {}) });
    if (budget <= 0) break;
  }
  return kept;
}

/// Below this many letters and digits a page counts as without text: a
/// scan, or at most a stamp or a page number over one.
const SCANNED_PAGE_CHARS = 20;

async function extractPdf(path: string, bytes: Buffer): Promise<Section[]> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  const sections: Section[] = text.map((pageText, index) => ({ page: index + 1, text: pageText }));
  // Pages without text of their own are read by OCR, when this computer
  // can (./ocr.ts); a PDF that already carries text is never touched.
  const scanned = sections.filter((section) => (section.text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) < SCANNED_PAGE_CHARS).map((section) => section.page as number);
  if (scanned.length > 0) {
    const read = await ocrPages(path, scanned);
    for (const section of sections) {
      const ocrText = read?.get(section.page as number);
      if (ocrText?.trim()) {
        section.text = ocrText;
        section.ocr = true;
      }
    }
  }
  return sections;
}

/// A .docx is a zip; the body is word/document.xml, where each <w:p> is
/// a paragraph and each <w:t> a run of text.
function extractDocx(bytes: Buffer): string {
  const entry = unzipSync(new Uint8Array(bytes), { filter: (file) => file.name === "word/document.xml" })["word/document.xml"];
  if (!entry) return "";
  return strFromU8(entry)
    .split(/<\/w:p>/)
    .map((paragraph) =>
      paragraph
        .replace(/<w:tab\/>/g, "\t")
        .replace(/<w:br[^>]*\/>/g, "\n")
        .replace(/<(?!\/?w:t[ >])[^>]+>/g, "")
        .replace(/<\/?w:t[^>]*>/g, ""),
    )
    .map(decodeEntities)
    .join("\n");
}

function extractOdt(bytes: Buffer): string {
  const entry = unzipSync(new Uint8Array(bytes), { filter: (file) => file.name === "content.xml" })["content.xml"];
  if (!entry) return "";
  return decodeEntities(
    strFromU8(entry)
      .replace(/<text:(p|h)[ >]/g, "\n<text:$1 ")
      .replace(/<text:tab\/>/g, "\t")
      .replace(/<text:line-break\/>/g, "\n")
      .replace(/<[^>]+>/g, ""),
  );
}

function stripMarkup(source: string): string {
  return decodeEntities(
    source
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/(p|div|li|tr|h[1-6]|br|section|article)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  );
}

/// TextEdit's default format. Drops the header groups and control
/// words, keeps the text, and decodes \'hh (Windows-1252) and \uN.
function stripRtf(source: string): string {
  const cp1252 = new TextDecoder("windows-1252");
  return source
    .replace(/\{\\\*?\\?(fonttbl|colortbl|stylesheet|info|pict|themedata|datastore|generator)[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, "")
    .replace(/\\par[d]?\b ?/g, "\n")
    .replace(/\\(line|tab)\b ?/g, (_match, word: string) => (word === "tab" ? "\t" : "\n"))
    .replace(/\\u(-?\d+)\??/g, (_match, code: string) => String.fromCharCode((Number(code) + 65536) % 65536))
    .replace(/\\'([0-9a-fA-F]{2})/g, (_match, hex: string) => cp1252.decode(new Uint8Array([parseInt(hex, 16)])))
    .replace(/\\[a-zA-Z]+-?\d* ?/g, "")
    .replace(/\\([{}\\])/g, "$1")
    .replace(/[{}]/g, "");
}

/// UTF-8 when the bytes are valid UTF-8, Windows-1252 otherwise — old
/// French documents are routinely saved in the latter.
function decodeText(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#x")) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return ENTITIES[body] ?? match;
  });
}

function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
