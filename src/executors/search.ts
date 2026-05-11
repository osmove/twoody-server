// `search` task — Linux in-process implementation.
//
// Counterpart to twoody-mac's SpotlightSearch + FileManagerSearch. We
// don't have Spotlight on Linux, so we combine:
//   1. Filename match via `find` (case-insensitive)
//   2. Content match via `ripgrep` (text-y files only)
//
// Both run against every granted folder, results are merged, deduped,
// and capped at `limit` (default 25). Filename hits rank higher than
// pure content hits because the LLM's queries are usually concept names.

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import { grantedFolders } from "./folders.js";
import { rememberPath } from "./idCache.js";

const MIME_BY_EXT: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".rtf": "application/rtf",
  ".pdf": "application/pdf",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".csv": "text/csv",
  ".yml": "text/yaml",
  ".yaml": "text/yaml",
  ".log": "text/plain",
};

function mimeFor(path: string): string {
  const ext = extname(path).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

interface RawHit {
  absolute: string;
  filenameHit: boolean;
  contentHit: boolean;
}

function execCapture(cmd: string, args: string[], timeoutMs = 5_000): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
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

async function findByName(query: string, root: string, limit: number): Promise<string[]> {
  // Case-insensitive substring match on filename. Skip dotfiles and
  // node_modules to keep huge dev trees out of the result set.
  const out = await execCapture("find", [
    root,
    "-type",
    "f",
    "-not",
    "-path",
    "*/.*",
    "-not",
    "-path",
    "*/node_modules/*",
    "-iname",
    `*${query}*`,
  ]);
  return out
    .split("\n")
    .filter(Boolean)
    .slice(0, limit);
}

async function findByContent(query: string, root: string, limit: number): Promise<string[]> {
  const out = await execCapture("rg", [
    "--files-with-matches",
    "--ignore-case",
    "--max-count",
    "1",
    "--max-filesize",
    "5M",
    "--hidden",
    "--glob",
    "!.git",
    "--glob",
    "!node_modules",
    query,
    root,
  ]);
  return out
    .split("\n")
    .filter(Boolean)
    .slice(0, limit);
}

export async function runSearch(args: Record<string, unknown>) {
  const query = String(args.query ?? "").trim();
  const limit = Math.min(Math.max(Number(args.limit ?? 25), 1), 100);
  if (!query) return { items: [] };

  const folders = grantedFolders();
  if (folders.length === 0) return { items: [] };

  const hits = new Map<string, RawHit>();
  for (const folder of folders) {
    const perFolder = Math.ceil(limit / folders.length) + 5;
    const nameHits = await findByName(query, folder.path, perFolder);
    const contentHits = await findByContent(query, folder.path, perFolder);

    for (const abs of nameHits) {
      const existing = hits.get(abs);
      if (existing) existing.filenameHit = true;
      else hits.set(abs, { absolute: abs, filenameHit: true, contentHit: false });
    }
    for (const abs of contentHits) {
      const existing = hits.get(abs);
      if (existing) existing.contentHit = true;
      else hits.set(abs, { absolute: abs, filenameHit: false, contentHit: true });
    }
  }

  const ranked = [...hits.values()]
    .sort((a, b) => {
      const score = (h: RawHit) => (h.filenameHit ? 2 : 0) + (h.contentHit ? 1 : 0);
      return score(b) - score(a);
    })
    .slice(0, limit);

  const items = ranked.map((hit) => {
    let size = 0;
    let modifiedAt: string | null = null;
    try {
      const stat = statSync(hit.absolute);
      size = stat.size;
      modifiedAt = stat.mtime.toISOString();
    } catch {
      // best-effort: file may have been deleted between find and stat
    }
    return {
      id: rememberPath(hit.absolute),
      name: basename(hit.absolute),
      mime: mimeFor(hit.absolute),
      size,
      modified_at: modifiedAt,
      parent: basename(dirname(hit.absolute)) || "/",
      is_remote: false,
    };
  });

  return { items };
}
