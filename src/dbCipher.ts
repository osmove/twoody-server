import Database from "better-sqlite3-multiple-ciphers";
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, openSync, readSync, readdirSync, renameSync, rmSync, statSync, statfsSync } from "node:fs";
import { totalmem } from "node:os";
import { basename, dirname, join } from "node:path";

// The local database encrypted at rest (12/10/2026, docs/encrypted-storage.md
// « Twoody Desktop »). Inside Twoody Desktop, local.db — conversations,
// memories, the document index and its vectors, e-mails, traces with their
// prompts — and its -wal are encrypted page by page with a 256-bit key the
// Desktop keeps sealed by safeStorage (Keychain, DPAPI, libsecret) and hands
// over at start (dbKeyHandOver.ts). A server on its own (a Pi, `twoody
// serve`) has no one to unlock a key and keeps its database in clear: its
// protection is the volume (dataAtRest.ts).
//
// The driver is better-sqlite3 built with SQLite3 Multiple Ciphers, in its
// SQLCipher 4 scheme: AES-256-CBC per 4096-byte page, HMAC-SHA512 per page,
// a random IV per page write. The key is raw (x'…'): 256 random bits need no
// PBKDF2, which SQLCipher skips for raw keys. A file made so opens in
// SQLCipher 4 itself with `PRAGMA key = "x'<hex>'"` (debugging, AGENTS.md §7).
//
// A database an earlier version wrote in clear is encrypted once, at the
// first start with a key (encryptDatabaseFile): a copy encrypted and checked
// next to it, then swapped in; the clear file is put aside, for the Desktop
// to move to the Trash — never deleted (root AGENTS.md rule 6). Each step can
// be cut off and taken up again at the next start.

export type DatabaseFile = "absent" | "clear" | "encrypted";

const CLEAR_HEADER = Buffer.from("SQLite format 3\0", "latin1");
/// The cipher scheme, set before the key on every connection.
const CIPHER = ["cipher = 'sqlcipher'", "legacy = 4"];
const HEX_KEY = /^[0-9a-f]{64}$/;

export function isDatabaseKey(value: unknown): value is string {
  return typeof value === "string" && HEX_KEY.test(value);
}

/// What a database file is, by its first 16 bytes: an encrypted file starts
/// with its salt, never with SQLite's header. An empty file is a new one.
export function databaseFileState(path: string): DatabaseFile {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  try {
    const head = Buffer.alloc(16);
    const read = readSync(fd, head, 0, 16, 0);
    if (read === 0) return "absent";
    return read === 16 && head.equals(CLEAR_HEADER) ? "clear" : "encrypted";
  } finally {
    closeSync(fd);
  }
}

/// Sets the cipher and the key on a connection just opened, before anything
/// reads the file.
export function useDatabaseKey(sqlite: Database.Database, hex: string): void {
  if (!isDatabaseKey(hex)) throw new Error("invalid database key");
  for (const pragma of CIPHER) sqlite.pragma(pragma);
  sqlite.pragma(`key = "x'${hex}'"`);
}

/// SQLite's page cache for an encrypted database, in KiB. A page read from
/// the file is decrypted and its HMAC checked (this build's AES is in
/// software: SQLITE3MC_OMIT_AES_HARDWARE_SUPPORT); a page in the cache is
/// read as in clear, faster than from the system's file cache. With
/// SQLite's default 16 MB, a document search on a large index (Jimmy's:
/// 250,000 passages, 600 MB) took up to ten times as long as in clear; with
/// a cache that holds what the searches read, no longer than in clear once
/// read (scripts/db-encryption-bench.ts, 12/10/2026). The cache only grows
/// with the pages read — never beyond the database — so a small database
/// costs no more: 1/32 of the memory, 1 GB at most.
export function encryptedCacheKiB(totalMemory = totalmem()): number {
  return Math.max(16_000, Math.min(1_048_576, Math.floor(totalMemory / 32 / 1024)));
}

export class DatabaseKeyError extends Error {
  constructor(readonly reason: "key_mismatch" | "no_key", message: string) {
    super(message);
  }
}

/// An encrypted database, opened and read once: the wrong key fails here
/// (SQLITE_NOTADB), not at the first query.
export function openEncryptedDatabase(path: string, hex: string, options: Database.Options = {}): Database.Database {
  const sqlite = new Database(path, options);
  try {
    useDatabaseKey(sqlite, hex);
    sqlite.prepare("SELECT count(*) FROM sqlite_master").get();
    return sqlite;
  } catch (error) {
    sqlite.close();
    if ((error as { code?: string }).code === "SQLITE_NOTADB") {
      throw new DatabaseKeyError("key_mismatch", `${basename(path)} does not open with the key this computer keeps`);
    }
    throw error;
  }
}

// ── encrypting a clear file ──────────────────────────────────────────────────

/// local.db → local.db.encrypting (being made), local.db.encrypted (checked,
/// waiting to be swapped in), local.unencrypted-<stamp>.db (the clear file,
/// put aside for the Trash).
export const workPath = (path: string) => `${path}.encrypting`;
export const readyPath = (path: string) => `${path}.encrypted`;
const ASIDE = /\.unencrypted-[0-9TZ-]+\.db(-wal|-shm|-journal)?$/;

export function asidePath(path: string, now = new Date()): string {
  const name = basename(path).replace(/\.db$/, "");
  return join(dirname(path), `${name}.unencrypted-${now.toISOString().replace(/[:.]/g, "-")}.db`);
}

/// Clear copies put aside in this folder, for the Trash.
export function clearCopiesIn(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => ASIDE.test(name)).map((name) => join(dir, name));
  } catch {
    return [];
  }
}

export function isClearCopyName(name: string): boolean {
  return ASIDE.test(name);
}

export type EncryptionResult =
  | { state: "encrypted"; aside: string[]; ms: number; bytes: number; tables: number; rows: number; phases: Record<"read" | "copy" | "encrypt" | "check", number> }
  | { state: "resumed"; aside: string[] }
  | { state: "already" }
  | { state: "no_space"; needed: number; free: number }
  | { state: "failed"; reason: string };

export interface EncryptOptions {
  log?: (line: string) => void;
  /// Free bytes on the folder's volume (tests).
  freeBytes?: (dir: string) => number;
  now?: () => Date;
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function freeBytesOf(dir: string): number {
  const stats = statfsSync(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

function remove(path: string) {
  // Only this module's own half-made copies (encrypted, or a copy of the
  // clear file still in place): never the person's data itself.
  rmSync(path, { force: true });
  for (const suffix of ["-wal", "-shm", "-journal"]) rmSync(`${path}${suffix}`, { force: true });
}

function syncFile(path: string) {
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncDir(dir: string) {
  // Windows cannot open a folder to flush it; its renames are journaled.
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // best effort
  }
}

/// Row counts of every stored table (virtual tables are counted through
/// their shadow tables), and the schema version.
export function tableCounts(sqlite: Database.Database): { counts: Map<string, number>; version: number } {
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND (sql IS NULL OR sql NOT LIKE 'CREATE VIRTUAL TABLE%') ORDER BY name")
    .all() as Array<{ name: string }>;
  const counts = new Map<string, number>();
  for (const { name } of tables) {
    counts.set(name, Number((sqlite.prepare(`SELECT count(*) AS n FROM "${name.replace(/"/g, '""')}"`).get() as { n: number }).n));
  }
  return { counts, version: Number(sqlite.pragma("user_version", { simple: true })) || 0 };
}

/// Takes up an encryption cut off between its renames: the checked copy is
/// put in place when the clear file has already been put aside. A clear
/// file put aside with nothing to take its place goes back (never a new,
/// empty database in front of the person's data).
export function resumeEncryption(path: string, log: (line: string) => void = () => undefined): { state: DatabaseFile; resumed: boolean } {
  let state = databaseFileState(path);
  if (state !== "absent") return { state, resumed: false };
  if (existsSync(readyPath(path)) && databaseFileState(readyPath(path)) === "encrypted") {
    renameSync(readyPath(path), path);
    syncDir(dirname(path));
    log(`[db] the encrypted copy checked before the last stop is now ${basename(path)}`);
    return { state: "encrypted", resumed: true };
  }
  const stem = basename(path).replace(/\.db$/, "");
  const aside = clearCopiesIn(dirname(path))
    .filter((file) => basename(file).startsWith(`${stem}.unencrypted-`) && file.endsWith(".db"))
    .sort()
    .pop();
  if (aside && databaseFileState(aside) === "clear") {
    renameSync(aside, path);
    syncDir(dirname(path));
    log(`[db] ${basename(path)} was missing: its clear copy put aside is back in its place`);
    state = "clear";
  }
  return { state, resumed: false };
}

/// Encrypts a clear database file in place, safely: checkpoint, copy,
/// encrypt the copy (SQLite3 Multiple Ciphers' rekey), check that the copy
/// opens with the key, passes quick_check and holds the same rows in every
/// table at the same schema version, then swap. The clear file is put aside
/// (`aside`), for the caller to move to the Trash. Nobody else may have the
/// file open meanwhile.
export function encryptDatabaseFile(path: string, hex: string, options: EncryptOptions = {}): EncryptionResult {
  const log = options.log ?? (() => undefined);
  const dir = dirname(path);
  if (!isDatabaseKey(hex)) return { state: "failed", reason: "invalid database key" };
  const { state, resumed } = resumeEncryption(path, log);
  if (state === "encrypted") return resumed ? { state: "resumed", aside: clearCopiesIn(dir).filter((file) => basename(file).startsWith(`${basename(path).replace(/\.db$/, "")}.unencrypted-`)) } : { state: "already" };
  if (state === "absent") return { state: "already" };
  const started = performance.now();
  // Half-made copies of an earlier try: started again from the clear file.
  remove(workPath(path));
  remove(readyPath(path));

  // The copy needs the room of the file and its WAL, with some margin.
  const needed = Math.ceil((sizeOf(path) + sizeOf(`${path}-wal`)) * 1.05) + 16 * 1024 * 1024;
  const free = (options.freeBytes ?? freeBytesOf)(dir);
  if (free < needed) return { state: "no_space", needed, free };

  let before: ReturnType<typeof tableCounts>;
  const phases = { read: 0, copy: 0, encrypt: 0, check: 0 };
  let mark = performance.now();
  const lap = (phase: keyof typeof phases) => {
    const now = performance.now();
    phases[phase] = Math.round(now - mark);
    mark = now;
  };
  try {
    // Everything the WAL holds goes into the file first; closing the last
    // connection then removes the WAL.
    const clear = new Database(path);
    try {
      clear.pragma("wal_checkpoint(TRUNCATE)");
      before = tableCounts(clear);
    } finally {
      clear.close();
    }
    if (sizeOf(`${path}-wal`) > 0) return { state: "failed", reason: "the database's WAL could not be emptied: is another Twoody running?" };
    lap("read");

    copyFileSync(path, workPath(path));
    try {
      chmodSync(workPath(path), 0o600);
    } catch {
      // Filesystems without POSIX modes.
    }
    lap("copy");
    const work = new Database(workPath(path));
    try {
      // rekey cannot run in WAL mode.
      work.pragma("journal_mode = DELETE");
      for (const pragma of CIPHER) work.pragma(pragma);
      work.pragma(`rekey = "x'${hex}'"`);
    } finally {
      work.close();
    }

    lap("encrypt");
    if (databaseFileState(workPath(path)) !== "encrypted") throw new Error("the copy is still in clear after rekey");
    const check = openEncryptedDatabase(workPath(path), hex);
    try {
      const quick = check.pragma("quick_check", { simple: true });
      if (quick !== "ok") throw new Error(`quick_check: ${String(quick)}`);
      const after = tableCounts(check);
      if (after.version !== before.version) throw new Error(`schema version ${after.version} ≠ ${before.version}`);
      for (const [table, rows] of before.counts) {
        if (after.counts.get(table) !== rows) throw new Error(`${table}: ${after.counts.get(table) ?? "missing"} rows ≠ ${rows}`);
      }
      if (after.counts.size !== before.counts.size) throw new Error(`${after.counts.size} tables ≠ ${before.counts.size}`);
      // Back to WAL, as the server runs it.
      check.pragma("journal_mode = WAL");
    } finally {
      check.close();
    }
    syncFile(workPath(path));
    lap("check");
    renameSync(workPath(path), readyPath(path));
    syncDir(dir);
  } catch (error) {
    remove(workPath(path));
    remove(readyPath(path));
    return { state: "failed", reason: error instanceof Error ? error.message : String(error) };
  }

  // The swap: the clear file aside, then the checked copy in its place.
  // Cut off between the two, resumeEncryption finishes it.
  const aside = asidePath(path, options.now?.() ?? new Date());
  const moved: string[] = [];
  renameSync(path, aside);
  moved.push(aside);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${path}${suffix}`)) {
      renameSync(`${path}${suffix}`, `${aside}${suffix}`);
      moved.push(`${aside}${suffix}`);
    }
  }
  renameSync(readyPath(path), path);
  syncDir(dir);
  const rows = [...before.counts.values()].reduce((sum, count) => sum + count, 0);
  return { state: "encrypted", aside: moved, ms: Math.round(performance.now() - started), bytes: sizeOf(path), tables: before.counts.size, rows, phases };
}

/// The migration backups (migrations/index.ts backupBefore) earlier versions
/// wrote in clear: each a whole copy of the database.
export function clearBackups(dataDir: string): string[] {
  const dir = join(dataDir, "backups");
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".db") && !ASIDE.test(name))
      .map((name) => join(dir, name))
      .filter((path) => databaseFileState(path) === "clear")
      .sort();
  } catch {
    return [];
  }
}
