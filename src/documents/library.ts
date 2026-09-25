import { and, eq } from "drizzle-orm";
import { realpathSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { generateId } from "../auth.js";
import { db, documentFolders, documents, sqlite } from "../db.js";
import { chunkSections } from "./chunk.js";
import { extractSections, isSupported, MAX_FILE_BYTES } from "./extract.js";
import { folderRisk } from "./folderRisk.js";
import { buildMatchQuery } from "./query.js";

// The user's document library: the folders they granted, the index
// built from them, and the search that feeds /queries.
//
// Everything stays in the server's own SQLite file. Indexing is
// incremental (a file is re-read only when its size or modification time
// changed) and runs one file at a time, yielding to the event loop
// between files so chat stays responsive while a large folder is read.

// ─── Folders ────────────────────────────────────────────────────────────────

export class FolderRejected extends Error {
  constructor(public readonly reason: "not_found" | "not_a_directory" | "too_broad" | "sensitive" | "already_added") {
    super(reason);
  }
}

/// Validates a folder the user picked and returns its canonical path.
/// Refuses what should never be indexed wholesale (folderRisk.ts): a
/// disk, a whole home directory or what holds it, system directories,
/// and anything hidden or under ~/Library or AppData.
export function canonicalFolder(input: string): string {
  let real: string;
  try {
    real = realpathSync(input);
  } catch {
    throw new FolderRejected("not_found");
  }
  if (!statSync(real).isDirectory()) throw new FolderRejected("not_a_directory");

  const risk = folderRisk(real, realpathSync(homedir()));
  if (risk) throw new FolderRejected(risk);
  return real;
}

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

  return db
    .select()
    .from(documentFolders)
    .where(eq(documentFolders.userId, userId))
    .all()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((folder) => {
      const count = byFolder.get(folder.id);
      return {
        id: folder.id,
        path: folder.path,
        name: basename(folder.path),
        documents: count?.total ?? 0,
        indexed: count?.indexed ?? 0,
        without_text: count?.empty ?? 0,
        failed: count?.failed ?? 0,
      };
    });
}

export function addFolder(userId: string, input: string) {
  const path = canonicalFolder(input);
  const existing = db
    .select()
    .from(documentFolders)
    .where(and(eq(documentFolders.userId, userId), eq(documentFolders.path, path)))
    .all();
  if (existing.length > 0) throw new FolderRejected("already_added");

  const id = generateId();
  db.insert(documentFolders).values({ id, userId, path, createdAt: new Date() }).run();
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
}

const jobs = new Map<string, IndexStatus>();

export function indexStatus(userId: string): IndexStatus {
  return jobs.get(userId) ?? { running: false, total: 0, done: 0, current: null, started_at: null, finished_at: null };
}

const SKIPPED_DIRECTORIES = new Set(["node_modules", "Library", "AppData", "__MACOSX", "$RECYCLE.BIN"]);
const MAX_FILES_PER_FOLDER = 20_000;

async function walk(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0 && files.length < MAX_FILES_PER_FOLDER) {
    const dir = pending.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: skip it, keep going
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name.startsWith("~$")) continue;
      const path = join(dir, entry.name);
      // Symlinks are not followed: a link must not widen the grant.
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) pending.push(path);
      } else if (entry.isFile() && isSupported(path)) {
        files.push(path);
      }
    }
  }
  return files;
}

/// Brings the index in line with the user's folders. Resolves once the
/// pass is over; callers that only want to start it do not await it.
export async function reindex(userId: string): Promise<IndexStatus> {
  const current = jobs.get(userId);
  if (current?.running) return current;

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
    const folders = db.select().from(documentFolders).where(eq(documentFolders.userId, userId)).all();
    const work: Array<{ folderId: string; path: string }> = [];
    const seen = new Set<string>();

    for (const folder of folders) {
      for (const path of await walk(folder.path)) {
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
  return status;
}

async function indexFile(userId: string, folderId: string, path: string): Promise<void> {
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
}

const MAX_PASSAGES_PER_DOCUMENT = 3;

/// Best passages for a question, best first. bm25() is negative and
/// lower is better; passages far behind the best one are noise that
/// would only dilute the model's context, so they are dropped.
export function searchPassages(userId: string, question: string, limit = 6): Passage[] {
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
          WHERE document_chunks MATCH ? AND c.user_id = ?
          ORDER BY score
          LIMIT ?`,
      )
      .all(match, userId, limit * 4) as Array<Passage & { score: number }>;
  } catch {
    return []; // a malformed MATCH expression must not break a chat turn
  }
  if (rows.length === 0) return [];

  const floor = rows[0].score * 0.35;
  const perDocument = new Map<string, number>();
  const kept: Passage[] = [];
  for (const row of rows) {
    if (row.score > floor) break;
    const used = perDocument.get(row.document_id) ?? 0;
    if (used >= MAX_PASSAGES_PER_DOCUMENT) continue;
    perDocument.set(row.document_id, used + 1);
    const { score: _score, ...passage } = row;
    kept.push(passage);
    if (kept.length >= limit) break;
  }
  return kept;
}

export function hasIndexedDocuments(userId: string): boolean {
  const row = sqlite.prepare("SELECT 1 FROM documents WHERE user_id = ? AND status = 'indexed' LIMIT 1").get(userId);
  return row !== undefined;
}

/// True when `path` is a file this user's index knows about. The desktop
/// asks before opening a cited document, so a forged path cannot be used
/// to open arbitrary files.
export function isIndexedPath(userId: string, path: string): boolean {
  const row = sqlite.prepare("SELECT 1 FROM documents WHERE user_id = ? AND path = ? LIMIT 1").get(userId, path);
  return row !== undefined;
}
