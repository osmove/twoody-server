import type Database from "better-sqlite3-multiple-ciphers";

// L5a: the full-text index of the conversations (src/memory/search.ts),
// on this computer only. A message is indexed when its conversation's
// memory mode is not « Aucune » — its own, else the person's (/me), and
// never with memory switched off (`memory_enabled: false`); private
// conversations are « Aucune ». Triggers keep it in step with every write,
// whatever the code path: a message written, edited or deleted, a
// conversation's mode changed, the person's setting changed. Rows are
// keyed by the message's rowid, which stays put as long as nobody runs
// VACUUM (rebuildMessageIndex() puts it right after one).
//
// `prefsColumn`: users.prefs_json before the convergence (migration 2),
// users.prefs after it.
export function createMessageFts(sqlite: Database.Database, prefsColumn: "prefs_json" | "prefs") {
  // The person's own setting, from users.prefs_json: « off » when memory is
  // switched off, else their mode (chatContext.ts, memoryModeFor).
  const personMode = (prefs: string) => {
    const json = `(CASE WHEN json_valid(${prefs}) THEN ${prefs} ELSE '{}' END)`;
    return `(CASE WHEN json_extract(${json}, '$.memory_enabled') IN (0, 'false') THEN 'off'
      WHEN json_extract(${json}, '$.memory_mode') IN ('full', 'profile', 'none') THEN json_extract(${json}, '$.memory_mode')
      ELSE 'full' END)`;
  };
  const created = !sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name = 'message_fts'").get();
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
      content,
      message_id UNINDEXED,
      discussion_id UNINDEXED,
      user_id UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 2'
    );
    DROP VIEW IF EXISTS message_fts_conversations;
    CREATE VIEW message_fts_conversations AS
      SELECT d.id AS discussion_id FROM discussions d JOIN users u ON u.id = d.user_id
       WHERE (CASE WHEN ${personMode(`u.${prefsColumn}`)} = 'off' THEN 'none'
                   WHEN d.memory_mode IN ('full', 'profile', 'none') THEN d.memory_mode
                   ELSE ${personMode(`u.${prefsColumn}`)} END) != 'none';

    DROP TRIGGER IF EXISTS message_fts_insert;
    CREATE TRIGGER message_fts_insert AFTER INSERT ON messages
      WHEN EXISTS (SELECT 1 FROM message_fts_conversations WHERE discussion_id = new.discussion_id)
    BEGIN
      INSERT INTO message_fts (rowid, content, message_id, discussion_id, user_id) VALUES (new.rowid, new.content, new.id, new.discussion_id, new.user_id);
    END;
    DROP TRIGGER IF EXISTS message_fts_delete;
    CREATE TRIGGER message_fts_delete AFTER DELETE ON messages BEGIN
      DELETE FROM message_fts WHERE rowid = old.rowid;
    END;
    DROP TRIGGER IF EXISTS message_fts_update;
    CREATE TRIGGER message_fts_update AFTER UPDATE OF content, discussion_id ON messages BEGIN
      DELETE FROM message_fts WHERE rowid = old.rowid;
      INSERT INTO message_fts (rowid, content, message_id, discussion_id, user_id)
        SELECT new.rowid, new.content, new.id, new.discussion_id, new.user_id
         WHERE EXISTS (SELECT 1 FROM message_fts_conversations WHERE discussion_id = new.discussion_id);
    END;
    DROP TRIGGER IF EXISTS message_fts_discussion_mode;
    CREATE TRIGGER message_fts_discussion_mode AFTER UPDATE OF memory_mode ON discussions
      WHEN old.memory_mode IS NOT new.memory_mode
    BEGIN
      DELETE FROM message_fts WHERE rowid IN (SELECT rowid FROM messages WHERE discussion_id = new.id);
      INSERT INTO message_fts (rowid, content, message_id, discussion_id, user_id)
        SELECT m.rowid, m.content, m.id, m.discussion_id, m.user_id FROM messages m
         WHERE m.discussion_id = new.id AND EXISTS (SELECT 1 FROM message_fts_conversations WHERE discussion_id = new.id);
    END;
    DROP TRIGGER IF EXISTS message_fts_person_mode;
    CREATE TRIGGER message_fts_person_mode AFTER UPDATE OF ${prefsColumn} ON users
      WHEN ${personMode(`old.${prefsColumn}`)} IS NOT ${personMode(`new.${prefsColumn}`)}
    BEGIN
      DELETE FROM message_fts WHERE rowid IN (SELECT rowid FROM messages WHERE user_id = new.id);
      INSERT INTO message_fts (rowid, content, message_id, discussion_id, user_id)
        SELECT m.rowid, m.content, m.id, m.discussion_id, m.user_id FROM messages m
         WHERE m.user_id = new.id AND m.discussion_id IN (SELECT discussion_id FROM message_fts_conversations);
    END;
  `);
  if (created) rebuildMessageIndex(sqlite);
}

/// Indexes again every message it should hold, from scratch: at creation
/// (the messages already there), or after a VACUUM renumbered the rowids.
export function rebuildMessageIndex(sqlite: Database.Database) {
  sqlite.transaction(() => {
    sqlite.exec("DELETE FROM message_fts");
    sqlite.exec(`INSERT INTO message_fts (rowid, content, message_id, discussion_id, user_id)
      SELECT m.rowid, m.content, m.id, m.discussion_id, m.user_id FROM messages m
       WHERE m.discussion_id IN (SELECT discussion_id FROM message_fts_conversations)`);
  })();
}
