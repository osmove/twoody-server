// `ocr_image` bridge task — Linux in-process implementation.
//
// Counterpart to twoody-mac's `OcrEngine.swift` (Vision framework).
// Args: { document_id, language? } — same opaque id as `read`,
// returns { text, truncated? }.
//
// Uses `tesseract` from the Tesseract OCR project. Install on Linux, with
// the app's ten languages (10/10/2026: French and English only before):
//   sudo apt install tesseract-ocr tesseract-ocr-eng tesseract-ocr-fra \
//     tesseract-ocr-deu tesseract-ocr-spa tesseract-ocr-ita tesseract-ocr-por \
//     tesseract-ocr-nld tesseract-ocr-jpn tesseract-ocr-chi-sim \
//     tesseract-ocr-chi-tra tesseract-ocr-kor
//
// Configurable via:
//   TESSERACT_BIN=/usr/bin/tesseract   (default)
//   TESSERACT_LANG=fra+eng             (passed when args.language is unset;
//                                       default: those of the ten installed)
// Tesseract refuses a language whose data is not installed, so the default
// is the app's languages it lists (`--list-langs`), English and French
// first; fra+eng when it cannot say.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { lookupPath } from "./idCache.js";

const DEFAULT_BIN = "/usr/bin/tesseract";
const DEFAULT_LANG = "fra+eng";
/// The app's ten languages as Tesseract names them (Chinese both ways).
export const TESSERACT_LANGUAGES = ["eng", "fra", "deu", "spa", "ita", "por", "nld", "jpn", "chi_sim", "chi_tra", "kor"];
const MAX_OUTPUT_CHARS = 100_000;

const IMAGE_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".gif", ".webp", ".heic",
]);

function tesseractBin(): string {
  return process.env.TESSERACT_BIN?.trim() || DEFAULT_BIN;
}

export function tesseractReady(): boolean {
  return existsSync(tesseractBin());
}

function runTesseract(image: string, outBase: string, lang: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(tesseractBin(), [image, outBase, "-l", lang, "--psm", "3", "txt"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tesseract exit=${code}: ${stderr.slice(-400)}`));
    });
  });
}

let installed: Promise<string> | null = null;

/// The app's languages this Tesseract has, joined as `-l` wants them.
export function languagesFrom(listing: string | null): string {
  const have = new Set((listing ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const usable = TESSERACT_LANGUAGES.filter((lang) => have.has(lang));
  return usable.length ? usable.join("+") : DEFAULT_LANG;
}

function installedLanguages(): Promise<string> {
  installed ??= new Promise((resolve) => {
    const proc = spawn(tesseractBin(), ["--list-langs"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    proc.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    proc.on("error", () => resolve(DEFAULT_LANG));
    proc.on("close", (code) => resolve(code === 0 ? languagesFrom(out) : DEFAULT_LANG));
  });
  return installed;
}

export async function runOcr(args: Record<string, unknown>) {
  if (!tesseractReady()) throw new Error("tesseract_not_configured");

  const documentId = String(args.document_id ?? "");
  if (!documentId) throw new Error("document_id is required");
  const path = lookupPath(documentId);
  if (!path) throw new Error("document_not_found");

  const ext = extname(path).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) {
    throw new Error(`unsupported_image_format ext=${ext || "<none>"}`);
  }

  const lang = typeof args.language === "string" && args.language.trim().length > 0
    ? args.language.trim()
    : (process.env.TESSERACT_LANG?.trim() || await installedLanguages());

  const dir = await mkdtemp(join(tmpdir(), "twoody-ocr-"));
  const outBase = join(dir, "out");
  try {
    await runTesseract(path, outBase, lang);
    let text = (await readFile(`${outBase}.txt`, "utf8")).trim();
    const truncated = text.length > MAX_OUTPUT_CHARS;
    if (truncated) text = text.slice(0, MAX_OUTPUT_CHARS);
    return { text, truncated };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
