import { statSync } from "node:fs";
import { basename, isAbsolute, relative, sep } from "node:path";
import { sqlite } from "../db.js";
import { isSupported, maxBytesFor } from "./extract.js";
import { safeRoots, type GrantedRoot } from "./fileListing.js";
import { indexOnDemand } from "./library.js";
import { spotlightEnabled, spotlightSearch } from "./spotlight.js";
import { skipDirectory, skipFile } from "./walk.js";

// Spotlight as one more source of candidates for a question (retrieval.ts):
// the files whose text or name the Mac's own index matches, inside the
// granted folders only. A candidate already in Twoody's index is pointed
// out to the search; one it has not read yet (the indexer has not reached
// it, or it changed since) is read now — the same extraction, kept in the
// index as the indexer would keep it — so that its passages and pages can
// be cited like any other. Reading waits 1.5 s at most; what is not read by
// then goes on in the background and is there for the next question.

const MAX_CANDIDATES = 8;
const MAX_READ_NOW = 4;
const READ_WAIT_MS = 1_500;

export interface SpotlightCandidates {
  /// Indexed documents Spotlight matched, best first.
  documentIds: string[];
  /// Files Spotlight matched inside the grants.
  found: number;
  /// Of those, read into the index for this question.
  readNow: number;
}

/// The granted folder a file is read under, as the indexer would: the
/// deepest one holding it along the walk (no hidden or skipped folder).
function owner(path: string, roots: GrantedRoot[]): GrantedRoot | null {
  const holders = roots
    .filter((root) => {
      const rel = relative(root.path, path);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
      const segments = rel.split(sep);
      segments.pop();
      return segments.every((segment) => !skipDirectory(segment));
    })
    .sort((a, b) => b.path.length - a.path.length);
  return holders[0] ?? null;
}

export async function spotlightCandidates(userId: string, terms: string[], folders: GrantedRoot[], timeoutMs = 1_500): Promise<SpotlightCandidates | null> {
  if (!spotlightEnabled()) return null;
  const roots = safeRoots(folders);
  if (!roots.length || !terms.length) return null;
  const started = Date.now();
  const found = await spotlightSearch(roots.map((root) => root.path), terms, timeoutMs);
  if (!found) return null;
  const candidates = found
    .map((path) => ({ path, root: owner(path, roots) }))
    .filter((c): c is { path: string; root: GrantedRoot } => !!c.root && !skipFile(basename(c.path)) && isSupported(c.path))
    .slice(0, MAX_CANDIDATES);
  if (!candidates.length) return { documentIds: [], found: 0, readNow: 0 };

  const known = (paths: string[]) =>
    sqlite
      .prepare(`SELECT id, path, folder_id, status, size, mtime_ms FROM documents WHERE user_id = ? AND path IN (${paths.map(() => "?").join(",")})`)
      .all(userId, ...paths) as Array<{ id: string; path: string; folder_id: string; status: string; size: number; mtime_ms: number }>;
  const before = new Map(known(candidates.map((c) => c.path)).map((row) => [row.path, row]));
  const toRead = candidates.filter((c) => {
    const row = before.get(c.path);
    try {
      const info = statSync(c.path);
      if (!info.isFile() || info.size > maxBytesFor(c.path)) return false;
      return !row || row.folder_id !== c.root.id || row.size !== info.size || row.mtime_ms !== Math.floor(info.mtimeMs);
    } catch {
      return false;
    }
  }).slice(0, MAX_READ_NOW);
  if (toRead.length) {
    const reading = Promise.allSettled(toRead.map((c) => indexOnDemand(userId, c.root.id, c.path)));
    const wait = Math.max(0, Math.min(READ_WAIT_MS, timeoutMs * 2 - (Date.now() - started)));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([reading, new Promise((resolve) => { timer = setTimeout(resolve, wait); })]);
    clearTimeout(timer);
  }
  const after = new Map(known(candidates.map((c) => c.path)).map((row) => [row.path, row]));
  const allowed = new Set(roots.map((root) => root.id));
  return {
    documentIds: candidates.flatMap((c) => {
      const row = after.get(c.path);
      return row && row.status === "indexed" && allowed.has(row.folder_id) ? [row.id] : [];
    }),
    found: candidates.length,
    readNow: toRead.filter((c) => after.get(c.path)?.status === "indexed").length,
  };
}
