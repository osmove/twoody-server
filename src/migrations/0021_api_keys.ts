import type Database from "better-sqlite3-multiple-ciphers";

// Migration 21 — local API keys (Jimmy, 30/10/2026: « rendons Twoody plus
// developer-friendly », a key required; docs/developer-api-design.md): what
// a program of this machine shows to call the OpenAI-compatible API (/v1/*,
// src/routes/developerApi.ts). Only the SHA-256 of a key is kept, with its
// first characters to recognise it in a list; revoking sets `revoked_at`,
// nothing is deleted.
//
// Local only (schema/contract.json `local_only.api_keys`): a key opens this
// computer's models to this computer's programs, never leaves it.

export function apiKeys(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      prefix TEXT NOT NULL,
      token_digest TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS api_keys_digest ON api_keys(token_digest);
  `);
}
