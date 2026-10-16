import type Database from "better-sqlite3-multiple-ciphers";

// Migration 13 — folder shares under the account's column names (schema
// audit of 17/10/2026, docs/schema-audit-2026-10-17.md n° 2; Jimmy's go the
// same day). The same notion, the same names on both sides:
//
//   "right"     → access_right    (no SQL keyword to quote any more)
//   label       → folder_label
//   revoked_by  → revoked_reason  (it always was a reason — owner, grantee,
//                                  organization, eligibility — never a person;
//                                  the account's `host` is now kept as it is)
//
// A rename keeps every row and value. Each step looks first, so running it
// on a table already renamed (or half renamed) changes nothing.

const RENAMES: Array<[from: string, to: string]> = [
  ["right", "access_right"],
  ["label", "folder_label"],
  ["revoked_by", "revoked_reason"],
];

export function folderShareNames(sqlite: Database.Database) {
  const columns = new Set((sqlite.prepare("PRAGMA table_info(folder_shares)").all() as Array<{ name: string }>).map((column) => column.name));
  if (columns.size === 0) return;
  for (const [from, to] of RENAMES) {
    if (columns.has(from) && !columns.has(to)) sqlite.exec(`ALTER TABLE folder_shares RENAME COLUMN "${from}" TO ${to}`);
  }
}
