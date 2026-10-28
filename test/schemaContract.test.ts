// The schema contract shared with the account (schema/contract.json, v2 of
// 17/10/2026, docs/schema-audit-2026-10-17.md): every table of this
// database is classified — shared, local only, or the same name as an
// account table that is another thing — and every column of a shared table
// is in the contract or classified local with its reason; types, values and
// references match; the walled-off projects' rows never leave. Anything new
// and unclassified, anything gone and still listed, fails here (and the
// account's test/schema_contract_test.rb does the same on its side).
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The constants below live in modules that open the server's database.
process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-contract-data-"));

const { migrate } = await import("../src/migrations/index.ts");
const { MESSAGE_ROLES } = await import("../src/db.ts");
const { TRACE_KINDS } = await import("../src/diagnostics/traces.ts");
const { MEMORY_KINDS } = await import("../src/vault/contracts.ts");
const { PROJECT_SIZES, PROJECT_SOURCES, PROJECT_STATUSES } = await import("../src/projects/projects.ts");
const { CONTACT_RELATION_TYPES } = await import("../src/memory/discover.ts");
const { REVOKED_REASONS, SHARE_KINDS, SHARE_RIGHTS } = await import("../src/shares/store.ts");
const { ANSWER_VOTES, VOTE_REASONS } = await import("../src/routes/answerVotes.ts");
const { leavingWhere, mayLeave, SHAREABLE_TABLES, WALLED_PROJECT_PATHS } = await import("../src/sync/walls.ts");
const { assertWallsHold, seedWalls } = await import("./helpers/walls.ts");

type Column = { type: string; local?: string; rails?: string; to?: string; rails_bigint?: string; values?: string[]; local_values?: string[]; rails_values?: string[]; gap?: string; shape?: string };
type Reasons = Record<string, string>;
interface Contract {
  version: number;
  types: Record<string, string>;
  reasons: Reasons;
  tables: Record<string, Record<string, Column>>;
  local_columns: Record<string, Reasons>;
  account_columns: Record<string, Reasons>;
  never_leave: { walled_projects: { about: string; tables: Record<string, string>; not_concerned: Reasons } };
  local_only: Reasons;
  account_only: Reasons;
  same_name: Reasons;
}

const contract = JSON.parse(readFileSync(join(import.meta.dirname, "..", "schema", "contract.json"), "utf8")) as Contract;
const SQLITE_TYPES: Record<string, string> = { uuid: "TEXT", text: "TEXT", int: "INTEGER", real: "REAL", bool: "INTEGER", datetime: "INTEGER", json: "TEXT", text_array: "TEXT", ref: "TEXT" };
const COLUMN_KEYS = new Set(["type", "local", "rails", "to", "rails_bigint", "values", "local_values", "rails_values", "gap", "shape"]);

/// The code's own list for each column whose values the contract fixes.
const VALUES_HERE: Record<string, readonly string[]> = {
  "messages.role": MESSAGE_ROLES,
  "message_traces.kind": TRACE_KINDS,
  "memories.kind": MEMORY_KINDS,
  "projects.size": PROJECT_SIZES,
  "projects.status": PROJECT_STATUSES,
  "projects.source": PROJECT_SOURCES,
  "contacts.relation_type": CONTACT_RELATION_TYPES,
  "folder_shares.kind": SHARE_KINDS,
  "folder_shares.access_right": SHARE_RIGHTS,
  "folder_shares.revoked_reason": REVOKED_REASONS,
  "answer_votes.vote": ANSWER_VOTES,
  "answer_votes.reason": VOTE_REASONS,
};

function migrated() {
  const dir = mkdtempSync(join(tmpdir(), "twoody-contract-"));
  const db = new Database(join(dir, "local.db"));
  migrate(db, { dataDir: dir, log: () => undefined });
  return db;
}

const db = migrated();

/// The tables of this database, without SQLite's own and the shadow tables
/// of a full-text index (message_fts_data…), which belong to the index.
function tablesHere(): string[] {
  const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string; sql: string | null }>;
  const virtual = new Set(rows.filter((row) => /^CREATE VIRTUAL TABLE/i.test(row.sql ?? "")).map((row) => row.name));
  return rows
    .map((row) => row.name)
    .filter((name) => !name.startsWith("sqlite_") && ![...virtual].some((index) => new RegExp(`^${index}_(config|content|data|docsize|idx)$`).test(name)));
}

const columnsHere = (table: string) => new Map((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>).map((row) => [row.name, row.type.toUpperCase()]));

const reasonsOf = (): Array<[string, string]> => [
  ...Object.entries(contract.local_only), ...Object.entries(contract.account_only), ...Object.entries(contract.same_name),
  ...Object.values(contract.local_columns).flatMap((reasons) => Object.entries(reasons)),
  ...Object.values(contract.account_columns).flatMap((reasons) => Object.entries(reasons)),
  ...Object.entries(contract.never_leave.walled_projects.not_concerned),
  ...Object.values(contract.tables).flatMap((columns) => Object.entries(columns).flatMap(([name, column]) => [column.rails_bigint, column.gap].filter((reason): reason is string => !!reason).map((reason) => [name, reason] as [string, string]))),
];

test("the contract is v2 and well formed: classes apart, every reason given, every type known", () => {
  assert.equal(contract.version, 2);
  const classes = { tables: Object.keys(contract.tables), local_only: Object.keys(contract.local_only), account_only: Object.keys(contract.account_only), same_name: Object.keys(contract.same_name) };
  const seen = new Map<string, string>();
  for (const [name, list] of Object.entries(classes)) {
    for (const table of list) {
      assert.ok(!seen.has(table), `${table} is in both ${seen.get(table)} and ${name}`);
      seen.set(table, name);
    }
  }
  for (const [what, reason] of reasonsOf()) {
    assert.ok(typeof reason === "string" && reason.trim().length > 3, `${what}: a reason, not « ${reason} »`);
    for (const ref of reason.match(/@[a-z_]+/g) ?? []) assert.ok(contract.reasons[ref], `${what}: ${ref} is not in reasons`);
  }
  for (const [table, columns] of Object.entries(contract.tables)) {
    for (const [name, column] of Object.entries(columns)) {
      const where = `${table}.${name}`;
      for (const key of Object.keys(column)) assert.ok(COLUMN_KEYS.has(key), `${where}: unknown key ${key}`);
      assert.ok(SQLITE_TYPES[column.type] && contract.types[column.type], `${where}: unknown type ${column.type}`);
      if (column.type === "ref") assert.ok(column.to && contract.tables[column.to], `${where}: a ref names a shared table`);
      else assert.ok(!column.to && !column.rails_bigint, `${where}: to and rails_bigint are for a ref`);
      if (column.local_values || column.rails_values) {
        assert.ok(column.values?.length && column.gap, `${where}: a side's own values come with the shared ones and the gap`);
        for (const side of [column.local_values, column.rails_values]) {
          if (side) assert.notDeepEqual([...side].sort(), [...column.values!].sort(), `${where}: the gap is closed — drop local_values/rails_values and gap`);
        }
      } else assert.ok(!column.gap, `${where}: a gap without a side's values`);
    }
    for (const side of ["local_columns", "account_columns"] as const) {
      for (const name of Object.keys(contract[side][table] ?? {})) {
        const shared = Object.entries(columns).some(([key, column]) => (side === "local_columns" ? column.local ?? key : column.rails ?? key) === name);
        assert.ok(!shared, `${table}.${name} is in the contract and in ${side}`);
      }
    }
  }
  for (const side of ["local_columns", "account_columns"] as const) {
    for (const table of Object.keys(contract[side])) assert.ok(contract.tables[table], `${side}.${table}: not a shared table`);
  }
});

test("every table here is classified, and every table the contract classifies here exists", () => {
  const here = tablesHere();
  const classified = new Set([...Object.keys(contract.tables), ...Object.keys(contract.local_only), ...Object.keys(contract.same_name)]);
  assert.deepEqual(here.filter((table) => !classified.has(table)), [], "tables to classify in schema/contract.json (shared, local_only or same_name, with the reason)");
  assert.deepEqual([...classified].filter((table) => !here.includes(table)), [], "tables the contract lists that this database does not have");
  assert.deepEqual(Object.keys(contract.account_only).filter((table) => here.includes(table)), [], "an account_only table exists here: same_name, or shared");
});

test("every shared table has the contract's columns, of their types, and nothing unclassified", () => {
  const missing: string[] = [];
  const unclassified: string[] = [];
  const stale: string[] = [];
  for (const [table, columns] of Object.entries(contract.tables)) {
    const here = columnsHere(table);
    assert.ok(here.size > 0, `table ${table} is missing`);
    const named = new Set<string>();
    for (const [name, column] of Object.entries(columns)) {
      const local = column.local ?? name;
      named.add(local);
      const type = here.get(local);
      if (!type) missing.push(`${table}.${local}`);
      else assert.equal(type, SQLITE_TYPES[column.type], `${table}.${local}: ${column.type}`);
    }
    const local = contract.local_columns[table] ?? {};
    for (const name of here.keys()) if (!named.has(name) && !local[name]) unclassified.push(`${table}.${name}`);
    for (const name of Object.keys(local)) if (!here.has(name)) stale.push(`${table}.${name}`);
  }
  assert.deepEqual(missing, [], "columns of the contract missing here");
  assert.deepEqual(unclassified, [], "columns to put in the contract, or in local_columns with the reason");
  assert.deepEqual(stale, [], "local_columns that this database does not have");
});

test("the values the contract fixes are the code's own", () => {
  for (const [table, columns] of Object.entries(contract.tables)) {
    for (const [name, column] of Object.entries(columns)) {
      if (!column.values) continue;
      const key = `${table}.${name}`;
      const code = VALUES_HERE[key];
      assert.ok(code, `${key}: say which constant of the code holds its values (VALUES_HERE)`);
      assert.deepEqual([...code].sort(), [...(column.local_values ?? column.values)].sort(), `${key}: the code's values and the contract's differ`);
    }
  }
  for (const key of Object.keys(VALUES_HERE)) {
    const [table, name] = key.split(".") as [string, string];
    assert.ok(contract.tables[table]?.[name]?.values, `${key}: no values in the contract any more`);
  }
});

test("walled-off projects: the rule of the contract is src/sync/walls.ts's, covers every shared table that can hold a project's rows, and holds", () => {
  const rule = contract.never_leave.walled_projects;
  assert.deepEqual([...SHAREABLE_TABLES].sort(), Object.keys(contract.tables).sort(), "SHAREABLE_TABLES is the contract's tables");
  assert.deepEqual(WALLED_PROJECT_PATHS, rule.tables, "WALLED_PROJECT_PATHS is never_leave.walled_projects.tables");
  for (const table of Object.keys(rule.tables)) assert.ok(contract.tables[table] || contract.local_only[table], `${table}: a table of this database`);
  for (const table of Object.keys(rule.not_concerned)) assert.ok(contract.tables[table] && !rule.tables[table], `${table}: not_concerned is for a shared table the rule does not name`);
  for (const table of Object.keys(contract.tables)) {
    const here = columnsHere(table);
    const linked = ["project_id", "discussion_id", "message_id", "folder_id"].filter((column) => here.has(column));
    assert.ok(rule.tables[table] || rule.not_concerned[table], `${table}: never_leave.walled_projects names it, or not_concerned says why not`);
    if (rule.not_concerned[table]) assert.deepEqual(linked, [], `${table} can hold a project's rows (${linked.join(", ")}): the rule must name it`);
  }
  // A table local only never leaves, whatever its rows.
  for (const table of Object.keys(contract.local_only)) assert.equal(leavingWhere(table), "0", table);

  const walls = migrated();
  const seeded = seedWalls(walls);
  assertWallsHold(seeded, (table) => {
    const ids = (walls.prepare(`SELECT id FROM ${table}`).all() as Array<{ id: string }>).map((row) => row.id);
    return ids.filter((id) => mayLeave(walls, table, id));
  });
  // The same through the condition a sync adds to its reading.
  assertWallsHold(seeded, (table) => (walls.prepare(`SELECT id FROM ${table} WHERE ${leavingWhere(table)}`).all() as Array<{ id: string }>).map((row) => row.id));
});
