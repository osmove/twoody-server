import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";

// Scanned pages, read on this computer. TWOODY_OCR_BIN names the helper the
// Desktop ships — twoody-ocr: on a Mac, Apple's Vision framework; on
// Windows (27/10/2026), the character recognition built into Windows, with
// the languages installed on the PC; no network either way — and the
// extractor asks it only for the pages of a PDF that carry no text of their
// own. Without it (Linux, the server run on its own) a scan stays unread.
//
// The helper answers {"engine":"vision"|"windows","pages":[{"page":1,"text":"…"}]}.
//
// Languages (10/10/2026: a Japanese scan came out as garbage — the helper
// was asked for French and English only): the helper's own choice by
// default, Vision detecting the language among the app's ten with the
// person's first (TWOODY_OCR_PREFER, which the Desktop sets to the app's
// language); TWOODY_OCR_LANGUAGES, a list (« fr-FR,en-US »), reads with
// that list alone.

/// A whole scanned book is not read in one sitting: past this many pages
/// the rest stays unread, and the document says so through its gaps.
export const MAX_OCR_PAGES = 300;
/// About a second a page on Apple silicon; generous for older Macs.
const TIMEOUT_MS = 15 * 60 * 1000;

/// What the helper is told about languages: nothing (it detects them), the
/// person's language to try first, or the list it must read with.
export function ocrLanguageArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const languages = env.TWOODY_OCR_LANGUAGES?.trim();
  const prefer = env.TWOODY_OCR_PREFER?.trim();
  return [...(languages ? ["--languages", languages] : []), ...(prefer && /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/.test(prefer) ? ["--prefer", prefer] : [])];
}

export function ocrAvailable(): boolean {
  return Boolean(process.env.TWOODY_OCR_BIN);
}

/// The text of the given pages (1-based), read by OCR; null when there is
/// no helper, or it failed — the caller then keeps what it had.
export async function ocrPages(path: string, pages: number[]): Promise<Map<number, string> | null> {
  const bin = process.env.TWOODY_OCR_BIN;
  if (!bin || pages.length === 0) return null;
  try {
    await access(bin, constants.X_OK);
  } catch {
    return null;
  }
  const wanted = pages.slice(0, MAX_OCR_PAGES);
  const args = [path, "--pages", wanted.join(","), ...ocrLanguageArgs()];
  const stdout = await new Promise<string | null>((resolve) => {
    execFile(bin, args, { timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (error, out, err) => {
      if (error) {
        console.warn(`[ocr] ${path}: ${error.message.split("\n")[0]} ${String(err).trim().split("\n").pop() ?? ""}`);
        resolve(null);
      } else {
        resolve(out);
      }
    });
  });
  if (stdout === null) return null;
  try {
    const parsed = JSON.parse(stdout) as { pages?: Array<{ page?: unknown; text?: unknown }> };
    const read = new Map<number, string>();
    for (const entry of parsed.pages ?? []) {
      if (typeof entry.page === "number" && typeof entry.text === "string") read.set(entry.page, entry.text);
    }
    return read;
  } catch {
    console.warn(`[ocr] ${path}: the helper's answer is not JSON`);
    return null;
  }
}
