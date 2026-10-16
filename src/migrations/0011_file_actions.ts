import type Database from "better-sqlite3-multiple-ciphers";

// Migration 11 — « Agir dans vos dossiers » (twoody-desktop
// docs/agent-in-chat.md, 16/10/2026): the actions proposed in the chat.
// Until now src/fileActions/store.ts made the table on first use (migration
// 10 was being written at the same time); a computer that already used it
// has it, with the same columns: everything here is IF NOT EXISTS, so it is
// kept as it is, rows included.

export function fileActions(sqlite: Database.Database) {
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
}
