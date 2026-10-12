import type Database from "better-sqlite3-multiple-ciphers";

// Migration 7 — client files retired (Jimmy, 10/10/2026: « je ne comprends
// pas pourquoi on a créé Twoody Pro, et cette histoire de Dossiers… il
// faudrait enlever tout ça et simplement utiliser les Documents pour les
// dossiers »). The app no longer makes isolated projects nor shows their
// pages. Those made between 04/10 and 10/10/2026 keep their walls — their
// documents, conversations and notes still reach nothing outside them
// (src/projects/isolation.ts) — and are closed, as « Archiver » did: their
// conversations are read in the list of conversations, written in no more.
// Nothing is deleted.

export function retireClientFiles(sqlite: Database.Database) {
  const columns = (sqlite.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>).map((column) => column.name);
  if (!columns.includes("isolated")) return;
  const now = Date.now();
  sqlite.prepare("UPDATE projects SET status = 'done', done_at = COALESCE(done_at, ?), updated_at = ? WHERE isolated = 1 AND status NOT IN ('done', 'dropped')").run(now, now);
}
