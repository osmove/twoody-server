import type Database from "better-sqlite3";

// Migration 6 — isolated projects (Jimmy, 04/10/2026, Twoody Pro:
// « dossiers clients cloisonnés », built on Project): a project whose
// documents, conversations and notes reach nothing outside it — a client
// file (src/projects/isolation.ts).
//
//   projects.isolated            1: walled off; set when it is made, never
//                                changed
//   projects.reference           the firm's own number for it (« 2026-014 »)
//   project_notes                a project's memory: what the person wrote on
//                                its page or asked to remember in one of its
//                                conversations; never in `memories`, so that
//                                no path of the person's memory (the profile,
//                                the graph, the searches, the encrypted
//                                history) can reach an isolated one's
//   document_folders.project_id  the folder holding an isolated project's
//                                documents: searched in its conversations
//                                only (a folder granted inside it too)
//
// discussions.project_id was there already (the project a conversation is
// about): in an isolated project it is set when the conversation starts and
// never changed.
//
// Local only, not in schema/contract.json: nothing of an isolated project
// leaves this computer — not to the account, not to another computer.

export function isolatedProjects(sqlite: Database.Database) {
  const columns = (table: string) => (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
  if (!columns("projects").includes("isolated")) sqlite.exec("ALTER TABLE projects ADD COLUMN isolated INTEGER NOT NULL DEFAULT 0");
  if (!columns("projects").includes("reference")) sqlite.exec("ALTER TABLE projects ADD COLUMN reference TEXT");
  if (!columns("document_folders").includes("project_id")) sqlite.exec("ALTER TABLE document_folders ADD COLUMN project_id TEXT");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS project_notes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      discussion_id TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS project_notes_project ON project_notes (project_id, created_at);
    CREATE INDEX IF NOT EXISTS discussions_project ON discussions (user_id, project_id);
  `);
}
