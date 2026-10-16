// The walled-off projects' invariant, as a test any synchronisation runs
// (schema/contract.json `never_leave.walled_projects`, src/sync/walls.ts):
// seed a walled project with a row in every table its rule names, and an open
// project beside it; hand the sync's outbox to `assertWallsHold`: none of the
// walled rows may be in it, every open one must (a sync that sends nothing
// proves nothing). The future sync's own test calls it with what it would
// send; test/schemaContract.test.ts calls it with `mayLeave` alone.
import assert from "node:assert/strict";
import type Database from "better-sqlite3-multiple-ciphers";
import { WALLED_PROJECT_PATHS } from "../../src/sync/walls.ts";

type Row = Record<string, string | number | null>;

/// A row with what is given, and a placeholder in every other NOT NULL
/// column without a default (foreign keys are switched off by the caller).
function insert(db: Database.Database, table: string, row: Row) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown }>;
  const full: Row = { ...row };
  for (const column of columns) {
    if (column.name in full || !column.notnull || column.dflt_value !== null) continue;
    full[column.name] = column.name === "user_id" ? "u1" : /INT|REAL/i.test(column.type) ? 0 : "x";
  }
  const names = Object.keys(full);
  db.prepare(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...names.map((name) => full[name]));
}

export interface SeededWalls {
  /// Per table, the ids of the rows that belong to the walled project.
  walled: Record<string, string[]>;
  /// Per table, rows of an open project or of none.
  open: Record<string, string[]>;
}

/// On a migrated database (src/migrations), with foreign keys off.
export function seedWalls(db: Database.Database): SeededWalls {
  db.pragma("foreign_keys = OFF");
  const walled: Record<string, string[]> = {};
  const open: Record<string, string[]> = {};
  const add = (bucket: Record<string, string[]>, table: string, row: Row) => {
    insert(db, table, row);
    (bucket[table] ??= []).push(String(row.id));
  };
  add(walled, "projects", { id: "p-walled", title: "Dossier Tessane", isolated: 1 });
  add(open, "projects", { id: "p-open", title: "Cuisine", isolated: 0 });
  add(walled, "document_folders", { id: "f-walled", path: "/Users/x/Documents/Tessane", project_id: "p-walled" });
  add(open, "document_folders", { id: "f-open", path: "/Users/x/Documents/Factures", project_id: null });
  add(walled, "discussions", { id: "d-walled", project_id: "p-walled" });
  add(open, "discussions", { id: "d-open", project_id: "p-open" });
  add(open, "discussions", { id: "d-none", project_id: null });
  for (const [discussion, bucket] of [["d-walled", walled], ["d-none", open]] as const) {
    add(bucket, "messages", { id: `m-${discussion}`, discussion_id: discussion, role: "user", content: "…" });
    add(bucket, "message_traces", { id: `t-${discussion}`, discussion_id: discussion, kind: "chat" });
    add(bucket, "memory_candidates", { id: `c-${discussion}`, discussion_id: discussion, content: "…" });
  }
  add(open, "message_traces", { id: "t-no-discussion", discussion_id: null, kind: "learn" });
  for (const [project, bucket] of [["p-walled", walled], ["p-open", open], [null, open]] as const) {
    const tag = project ?? "none";
    add(bucket, "tasks", { id: `task-${tag}`, project_id: project, title: "…" });
    add(bucket, "reminders", { id: `rem-${tag}`, project_id: project, text: "…" });
    add(bucket, "events", { id: `ev-${tag}`, project_id: project, name: "…" });
  }
  add(walled, "folder_shares", { id: "s-walled", folder_id: "f-walled", kind: "person", folder_label: "Tessane", access_right: "ask" });
  add(open, "folder_shares", { id: "s-open", folder_id: "f-open", kind: "person", folder_label: "Factures", access_right: "ask" });
  // Tables the rule does not name, with a row each: they leave as they are.
  add(open, "notes", { id: "n1", title: "…" });
  add(open, "memories", { id: "mem1", content: "…" });
  add(open, "contacts", { id: "ct1", name: "Paul" });
  return { walled, open };
}

/// `outbox(table)`: the ids the sync would send of that table.
export function assertWallsHold(seeded: SeededWalls, outbox: (table: string) => string[]) {
  for (const table of Object.keys(WALLED_PROJECT_PATHS)) {
    if (table === "document_folders") continue; // local only: never in any outbox
    assert.ok(seeded.walled[table]?.length, `the seed has a walled row of ${table}`);
  }
  for (const [table, ids] of Object.entries(seeded.walled)) {
    const sent = new Set(outbox(table));
    for (const id of ids) assert.ok(!sent.has(id), `${table} ${id} belongs to a walled-off project: it never leaves this computer`);
  }
  for (const [table, ids] of Object.entries(seeded.open)) {
    if (table === "document_folders") continue;
    const sent = new Set(outbox(table));
    for (const id of ids) assert.ok(sent.has(id), `${table} ${id} is not walled: a sync that keeps it proves nothing`);
  }
}
