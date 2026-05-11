// `read` task — Linux in-process implementation.
//
// Counterpart to twoody-mac's DocumentExtractor. PDF goes through
// `pdftotext` (poppler-utils); text-y files are read directly with a
// 10 MB ceiling matching the Mac side. Binary formats return an empty
// content with truncated=false so the LLM gets a clean signal that the
// file exists but isn't extractable.

import { spawn } from "node:child_process";
import { readFile, stat as fsStat } from "node:fs/promises";
import { extname } from "node:path";
import { lookupPath } from "./idCache.js";

const FILE_SIZE_CAP = 10 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 60_000;

const TEXT_EXTS = new Set([
  ".txt",
  ".md",
  ".rtf",
  ".html",
  ".htm",
  ".json",
  ".csv",
  ".yml",
  ".yaml",
  ".log",
  ".xml",
  ".srt",
  ".vtt",
  ".tsv",
]);

function pdfToText(path: string, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("pdftotext", ["-layout", "-nopgbrk", path, "-"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

export async function runRead(args: Record<string, unknown>) {
  const documentId = String(args.document_id ?? "");
  if (!documentId) throw new Error("document_id is required");

  const path = lookupPath(documentId);
  if (!path) throw new Error("document_not_found");

  const stat = await fsStat(path);
  if (stat.size > FILE_SIZE_CAP) {
    throw new Error(`file_too_large size=${stat.size} cap=${FILE_SIZE_CAP}`);
  }

  const maxChars = Math.min(
    Math.max(Number(args.max_chars ?? DEFAULT_MAX_CHARS), 1),
    500_000,
  );

  const ext = extname(path).toLowerCase();
  let content = "";

  if (ext === ".pdf") {
    content = await pdfToText(path);
  } else if (TEXT_EXTS.has(ext) || ext === "") {
    const buffer = await readFile(path);
    content = buffer.toString("utf8");
  } else {
    return { content: "", truncated: false };
  }

  const truncated = content.length > maxChars;
  if (truncated) content = content.slice(0, maxChars);

  return { content, truncated };
}
