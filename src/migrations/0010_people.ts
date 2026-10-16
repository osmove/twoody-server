import type Database from "better-sqlite3-multiple-ciphers";
import { kindsOfWord } from "../people/kinship.js";

// Migration 10 — « Proches » (docs/people-design.md, 16/10/2026): the
// person's people, one entity each, linked to their contact cards, with a
// fixed kind of relation beside the free label.
//
//   entity_relations   += kind (one of src/people/kinship.ts RELATION_KINDS,
//                         NULL for a label none says) and source (manual,
//                         learned, contact). The rows of before get their
//                         kind from their label when it says one.
//   entity_contacts    which contact cards are whom: auto (sure), confirmed
//                      (the person said yes), manual, or refused (never
//                      linked again on its own). No foreign key on
//                      contact_id: a card copied from the Mac or Outlook is
//                      written again with the same id at every copy
//                      (personalSync.ts); a link to a card gone is ignored.

export function people(sqlite: Database.Database) {
  const columns = new Set((sqlite.prepare("PRAGMA table_info(entity_relations)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!columns.has("kind")) sqlite.exec("ALTER TABLE entity_relations ADD COLUMN kind TEXT");
  if (!columns.has("source")) sqlite.exec("ALTER TABLE entity_relations ADD COLUMN source TEXT");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS entity_contacts (
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      contact_id TEXT NOT NULL,
      how TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (entity_id, contact_id)
    );
    CREATE INDEX IF NOT EXISTS idx_entity_contacts_contact ON entity_contacts (contact_id);
  `);
  const rows = sqlite.prepare("SELECT rowid AS id, label FROM entity_relations WHERE kind IS NULL").all() as Array<{ id: number; label: string }>;
  const set = sqlite.prepare("UPDATE entity_relations SET kind = ? WHERE rowid = ?");
  for (const row of rows) {
    const kinds = kindsOfWord(row.label);
    if (kinds.length === 1) set.run(kinds[0], row.id);
  }
}
