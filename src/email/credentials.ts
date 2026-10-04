import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../db.js";

// The mailbox's password — an app password — kept as the connectors keep
// their tokens (connectors.json): on this computer, in a file of its own
// that only this account can read (0600), apart from the database and the
// copies saved before each migration. Never sent back to a screen, never
// given to a model, never written to a log. Removing the mailbox forgets
// it.

interface Kept {
  password: string;
  saved_at: number;
}

const FILE = () => join(DATA_DIR, "email-credentials.json");

function readAll(): Record<string, Kept> {
  try {
    const parsed = JSON.parse(readFileSync(FILE(), "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, Kept>) : {};
  } catch {
    return {};
  }
}

/// Written whole, then put in place: a crash never leaves half a file, and
/// the mode is the new file's own (a mode given to writeFileSync only
/// applies when it creates the file).
function writeAll(all: Record<string, Kept>) {
  const path = FILE();
  if (Object.keys(all).length === 0) {
    rmSync(path, { force: true });
    return;
  }
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(all, null, 2), { mode: 0o600 });
  try {
    chmodSync(temporary, 0o600);
  } catch {
    // Filesystems without POSIX modes.
  }
  renameSync(temporary, path);
}

export function mailPassword(sourceId: string): string | null {
  const kept = readAll()[sourceId];
  return typeof kept?.password === "string" && kept.password ? kept.password : null;
}

export function keepMailPassword(sourceId: string, password: string): void {
  writeAll({ ...readAll(), [sourceId]: { password, saved_at: Date.now() } });
}

export function forgetMailPassword(sourceId: string): void {
  const all = readAll();
  if (!(sourceId in all)) return;
  delete all[sourceId];
  writeAll(all);
}
