import { createHash, randomUUID } from "node:crypto";
import { sqlite } from "../../db.js";
import { folderLayout } from "../../documents/library.js";
import { within as sameOrInside } from "../../documents/samePath.js";
import { foldQuote } from "./quotes.js";
import type { SectionKind } from "./prompts.js";

// The rows of a project's overview (migration 17,
// docs/project-overview-design.md §5): the overview, its versions, and what
// each document says.

export interface Source {
  key: string;
  document_id: string;
  name: string;
  page: number | null;
  quote: string;
  date: string | null;
}

export interface Line {
  text: string;
  sources: Source[];
}

export interface Section {
  kind: SectionKind;
  lines: Line[];
}

export interface DocumentsRead {
  /// Documents read (with text).
  read: number;
  /// Without text (a scan where there is no OCR, an image) or that failed.
  unreadable: Array<{ document_id: string; name: string; reason: string }>;
  /// Read in part (too long).
  partial: Array<{ document_id: string; name: string }>;
  /// Each document as it was read (« size:mtime »).
  signatures: Record<string, string>;
  /// The points each section was written from.
  keys: Partial<Record<SectionKind, string[]>>;
}

export interface Changes {
  documents: { added: string[]; changed: string[]; removed: string[] };
  sections: Array<{ kind: SectionKind; added: string[]; removed: string[] }>;
}

export interface OverviewRow {
  id: string;
  userId: string;
  projectId: string;
  folder: string | null;
  language: string;
  sections: Section[] | null;
  documents: DocumentsRead | null;
  builtAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface VersionRow {
  id: string;
  overviewId: string;
  sections: Section[];
  documents: DocumentsRead | null;
  changes: Changes | null;
  status: "built" | "proposed" | "applied" | "ignored" | "replaced";
  createdAt: number;
  decidedAt: number | null;
}

function parse<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

type RawOverview = { id: string; user_id: string; project_id: string; folder: string | null; language: string; sections: string | null; documents: string | null; built_at: number | null; created_at: number; updated_at: number };
const overviewOf = (row: RawOverview): OverviewRow => ({
  id: row.id, userId: row.user_id, projectId: row.project_id, folder: row.folder, language: row.language,
  sections: parse<Section[]>(row.sections), documents: parse<DocumentsRead>(row.documents), builtAt: row.built_at, createdAt: row.created_at, updatedAt: row.updated_at,
});

export function overviewFor(userId: string, projectId: string): OverviewRow | null {
  const row = sqlite.prepare("SELECT * FROM project_overviews WHERE user_id = ? AND project_id = ? AND deleted_at IS NULL").get(userId, projectId) as RawOverview | undefined;
  return row ? overviewOf(row) : null;
}

export function overviewsOf(userId: string): OverviewRow[] {
  return (sqlite.prepare("SELECT * FROM project_overviews WHERE user_id = ? AND deleted_at IS NULL").all(userId) as RawOverview[]).map(overviewOf);
}

/// The project's overview row, made when it has none (nothing written yet).
export function ensureOverview(userId: string, projectId: string, language: string, now = Date.now()): OverviewRow {
  const existing = overviewFor(userId, projectId);
  if (existing) {
    if (existing.language !== language && !existing.sections) {
      sqlite.prepare("UPDATE project_overviews SET language = ?, updated_at = ? WHERE id = ?").run(language, now, existing.id);
      return { ...existing, language };
    }
    return existing;
  }
  const id = randomUUID();
  sqlite.prepare("INSERT INTO project_overviews (id, user_id, project_id, folder, language, sections, documents, built_at, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, NULL, NULL, NULL, ?, ?)")
    .run(id, userId, projectId, language, now, now);
  return overviewFor(userId, projectId)!;
}

export function setFolder(id: string, folder: string | null, now = Date.now()): void {
  sqlite.prepare("UPDATE project_overviews SET folder = ?, updated_at = ? WHERE id = ?").run(folder, now, id);
}

export function setLanguage(id: string, language: string, now = Date.now()): void {
  sqlite.prepare("UPDATE project_overviews SET language = ?, updated_at = ? WHERE id = ?").run(language, now, id);
}

/// The overview the person sees from now on, kept as a version too.
export function saveOverview(overview: OverviewRow, sections: Section[], documents: DocumentsRead, status: "built" | "applied", now = Date.now()): void {
  sqlite.transaction(() => {
    sqlite.prepare("UPDATE project_overviews SET sections = ?, documents = ?, built_at = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(sections), JSON.stringify(documents), now, now, overview.id);
    sqlite.prepare("INSERT INTO project_overview_versions (id, overview_id, sections, documents, changes, status, created_at, updated_at, decided_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)")
      .run(randomUUID(), overview.id, JSON.stringify(sections), JSON.stringify(documents), status, now, now, now);
  })();
}

/// What was read changed and the overview did not: what it says of the
/// documents follows, silently.
export function saveDocumentsOnly(overview: OverviewRow, documents: DocumentsRead, now = Date.now()): void {
  sqlite.prepare("UPDATE project_overviews SET documents = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(documents), now, overview.id);
}

/// A proposal: the one waiting before it is replaced (never deleted).
export function propose(overview: OverviewRow, sections: Section[], documents: DocumentsRead, changes: Changes, now = Date.now()): string {
  const id = randomUUID();
  sqlite.transaction(() => {
    sqlite.prepare("UPDATE project_overview_versions SET status = 'replaced', decided_at = ?, updated_at = ? WHERE overview_id = ? AND status = 'proposed'").run(now, now, overview.id);
    sqlite.prepare("INSERT INTO project_overview_versions (id, overview_id, sections, documents, changes, status, created_at, updated_at, decided_at) VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, NULL)")
      .run(id, overview.id, JSON.stringify(sections), JSON.stringify(documents), JSON.stringify(changes), now, now);
    sqlite.prepare("UPDATE project_overviews SET updated_at = ? WHERE id = ?").run(now, overview.id);
  })();
  return id;
}

type RawVersion = { id: string; overview_id: string; sections: string; documents: string | null; changes: string | null; status: VersionRow["status"]; created_at: number; decided_at: number | null };
const versionOf = (row: RawVersion): VersionRow => ({
  id: row.id, overviewId: row.overview_id, sections: parse<Section[]>(row.sections) ?? [], documents: parse<DocumentsRead>(row.documents), changes: parse<Changes>(row.changes), status: row.status, createdAt: row.created_at, decidedAt: row.decided_at,
});

export function pendingProposal(overviewId: string): VersionRow | null {
  const row = sqlite.prepare("SELECT * FROM project_overview_versions WHERE overview_id = ? AND status = 'proposed' ORDER BY created_at DESC LIMIT 1").get(overviewId) as RawVersion | undefined;
  return row ? versionOf(row) : null;
}

/// The last version made, whatever became of it: what the next update is
/// compared with (an ignored proposal is not proposed again until something
/// else changes).
export function latestVersion(overviewId: string): VersionRow | null {
  const row = sqlite.prepare("SELECT * FROM project_overview_versions WHERE overview_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(overviewId) as RawVersion | undefined;
  return row ? versionOf(row) : null;
}

export function decideProposal(overview: OverviewRow, apply: boolean, now = Date.now()): boolean {
  const proposal = pendingProposal(overview.id);
  if (!proposal) return false;
  sqlite.transaction(() => {
    sqlite.prepare("UPDATE project_overview_versions SET status = ?, decided_at = ?, updated_at = ? WHERE id = ?").run(apply ? "applied" : "ignored", now, now, proposal.id);
    if (apply) sqlite.prepare("UPDATE project_overviews SET sections = ?, documents = ?, built_at = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(proposal.sections), JSON.stringify(proposal.documents), now, now, overview.id);
    else sqlite.prepare("UPDATE project_overviews SET updated_at = ? WHERE id = ?").run(now, overview.id);
  })();
  return true;
}

// ── What each document says ──────────────────────────────────────────────

export interface Point {
  key: string;
  kind: SectionKind;
  text: string;
  quote: string;
  page: number | null;
}

export interface Digest {
  id: string;
  documentId: string;
  name: string;
  size: number;
  mtimeMs: number;
  documentAt: number | null;
  items: Point[];
  pieces: number;
  partial: boolean;
  language: string;
}

/// A point's key: the same point read again from the same document (its
/// kind and quote) keeps it, so that a line still standing on it keeps its
/// source when the document changed elsewhere.
export function pointKey(documentId: string, kind: SectionKind, quote: string): string {
  return createHash("sha256").update(`${documentId}\u0000${kind}\u0000${foldQuote(quote)}`).digest("hex").slice(0, 16);
}

export function digestsOf(projectId: string): Digest[] {
  return (sqlite.prepare("SELECT * FROM project_document_digests WHERE project_id = ?").all(projectId) as Array<{ id: string; document_id: string; name: string; size: number; mtime_ms: number; document_at: number | null; items: string; pieces: number; partial: number; language: string }>)
    .map((row) => ({ id: row.id, documentId: row.document_id, name: row.name, size: row.size, mtimeMs: row.mtime_ms, documentAt: row.document_at, items: parse<Point[]>(row.items) ?? [], pieces: row.pieces, partial: row.partial === 1, language: row.language }));
}

export function saveDigest(userId: string, projectId: string, digest: Omit<Digest, "id">, model: string | null, now = Date.now()): void {
  sqlite.prepare(`INSERT INTO project_document_digests (id, user_id, project_id, document_id, name, size, mtime_ms, document_at, items, pieces, partial, model, language, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, document_id) DO UPDATE SET name = excluded.name, size = excluded.size, mtime_ms = excluded.mtime_ms, document_at = excluded.document_at,
      items = excluded.items, pieces = excluded.pieces, partial = excluded.partial, model = excluded.model, language = excluded.language, updated_at = excluded.updated_at`)
    .run(randomUUID(), userId, projectId, digest.documentId, digest.name, digest.size, digest.mtimeMs, digest.documentAt, JSON.stringify(digest.items), digest.pieces, digest.partial ? 1 : 0, model, digest.language, now, now);
}

/// What a document no longer in the project said: it is not read again,
/// and it says nothing in the overview any more (an index row, not the
/// person's: the document itself is where it was, or gone by their hand).
export function dropDigests(projectId: string, documentIds: string[]): void {
  const drop = sqlite.prepare("DELETE FROM project_document_digests WHERE project_id = ? AND document_id = ?");
  for (const id of documentIds) drop.run(projectId, id);
}

/// What was read in another language: read again in the overview's.
export function dropAllDigests(projectId: string): void {
  sqlite.prepare("DELETE FROM project_document_digests WHERE project_id = ?").run(projectId);
}

// ── Which documents ──────────────────────────────────────────────────────

export interface ProjectDocument {
  id: string;
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
  status: string;
  error: string | null;
}

/// The documents an overview reads: a walled-off project's folders'; for
/// any other project, those of the folder chosen for it — never one of a
/// walled-off project's folder, wherever it lies.
export function projectDocuments(userId: string, projectId: string, isolated: boolean, folder: string | null): ProjectDocument[] {
  const rows = sqlite.prepare("SELECT id, path, project_id AS projectId FROM document_folders WHERE user_id = ?").all(userId) as Array<{ id: string; path: string; projectId: string | null }>;
  const layout = folderLayout(rows);
  const wanted = isolated
    ? rows.filter((row) => layout.projectOf.get(row.id) === projectId)
    : folder
      ? rows.filter((row) => (layout.projectOf.get(row.id) ?? null) === null && (sameOrInside(folder, row.path) || sameOrInside(row.path, folder)))
      : [];
  if (!wanted.length) return [];
  const ids = wanted.map((row) => row.id);
  const documents = sqlite.prepare(`SELECT id, name, path, size, mtime_ms AS mtimeMs, status, error, folder_id AS folderId FROM documents WHERE user_id = ? AND folder_id IN (${ids.map(() => "?").join(",")})`)
    .all(userId, ...ids) as Array<ProjectDocument & { folderId: string }>;
  const seen = new Set<string>();
  return documents
    .filter((document) => isolated || sameOrInside(folder!, document.path))
    .filter((document) => (seen.has(document.path) ? false : (seen.add(document.path), true)))
    .map(({ folderId: _folder, ...document }) => document);
}
