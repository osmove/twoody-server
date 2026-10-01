import { realpathSync } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { sqlite } from "../db.js";
import { serveRawFile } from "../peerDocuments/raw.js";
import { fileKind, type GrantedRoot } from "./fileListing.js";
import { plain } from "./folderAliases.js";
import { folderRisk } from "./folderRisk.js";
import { skipDirectory, skipFile } from "./walk.js";

// A file browser over the person's granted folders (docs/mesh-design.md
// §2b): what a folder holds as the file system has it — sub-folders and
// every regular file, indexed or not — page by page, sorted by name, date
// or size, with a search by name inside the folder shown.
//
//   GET …/browse?root=<granted folder id>&path=<path inside it>&sort=&order=&offset=&limit=&q=
//     → {root{id,name}, path, breadcrumbs[{name,path}], entries[{name, path, kind dir|file,
//        size, modified, type, indexed, document_id?}], total, offset, next_offset, sort, order, limited}
//   GET …/browse/raw?root=&path=   the file itself (peerDocuments/raw.ts: Range, caps, nosniff)
//
// Strictly inside the granted folders, as their grant reaches them: the
// path is relative to a granted folder (no absolute path in, none out), no
// segment is hidden or one the indexer's walk never enters (walk.ts:
// ~/Library, application bundles, node_modules…), no symbolic link on the
// way (the real path must be the path asked), folderRisk applied to what
// is listed, and a symbolic link inside a folder is never listed. The same
// function serves this computer's owner and person sessions
// (/local_documents/browse) and a trusted computer of the mesh
// (/peer/documents/browse); which granted folders a caller may name is the
// route's business.

export type BrowseSort = "name" | "date" | "size";
export type BrowseOrder = "asc" | "desc";

export interface BrowseRequest {
  root: string;
  path: string;
  sort: BrowseSort;
  order: BrowseOrder;
  offset: number;
  limit: number;
  /// A name to look for inside the folder and its sub-folders.
  q: string | null;
}

export interface BrowseEntry {
  name: string;
  /// From the granted folder, with forward slashes: what the next request names.
  path: string;
  kind: "dir" | "file";
  /// Bytes; null for a folder.
  size: number | null;
  modified: string;
  /// « folder », or the kind fileListing.ts gives (pdf, image, screenshot, document…).
  type: string;
  /// Read by the index (its text can be searched and cited).
  indexed: boolean;
  /// Known to the index (readable through …/files/:id), indexed or not.
  document_id?: string;
}

export interface BrowseResult {
  root: { id: string; name: string };
  path: string;
  breadcrumbs: Array<{ name: string; path: string }>;
  entries: BrowseEntry[];
  total: number;
  offset: number;
  next_offset: number | null;
  sort: BrowseSort;
  order: BrowseOrder;
  query?: string;
  /// The folder (or the search) had more entries than are looked at.
  limited: boolean;
}

export type BrowseFailure = { error: "not_found" | "invalid_path" };

export const BROWSE_PAGE = 100;
export const BROWSE_MAX_PAGE = 200;
/// Entries of one folder looked at.
export const MAX_FOLDER_ENTRIES = 5_000;
/// Entries a search looks at, and matches it keeps.
const MAX_SEARCH_SCAN = 20_000;
const MAX_SEARCH_MATCHES = 500;
const MAX_DEPTH = 12;
const ROOT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SORTS: readonly BrowseSort[] = ["name", "date", "size"];

/// The query of a browse request, checked; null when it is not one.
export function readBrowseRequest(query: Record<string, unknown> | null | undefined): BrowseRequest | null {
  const q = query ?? {};
  const one = (value: unknown) => (Array.isArray(value) ? value[0] : value);
  const root = one(q.root);
  if (typeof root !== "string" || !ROOT_ID.test(root)) return null;
  const path = one(q.path) ?? "";
  if (typeof path !== "string" || path.length > 4096) return null;
  const sort = one(q.sort) ?? "name";
  const order = one(q.order) ?? (sort === "name" ? "asc" : "desc");
  if (!SORTS.includes(sort as BrowseSort) || (order !== "asc" && order !== "desc")) return null;
  const int = (value: unknown, fallback: number) => {
    const v = one(value);
    if (v === undefined || v === "") return fallback;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isInteger(n) ? n : NaN;
  };
  const offset = int(q.offset, 0);
  const limit = int(q.limit, BROWSE_PAGE);
  if (!(offset >= 0 && offset <= 1_000_000) || !(limit >= 1 && limit <= BROWSE_MAX_PAGE)) return null;
  const search = one(q.q);
  if (search !== undefined && (typeof search !== "string" || search.length > 200)) return null;
  const text = typeof search === "string" ? search.replace(/[\u0000-\u001f]/g, "").trim() : "";
  return { root, path, sort: sort as BrowseSort, order, offset, limit, q: text || null };
}

/// The segments of a path inside a granted folder, or null when it is not
/// one the browser goes to: absolute, with a drive or a backslash, « . » or
/// « .. », empty segments, control characters, a hidden name, or a folder
/// the indexer's walk never enters. `file`: the last segment is a file's.
export function browsePath(path: string, file = false): string[] | null {
  if (path === "") return file ? null : [];
  if (path.length > 4096 || path.includes("\\") || path.startsWith("/") || /^[a-z]:/i.test(path) || /[\u0000-\u001f]/.test(path)) return null;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.startsWith("."))) return null;
  const folders = file ? segments.slice(0, -1) : segments;
  if (folders.some((segment) => skipDirectory(segment))) return null;
  if (file && skipFile(segments[segments.length - 1]!)) return null;
  return segments;
}

function realHome(): string {
  try {
    return realpathSync(homedir());
  } catch {
    return homedir();
  }
}

const same = (a: string, b: string) => (process.platform === "darwin" || process.platform === "win32" ? a.normalize("NFC").toLowerCase() === b.normalize("NFC").toLowerCase() : a === b);

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/// Where `segments` lead inside `root`, if they lead there without a
/// symbolic link and to a place folderRisk lets through; null otherwise.
async function resolveInside(root: GrantedRoot, segments: string[]): Promise<{ real: string; realRoot: string } | null> {
  let realRoot: string;
  try {
    realRoot = await realpath(root.path);
  } catch {
    return null;
  }
  // The granted folder itself swapped for a link since it was granted: not it.
  if (!same(realRoot, root.path)) return null;
  const home = realHome();
  if (folderRisk(realRoot, home, process.platform, realRoot === home) !== null) return null;
  if (!segments.length) return { real: realRoot, realRoot };
  const asked = join(realRoot, ...segments);
  let real: string;
  try {
    real = await realpath(asked);
  } catch {
    return null;
  }
  // A link anywhere on the way makes the real path another one.
  if (!same(real, asked) || !inside(realRoot, real)) return null;
  if (folderRisk(real, home, process.platform) === "sensitive") return null;
  return { real, realRoot };
}

type Found = { name: string; abs: string; rel: string; kind: "dir" | "file"; size: number | null; mtime: number };

const relOf = (realRoot: string, abs: string) => relative(realRoot, abs).split(/[\\/]/).join("/");

/// One folder's entries the browser shows (no link, nothing hidden or skipped).
async function folderEntries(dir: string, realRoot: string, cap: number): Promise<{ found: Found[]; limited: boolean }> {
  const dirents = await readdir(dir, { withFileTypes: true });
  const kept = [];
  for (const entry of dirents) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() ? skipDirectory(entry.name) : !entry.isFile() || skipFile(entry.name)) continue;
    kept.push(entry);
    if (kept.length >= cap) break;
  }
  const found: Found[] = [];
  for (let i = 0; i < kept.length; i += 256) {
    await Promise.all(
      kept.slice(i, i + 256).map(async (entry) => {
        const abs = join(dir, entry.name);
        try {
          const stat = await lstat(abs);
          if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) return;
          found.push({ name: entry.name, abs, rel: relOf(realRoot, abs), kind: stat.isDirectory() ? "dir" : "file", size: stat.isDirectory() ? null : stat.size, mtime: stat.mtimeMs });
        } catch {
          // gone meanwhile
        }
      }),
    );
  }
  return { found, limited: kept.length >= cap && dirents.length > cap };
}

/// Entries under `dir` whose name holds `q` (accents and case aside).
async function searchEntries(dir: string, realRoot: string, q: string): Promise<{ found: Found[]; limited: boolean }> {
  const wanted = plain(q);
  const found: Found[] = [];
  const pending: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }];
  let scanned = 0;
  let limited = false;
  while (pending.length) {
    if (scanned >= MAX_SEARCH_SCAN || found.length >= MAX_SEARCH_MATCHES) {
      limited = true;
      break;
    }
    const next = pending.shift()!;
    let listed;
    try {
      listed = await folderEntries(next.dir, realRoot, MAX_FOLDER_ENTRIES);
    } catch {
      continue;
    }
    scanned += listed.found.length;
    if (listed.limited) limited = true;
    for (const entry of listed.found) {
      if (plain(entry.name).includes(wanted) && found.length < MAX_SEARCH_MATCHES) found.push(entry);
      if (entry.kind === "dir" && next.depth < MAX_DEPTH) pending.push({ dir: entry.abs, depth: next.depth + 1 });
    }
  }
  return { found, limited };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function sortEntries<T extends { name: string; kind: "dir" | "file"; size: number | null; mtime: number }>(entries: T[], sort: BrowseSort, order: BrowseOrder): T[] {
  const sign = order === "asc" ? 1 : -1;
  const by = (a: T, b: T) => {
    if (sort === "date") return a.mtime - b.mtime;
    if (sort === "size") return (a.size ?? 0) - (b.size ?? 0);
    return 0;
  };
  // Folders first, whatever the order.
  return [...entries].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "dir" ? -1 : 1) || sign * (by(a, b) || collator.compare(a.name, b.name)) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/// The index's documents among these files (any granted folder of the caller holds them).
function indexedAt(userId: string, folderIds: string[], paths: string[]): Map<string, { id: string; status: string }> {
  const out = new Map<string, { id: string; status: string }>();
  if (!folderIds.length) return out;
  const scope = folderIds.map(() => "?").join(",");
  for (let i = 0; i < paths.length; i += 400) {
    const batch = paths.slice(i, i + 400);
    const rows = sqlite
      .prepare(`SELECT id, path, status FROM documents WHERE user_id = ? AND folder_id IN (${scope}) AND path IN (${batch.map(() => "?").join(",")})`)
      .all(userId, ...folderIds, ...batch) as Array<{ id: string; path: string; status: string }>;
    for (const row of rows) out.set(row.path, { id: row.id, status: row.status });
  }
  return out;
}

/**
 * One page of a folder inside a granted folder. `roots`: the granted
 * folders this caller may browse here (already scoped and checked by
 * folderRisk, retrieval.ts scopedFolders).
 */
export async function browseGranted(userId: string, roots: GrantedRoot[], request: BrowseRequest): Promise<BrowseResult | BrowseFailure> {
  const root = roots.find((r) => r.id === request.root);
  if (!root) return { error: "not_found" };
  const segments = browsePath(request.path);
  if (!segments) return { error: "invalid_path" };
  const place = await resolveInside(root, segments);
  if (!place) return { error: "not_found" };
  let listed: { found: Found[]; limited: boolean };
  try {
    const stat = await lstat(place.real);
    if (!stat.isDirectory()) return { error: "not_found" };
    listed = request.q ? await searchEntries(place.real, place.realRoot, request.q) : await folderEntries(place.real, place.realRoot, MAX_FOLDER_ENTRIES);
  } catch {
    return { error: "not_found" };
  }
  const sorted = sortEntries(listed.found, request.sort, request.order);
  const page = sorted.slice(request.offset, request.offset + request.limit);
  const known = indexedAt(userId, roots.map((r) => r.id), page.filter((e) => e.kind === "file").map((e) => e.abs));
  const path = segments.join("/");
  return {
    root: { id: root.id, name: root.name },
    path,
    breadcrumbs: [{ name: root.name, path: "" }, ...segments.map((name, i) => ({ name, path: segments.slice(0, i + 1).join("/") }))],
    entries: page.map((entry) => {
      const doc = entry.kind === "file" ? known.get(entry.abs) : undefined;
      return {
        name: entry.name,
        path: entry.rel,
        kind: entry.kind,
        size: entry.size,
        modified: new Date(entry.mtime).toISOString(),
        type: entry.kind === "dir" ? "folder" : fileKind(entry.name),
        indexed: doc?.status === "indexed",
        ...(doc ? { document_id: doc.id } : {}),
      };
    }),
    total: sorted.length,
    offset: request.offset,
    next_offset: request.offset + request.limit < sorted.length ? request.offset + request.limit : null,
    sort: request.sort,
    order: request.order,
    ...(request.q ? { query: request.q } : {}),
    limited: listed.limited,
  };
}

/// The file `root`/`path` names, if a browse would list it.
export async function browsedFile(roots: GrantedRoot[], rootId: unknown, path: unknown): Promise<{ abs: string; realRoot: string; name: string } | null> {
  if (typeof rootId !== "string" || !ROOT_ID.test(rootId) || typeof path !== "string") return null;
  const root = roots.find((r) => r.id === rootId);
  const segments = browsePath(path, true);
  if (!root || !segments) return null;
  const place = await resolveInside(root, segments);
  if (!place) return null;
  return { abs: place.real, realRoot: place.realRoot, name: segments[segments.length - 1]! };
}

/**
 * GET …/browse/raw: the file itself, indexed or not, with the raw route's
 * Range, caps and headers (peerDocuments/raw.ts); 404 for anything a
 * browse would not list. Returns what was sent, for an audit.
 */
export async function serveBrowsedFile(
  req: FastifyRequest,
  reply: FastifyReply,
  args: { userId: string; roots: GrantedRoot[]; root: unknown; path: unknown },
): Promise<{ name: string; documentId: string | null; bytes: number } | null> {
  const file = await browsedFile(args.roots, args.root, args.path);
  if (!file) {
    reply.code(404).send({ error: "not_found" });
    return null;
  }
  const sent = await serveRawFile(req, reply, { path: file.abs, folderPath: file.realRoot, name: file.name, ext: extname(file.name) });
  if (!sent) return null;
  const doc = indexedAt(args.userId, args.roots.map((r) => r.id), [file.abs]).get(file.abs);
  return { name: file.name, documentId: doc?.id ?? null, bytes: sent.bytes };
}
