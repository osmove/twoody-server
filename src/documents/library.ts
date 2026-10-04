import {indexedDirectory, type IndexedEntry} from "./tree.js";
import { indexSemantic } from "./semantic.js";
import { and, eq } from "drizzle-orm";
import { realpathSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative } from "node:path";
import { generateId } from "../auth.js";
import { db, documentFolders, documents, sqlite } from "../db.js";
import { chunkSections } from "./chunk.js";
import { extractSections, MAX_FILE_BYTES } from "./extract.js";
import { folderRisk } from "./folderRisk.js";
import { capabilityOn, setLocalCapability } from "../localCapabilities.js";
import { folderReadable, walk } from "./walk.js";
import { buildMatchQuery, metadataScore, queryTerms, selectPassages } from "./query.js";

// The user's document library: the folders they granted, the index
// built from them, and the search that feeds /queries.
//
// Everything stays in the server's own SQLite file. Indexing is
// incremental (a file is re-read only when its size or modification time
// changed) and runs one file at a time, yielding to the event loop
// between files so chat stays responsive while a large folder is read.

// ─── Folders ────────────────────────────────────────────────────────────────

export class FolderRejected extends Error {
  constructor(public readonly reason: "not_found" | "not_a_directory" | "too_broad" | "sensitive" | "already_added" | "not_permitted") {
    super(reason);
  }
}

/// Validates a folder the user picked and returns its canonical path.
/// Refuses what should never be indexed wholesale (folderRisk.ts): a
/// disk, a whole home directory or what holds it, system directories,
/// and anything hidden or under ~/Library or AppData.
export function canonicalFolder(input: string, personalRoot = false): string {
  let real: string;
  try {
    real = realpathSync(input);
  } catch {
    throw new FolderRejected("not_found");
  }
  if (!statSync(real).isDirectory()) throw new FolderRejected("not_a_directory");

  const risk = folderRisk(real, realpathSync(homedir()), process.platform, personalRoot);
  if (risk) throw new FolderRejected(risk);
  return real;
}

/// A granted folder as the person knows it: iCloud Drive rather than its
/// directory's name (com~apple~CloudDocs).
export function folderName(path: string): string {
  if (/[\\/]Library[\\/]Mobile Documents[\\/]com~apple~CloudDocs$/.test(path)) return "iCloud Drive";
  // ~/Library/CloudStorage/GoogleDrive-claire@example.com → « Google Drive (claire@example.com) »
  const cloud = /[\\/]Library[\\/]CloudStorage[\\/](GoogleDrive|Dropbox|OneDrive|Box)(?:-(.+))?$/.exec(path);
  if (cloud) {
    const name = { GoogleDrive: "Google Drive", Dropbox: "Dropbox", OneDrive: "OneDrive", Box: "Box" }[cloud[1] as "GoogleDrive" | "Dropbox" | "OneDrive" | "Box"];
    return cloud[2] && cloud[2] !== "Box" ? `${name} (${cloud[2]})` : name;
  }
  return basename(path);
}

/// Files of each folder the last pass could not read (walk.ts `ignored`).
const ignoredByFolder = new Map<string, number>();

export function listFolders(userId: string) {
  const counts = sqlite
    .prepare(
      `SELECT folder_id AS folderId,
              COUNT(*) AS total,
              SUM(status = 'indexed') AS indexed,
              SUM(status = 'empty') AS empty,
              SUM(status = 'error') AS failed
         FROM documents WHERE user_id = ? GROUP BY folder_id`,
    )
    .all(userId) as Array<{ folderId: string; total: number; indexed: number; empty: number; failed: number }>;
  const byFolder = new Map(counts.map((row) => [row.folderId, row]));

  const rows = db
    .select()
    .from(documentFolders)
    .where(eq(documentFolders.userId, userId))
    .all()
    .sort((a, b) => a.path.localeCompare(b.path));
  const dossierOf = folderDossiers(rows);
  return rows.map((folder) => {
    const count = byFolder.get(folder.id);
    return {
      id: folder.id,
      path: folder.path,
      name: folderName(folder.path),
      documents: count?.total ?? 0,
      indexed: count?.indexed ?? 0,
      without_text: count?.empty ?? 0,
      failed: count?.failed ?? 0,
      ignored: ignoredByFolder.get(folder.id) ?? 0,
      // The client file it belongs to (src/dossiers/): searched in that
      // file's conversations only, never elsewhere.
      dossier_id: dossierOf.get(folder.id) ?? null,
    };
  });
}

/// The client file each granted folder belongs to: its own, else that of a
/// client file's folder holding it — a folder granted inside a file's folder
/// is that file's too, whatever was granted first.
export function folderDossiers(rows: ReadonlyArray<{ id: string; path: string; dossierId: string | null }>): Map<string, string | null> {
  const filed = rows.filter((row) => row.dossierId).sort((a, b) => b.path.length - a.path.length);
  return new Map(rows.map((row) => [row.id, row.dossierId ?? filed.find((folder) => within(folder.path, row.path))?.dossierId ?? null]));
}

/// Grants a folder. Its first entry is read before it is kept, so that
/// macOS asks the person now (Desktop, Documents, Downloads, iCloud
/// Drive) rather than in the middle of an index pass, and a refusal is
/// said at once ("not_permitted") instead of leaving an empty folder.
export async function addFolder(userId: string, input: string, personalRoot = false) {
  const path = canonicalFolder(input, personalRoot);
  if (!(await folderReadable(path))) throw new FolderRejected("not_permitted");
  const existing = db
    .select()
    .from(documentFolders)
    .where(and(eq(documentFolders.userId, userId), eq(documentFolders.path, path)))
    .all();
  if (existing.length > 0) throw new FolderRejected("already_added");

  const id = generateId();
  db.insert(documentFolders).values({ id, userId, path, createdAt: new Date() }).run();
  // Granting a folder is asking for Documents — the way to switch it on
  // for a computer without a screen (a Pi), where Capacités is not shown.
  setLocalCapability(userId, "documents", true);
  return { id, path };
}

export function removeFolder(userId: string, folderId: string): boolean {
  const [folder] = db
    .select()
    .from(documentFolders)
    .where(and(eq(documentFolders.id, folderId), eq(documentFolders.userId, userId)))
    .all();
  if (!folder) return false;

  sqlite.transaction(() => {
    sqlite
      .prepare("DELETE FROM document_chunks WHERE document_id IN (SELECT id FROM documents WHERE folder_id = ?)")
      .run(folderId);
    sqlite.prepare("DELETE FROM documents WHERE folder_id = ?").run(folderId);
    sqlite.prepare("DELETE FROM document_folders WHERE id = ?").run(folderId);
  })();
  return true;
}

// ─── Indexing ───────────────────────────────────────────────────────────────

export interface IndexStatus {
  running: boolean;
  total: number;
  done: number;
  current: string | null;
  started_at: string | null;
  finished_at: string | null;
  limited?: boolean;
  /// Folders the system would not let Twoody read (see walk.ts).
  denied?: string[];
}

const jobs = new Map<string, IndexStatus>();
/// Asked again while a pass ran (a folder granted, a client file's folder
/// set, src/dossiers/): another pass follows it, which knows the new folder.
const askedAgain = new Set<string>();

export function indexStatus(userId: string): IndexStatus {
  return jobs.get(userId) ?? { running: false, total: 0, done: 0, current: null, started_at: null, finished_at: null };
}

/// Brings the index in line with the user's folders. Resolves once the
/// pass is over; callers that only want to start it do not await it.
export async function reindex(userId: string): Promise<IndexStatus> {
  const current = jobs.get(userId);
  if (current?.running) {
    askedAgain.add(userId);
    return current;
  }
  // Documents switched off in Capabilities: nothing is read.
  if (!capabilityOn(userId, "documents")) return indexStatus(userId);

  const status: IndexStatus = {
    running: true,
    total: 0,
    done: 0,
    current: null,
    started_at: new Date().toISOString(),
    finished_at: null,
  };
  jobs.set(userId, status);

  try {
    const folders = db.select().from(documentFolders).where(eq(documentFolders.userId, userId)).all().sort((a,b)=>b.path.length-a.path.length);
    const work: Array<{ folderId: string; path: string }> = [];
    const seen = new Set<string>();

    for (const folder of folders) {
      // Granted subfolders are walked for themselves (longest path first);
      // the files this one indexed already, and when it was last read,
      // decide what a full folder keeps (walk.ts).
      const inside = folders.filter((other) => other.id !== folder.id && within(folder.path, other.path));
      const indexed = sqlite.prepare("SELECT path, indexed_at AS indexedAt FROM documents WHERE user_id = ? AND folder_id = ?").all(userId, folder.id) as Array<{ path: string; indexedAt: number | null }>;
      const last = indexed.reduce<number | null>((latest, row) => (row.indexedAt !== null && (latest === null || row.indexedAt > latest) ? row.indexedAt : latest), null);
      const scan = await walk(folder.path, undefined, {
        skip: inside.map((other) => other.path),
        keep: new Set(indexed.map((row) => row.path)),
        since: last,
      });
      ignoredByFolder.set(folder.id, scan.ignored);
      if (scan.limited) status.limited = true;
      if (scan.denied.length > 0) status.denied = [...(status.denied ?? []), ...scan.denied].slice(0, 10);
      for (const path of scan.files) {
        if (seen.has(path)) continue;
        seen.add(path);
        work.push({ folderId: folder.id, path });
      }
    }

    // Files that disappeared since the last pass.
    const known = db.select({ id: documents.id, path: documents.path }).from(documents).where(eq(documents.userId, userId)).all();
    for (const row of known) {
      if (!seen.has(row.path)) deleteDocument(row.id);
    }

    status.total = work.length;
    for (const item of work) {
      status.current = basename(item.path);
      await indexFile(userId, item.folderId, item.path);
      status.done += 1;
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    status.running = false;
    status.current = null;
    status.finished_at = new Date().toISOString();
  }
  if (askedAgain.delete(userId)) return reindex(userId);
  void indexSemantic(userId);
  return status;
}

/// The deepest granted folder holding a file, now.
function holderOf(userId: string, path: string): string | null {
  const folders = sqlite.prepare("SELECT id, path FROM document_folders WHERE user_id = ?").all(userId) as Array<{ id: string; path: string }>;
  return folders.filter((folder) => within(folder.path, path)).sort((a, b) => b.path.length - a.path.length)[0]?.id ?? null;
}

/// Whether `child` lies under `parent` (not the same folder).
function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

/// One file read into the index now, outside a pass (a file Spotlight found
/// for a question before the indexer reached it): the same as the pass
/// would do, so the pass finds it up to date. The caller checks the grant.
export function indexOnDemand(userId: string, folderId: string, path: string): Promise<void> {
  return indexFile(userId, folderId, path);
}

async function indexFile(userId: string, given: string, path: string): Promise<void> {
  // The deepest granted folder holding it now, not the one the pass started
  // with: a folder granted meanwhile inside it (a client file's, which no
  // other conversation may search) takes its files at once.
  const folderId = holderOf(userId, path) ?? given;
  let info;
  try {
    info = await stat(path);
  } catch {
    return;
  }
  const mtimeMs = Math.floor(info.mtimeMs);

  const [existing] = db
    .select()
    .from(documents)
    .where(and(eq(documents.userId, userId), eq(documents.path, path)))
    .all();
  if (existing && existing.size === info.size && existing.mtimeMs === mtimeMs && existing.folderId === folderId) return;

  const id = existing?.id ?? generateId();
  let status = "indexed";
  let error: string | null = null;
  let chunks: ReturnType<typeof chunkSections> = [];

  if (info.size > MAX_FILE_BYTES) {
    status = "error";
    error = "too_large";
  } else {
    try {
      chunks = chunkSections(await extractSections(path));
      if (chunks.length === 0) status = "empty";
    } catch (err) {
      status = "error";
      error = err instanceof Error ? err.message.slice(0, 200) : "extraction_failed";
    }
  }

  const insertChunk = sqlite.prepare(
    "INSERT INTO document_chunks (text, document_id, user_id, page, position) VALUES (?, ?, ?, ?, ?)",
  );
  sqlite.transaction(() => {
    sqlite.prepare("DELETE FROM document_labels WHERE document_id = ?").run(id);
    sqlite.prepare("DELETE FROM document_embeddings WHERE document_id = ?").run(id);
    sqlite.prepare("DELETE FROM document_chunks WHERE document_id = ?").run(id);
    for (const chunk of chunks) insertChunk.run(chunk.text, id, userId, chunk.page, chunk.position);
    const values = {
      userId,
      folderId,
      path,
      name: basename(path),
      ext: extname(path).toLowerCase(),
      size: info.size,
      mtimeMs,
      status,
      error,
      chars: chunks.reduce((sum, chunk) => sum + chunk.text.length, 0),
      indexedAt: new Date(),
    };
    if (existing) db.update(documents).set(values).where(eq(documents.id, id)).run();
    else db.insert(documents).values({ id, ...values }).run();
  })();
}

function deleteDocument(id: string): void {
  sqlite.transaction(() => {
    sqlite.prepare("DELETE FROM document_labels WHERE document_id = ?").run(id);
    sqlite.prepare("DELETE FROM document_embeddings WHERE document_id = ?").run(id);
    sqlite.prepare("DELETE FROM document_chunks WHERE document_id = ?").run(id);
    sqlite.prepare("DELETE FROM documents WHERE id = ?").run(id);
  })();
}

// ─── Search ─────────────────────────────────────────────────────────────────

export interface Passage {
  document_id: string;
  name: string;
  path: string;
  page: number | null;
  text: string;
  snippet: string;
  match?: "content" | "name" | "semantic";
  /// For a semantic match: its cosine with the question (vectors are normalised).
  cosine?: number;
}

const MAX_PASSAGES_PER_DOCUMENT = 3;

/// Best passages for a question, best first (see selectPassages).
export function searchPassages(userId: string, question: string, limit = 6, folderIds?: string[]): Passage[] {
  if (folderIds?.length === 0) return [];
  const scope = folderIds ? ` AND d.folder_id IN (${folderIds.map(() => "?").join(",")})` : "";
  const match = buildMatchQuery(question);
  if (!match) return [];

  let rows: Array<Passage & { score: number }>;
  try {
    rows = sqlite
      .prepare(
        `SELECT c.document_id, d.name, d.path, c.page, c.text,
                snippet(document_chunks, 0, '', '', '…', 24) AS snippet,
                bm25(document_chunks) AS score
           FROM document_chunks c
           JOIN documents d ON d.id = c.document_id
          WHERE document_chunks MATCH ? AND c.user_id = ? ${scope}
          ORDER BY score
          LIMIT ?`,
      )
      .all(match, userId, ...(folderIds ?? []), limit * 4) as Array<Passage & { score: number }>;
  } catch {
    return []; // a malformed MATCH expression must not break a chat turn
  }
  const terms = queryTerms(question);
  const content = selectPassages(rows, terms, limit, MAX_PASSAGES_PER_DOCUMENT).map(({ score: _score, ...passage }) => ({ ...passage, match: "content" as const }));
  // No reindex or schema migration needed: existing libraries benefit too.
  // Only granted-folder-relative paths count, never the user's home path.
  const candidates = sqlite.prepare(`SELECT d.id, d.name, d.path, f.path AS folder_path
    FROM documents d JOIN document_folders f ON f.id = d.folder_id AND f.user_id = d.user_id
    WHERE d.user_id = ? AND d.status = 'indexed' ${scope}`).all(userId, ...(folderIds ?? [])) as Array<{ id: string; name: string; path: string; folder_path: string }>;
  const named = candidates.map((doc) => ({ ...doc, score: metadataScore(doc.name, join(basename(doc.folder_path), relative(doc.folder_path, doc.path)), terms) }))
    .filter((doc) => doc.score > 0).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
  const names: Passage[] = [];
  for (const doc of named) {
    // Prefer the relevant body passage if it also matches this named file.
    const relevant = content.find((passage) => passage.document_id === doc.id);
    if (relevant) { names.push(relevant); continue; }
    const first = sqlite.prepare("SELECT page, text FROM document_chunks WHERE document_id = ? AND user_id = ? ORDER BY rowid LIMIT 1").get(doc.id, userId) as { page: number | null; text: string } | undefined;
    if (first) names.push({ document_id: doc.id, name: doc.name, path: doc.path, ...first, snippet: first.text.slice(0, 240), match: "name" });
  }
  // File-name hits first, then content, then folder-only hits. Keep diversity
  // without letting a folder name push all relevant body passages away.
  const direct = new Set(named.filter((doc) => metadataScore(doc.name, "", terms) > 0).map((doc) => doc.id));
  const combined = [...names.filter((passage) => direct.has(passage.document_id)), ...content, ...names];
  const seen = new Set<string>();
  return combined.filter((passage) => {
    const key = `${passage.document_id}:${passage.page}:${passage.text}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, limit);
}

/** Paginated metadata only; every row is scoped to the caller and a current grant. */
export function listDocuments(userId: string, folderId: string, offset = 0, limit = 100, sort: "name" | "modified" | "category" = "name") {
  const order = sort === "modified" ? "d.mtime_ms DESC," : sort === "category" ? "COALESCE(l.category,'zzz')," : "";
  const files = sqlite.prepare(`SELECT d.id, d.name, d.path, d.status, d.chars, d.indexed_at, d.mtime_ms AS modified_at, l.category
    FROM documents d JOIN document_folders f ON f.id = d.folder_id AND f.user_id = d.user_id
    LEFT JOIN document_labels l ON l.document_id=d.id AND EXISTS(SELECT 1 FROM document_semantic_settings s WHERE s.user_id=d.user_id AND s.enabled=1)
    WHERE d.user_id = ? AND d.folder_id = ? ORDER BY ${order} d.name COLLATE NOCASE, d.id LIMIT ? OFFSET ?`)
    .all(userId, folderId, limit, offset);
  const count = sqlite.prepare("SELECT COUNT(*) AS total FROM documents WHERE user_id = ? AND folder_id = ?").get(userId, folderId) as { total: number };
  return { files, total: count.total, offset, limit };
}

export function hasIndexedDocuments(userId: string): boolean {
  const row = sqlite.prepare("SELECT 1 FROM documents WHERE user_id = ? AND status = 'indexed' LIMIT 1").get(userId);
  return row !== undefined;
}

/// True when `path` is a file this user's index knows about AND lies, on
/// disk now, inside the folder it was indexed from — a folder the person
/// still grants, and that folderRisk does not refuse on this machine. The
/// desktop asks before opening a cited document, so a forged path cannot
/// be used to open arbitrary files, nor an indexed row whose folder was
/// taken back, nor a file a symbolic link moved out of its folder.
export function isIndexedPath(userId: string, path: string): boolean {
  if (typeof path !== "string" || !path || path.includes("\0")) return false;
  const row = sqlite
    .prepare("SELECT f.path AS folder FROM documents d JOIN document_folders f ON f.id = d.folder_id AND f.user_id = d.user_id WHERE d.user_id = ? AND d.path = ? LIMIT 1")
    .get(userId, path) as { folder: string } | undefined;
  if (!row) return false;
  let folder: string;
  let file: string;
  let home: string;
  try {
    folder = realpathSync(row.folder);
    file = realpathSync(path);
    home = realpathSync(homedir());
  } catch {
    return false;
  }
  if (folderRisk(folder, home, process.platform, folder === home) !== null) return false;
  const inside = relative(folder, file);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) return false;
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Current grants and caller ownership are checked before reading index metadata. */
export function browseDocuments(userId: string, folderId: string, directory = "", offset = 0) {
  const folder = sqlite.prepare("SELECT path FROM document_folders WHERE user_id = ? AND id = ?").get(userId, folderId) as {path: string} | undefined;
  if (!folder) return null;
  const files = sqlite.prepare("SELECT id, name, path, status, mtime_ms AS modified_at FROM documents WHERE user_id = ? AND folder_id = ?").all(userId, folderId) as IndexedEntry[];
  const entries = indexedDirectory(folder.path, files, directory);
  return {entries: entries.slice(offset, offset + 100), total: entries.length, next_offset: offset + 100 < entries.length ? offset + 100 : null, directory};
}
