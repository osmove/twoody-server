import { randomUUID } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import { sqlite } from "../db.js";
import { typedText } from "../documentBlocks.js";
import { addFolder, canonicalFolder, listFolders, reindex, removeFolder } from "../documents/library.js";
import { normaliseMemoryContent } from "../vault/contracts.js";

// Client files (Jimmy, 04/10/2026, Twoody Pro: « dossiers clients
// cloisonnés »; the note « Pour qui est Twoody ? »): a file holds its
// documents, its conversations and its memory, and none of it reaches
// another file or a conversation outside it.
//
//   documents      the folder of its documents (document_folders.dossier_id,
//                  a folder granted inside it too: library.ts folderDossiers)
//                  is searched in its conversations only; another computer,
//                  the account's tools and a conversation held elsewhere never
//                  see it (retrieval.ts scopedFolders)
//   conversations  discussions.dossier_id, set when one starts: answered from
//                  this file only, never synchronised, learned from never into
//                  the person's memory (learner.ts), searched never from
//                  elsewhere (memory/search.ts)
//   memory         its notes (dossier_notes): written on its page or asked in
//                  one of its conversations (« Retiens que… »), given with its
//                  conversations only; the person's own memory reaches them
//                  only as what they wrote themselves (routes/queries.ts)
//
// Migration 6 (src/migrations/0006_dossiers.ts). This computer's app only
// (routes/dossiers.ts): the phone later.

export const DOSSIER_STATUSES = ["open", "archived"] as const;
export type DossierStatus = (typeof DOSSIER_STATUSES)[number];
export const NOTE_SOURCES = ["manual", "conversation"] as const;
export type NoteSource = (typeof NOTE_SOURCES)[number];

const MAX_TITLE = 200;
const MAX_REFERENCE = 100;
const MAX_BRIEF = 8000;
const MAX_NOTE = 2000;
const MAX_NOTES = 1000;

export class DossierError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}

interface Row {
  id: string;
  user_id: string;
  title: string;
  reference: string | null;
  brief: string | null;
  status: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface DossierInput {
  title?: string;
  reference?: string | null;
  brief?: string | null;
  status?: DossierStatus;
}

export interface DossierFolder {
  id: string;
  path: string;
  name: string;
  documents: number;
  indexed: number;
  without_text: number;
  failed: number;
}

export interface DossierView {
  id: string;
  title: string;
  reference: string | null;
  brief: string | null;
  status: DossierStatus;
  folders: DossierFolder[];
  conversations: number;
  notes: number;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface DossierNote {
  id: string;
  content: string;
  source: NoteSource;
  pinned: boolean;
  discussion_id: string | null;
  created_at: string;
  updated_at: string;
}

/// What a conversation needs of its file.
export interface DossierRef {
  id: string;
  title: string;
  reference: string | null;
  status: DossierStatus;
}

const iso = (ms: number) => new Date(ms).toISOString();
const oneLine = (text: string) => text.trim().replace(/\s+/g, " ");

export function readDossierInput(raw: unknown, creating: boolean): DossierInput {
  const body = ((raw as { dossier?: unknown } | null)?.dossier ?? raw) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") throw new DossierError(422, "dossier_required");
  const out: DossierInput = {};
  if (body.title !== undefined || creating) {
    const title = typeof body.title === "string" ? oneLine(body.title) : "";
    if (!title || title.length > MAX_TITLE) throw new DossierError(422, "invalid_title");
    out.title = title;
  }
  if (body.reference !== undefined) {
    if (body.reference !== null && (typeof body.reference !== "string" || oneLine(body.reference).length > MAX_REFERENCE)) throw new DossierError(422, "invalid_reference");
    out.reference = typeof body.reference === "string" && oneLine(body.reference) ? oneLine(body.reference) : null;
  }
  if (body.brief !== undefined) {
    if (body.brief !== null && (typeof body.brief !== "string" || body.brief.length > MAX_BRIEF)) throw new DossierError(422, "invalid_brief");
    out.brief = typeof body.brief === "string" && body.brief.trim() ? body.brief.trim() : null;
  }
  if (body.status !== undefined) {
    if (!(DOSSIER_STATUSES as readonly string[]).includes(String(body.status))) throw new DossierError(422, "invalid_status");
    out.status = body.status as DossierStatus;
  }
  return out;
}

function rowOf(userId: string, id: string): Row | null {
  return (sqlite.prepare("SELECT * FROM dossiers WHERE id = ? AND user_id = ?").get(id, userId) as Row | undefined) ?? null;
}

function mustOwn(userId: string, id: string): Row {
  const row = rowOf(userId, id);
  if (!row) throw new DossierError(404, "dossier_not_found");
  return row;
}

function viewsOf(userId: string, rows: Row[]): DossierView[] {
  if (!rows.length) return [];
  const folders = listFolders(userId);
  const talks = new Map((sqlite.prepare(`SELECT dossier_id, COUNT(*) AS n, MAX(last_activity_at) AS last FROM discussions
    WHERE user_id = ? AND dossier_id IS NOT NULL GROUP BY dossier_id`).all(userId) as Array<{ dossier_id: string; n: number; last: number }>)
    .map((row) => [row.dossier_id, row]));
  const notes = new Map((sqlite.prepare("SELECT dossier_id, COUNT(*) AS n FROM dossier_notes WHERE user_id = ? GROUP BY dossier_id").all(userId) as Array<{ dossier_id: string; n: number }>)
    .map((row) => [row.dossier_id, row.n]));
  return rows.map((row) => {
    const talk = talks.get(row.id);
    return {
      id: row.id,
      title: row.title,
      reference: row.reference,
      brief: row.brief,
      status: row.status === "archived" ? "archived" : "open",
      // Its own folders, not the ones granted inside them (theirs too).
      folders: folders.filter((folder) => folder.dossier_id === row.id && ownFolder(folder.id, row.id))
        .map(({ id, path, name, documents, indexed, without_text, failed }) => ({ id, path, name, documents, indexed, without_text, failed })),
      conversations: talk?.n ?? 0,
      notes: notes.get(row.id) ?? 0,
      last_activity_at: iso(Math.max(row.updated_at, talk?.last ?? 0)),
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
      archived_at: row.archived_at === null ? null : iso(row.archived_at),
    };
  });
}

function ownFolder(folderId: string, dossierId: string): boolean {
  return !!sqlite.prepare("SELECT 1 FROM document_folders WHERE id = ? AND dossier_id = ?").get(folderId, dossierId);
}

/// The person's client files, the most recently active first.
export function listDossiers(userId: string, status: DossierStatus | "all" = "open"): DossierView[] {
  const rows = sqlite.prepare(`SELECT * FROM dossiers WHERE user_id = ? AND (? = 'all' OR status = ?)`).all(userId, status, status) as Row[];
  return viewsOf(userId, rows).sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at) || a.title.localeCompare(b.title));
}

export function getDossier(userId: string, id: string): DossierView | null {
  const row = rowOf(userId, id);
  return row ? viewsOf(userId, [row])[0]! : null;
}

export function createDossier(userId: string, input: DossierInput, now = Date.now()): DossierView {
  const id = randomUUID();
  sqlite.prepare(`INSERT INTO dossiers (id, user_id, title, reference, brief, status, created_at, updated_at, archived_at)
    VALUES (?, ?, ?, ?, ?, 'open', ?, ?, NULL)`).run(id, userId, input.title!, input.reference ?? null, input.brief ?? null, now, now);
  return getDossier(userId, id)!;
}

export function updateDossier(userId: string, id: string, input: DossierInput, now = Date.now()): DossierView {
  const row = mustOwn(userId, id);
  const status = input.status ?? (row.status as DossierStatus);
  const archivedAt = status === "archived" ? (row.status === "archived" ? row.archived_at : now) : null;
  sqlite.prepare("UPDATE dossiers SET title = ?, reference = ?, brief = ?, status = ?, archived_at = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(
    input.title ?? row.title,
    input.reference !== undefined ? input.reference : row.reference,
    input.brief !== undefined ? input.brief : row.brief,
    status,
    archivedAt,
    now,
    id,
    userId,
  );
  return getDossier(userId, id)!;
}

/// The file a conversation of the person belongs to, if any.
export function dossierOfDiscussion(discussionId: string, userId: string): DossierRef | null {
  const row = sqlite.prepare(`SELECT f.id, f.title, f.reference, f.status FROM discussions d JOIN dossiers f ON f.id = d.dossier_id AND f.user_id = d.user_id
    WHERE d.id = ? AND d.user_id = ?`).get(discussionId, userId) as { id: string; title: string; reference: string | null; status: string } | undefined;
  return row ? { id: row.id, title: row.title, reference: row.reference, status: row.status === "archived" ? "archived" : "open" } : null;
}

/// A file a new conversation may start in: the person's, open.
export function dossierForNewConversation(userId: string, id: string): DossierRef {
  const row = mustOwn(userId, id);
  if (row.status === "archived") throw new DossierError(409, "dossier_archived");
  return { id: row.id, title: row.title, reference: row.reference, status: "open" };
}

// ─── Its documents ──────────────────────────────────────────────────────────

function sameOrWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/// Grants the folder of a file's documents (or files one already granted):
/// from now on searched in its conversations only. Another file's folder,
/// holding this one or inside it, is refused — a document belongs to one
/// file. What was indexed of it under a folder holding it is this file's at
/// once, before the next pass reads it again.
export async function linkFolder(userId: string, dossierId: string, input: string): Promise<DossierView> {
  const row = mustOwn(userId, dossierId);
  if (row.status === "archived") throw new DossierError(409, "dossier_archived");
  const path = canonicalFolder(input);
  const granted = listFolders(userId);
  const clash = granted.find((folder) => folder.dossier_id && folder.dossier_id !== dossierId && (sameOrWithin(folder.path, path) || sameOrWithin(path, folder.path)));
  if (clash) throw new DossierError(409, "other_dossier_folder");
  const existing = granted.find((folder) => folder.path === path);
  const folderId = existing ? existing.id : (await addFolder(userId, path)).id;
  sqlite.transaction(() => {
    sqlite.prepare("UPDATE document_folders SET dossier_id = ? WHERE id = ? AND user_id = ?").run(dossierId, folderId, userId);
    const folderPaths = new Map(granted.map((folder) => [folder.id, folder.path]));
    const move = sqlite.prepare("UPDATE documents SET folder_id = ? WHERE id = ?");
    for (const document of sqlite.prepare("SELECT id, path, folder_id FROM documents WHERE user_id = ? AND folder_id != ?").all(userId, folderId) as Array<{ id: string; path: string; folder_id: string }>) {
      const holder = folderPaths.get(document.folder_id);
      if (sameOrWithin(path, document.path) && (!holder || !sameOrWithin(path, holder))) move.run(folderId, document.id);
    }
    sqlite.prepare("UPDATE dossiers SET updated_at = ? WHERE id = ?").run(Date.now(), dossierId);
  })();
  void reindex(userId).catch(() => undefined);
  return getDossier(userId, dossierId)!;
}

/// The folder no longer this file's: its grant is removed (its index with
/// it; the files themselves are not touched).
export function unlinkFolder(userId: string, dossierId: string, folderId: string): DossierView {
  mustOwn(userId, dossierId);
  if (!ownFolder(folderId, dossierId)) throw new DossierError(404, "folder_not_found");
  removeFolder(userId, folderId);
  sqlite.prepare("UPDATE dossiers SET updated_at = ? WHERE id = ?").run(Date.now(), dossierId);
  void reindex(userId).catch(() => undefined);
  return getDossier(userId, dossierId)!;
}

// ─── Its memory ─────────────────────────────────────────────────────────────

interface NoteRow { id: string; content: string; source: string; pinned: number; discussion_id: string | null; created_at: number; updated_at: number }

const noteOf = (row: NoteRow): DossierNote => ({
  id: row.id,
  content: row.content,
  source: row.source === "conversation" ? "conversation" : "manual",
  pinned: row.pinned === 1,
  discussion_id: row.discussion_id,
  created_at: iso(row.created_at),
  updated_at: iso(row.updated_at),
});

/// Pinned first, then the newest.
export function listNotes(userId: string, dossierId: string): DossierNote[] {
  mustOwn(userId, dossierId);
  return (sqlite.prepare("SELECT * FROM dossier_notes WHERE dossier_id = ? AND user_id = ? ORDER BY pinned DESC, created_at DESC, rowid DESC").all(dossierId, userId) as NoteRow[]).map(noteOf);
}

export function readNoteContent(value: unknown): string {
  const content = typeof value === "string" ? value.trim() : "";
  if (!content || content.length > MAX_NOTE) throw new DossierError(422, "invalid_content");
  return content;
}

/// A note kept in the file; null when it holds it already (the same words).
export function addNote(userId: string, dossierId: string, content: string, options: { source?: NoteSource; discussionId?: string | null; now?: number } = {}): DossierNote | null {
  const row = mustOwn(userId, dossierId);
  if (row.status === "archived") throw new DossierError(409, "dossier_archived");
  const norm = normaliseMemoryContent(content);
  const present = sqlite.prepare("SELECT content FROM dossier_notes WHERE dossier_id = ?").all(dossierId) as Array<{ content: string }>;
  if (present.some((note) => normaliseMemoryContent(note.content) === norm)) return null;
  if (present.length >= MAX_NOTES) throw new DossierError(422, "too_many_notes");
  const now = options.now ?? Date.now();
  const id = randomUUID();
  sqlite.prepare(`INSERT INTO dossier_notes (id, dossier_id, user_id, content, source, discussion_id, pinned, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(id, dossierId, userId, content, options.source ?? "manual", options.discussionId ?? null, now, now);
  sqlite.prepare("UPDATE dossiers SET updated_at = ? WHERE id = ?").run(now, dossierId);
  return noteOf(sqlite.prepare("SELECT * FROM dossier_notes WHERE id = ?").get(id) as NoteRow);
}

export function updateNote(userId: string, dossierId: string, noteId: string, patch: { content?: string; pinned?: boolean }, now = Date.now()): DossierNote {
  mustOwn(userId, dossierId);
  const row = sqlite.prepare("SELECT * FROM dossier_notes WHERE id = ? AND dossier_id = ? AND user_id = ?").get(noteId, dossierId, userId) as NoteRow | undefined;
  if (!row) throw new DossierError(404, "note_not_found");
  sqlite.prepare("UPDATE dossier_notes SET content = ?, pinned = ?, updated_at = ? WHERE id = ?").run(
    patch.content ?? row.content,
    patch.pinned === undefined ? row.pinned : patch.pinned ? 1 : 0,
    now,
    noteId,
  );
  return noteOf(sqlite.prepare("SELECT * FROM dossier_notes WHERE id = ?").get(noteId) as NoteRow);
}

/// A note the person removes from the file's page.
export function removeNote(userId: string, dossierId: string, noteId: string): boolean {
  mustOwn(userId, dossierId);
  return sqlite.prepare("DELETE FROM dossier_notes WHERE id = ? AND dossier_id = ? AND user_id = ?").run(noteId, dossierId, userId).changes > 0;
}

// ─── In its conversations ───────────────────────────────────────────────────

const BRIEF_CHARS = 2000;
const NOTES_CHARS = 3000;

/// The end of the system prompt of a conversation in this file: what it is,
/// that nothing else is reachable from it, its summary and its notes. Last,
/// so that what comes before it — the tools first, then the system prompt
/// the person's other conversations share — stays read by the runtime.
export function dossierContext(userId: string, dossierId: string, scale = 1): string | null {
  const row = rowOf(userId, dossierId);
  if (!row) return null;
  const named = `« ${row.title} »${row.reference ? ` (ref. ${row.reference})` : ""}`;
  const sections = [
    `This conversation is in the user's client file ${named}. ` +
      "Everything in it stays in this file: answer from this file's documents and notes and from what the user says here; " +
      "you know nothing of the user's other client files nor of their conversations outside this one, so never bring anything in from them. " +
      "The user's e-mails, calendar, contacts, the web and their connected services are not used in a client file unless the user switches them on for a message with their icons under the message box: " +
      "if a message needs one of them, say so in one sentence.",
  ];
  const brief = row.brief?.trim();
  if (brief) {
    const budget = Math.round(BRIEF_CHARS * scale);
    sections.push(`The file's summary, written by the user:\n${brief.length > budget ? `${brief.slice(0, budget - 1).trimEnd()}…` : brief}`);
  }
  const notes = sqlite.prepare("SELECT content FROM dossier_notes WHERE dossier_id = ? AND user_id = ? ORDER BY pinned DESC, created_at DESC, rowid DESC").all(dossierId, userId) as Array<{ content: string }>;
  if (notes.length) {
    const budget = Math.round(NOTES_CHARS * scale);
    const lines: string[] = [];
    let used = 0;
    for (const note of notes) {
      const line = `- ${oneLine(note.content)}`;
      if (used + line.length + 1 > budget) break;
      lines.push(line);
      used += line.length + 1;
    }
    const left = notes.length - lines.length;
    sections.push(`What the user keeps in this file's notes (newest first${left ? `; ${left} older notes are on the file's page` : ""}):\n${lines.join("\n")}`);
  }
  return sections.join("\n\n");
}

/// « Retiens que… » in one of its conversations: a note of the file, never
/// a memory of the person. Whether it was new.
export function rememberInDossier(userId: string, dossierId: string, fact: string, discussionId: string): boolean {
  const content = fact.trim().slice(0, MAX_NOTE);
  if (!content) return false;
  try {
    return addNote(userId, dossierId, content, { source: "conversation", discussionId }) !== null;
  } catch {
    return false;
  }
}

// ─── Exported ───────────────────────────────────────────────────────────────

export interface DossierExport {
  dossier: DossierView;
  notes: DossierNote[];
  conversations: Array<{
    id: string;
    title: string | null;
    created_at: string;
    last_activity_at: string;
    messages: Array<{ role: "user" | "assistant"; content: string; model: string | null; created_at: string }>;
  }>;
  documents: Array<{ name: string; path: string; status: string; modified_at: string }>;
}

/// All of a file, for the app to write where the person chooses: its
/// summary, notes, conversations (what was typed and answered) and the list
/// of its documents (the files themselves stay where they are).
export function exportDossier(userId: string, id: string): DossierExport {
  const dossier = getDossier(userId, id);
  if (!dossier) throw new DossierError(404, "dossier_not_found");
  const talks = sqlite.prepare("SELECT id, title, created_at, last_activity_at FROM discussions WHERE user_id = ? AND dossier_id = ? ORDER BY created_at, rowid").all(userId, id) as Array<{ id: string; title: string | null; created_at: number; last_activity_at: number }>;
  const messagesOf = sqlite.prepare("SELECT role, content, model, created_at FROM messages WHERE discussion_id = ? AND role IN ('user', 'assistant') ORDER BY rowid");
  const folderIds = listFolders(userId).filter((folder) => folder.dossier_id === id).map((folder) => folder.id);
  const documents = folderIds.length
    ? (sqlite.prepare(`SELECT name, path, status, mtime_ms FROM documents WHERE user_id = ? AND folder_id IN (${folderIds.map(() => "?").join(",")}) ORDER BY path`).all(userId, ...folderIds) as Array<{ name: string; path: string; status: string; mtime_ms: number }>)
        .map((row) => ({ name: row.name, path: row.path, status: row.status, modified_at: iso(row.mtime_ms) }))
    : [];
  return {
    dossier,
    notes: listNotes(userId, id),
    conversations: talks.map((talk) => ({
      id: talk.id,
      title: talk.title,
      created_at: iso(talk.created_at),
      last_activity_at: iso(talk.last_activity_at),
      messages: (messagesOf.all(talk.id) as Array<{ role: "user" | "assistant"; content: string; model: string | null; created_at: number }>).map((message) => ({
        role: message.role,
        content: message.role === "user" ? typedText(message.content) : message.content.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").trim(),
        model: message.model,
        created_at: iso(message.created_at),
      })),
    })),
    documents,
  };
}
