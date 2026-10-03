import type Database from "better-sqlite3";
import { createMessageFts } from "./fts.js";

// Migration 2 — the convergence with the account's Postgres (Jimmy,
// 03/10/2026: « réduire les écarts… on proposera des offres cloud, et on
// devra tout faire converger », docs/schema-convergence.md):
//
// - one name per thing: usage_events → model_calls (one call of a model;
//   the account's usage_events counts quotas), providers → llm_endpoints
//   (this computer's model addresses; the account's providers are a
//   catalogue), account_peers → account_computers (as on the account),
//   turn_traces + turn_prompts → message_traces (as on the account);
// - JSON columns named for what they hold, without « _json »;
// - every date in milliseconds (half the tables were in seconds);
// - contacts' phones, e-mails and addresses as {label, value} objects;
// - ids the account can store as UUIDs: the macOS rows' « macos-<hex> »
//   become the UUID of that hex (the undashed 32-hex ids of before already
//   are UUIDs for Postgres and stay as they are);
// - memories get the account's `confidence`.
//
// Nothing is dropped that holds data: renamed tables keep their rows, the
// two traces tables are copied into one before going.

/// Tables whose dates were seconds (drizzle `timestamp`), and those dates.
export const SECONDS_COLUMNS: Array<[string, string[]]> = [
  ["users", ["created_at"]],
  ["auth_sessions", ["created_at", "expires_at"]],
  ["pairing_codes", ["created_at", "expires_at", "claimed_at"]],
  ["devices", ["last_seen_at", "created_at"]],
  ["tunnel_peers", ["paired_at", "last_seen_at"]],
  ["account_computers", ["request_expires_at", "created_at", "updated_at"]],
  ["llm_endpoints", ["created_at", "updated_at"]],
  ["discussions", ["created_at", "last_activity_at"]],
  ["messages", ["created_at"]],
  ["tasks", ["due_at", "done_at", "created_at", "updated_at"]],
  ["reminders", ["notify_at", "created_at", "updated_at"]],
  ["contacts", ["created_at", "updated_at"]],
  ["events", ["start_time", "end_time", "created_at", "updated_at"]],
  ["notes", ["created_at", "updated_at"]],
  ["memories", ["created_at", "updated_at"]],
  ["document_folders", ["created_at"]],
  ["documents", ["indexed_at"]],
  ["members", ["created_at", "updated_at"]],
  ["wake_word_samples", ["created_at"]],
  ["voice_profiles", ["created_at", "updated_at"]],
  ["face_embeddings", ["created_at", "updated_at"]],
];

/// JSON columns renamed: [table, before, after].
export const JSON_RENAMES: Array<[string, string, string]> = [
  ["users", "prefs_json", "prefs"],
  ["auth_sessions", "device_access_json", "device_access"],
  ["messages", "sources_json", "sources"],
  ["messages", "answered_by_json", "answered_by"],
  ["messages", "memory_json", "memory"],
  ["discussions", "context_json", "context"],
  ["memories", "tags_json", "tags"],
  ["contacts", "phones_json", "phones"],
  ["contacts", "emails_json", "emails"],
  ["contacts", "addresses_json", "addresses"],
  ["face_embeddings", "embedding_json", "embedding"],
  ["memory_vault_events", "payload_json", "payload"],
  ["memory_vault_events", "sealed_json", "sealed"],
  ["memory_candidates", "payload_json", "payload"],
  ["memory_notices", "saved_json", "saved"],
];

/// `macos-<32 hex>` (or any 32-hex string) as a dashed UUID, in SQL.
const dashed = (column: string) => {
  const hex = `lower(CASE WHEN ${column} LIKE 'macos-%' THEN substr(${column}, 7) ELSE ${column} END)`;
  return `(substr(${hex}, 1, 8) || '-' || substr(${hex}, 9, 4) || '-' || substr(${hex}, 13, 4) || '-' || substr(${hex}, 17, 4) || '-' || substr(${hex}, 21, 12))`;
};
const macosId = (column: string) => `(${column} LIKE 'macos-%' AND length(${column}) = 38)`;

function columns(sqlite: Database.Database, table: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
}

export function convergence(sqlite: Database.Database) {
  // The full-text index's view and triggers name users.prefs_json: they go
  // first, and come back on the renamed column at the end.
  for (const trigger of ["message_fts_insert", "message_fts_delete", "message_fts_update", "message_fts_discussion_mode", "message_fts_person_mode"]) {
    sqlite.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
  sqlite.exec("DROP VIEW IF EXISTS message_fts_conversations");

  // ── one name per thing ────────────────────────────────────────────────
  sqlite.exec(`
    ALTER TABLE usage_events RENAME TO model_calls;
    ALTER TABLE model_calls RENAME COLUMN at TO occurred_at;
    DROP INDEX IF EXISTS usage_events_user_at;
    DROP INDEX IF EXISTS usage_events_message;
    CREATE INDEX IF NOT EXISTS model_calls_user_occurred ON model_calls (user_id, occurred_at);
    CREATE UNIQUE INDEX IF NOT EXISTS model_calls_message ON model_calls (message_id) WHERE message_id IS NOT NULL;

    ALTER TABLE providers RENAME TO llm_endpoints;
    ALTER TABLE account_peers RENAME TO account_computers;

    CREATE TABLE message_traces (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'chat',
      discussion_id TEXT,
      message_id TEXT,
      client TEXT,
      model TEXT,
      outcome TEXT NOT NULL,
      error TEXT,
      total_ms INTEGER,
      trace TEXT NOT NULL DEFAULT '{}',
      prompt TEXT
    );
    INSERT INTO message_traces (id, user_id, occurred_at, kind, discussion_id, message_id, client, model, outcome, error, total_ms, trace, prompt)
      SELECT t.id, t.user_id, t.at, t.kind, t.discussion_id, t.message_id, t.client, t.model, t.outcome, t.error, t.total_ms, t.trace_json, p.prompt_json
        FROM turn_traces t LEFT JOIN turn_prompts p ON p.trace_id = t.id;
    DROP TABLE turn_prompts;
    DROP TABLE turn_traces;
    CREATE INDEX message_traces_user_occurred ON message_traces (user_id, occurred_at);
    CREATE INDEX message_traces_message ON message_traces (message_id);
  `);

  // ── JSON columns without « _json » ────────────────────────────────────
  for (const [table, before, after] of JSON_RENAMES) {
    if (columns(sqlite, table).includes(before)) sqlite.exec(`ALTER TABLE ${table} RENAME COLUMN ${before} TO ${after}`);
  }

  // ── dates in milliseconds ─────────────────────────────────────────────
  // A date in seconds is below 10^11 (year 5138); one already in
  // milliseconds is above 10^12 (2001): only the former is multiplied.
  for (const [table, names] of SECONDS_COLUMNS) {
    for (const name of names) {
      sqlite.exec(`UPDATE ${table} SET ${name} = ${name} * 1000 WHERE ${name} IS NOT NULL AND ${name} < 100000000000`);
    }
  }

  // ── contacts: {label, value} ──────────────────────────────────────────
  for (const name of ["phones", "emails", "addresses"]) {
    sqlite.exec(`
      UPDATE contacts SET ${name} = (
        SELECT json_group_array(CASE WHEN json_each.type = 'text' THEN json_object('label', NULL, 'value', json_each.value) ELSE json(json_each.value) END)
          FROM json_each(contacts.${name})
      ) WHERE ${name} IS NOT NULL AND json_valid(${name}) AND json_type(${name}) = 'array'
    `);
  }

  // ── ids: the macOS rows as UUIDs ──────────────────────────────────────
  for (const table of ["contacts", "events"]) {
    sqlite.exec(`UPDATE ${table} SET id = ${dashed("id")} WHERE ${macosId("id")}`);
  }
  sqlite.exec(`UPDATE memories SET entity_id = ${dashed("entity_id")} WHERE ${macosId("entity_id")}`);

  // ── memories: how sure (the account's column) ─────────────────────────
  if (!columns(sqlite, "memories").includes("confidence")) {
    sqlite.exec("ALTER TABLE memories ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0");
  }

  createMessageFts(sqlite, "prefs");
}
