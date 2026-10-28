import type Database from "better-sqlite3-multiple-ciphers";

// Migration 20 — a project's tags (Jimmy, 28/10/2026: « nom, description et
// tags », in place of the four sizes and the kind picked from a list):
// `projects.tags`, a JSON array of the person's own words (« client », « 2026 »),
// shared like the rest of the project (schema/contract.json, `text[]` on the
// account). The kind stays, shown as a tag of its own; « Toujours en tête »
// is the size: large when ticked, small otherwise (src/projects/projects.ts).

export function projectTags(sqlite: Database.Database) {
  const columns = (sqlite.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>).map((column) => column.name);
  if (!columns.includes("tags")) sqlite.exec("ALTER TABLE projects ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
}
