import type Database from "better-sqlite3";

// Migration 6 — « Dossiers » (Jimmy, 04/10/2026, Twoody Pro: « dossiers
// clients cloisonnés »): a client file holds its documents, its
// conversations and its memory, and nothing of it reaches another file or a
// conversation outside it (src/dossiers/).
//
//   dossiers                 one per client file: its title (« Dupont c/ SCI
//                            Les Lilas »), the firm's own reference, its
//                            summary (« fiche »), open or archived
//   dossier_notes            its memory: what the person wrote on its page or
//                            asked to remember in one of its conversations;
//                            never in `memories`, so that no path of the
//                            person's memory (the profile, the graph, the
//                            searches, the encrypted history) can reach it
//   discussions.dossier_id   the file a conversation belongs to, set when it
//                            starts and never changed
//   document_folders.dossier_id
//                            the folder holding a file's documents: searched
//                            in its conversations only (a folder inside it
//                            too)
//
// Local only, not in schema/contract.json: nothing about a client file
// leaves this computer — not to the account, not to another computer.

export function dossiers(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS dossiers (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      reference TEXT,
      brief TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS dossiers_user ON dossiers (user_id, status);

    CREATE TABLE IF NOT EXISTS dossier_notes (
      id TEXT PRIMARY KEY,
      dossier_id TEXT NOT NULL REFERENCES dossiers(id),
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      discussion_id TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS dossier_notes_dossier ON dossier_notes (dossier_id, created_at);
  `);
  const columns = (table: string) => (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
  if (!columns("discussions").includes("dossier_id")) sqlite.exec("ALTER TABLE discussions ADD COLUMN dossier_id TEXT");
  if (!columns("document_folders").includes("dossier_id")) sqlite.exec("ALTER TABLE document_folders ADD COLUMN dossier_id TEXT");
  sqlite.exec("CREATE INDEX IF NOT EXISTS discussions_dossier ON discussions (user_id, dossier_id)");
}
