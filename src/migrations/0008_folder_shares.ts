import type Database from "better-sqlite3";

// Migration 8 — folder sharing, the owner's side (docs/sharing-design.md §2,
// docs/sharing-contracts.md §3, 10/10/2026): a Documents folder of this
// computer shared with a household member, an organization co-member or a
// whole organization. This computer is the authority: the account relays
// and lists, it can only restrict (src/shares/).
//
//   folder_shares         one share: the folder, who, the right, until when;
//                         revoked rather than deleted (rule 6). `folder_id`
//                         names a document_folders row without a SQL foreign
//                         key: removing the folder must still work, and the
//                         share stops by itself (« folder_gone »).
//   share_guest_devices   a grantee's device keys this computer has seen, and
//                         whether the owner approved them (« Autoriser »),
//                         per grantee and fingerprint; covers every share of
//                         this computer to that person.
//   peer_document_audit   gains the share, the guest and the outcome of each
//                         request — never a question, never a path.
//
// The column `right` is a keyword of SQLite (RIGHT JOIN): always quoted.

export function folderShares(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS folder_shares (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      folder_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      grantee_user_id TEXT,
      grantee_name TEXT,
      organization_id TEXT,
      organization_name TEXT,
      label TEXT NOT NULL,
      "right" TEXT NOT NULL,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      revoked_at INTEGER,
      revoked_by TEXT,
      published_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS folder_shares_user ON folder_shares (user_id, created_at);
    CREATE TABLE IF NOT EXISTS share_guest_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      grantee_user_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      enc_public TEXT NOT NULL,
      sign_public TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      approved_at INTEGER,
      verified_at INTEGER,
      UNIQUE (user_id, grantee_user_id, fingerprint)
    );
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
  const columns = (sqlite.prepare("PRAGMA table_info(peer_document_audit)").all() as Array<{ name: string }>).map((column) => column.name);
  for (const name of ["requester", "requester_name", "share_id", "guest_user_id", "guest_fingerprint", "outcome"]) {
    if (!columns.includes(name)) sqlite.exec(`ALTER TABLE peer_document_audit ADD COLUMN ${name} TEXT`);
  }
  sqlite.exec("CREATE INDEX IF NOT EXISTS peer_document_audit_share ON peer_document_audit (user_id, share_id, id)");
}
