import type Database from "better-sqlite3-multiple-ciphers";

// Migration 12 — « Retirer de vos proches » without deleting (Jimmy,
// 17/10/2026, « rien de définitif »; docs/people-design.md §7): a person
// removed is kept with the time they were removed, hidden from « Proches »,
// the chat's cards, the graph the memory follows, « dis à maman » and the
// learner's proposals, until « Rétablir ».

export function peopleRemoved(sqlite: Database.Database) {
  const columns = new Set((sqlite.prepare("PRAGMA table_info(entities)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!columns.has("removed_at")) sqlite.exec("ALTER TABLE entities ADD COLUMN removed_at INTEGER");
}
