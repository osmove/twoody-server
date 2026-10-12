// The schema contract shared with the account (schema/contract.json): each
// table it lists exists here with each column, of a matching SQLite type —
// so a renaming on one side breaks a test instead of the convergence.
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/migrations/index.ts";

type Column = { type: string; local?: string; rails?: string };
const contract = JSON.parse(readFileSync(join(import.meta.dirname, "..", "schema", "contract.json"), "utf8")) as { tables: Record<string, Record<string, Column>> };
const SQLITE_TYPES: Record<string, string> = { uuid: "TEXT", text: "TEXT", int: "INTEGER", real: "REAL", bool: "INTEGER", datetime: "INTEGER", json: "TEXT", text_array: "TEXT" };

test("every table and column of the contract is here, of its type", () => {
  const dir = mkdtempSync(join(tmpdir(), "twoody-contract-"));
  const db = new Database(join(dir, "local.db"));
  migrate(db, { dataDir: dir, log: () => undefined });
  const missing: string[] = [];
  for (const [table, columns] of Object.entries(contract.tables)) {
    const here = new Map((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>).map((row) => [row.name, row.type.toUpperCase()]));
    if (here.size === 0) { missing.push(table); continue; }
    for (const [name, column] of Object.entries(columns)) {
      const local = column.local ?? name;
      const type = here.get(local);
      if (!type) missing.push(`${table}.${local}`);
      else assert.equal(type, SQLITE_TYPES[column.type], `${table}.${local}: ${column.type}`);
    }
  }
  assert.deepEqual(missing, []);
});
