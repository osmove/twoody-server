import type Database from "better-sqlite3-multiple-ciphers";
import { chmodSync, mkdirSync } from "fs";
import { join } from "path";
import { legacyBaseline } from "./baseline.js";
import { convergence } from "./0002_convergence.js";
import { titleSource } from "./0003_title_source.js";
import { emailsSchema } from "./0004_emails.js";
import { bank } from "./0005_bank.js";
import { isolatedProjects } from "./0006_isolated_projects.js";
import { retireClientFiles } from "./0007_retire_client_files.js";
import { folderShares } from "./0008_folder_shares.js";
import { documentGrams } from "./0009_document_grams.js";
import { people } from "./0010_people.js";
import { fileActions } from "./0011_file_actions.js";
import { peopleRemoved } from "./0012_people_removed.js";
import { folderShareNames } from "./0013_folder_share_names.js";
import { peopleRows } from "./0014_people_rows.js";
import { peerDocumentAudit } from "./0015_peer_document_audit.js";
import { walledFolderPlaces } from "./0016_walled_folder_places.js";
import { projectOverviews } from "./0017_project_overviews.js";
import { answerVotes } from "./0018_answer_votes.js";

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
  { version: 8, name: "folder_shares", up: folderShares },
  { version: 9, name: "document_grams", up: documentGrams },
  { version: 10, name: "people", up: people },
  { version: 11, name: "file_actions", up: fileActions },
  { version: 12, name: "people_removed", up: peopleRemoved },
  { version: 13, name: "folder_share_names", up: folderShareNames },
  { version: 14, name: "people_rows", up: (sqlite) => peopleRows(sqlite) },
  { version: 15, name: "peer_document_audit", up: peerDocumentAudit },
  { version: 16, name: "walled_folder_places", up: walledFolderPlaces },
  { version: 17, name: "project_overviews", up: projectOverviews },
  { version: 18, name: "answer_votes", up: answerVotes },
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

/// `upTo` stops at that version (tests: a database as an earlier Twoody left it).
export function migrate(
  sqlite: Database.Database,
  { dataDir, log = (line: string) => console.log(line), upTo = SCHEMA_VERSION }: { dataDir: string; dbPath?: string; log?: (line: string) => void; upTo?: number },
) {
  let version = schemaVersion(sqlite);
  // A database a newer Twoody migrated: this one would read it wrong.
  if (version > SCHEMA_VERSION) throw new Error(`database at version ${version}, newer than this server (${SCHEMA_VERSION}): update Twoody`);
  const pending = MIGRATIONS.filter((migration) => migration.version > version && migration.version <= upTo);
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
