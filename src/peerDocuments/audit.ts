import { sqlite } from "../db.js";

// What the account's other computers did with this computer's documents
// (docs/mesh-design.md §1, §2, §6): which computer, which document, what
// for, when. Shown to the owner in « Appareils » (GET /api/v1/peers/:id/
// audit). Never the question asked, never a path: the document's id and
// its name as it was then. Kept like the rest of the data here, with no
// automatic purge; one row per document a search returned or a read
// touched, one row for a search that returned nothing. When that computer
// passed on a request of one of the person's devices (documents/remote.ts),
// which one, as it says (`requester`: « owner » or « person:<vault device
// id> », and its name).

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS peer_document_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    computer_id TEXT NOT NULL,
    session_id TEXT,
    action TEXT NOT NULL,
    document_id TEXT,
    name TEXT,
    bytes INTEGER,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS peer_document_audit_computer ON peer_document_audit (user_id, computer_id, id);
`);
const auditColumns = sqlite.prepare("PRAGMA table_info(peer_document_audit)").all() as Array<{ name: string }>;
for (const name of ["requester", "requester_name"]) {
  if (!auditColumns.some((column) => column.name === name)) sqlite.exec(`ALTER TABLE peer_document_audit ADD COLUMN ${name} TEXT`);
}

export type AuditAction = "search" | "folders" | "list" | "read" | "raw";

export interface AuditEntry {
  userId: string;
  computerId: string;
  sessionId: string | null;
  action: AuditAction;
  documents?: Array<{ id: string; name: string | null }>;
  bytes?: number | null;
  at?: number;
  /// Whom the computer asked for, as it said.
  requester?: { id: string; name: string | null } | null;
}

const insert = sqlite.prepare(
  "INSERT INTO peer_document_audit (user_id, computer_id, session_id, action, document_id, name, bytes, at, requester, requester_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
);

export function recordAccess(entry: AuditEntry): void {
  const at = entry.at ?? Date.now();
  const documents = entry.documents?.length ? entry.documents : [null];
  sqlite.transaction(() => {
    for (const document of documents) {
      insert.run(entry.userId, entry.computerId, entry.sessionId, entry.action, document?.id ?? null, document?.name ?? null, entry.bytes ?? null, at, entry.requester?.id ?? null, entry.requester?.name ?? null);
    }
  })();
}

export interface AuditRow {
  id: number;
  action: AuditAction;
  document_id: string | null;
  name: string | null;
  bytes: number | null;
  at: string;
  requester: string | null;
  requester_name: string | null;
}

/// Newest first, `limit` at a time; `before` is the last id of the page before.
export function auditOf(userId: string, computerId: string, options: { before?: number; limit?: number } = {}): { entries: AuditRow[]; next_before: number | null } {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const rows = sqlite
    .prepare(
      `SELECT id, action, document_id, name, bytes, at, requester, requester_name FROM peer_document_audit
        WHERE user_id = ? AND computer_id = ? ${options.before ? "AND id < ?" : ""}
        ORDER BY id DESC LIMIT ?`,
    )
    .all(...[userId, computerId, ...(options.before ? [options.before] : []), limit + 1]) as Array<Omit<AuditRow, "at"> & { at: number }>;
  const page = rows.slice(0, limit).map((row) => ({ ...row, at: new Date(row.at).toISOString() }));
  return { entries: page, next_before: rows.length > limit ? page[page.length - 1]!.id : null };
}
