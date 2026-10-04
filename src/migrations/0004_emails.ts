import type Database from "better-sqlite3";

// Migration 4 — « E-mails » (Capacités, Jimmy, 04/10/2026: « IMAP d'abord »):
// a copy of the person's mailbox on this computer, read over IMAP
// (src/email/), searched and read in the chat by a model of theirs.
//
//   email_sources  the mailbox the person set up: its address, its IMAP
//                  server, the state of its sync — as the account's
//                  `email_sources` (Gmail) — never its password, which is
//                  kept apart (DATA_DIR/email-credentials.json, 0600)
//   email_folders  the folders read (INBOX, Sent) or written to (Drafts),
//                  with their UIDVALIDITY and the last UID read
//   emails         the messages, under the names of the account's `emails`
//                  (from_email, to_email, text_body, provider_message_id,
//                  attachment_metadata…); dates in milliseconds, JSON
//                  without suffix (docs/schema-convergence.md)
//   email_fts      their full-text index (subject, people, text_body),
//                  external content kept in step by triggers
//
// Local only (not in schema/contract.json): the account reads Gmail
// itself. Idempotent: src/email/store.ts runs it again should a database
// have skipped it.

export function emailsSchema(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS email_sources (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      provider TEXT NOT NULL DEFAULT 'imap',
      email_address TEXT NOT NULL,
      display_name TEXT,
      imap_host TEXT NOT NULL,
      imap_port INTEGER NOT NULL,
      imap_security TEXT NOT NULL DEFAULT 'tls',
      username TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      import_after INTEGER,
      last_synced_at INTEGER,
      last_imported_at INTEGER,
      last_error TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_email_sources_user ON email_sources (user_id, status);

    CREATE TABLE IF NOT EXISTS email_folders (
      id TEXT PRIMARY KEY,
      email_source_id TEXT NOT NULL REFERENCES email_sources(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      name TEXT,
      special_use TEXT,
      role TEXT,
      uid_validity INTEGER,
      last_uid INTEGER NOT NULL DEFAULT 0,
      synced_after INTEGER,
      message_count INTEGER,
      last_synced_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (email_source_id, path)
    );

    CREATE TABLE IF NOT EXISTS emails (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      email_source_id TEXT NOT NULL REFERENCES email_sources(id) ON DELETE CASCADE,
      email_folder_id TEXT NOT NULL REFERENCES email_folders(id) ON DELETE CASCADE,
      uid INTEGER,
      uid_validity INTEGER,
      provider_message_id TEXT,
      provider_thread_id TEXT,
      provider_label_ids TEXT NOT NULL DEFAULT '[]',
      direction TEXT NOT NULL,
      status TEXT NOT NULL,
      subject TEXT,
      from_name TEXT,
      from_email TEXT,
      to_name TEXT,
      to_email TEXT,
      recipients TEXT NOT NULL DEFAULT '{}',
      people TEXT,
      text_body TEXT,
      body_format TEXT NOT NULL DEFAULT 'text',
      body_truncated INTEGER NOT NULL DEFAULT 0,
      is_read INTEGER NOT NULL DEFAULT 0,
      is_replied INTEGER NOT NULL DEFAULT 0,
      important INTEGER NOT NULL DEFAULT 0,
      provider_internal_date INTEGER,
      sent_at INTEGER,
      size INTEGER,
      attachment_metadata TEXT NOT NULL DEFAULT '{}',
      metadata TEXT NOT NULL DEFAULT '{}',
      trashed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_folder_uid ON emails (email_folder_id, uid) WHERE uid IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_emails_folder_message ON emails (email_folder_id, provider_message_id);
    CREATE INDEX IF NOT EXISTS idx_emails_user_date ON emails (user_id, provider_internal_date);
    CREATE INDEX IF NOT EXISTS idx_emails_thread ON emails (user_id, provider_thread_id);

    -- unicode61 with remove_diacritics: « reunion » finds « Réunion ».
    CREATE VIRTUAL TABLE IF NOT EXISTS email_fts USING fts5(
      subject,
      people,
      text_body,
      content = 'emails',
      content_rowid = 'rowid',
      tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS email_fts_insert AFTER INSERT ON emails BEGIN
      INSERT INTO email_fts (rowid, subject, people, text_body) VALUES (new.rowid, new.subject, new.people, new.text_body);
    END;
    CREATE TRIGGER IF NOT EXISTS email_fts_delete AFTER DELETE ON emails BEGIN
      INSERT INTO email_fts (email_fts, rowid, subject, people, text_body) VALUES ('delete', old.rowid, old.subject, old.people, old.text_body);
    END;
    CREATE TRIGGER IF NOT EXISTS email_fts_update AFTER UPDATE OF subject, people, text_body ON emails BEGIN
      INSERT INTO email_fts (email_fts, rowid, subject, people, text_body) VALUES ('delete', old.rowid, old.subject, old.people, old.text_body);
      INSERT INTO email_fts (rowid, subject, people, text_body) VALUES (new.rowid, new.subject, new.people, new.text_body);
    END;
  `);
}

/// Indexes the messages again from the table (after a VACUUM renumbered
/// the rowids, or should the index be found broken).
export function rebuildEmailIndex(sqlite: Database.Database) {
  sqlite.prepare("INSERT INTO email_fts (email_fts) VALUES ('rebuild')").run();
}
