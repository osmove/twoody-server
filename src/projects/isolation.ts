import { randomUUID } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import { sqlite } from "../db.js";
import { typedText } from "../documentBlocks.js";
import { addFolder, canonicalFolder, listFolders, reindex, removeFolder } from "../documents/library.js";
import { normaliseMemoryContent } from "../vault/contracts.js";
import { ProjectError } from "./projects.js";

// Isolated projects (Jimmy, 04/10/2026, Twoody Pro: « dossiers clients
// cloisonnés », the note « Pour qui est Twoody ? »): a client file is a
// project whose documents, conversations and memory reach nothing outside
// it — `projects.isolated` (migration 6).
//
//   documents      the folder of its documents (document_folders.project_id,
//                  a folder granted inside it too: library.ts folderProjects)
//                  is searched in its conversations only; another computer,
//                  the account's tools and a conversation held elsewhere never
//                  see it (retrieval.ts scopedFolders)
//   conversations  discussions.project_id, set when one starts there and never
//                  changed: answered from this project only, by a model of
//                  this computer (or one trusted with it), never synchronised,
//                  never learned into the person's memory (learner.ts), never
//                  found from elsewhere (memory/search.ts)
//   memory         its notes (project_notes): written on its page or asked in
//                  one of its conversations (« Retiens que… »), given with its
//                  conversations only; of the person's own memory, only what
//                  they wrote or pinned themselves reaches them (queries.ts)
//
// Its title has no entity in the memory graph, and the profile, the cards,
// the learner and the chat's actions leave it out (projects.ts, actions.ts).
// This computer's app only (routes/projects.ts): the phone later.

export const NOTE_SOURCES = ["manual", "conversation"] as const;
export type NoteSource = (typeof NOTE_SOURCES)[number];

const MAX_NOTE = 2000;
const MAX_NOTES = 1000;

/// What a conversation needs of the isolated project it is in.
export interface IsolatedProjectRef {
  id: string;
  title: string;
  reference: string | null;
  /// Done or dropped (« Archiver »): read, exported, written in no more.
  closed: boolean;
}

export interface ProjectFolder {
  id: string;
  path: string;
  name: string;
  documents: number;
  indexed: number;
  without_text: number;
  failed: number;
}

export interface ProjectNote {
  id: string;
  content: string;
  source: NoteSource;
  pinned: boolean;
  discussion_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ProjectRow { id: string; title: string; reference: string | null; status: string; isolated: number; brief: string | null }

const iso = (ms: number) => new Date(ms).toISOString();
const oneLine = (text: string) => text.trim().replace(/\s+/g, " ");
const closedStatus = (status: string) => status === "done" || status === "dropped";

function projectRow(userId: string, id: string): ProjectRow | null {
  return (sqlite.prepare("SELECT id, title, reference, status, isolated, brief FROM projects WHERE id = ? AND user_id = ?").get(id, userId) as ProjectRow | undefined) ?? null;
}

function mustIsolated(userId: string, id: string): ProjectRow {
  const row = projectRow(userId, id);
  if (!row) throw new ProjectError(404, "not_found");
  if (row.isolated !== 1) throw new ProjectError(409, "not_isolated");
  return row;
}

function touch(id: string, now = Date.now()) {
  sqlite.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, id);
}

/// The isolated project a conversation of the person is in, if any.
export function isolatedProjectOf(discussionId: string, userId: string): IsolatedProjectRef | null {
  const row = sqlite.prepare(`SELECT p.id, p.title, p.reference, p.status FROM discussions d JOIN projects p ON p.id = d.project_id AND p.user_id = d.user_id
    WHERE d.id = ? AND d.user_id = ? AND p.isolated = 1`).get(discussionId, userId) as { id: string; title: string; reference: string | null; status: string } | undefined;
  return row ? { id: row.id, title: row.title, reference: row.reference, closed: closedStatus(row.status) } : null;
}

/// A project a new conversation may start in: the person's; an isolated one
/// open. Whether it is isolated.
export function projectForConversation(userId: string, id: string): { id: string; isolated: IsolatedProjectRef | null } {
  const row = projectRow(userId, id);
  if (!row) throw new ProjectError(404, "project_not_found");
  if (row.isolated !== 1) return { id: row.id, isolated: null };
  if (closedStatus(row.status)) throw new ProjectError(409, "project_closed");
  return { id: row.id, isolated: { id: row.id, title: row.title, reference: row.reference, closed: false } };
}

// ─── Its documents ──────────────────────────────────────────────────────────

function sameOrWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/// The folders an isolated project owns (not the ones granted inside them,
/// which are its too).
export function isolatedFolders(userId: string, projectId: string): ProjectFolder[] {
  const own = new Set((sqlite.prepare("SELECT id FROM document_folders WHERE project_id = ? AND user_id = ?").all(projectId, userId) as Array<{ id: string }>).map((row) => row.id));
  if (!own.size) return [];
  return listFolders(userId)
    .filter((folder) => own.has(folder.id))
    .map(({ id, path, name, documents, indexed, without_text, failed }) => ({ id, path, name, documents, indexed, without_text, failed }));
}

/// Grants the folder of an isolated project's documents (or gives it one
/// already granted): from now on searched in its conversations only.
/// Another isolated project's folder, holding this one or inside it, is
/// refused — a document belongs to one. What was indexed of it under a
/// folder holding it is this project's at once, before the next pass reads
/// it again.
export async function linkProjectFolder(userId: string, projectId: string, input: string): Promise<void> {
  const row = mustIsolated(userId, projectId);
  if (closedStatus(row.status)) throw new ProjectError(409, "project_closed");
  const path = canonicalFolder(input);
  const granted = listFolders(userId);
  const clash = granted.find((folder) => folder.project_id && folder.project_id !== projectId && (sameOrWithin(folder.path, path) || sameOrWithin(path, folder.path)));
  if (clash) throw new ProjectError(409, "other_project_folder");
  const existing = granted.find((folder) => folder.path === path);
  const folderId = existing ? existing.id : (await addFolder(userId, path)).id;
  sqlite.transaction(() => {
    sqlite.prepare("UPDATE document_folders SET project_id = ? WHERE id = ? AND user_id = ?").run(projectId, folderId, userId);
    const folderPaths = new Map(granted.map((folder) => [folder.id, folder.path]));
    const move = sqlite.prepare("UPDATE documents SET folder_id = ? WHERE id = ?");
    for (const document of sqlite.prepare("SELECT id, path, folder_id FROM documents WHERE user_id = ? AND folder_id != ?").all(userId, folderId) as Array<{ id: string; path: string; folder_id: string }>) {
      const holder = folderPaths.get(document.folder_id);
      if (sameOrWithin(path, document.path) && (!holder || !sameOrWithin(path, holder))) move.run(folderId, document.id);
    }
    touch(projectId);
  })();
  void reindex(userId).catch(() => undefined);
}

/// The folder no longer the project's: its grant is removed (its index with
/// it; the files themselves are not touched).
export function unlinkProjectFolder(userId: string, projectId: string, folderId: string): void {
  mustIsolated(userId, projectId);
  if (!sqlite.prepare("SELECT 1 FROM document_folders WHERE id = ? AND project_id = ? AND user_id = ?").get(folderId, projectId, userId)) throw new ProjectError(404, "folder_not_found");
  removeFolder(userId, folderId);
  touch(projectId);
  void reindex(userId).catch(() => undefined);
}

// ─── Its memory ─────────────────────────────────────────────────────────────

interface NoteRow { id: string; content: string; source: string; pinned: number; discussion_id: string | null; created_at: number; updated_at: number }

const noteOf = (row: NoteRow): ProjectNote => ({
  id: row.id,
  content: row.content,
  source: row.source === "conversation" ? "conversation" : "manual",
  pinned: row.pinned === 1,
  discussion_id: row.discussion_id,
  created_at: iso(row.created_at),
  updated_at: iso(row.updated_at),
});

/// Pinned first, then the newest.
export function listProjectNotes(userId: string, projectId: string): ProjectNote[] {
  return (sqlite.prepare("SELECT * FROM project_notes WHERE project_id = ? AND user_id = ? ORDER BY pinned DESC, created_at DESC, rowid DESC").all(projectId, userId) as NoteRow[]).map(noteOf);
}

export function readNoteContent(value: unknown): string {
  const content = typeof value === "string" ? value.trim() : "";
  if (!content || content.length > MAX_NOTE) throw new ProjectError(422, "invalid_content");
  return content;
}

/// A note kept in the project; null when it holds it already (the same
/// words).
export function addProjectNote(userId: string, projectId: string, content: string, options: { source?: NoteSource; discussionId?: string | null; now?: number } = {}): ProjectNote | null {
  const row = projectRow(userId, projectId);
  if (!row) throw new ProjectError(404, "not_found");
  if (row.isolated === 1 && closedStatus(row.status)) throw new ProjectError(409, "project_closed");
  const norm = normaliseMemoryContent(content);
  const present = sqlite.prepare("SELECT content FROM project_notes WHERE project_id = ?").all(projectId) as Array<{ content: string }>;
  if (present.some((note) => normaliseMemoryContent(note.content) === norm)) return null;
  if (present.length >= MAX_NOTES) throw new ProjectError(422, "too_many_notes");
  const now = options.now ?? Date.now();
  const id = randomUUID();
  sqlite.prepare(`INSERT INTO project_notes (id, project_id, user_id, content, source, discussion_id, pinned, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(id, projectId, userId, content, options.source ?? "manual", options.discussionId ?? null, now, now);
  touch(projectId, now);
  return noteOf(sqlite.prepare("SELECT * FROM project_notes WHERE id = ?").get(id) as NoteRow);
}

export function updateProjectNote(userId: string, projectId: string, noteId: string, patch: { content?: string; pinned?: boolean }, now = Date.now()): ProjectNote {
  const row = sqlite.prepare("SELECT * FROM project_notes WHERE id = ? AND project_id = ? AND user_id = ?").get(noteId, projectId, userId) as NoteRow | undefined;
  if (!row) throw new ProjectError(404, "note_not_found");
  sqlite.prepare("UPDATE project_notes SET content = ?, pinned = ?, updated_at = ? WHERE id = ?").run(
    patch.content ?? row.content,
    patch.pinned === undefined ? row.pinned : patch.pinned ? 1 : 0,
    now,
    noteId,
  );
  return noteOf(sqlite.prepare("SELECT * FROM project_notes WHERE id = ?").get(noteId) as NoteRow);
}

/// A note the person removes from the project's page.
export function removeProjectNote(userId: string, projectId: string, noteId: string): boolean {
  return sqlite.prepare("DELETE FROM project_notes WHERE id = ? AND project_id = ? AND user_id = ?").run(noteId, projectId, userId).changes > 0;
}

/// « Retiens que… » in one of its conversations: a note of the project,
/// never a memory of the person. Whether it was new.
export function rememberInProject(userId: string, projectId: string, fact: string, discussionId: string): boolean {
  const content = fact.trim().slice(0, MAX_NOTE);
  if (!content) return false;
  try {
    return addProjectNote(userId, projectId, content, { source: "conversation", discussionId }) !== null;
  } catch {
    return false;
  }
}

// ─── In its conversations ───────────────────────────────────────────────────

const BRIEF_CHARS = 2000;
const NOTES_CHARS = 3000;

/// The end of the system prompt of a conversation in an isolated project:
/// what it is, that nothing else is reachable from it, its summary and its
/// notes. Last, so that what comes before it — the tools first, then the
/// system prompt the person's other conversations share — stays read by the
/// runtime.
export function isolatedProjectContext(userId: string, projectId: string, scale = 1): string | null {
  const row = projectRow(userId, projectId);
  if (!row || row.isolated !== 1) return null;
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
  const notes = sqlite.prepare("SELECT content FROM project_notes WHERE project_id = ? AND user_id = ? ORDER BY pinned DESC, created_at DESC, rowid DESC").all(projectId, userId) as Array<{ content: string }>;
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

// ─── Exported ───────────────────────────────────────────────────────────────

export interface ProjectExport {
  project: { id: string; title: string; reference: string | null; brief: string | null; status: string; folders: ProjectFolder[]; created_at: string };
  notes: ProjectNote[];
  conversations: Array<{
    id: string;
    title: string | null;
    created_at: string;
    last_activity_at: string;
    messages: Array<{ role: "user" | "assistant"; content: string; model: string | null; created_at: string }>;
  }>;
  documents: Array<{ name: string; path: string; status: string; modified_at: string }>;
}

/// All of an isolated project, for the app to write where the person
/// chooses: its summary, notes, conversations (what was typed and answered)
/// and the list of its documents (the files themselves stay where they are).
export function exportIsolatedProject(userId: string, projectId: string): ProjectExport {
  const row = mustIsolated(userId, projectId);
  const created = (sqlite.prepare("SELECT created_at FROM projects WHERE id = ?").get(projectId) as { created_at: number }).created_at;
  const talks = sqlite.prepare("SELECT id, title, created_at, last_activity_at FROM discussions WHERE user_id = ? AND project_id = ? ORDER BY created_at, rowid").all(userId, projectId) as Array<{ id: string; title: string | null; created_at: number; last_activity_at: number }>;
  const messagesOf = sqlite.prepare("SELECT role, content, model, created_at FROM messages WHERE discussion_id = ? AND role IN ('user', 'assistant') ORDER BY rowid");
  const folderIds = listFolders(userId).filter((folder) => folder.project_id === projectId).map((folder) => folder.id);
  const documents = folderIds.length
    ? (sqlite.prepare(`SELECT name, path, status, mtime_ms FROM documents WHERE user_id = ? AND folder_id IN (${folderIds.map(() => "?").join(",")}) ORDER BY path`).all(userId, ...folderIds) as Array<{ name: string; path: string; status: string; mtime_ms: number }>)
        .map((document) => ({ name: document.name, path: document.path, status: document.status, modified_at: iso(document.mtime_ms) }))
    : [];
  return {
    project: { id: row.id, title: row.title, reference: row.reference, brief: row.brief, status: row.status, folders: isolatedFolders(userId, projectId), created_at: iso(created) },
    notes: listProjectNotes(userId, projectId),
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
