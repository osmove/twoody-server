import type Database from "better-sqlite3-multiple-ciphers";

// What may leave this computer, for the synchronisation to come (step 5 of
// docs/schema-convergence.md) — the hook it must use, and its tests with it
// (test/helpers/walls.ts `assertWallsHold`).
//
// Two rules, both written in schema/contract.json and checked against this
// file by test/schemaContract.test.ts:
//
//   1. Only the rows of a shared table (`tables` of the contract) may ever
//      leave; a table « local only » never does.
//   2. The walled-off projects (Jimmy, 14/10/2026; docs/projects-design.md
//      §8, `never_leave.walled_projects`): a project with `isolated = 1` and
//      every row that belongs to it — its conversations, their messages and
//      traces, its tasks, reminders and events, the shares of its folder —
//      never leave this computer, whatever the sync, the account or the
//      offer. The vault (encrypted history) already keeps them out
//      (projects/isolation.ts); a clear-text sync must do the same through
//      `mayLeave` / `leavingWhere`.
//
// A path says how a row belongs to a walled project: a column holding a
// project's id, or a column holding the id of a row of another table that
// belongs to one (« discussion_id → discussions »). `projects` itself is
// walled by its own `isolated`.

/// The shared tables of schema/contract.json (`tables`).
export const SHAREABLE_TABLES = [
  "discussions", "messages", "message_traces", "memories", "memory_candidates", "projects",
  "tasks", "reminders", "notes", "events", "contacts", "folder_shares", "answer_votes",
] as const;

/// schema/contract.json `never_leave.walled_projects.tables`.
export const WALLED_PROJECT_PATHS: Record<string, string> = {
  projects: "isolated = 1",
  discussions: "project_id",
  messages: "discussion_id → discussions",
  message_traces: "discussion_id → discussions",
  memory_candidates: "discussion_id → discussions",
  tasks: "project_id",
  reminders: "project_id",
  events: "project_id",
  folder_shares: "folder_id → document_folders",
  document_folders: "project_id",
  answer_votes: "discussion_id → discussions",
};

const NAME = /^[a-z_]+$/;

/// The SQL condition (on the table's own columns) under which a row of
/// `table` belongs to a walled-off project, or null when no row of it can.
/// NULLs count as « not walled » only where the column says nothing: an
/// unknown project, a missing conversation.
export function walledWhere(table: string): string | null {
  const path = WALLED_PROJECT_PATHS[table];
  if (!path) return null;
  if (table === "projects") return "COALESCE(isolated = 1, 0)";
  const [column, via] = path.split(" → ").map((part) => part.trim());
  if (!column || !NAME.test(column)) throw new Error(`walls: bad path for ${table}`);
  if (!via) return `COALESCE(${column} IN (SELECT id FROM projects WHERE COALESCE(isolated = 1, 0)), 0)`;
  const inner = walledWhere(via);
  if (!inner || !NAME.test(via)) throw new Error(`walls: ${table} goes through ${via}, which no rule walls`);
  return `COALESCE(${column} IN (SELECT id FROM ${via} WHERE ${inner}), 0)`;
}

/// The SQL condition a sync adds to its reading of `table`: the rows that
/// may leave. A table that is not shared gives « 0 » (nothing).
export function leavingWhere(table: string): string {
  if (!(SHAREABLE_TABLES as readonly string[]).includes(table)) return "0";
  const walled = walledWhere(table);
  return walled ? `NOT (${walled})` : "1";
}

/// Whether this row of `table` (by its `id`) may leave this computer.
export function mayLeave(db: Database.Database, table: string, id: string): boolean {
  if (!(SHAREABLE_TABLES as readonly string[]).includes(table)) return false;
  return !!db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND ${leavingWhere(table)}`).get(id);
}
