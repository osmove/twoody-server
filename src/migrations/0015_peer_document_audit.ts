import type Database from "better-sqlite3-multiple-ciphers";

// Migration 15 — the document audit under the convention of the schema
// (schema audit of 17/10/2026, docs/schema-audit-2026-10-17.md n° 9; Jimmy's
// go the same day): `at` → `occurred_at`, the name the convergence gave a
// time something happened (model_calls, message_traces). The table is made
// and completed by migration 8 alone now; src/peerDocuments/audit.ts no
// longer creates or alters it when it loads. Local only: the journal of what
// the other computers and the grantees of a share read here never leaves this
// computer (schema/contract.json `local_only`).
//
// The rename keeps every row; run again, it changes nothing.

export function peerDocumentAudit(sqlite: Database.Database) {
  const columns = new Set((sqlite.prepare("PRAGMA table_info(peer_document_audit)").all() as Array<{ name: string }>).map((column) => column.name));
  if (columns.has("at") && !columns.has("occurred_at")) sqlite.exec("ALTER TABLE peer_document_audit RENAME COLUMN at TO occurred_at");
}
