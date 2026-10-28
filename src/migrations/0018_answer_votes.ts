import type Database from "better-sqlite3-multiple-ciphers";

// Migration 18 — 👍 / 👎 under an answer (Jimmy, 28/10/2026;
// src/routes/answerVotes.ts): the person's own opinion of an answer, with,
// for a 👎, a reason picked among a few and a comment if they wrote one. One
// per answer; taking it back sets `deleted_at`, choosing again brings it back.
//
// Shared with the account (schema/contract.json `tables.answer_votes`): the
// vote, its reason and comment reach Osmove when the person gives it (the
// Desktop or the phone sends them, with the answer's technical details only
// while « Partager des diagnostics » is ticked, never a walled-off project's).

export function answerVotes(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS answer_votes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      discussion_id TEXT,
      vote TEXT NOT NULL,
      reason TEXT,
      comment TEXT,
      model TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS answer_votes_message ON answer_votes(user_id, message_id);
    CREATE INDEX IF NOT EXISTS answer_votes_discussion ON answer_votes(discussion_id);
  `);
}
