import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";

// Migration 14 — the people's rows under the convention of the schema
// (schema audit of 17/10/2026, docs/schema-audit-2026-10-17.md n° 4 and 5;
// Jimmy's go the same day), before the graph exists on the account (step 4):
//
//   entities.removed_at → archived_at   « Retirer de vos proches » hides a
//                                       person and « Rétablir » brings them
//                                       back: hidden but restorable is what
//                                       the account calls `archived_at`
//                                       (projects.archived_at). `deleted_at`
//                                       stays for the logical deletion a sync
//                                       will propagate.
//   entity_relations                    rebuilt with an `id` (UUID) and
//                                       `created_at`, `updated_at`: a row a
//                                       sync can name and date. The pair and
//                                       label stay unique, the order of the
//                                       rows (rowid) is kept. A relation of
//                                       before gets the later of its two
//                                       people's dates (it cannot be older).
//   entity_contacts.updated_at          `how` changes (« À confirmer » →
//                                       confirmed): its own date, the row's
//                                       `created_at` to begin with.
//
// Every row is kept. Each step looks first: run again, it changes nothing.

function columnsOf(sqlite: Database.Database, table: string): Set<string> {
  return new Set((sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name));
}

export function peopleRows(sqlite: Database.Database, now = Date.now()) {
  const entities = columnsOf(sqlite, "entities");
  if (entities.has("removed_at") && !entities.has("archived_at")) sqlite.exec("ALTER TABLE entities RENAME COLUMN removed_at TO archived_at");
  else if (!entities.has("archived_at")) sqlite.exec("ALTER TABLE entities ADD COLUMN archived_at INTEGER");

  const relations = columnsOf(sqlite, "entity_relations");
  if (!relations.has("id")) {
    sqlite.exec(`
      CREATE TABLE entity_relations_v14 (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        to_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        kind TEXT,
        source TEXT,
        hlc TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (from_id, to_id, label)
      );
    `);
    const rows = sqlite
      .prepare(
        `SELECT r.from_id, r.to_id, r.label, r.kind, r.source, r.hlc, MAX(COALESCE(f.created_at, 0), COALESCE(t.created_at, 0)) AS since
           FROM entity_relations r LEFT JOIN entities f ON f.id = r.from_id LEFT JOIN entities t ON t.id = r.to_id ORDER BY r.rowid`,
      )
      .all() as Array<{ from_id: string; to_id: string; label: string; kind: string | null; source: string | null; hlc: string | null; since: number }>;
    const put = sqlite.prepare(
      "INSERT INTO entity_relations_v14 (id, from_id, to_id, label, kind, source, hlc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const row of rows) {
      const at = row.since > 0 ? row.since : now;
      put.run(randomUUID(), row.from_id, row.to_id, row.label, row.kind, row.source, row.hlc, at, at);
    }
    sqlite.exec(`
      DROP TABLE entity_relations;
      ALTER TABLE entity_relations_v14 RENAME TO entity_relations;
      CREATE INDEX IF NOT EXISTS idx_entity_relations_to ON entity_relations (to_id);
    `);
  }

  if (!columnsOf(sqlite, "entity_contacts").has("updated_at")) {
    sqlite.exec("ALTER TABLE entity_contacts ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0");
    sqlite.exec("UPDATE entity_contacts SET updated_at = created_at WHERE updated_at = 0");
  }
}
