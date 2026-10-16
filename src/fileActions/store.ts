import { randomUUID } from "node:crypto";
import { sqlite } from "../db.js";
import type { FileActionPlan } from "./plan.js";
import type { Language } from "./words.js";

// The actions proposed in the chat (docs/agent-in-chat.md of
// twoody-desktop): what was proposed, to whom, and what came of it. In the
// encrypted database, like the conversation they belong to.
//
// The table is made here on first use (as peerDocuments/audit.ts makes its
// own) rather than by a versioned migration: migration 10 (« people ») was
// being written beside this on 16/10/2026, and two versions numbered at
// once would leave one of them never run. To fold into the next migration.

export type FileActionStatus = "proposed" | "running" | "done" | "failed" | "declined" | "undone";

export interface FileActionItem {
  /// What happened to it: moved (a sort or a rename), created (a new
  /// document), read (a document the model was given), or why not.
  kind: "moved" | "created" | "folder" | "read";
  /// Relative to the action's folder, as the person sees it.
  from?: string;
  to: string;
}

export interface FileActionResult {
  done: number;
  total: number;
  items: FileActionItem[];
  /// The folders made for it (relative), removed again by an undo if empty.
  folders: string[];
  /// What stopped it, if anything.
  failure?: { reason: string; at?: string } | null;
  /// What an undo did: files put back, and those that could not be.
  undo?: { restored: number; left: number } | null;
}

export interface FileActionRow {
  id: string;
  userId: string;
  discussionId: string;
  messageId: string | null;
  kind: FileActionPlan["kind"];
  status: FileActionStatus;
  plan: FileActionPlan;
  result: FileActionResult | null;
  /// The session that asked, and whether it was this computer's app: the
  /// only ones that may agree (routes/fileActions.ts).
  askerSession: string | null;
  askerApp: boolean;
  model: string | null;
  language: Language;
  createdAt: number;
  decidedAt: number | null;
  doneAt: number | null;
}

let ready = false;

function ensureTable() {
  if (ready) return;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS file_actions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      discussion_id TEXT NOT NULL,
      message_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      plan TEXT NOT NULL,
      result TEXT,
      asker_session TEXT,
      asker_app INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      language TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      decided_at INTEGER,
      done_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS file_actions_discussion ON file_actions(discussion_id);
    CREATE INDEX IF NOT EXISTS file_actions_message ON file_actions(message_id);
  `);
  // A run the server stopped in the middle of (quit, crash) is no longer
  // running: said failed, what it did kept in its result.
  sqlite.prepare("UPDATE file_actions SET status = 'failed', done_at = ? WHERE status = 'running'").run(Date.now());
  ready = true;
}

type Raw = {
  id: string; user_id: string; discussion_id: string; message_id: string | null; kind: string; status: string; plan: string; result: string | null;
  asker_session: string | null; asker_app: number; model: string | null; language: string; created_at: number; decided_at: number | null; done_at: number | null;
};

function rowOf(raw: Raw | undefined): FileActionRow | null {
  if (!raw) return null;
  let plan: FileActionPlan;
  try {
    plan = JSON.parse(raw.plan) as FileActionPlan;
  } catch {
    return null;
  }
  let result: FileActionResult | null = null;
  try {
    result = raw.result ? (JSON.parse(raw.result) as FileActionResult) : null;
  } catch {
    result = null;
  }
  return {
    id: raw.id, userId: raw.user_id, discussionId: raw.discussion_id, messageId: raw.message_id, kind: raw.kind as FileActionPlan["kind"],
    status: raw.status as FileActionStatus, plan, result, askerSession: raw.asker_session, askerApp: raw.asker_app === 1, model: raw.model,
    language: raw.language as Language, createdAt: raw.created_at, decidedAt: raw.decided_at, doneAt: raw.done_at,
  };
}

export function createFileAction(args: { userId: string; discussionId: string; plan: FileActionPlan; askerSession: string | null; askerApp: boolean; model: string | null; language: Language; now?: number }): FileActionRow {
  ensureTable();
  const id = randomUUID();
  sqlite.prepare(`INSERT INTO file_actions (id, user_id, discussion_id, message_id, kind, status, plan, result, asker_session, asker_app, model, language, created_at)
    VALUES (?, ?, ?, NULL, ?, 'proposed', ?, NULL, ?, ?, ?, ?, ?)`).run(
    id, args.userId, args.discussionId, args.plan.kind, JSON.stringify(args.plan), args.askerSession, args.askerApp ? 1 : 0, args.model, args.language, args.now ?? Date.now(),
  );
  return fileAction(args.userId, id)!;
}

export function fileAction(userId: string, id: string): FileActionRow | null {
  ensureTable();
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) return null;
  return rowOf(sqlite.prepare("SELECT * FROM file_actions WHERE id = ? AND user_id = ?").get(id, userId) as Raw | undefined);
}

export function setActionMessage(id: string, messageId: string) {
  ensureTable();
  sqlite.prepare("UPDATE file_actions SET message_id = ? WHERE id = ?").run(messageId, id);
}

/// Moves an action from one status to another, only from the one expected:
/// two answers at once start it once.
export function transition(id: string, from: FileActionStatus[], to: FileActionStatus, fields: { result?: FileActionResult | null; now?: number } = {}): boolean {
  ensureTable();
  const now = fields.now ?? Date.now();
  const placeholders = from.map(() => "?").join(", ");
  const done = to === "done" || to === "failed" || to === "undone";
  const changed = sqlite.prepare(
    `UPDATE file_actions SET status = ?, ${fields.result !== undefined ? "result = ?, " : ""}${to === "running" || to === "declined" ? "decided_at = ?" : done ? "done_at = ?" : "decided_at = decided_at"} WHERE id = ? AND status IN (${placeholders})`,
  ).run(...[to, ...(fields.result !== undefined ? [fields.result ? JSON.stringify(fields.result) : null] : []), ...(to === "running" || to === "declined" || done ? [now] : []), id, ...from]);
  return changed.changes === 1;
}

export function setResult(id: string, result: FileActionResult) {
  ensureTable();
  sqlite.prepare("UPDATE file_actions SET result = ? WHERE id = ?").run(JSON.stringify(result), id);
}

/// The proposals of a conversation's messages, for GET /discussions/:id.
export function actionsOfMessages(userId: string, messageIds: string[]): Map<string, FileActionRow> {
  ensureTable();
  const found = new Map<string, FileActionRow>();
  if (!messageIds.length) return found;
  for (let i = 0; i < messageIds.length; i += 500) {
    const slice = messageIds.slice(i, i + 500);
    const rows = sqlite.prepare(`SELECT * FROM file_actions WHERE user_id = ? AND message_id IN (${slice.map(() => "?").join(", ")})`).all(userId, ...slice) as Raw[];
    for (const raw of rows) {
      const row = rowOf(raw);
      if (row?.messageId) found.set(row.messageId, row);
    }
  }
  return found;
}

/// The conversation's latest proposal still waiting, if its message is the
/// last answer (a « oui » typed after it).
export function waitingProposal(userId: string, discussionId: string): FileActionRow | null {
  ensureTable();
  return rowOf(sqlite.prepare("SELECT * FROM file_actions WHERE user_id = ? AND discussion_id = ? AND status = 'proposed' ORDER BY created_at DESC LIMIT 1").get(userId, discussionId) as Raw | undefined);
}

/// The folder of the conversation's latest action (« et renomme-les avec leur date »).
export function lastActionFolder(userId: string, discussionId: string): string | null {
  ensureTable();
  const raw = sqlite.prepare("SELECT plan FROM file_actions WHERE user_id = ? AND discussion_id = ? ORDER BY created_at DESC LIMIT 1").get(userId, discussionId) as { plan: string } | undefined;
  try {
    return raw ? ((JSON.parse(raw.plan) as FileActionPlan).folder.real ?? null) : null;
  } catch {
    return null;
  }
}
