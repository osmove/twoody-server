import type Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "fs";
import { join } from "path";
import { legacyBaseline } from "./baseline.js";
import { convergence } from "./0002_convergence.js";
import { titleSource } from "./0003_title_source.js";
import { emailsSchema } from "./0004_emails.js";
import { bank } from "./0005_bank.js";
import { isolatedProjects } from "./0006_isolated_projects.js";
import { retireClientFiles } from "./0007_retire_client_files.js";

// Versioned migrations (03/10/2026, docs/schema-convergence.md): the
// database's version is SQLite's `user_version`. A database at 0 — fresh,
// or from before migrations — gets the historical baseline first; then
// each migration above its version runs, in order, each in a transaction
// with its version, foreign keys checked at the end. Before touching a
// database that holds data, a copy is saved next to it (backups/), never
// deleted: the person's conversations and memories are worth more than the
// disk space.

export interface Migration {
  version: number;
  name: string;
  up: (sqlite: Database.Database) => void;
}

export const MIGRATIONS: Migration[] = [
  // The baseline itself: nothing to do beyond what legacyBaseline did.
  { version: 1, name: "baseline", up: () => undefined },
  { version: 2, name: "convergence", up: convergence },
  { version: 3, name: "title_source", up: titleSource },
  { version: 4, name: "emails", up: emailsSchema },
  { version: 5, name: "bank", up: bank },
  { version: 6, name: "isolated_projects", up: isolatedProjects },
  { version: 7, name: "retire_client_files", up: retireClientFiles },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export function schemaVersion(sqlite: Database.Database): number {
  return Number(sqlite.pragma("user_version", { simple: true })) || 0;
}

function holdsData(sqlite: Database.Database): boolean {
  return Boolean(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get());
}

/// A copy of the database as it is, before migrating it (VACUUM INTO: a
/// consistent copy even with the WAL, in one statement).
export function backupBefore(sqlite: Database.Database, dataDir: string, version: number, now = new Date()): string {
  const dir = join(dataDir, "backups");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `local-v${version}-${stamp}.db`);
  sqlite.prepare("VACUUM INTO ?").run(path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Filesystems without POSIX modes.
  }
  return path;
}

export function migrate(sqlite: Database.Database, { dataDir, log = (line: string) => console.log(line) }: { dataDir: string; dbPath?: string; log?: (line: string) => void }) {
  let version = schemaVersion(sqlite);
  // A database a newer Twoody migrated: this one would read it wrong.
  if (version > SCHEMA_VERSION) throw new Error(`database at version ${version}, newer than this server (${SCHEMA_VERSION}): update Twoody`);
  const pending = MIGRATIONS.filter((migration) => migration.version > version);
  if (pending.length === 0) return;
  if (holdsData(sqlite)) {
    log(`[db] saving the database before migrating it from version ${version}: ${backupBefore(sqlite, dataDir, version)}`);
  }
  if (version === 0) legacyBaseline(sqlite);
  for (const migration of pending) {
    // Foreign keys are switched off while a migration rebuilds or renames
    // tables (they cannot be while a transaction is open), then checked.
    sqlite.pragma("foreign_keys = OFF");
    try {
      sqlite.transaction(() => {
        migration.up(sqlite);
        sqlite.pragma(`user_version = ${migration.version}`);
      })();
      const broken = sqlite.pragma("foreign_key_check") as unknown[];
      if (broken.length) log(`[db] migration ${migration.version} (${migration.name}): ${broken.length} rows point at nothing`);
    } finally {
      sqlite.pragma("foreign_keys = ON");
    }
    version = migration.version;
    log(`[db] migrated to version ${version} (${migration.name})`);
  }
}
