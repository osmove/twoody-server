// The local database encrypted at rest inside Twoody Desktop (12/10/2026):
// a key handed over by the Desktop (dbKeyHandOver.ts), local.db and its WAL
// encrypted page by page (SQLCipher 4 scheme, dbCipher.ts), and a clear
// database of an earlier version encrypted once, safely — a checked copy
// swapped in, the clear file put aside for the Trash, never deleted, every
// step taken up again after a stop. An encrypted database this run cannot
// open is never replaced by a new one.
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { EventEmitter } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  asidePath,
  clearBackups,
  clearCopiesIn,
  databaseFileState,
  DatabaseKeyError,
  encryptDatabaseFile,
  encryptedCacheKiB,
  openEncryptedDatabase,
  readyPath,
  useDatabaseKey,
  workPath,
} from "../src/dbCipher.ts";
import { databaseKeyFromDesktop, trashThroughDesktop } from "../src/dbKeyHandOver.ts";
import { DatabaseRefusal, encryptClearBackups, openLocalDatabase, trashClearCopies } from "../src/dbOpen.ts";
import { backupBefore } from "../src/migrations/index.ts";
import { heldOpen } from "./helpers/heldOpen.ts";

const KEY = "7e".repeat(32);
const OTHER = "c4".repeat(32);
const SECRET = "Zanzibar-portail-4317";
const quiet = () => undefined;
const ENV = { TWOODY_DB_KEY_STORE: "desktop" } as NodeJS.ProcessEnv;

function dir(): string {
  return mkdtempSync(join(tmpdir(), "twoody-db-cipher-"));
}

/// A clear database as an earlier version left it: WAL mode, rows still in
/// the WAL, a full-text index.
function clearDatabase(at: string, rows = 200): { path: string; open: Database.Database } {
  const path = join(at, "local.db");
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("wal_autocheckpoint = 0");
  db.pragma("user_version = 9");
  db.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY, content TEXT); CREATE VIRTUAL TABLE message_fts USING fts5(content, content='messages', content_rowid='id');");
  const insert = db.prepare("INSERT INTO messages (content) VALUES (?)");
  for (let i = 0; i < rows; i += 1) insert.run(`${SECRET} message ${i} ${"x".repeat(200)}`);
  db.exec("INSERT INTO message_fts(message_fts) VALUES ('rebuild')");
  return { path, open: db };
}

function closedClearDatabase(at: string, rows = 200): string {
  const { path, open } = clearDatabase(at, rows);
  open.close();
  return path;
}

/// A stand-in for Electron's process.parentPort, the Desktop at the other end.
function desktop(answer: ((request: { type: string; [key: string]: unknown }) => unknown) | null) {
  const toServer = new EventEmitter();
  const posted: Array<{ type: string; [key: string]: unknown }> = [];
  const port = {
    on: (event: "message", listener: (event: { data: unknown }) => void) => void toServer.on(event, listener),
    removeListener: (event: "message", listener: (event: { data: unknown }) => void) => void toServer.removeListener(event, listener),
    postMessage: (message: unknown) => {
      posted.push(message as { type: string });
      const reply = answer?.(message as { type: string });
      if (reply) queueMicrotask(() => toServer.emit("message", { data: reply }));
    },
  };
  return { port, posted };
}

const keyAnswer = (answer: Record<string, unknown>) => (message: { type: string }) => (message.type === "db-key-request" ? { type: "db-key", ...answer } : null);

test("a clear database is encrypted in place: same rows, nothing readable on disk, the clear file put aside", () => {
  const at = dir();
  const path = closedClearDatabase(at);
  assert.equal(databaseFileState(path), "clear");
  const result = encryptDatabaseFile(path, KEY, { log: quiet });
  assert.equal(result.state, "encrypted");
  if (result.state !== "encrypted") return;
  assert.equal(databaseFileState(path), "encrypted");
  assert.ok(!readFileSync(path).includes(Buffer.from(SECRET)), "the encrypted file holds the text in clear");
  // The clear file, put aside for the Trash, is the person's data as it was.
  assert.equal(result.aside.length, 1);
  assert.equal(databaseFileState(result.aside[0]!), "clear");
  assert.deepEqual(clearCopiesIn(at), result.aside);
  const db = openEncryptedDatabase(path, KEY);
  assert.equal((db.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n, 200);
  assert.equal(db.pragma("user_version", { simple: true }), 9);
  assert.equal((db.prepare("SELECT count(*) AS n FROM message_fts WHERE message_fts MATCH 'zanzibar'").get() as { n: number }).n, 200);
  // Written to afterwards, in WAL mode: the WAL is encrypted too.
  db.pragma("journal_mode = WAL");
  db.pragma("wal_autocheckpoint = 0");
  db.prepare("INSERT INTO messages (content) VALUES (?)").run("Le code de la cave est Tombouctou-9921");
  assert.ok(existsSync(`${path}-wal`));
  assert.ok(!readFileSync(`${path}-wal`).includes(Buffer.from("Tombouctou")), "the WAL holds the text in clear");
  db.close();
  // No half-made copy left.
  assert.deepEqual(readdirSync(at).filter((name) => name.endsWith(".encrypting") || name.endsWith(".encrypted")), []);
});

test("encrypting writes no other file of clear pages than the copy it encrypts (no rollback journal)", async () => {
  const at = dir();
  const path = closedClearDatabase(at, 400);
  const seen = new Set<string>();
  const watcher = watch(at, (_event, name) => name && seen.add(String(name)));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(encryptDatabaseFile(path, KEY, { log: quiet }).state, "encrypted");
  await new Promise((resolve) => setTimeout(resolve, 200));
  watcher.close();
  assert.deepEqual([...seen].filter((name) => /journal/.test(name)), []);
});

test("rows still in the WAL of a clear database are kept", () => {
  const at = dir();
  const { path, open } = clearDatabase(at, 50);
  // A crash: the WAL is left behind with rows the main file does not hold.
  copyFileSync(path, join(at, "snapshot.db"));
  copyFileSync(`${path}-wal`, join(at, "snapshot.db-wal"));
  open.close();
  renameSync(join(at, "snapshot.db"), path);
  renameSync(join(at, "snapshot.db-wal"), `${path}-wal`);
  const result = encryptDatabaseFile(path, KEY, { log: quiet });
  assert.equal(result.state, "encrypted");
  const db = openEncryptedDatabase(path, KEY);
  assert.equal((db.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n, 50);
  db.close();
});

test("the wrong key never opens it, and no key at all reads nothing", () => {
  const at = dir();
  const path = closedClearDatabase(at, 3);
  encryptDatabaseFile(path, KEY, { log: quiet });
  assert.throws(() => openEncryptedDatabase(path, OTHER), (error: unknown) => error instanceof DatabaseKeyError && error.reason === "key_mismatch");
  const bare = new Database(path);
  assert.throws(() => bare.prepare("SELECT count(*) FROM messages").get(), /not a database/);
  bare.close();
  // A key that is not 64 hex digits never reaches a PRAGMA.
  const db = new Database(join(at, "other.db"));
  assert.throws(() => useDatabaseKey(db, "x'; DROP TABLE messages; --"), /invalid database key/);
  db.close();
  assert.equal(encryptDatabaseFile(closedClearDatabase(dir(), 1), "nope").state, "failed");
});

test("without room for the copy, nothing changes", () => {
  const at = dir();
  const path = closedClearDatabase(at);
  const before = readFileSync(path);
  const result = encryptDatabaseFile(path, KEY, { log: quiet, freeBytes: () => 1024 });
  assert.equal(result.state, "no_space");
  assert.equal(databaseFileState(path), "clear");
  assert.ok(readFileSync(path).equals(before));
  assert.deepEqual(readdirSync(at).sort(), ["local.db"]);
});

test("cut off while the copy was being made or checked: started again from the clear file", () => {
  const at = dir();
  const path = closedClearDatabase(at);
  writeFileSync(workPath(path), "half an encrypted copy");
  writeFileSync(readyPath(path), "a copy checked against another state of the file");
  const result = encryptDatabaseFile(path, KEY, { log: quiet });
  assert.equal(result.state, "encrypted");
  const db = openEncryptedDatabase(path, KEY);
  assert.equal((db.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n, 200);
  db.close();
  assert.equal(existsSync(workPath(path)), false);
  assert.equal(existsSync(readyPath(path)), false);
});

test("cut off between the two renames: the checked copy is put in place at the next start", () => {
  const at = dir();
  const path = closedClearDatabase(at);
  // Played by hand: a checked encrypted copy waiting, the clear file aside.
  const other = join(dir(), "local.db");
  copyFileSync(path, other);
  encryptDatabaseFile(other, KEY, { log: quiet });
  copyFileSync(other, readyPath(path));
  renameSync(path, asidePath(path));
  const result = encryptDatabaseFile(path, KEY, { log: quiet });
  assert.equal(result.state, "resumed");
  assert.equal(databaseFileState(path), "encrypted");
  if (result.state === "resumed") assert.equal(result.aside.length, 1);
  const db = openEncryptedDatabase(path, KEY);
  assert.equal((db.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n, 200);
  db.close();
});

test("a clear file put aside with nothing in its place goes back, never an empty database in front of it", async () => {
  const at = dir();
  const path = closedClearDatabase(at);
  renameSync(path, asidePath(path));
  const { port } = desktop(keyAnswer({ state: "ok", hex: KEY }));
  const opened = await openLocalDatabase({ dbPath: path, port, env: ENV, log: quiet });
  assert.equal(opened.encryption, "encrypted");
  assert.equal((opened.sqlite.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n, 200);
  opened.sqlite.close();
});

test("inside the Desktop: the key is asked for, a clear database encrypted, the Desktop told", async () => {
  const at = dir();
  const path = closedClearDatabase(at);
  const { port, posted } = desktop(keyAnswer({ state: "ok", hex: KEY }));
  const opened = await openLocalDatabase({ dbPath: path, port, env: ENV, log: quiet });
  assert.equal(opened.encryption, "encrypted");
  assert.deepEqual(posted[0], { type: "db-key-request", database: "clear" });
  const told = posted.filter((m) => m.type === "db-encryption");
  assert.deepEqual(told.map((m) => m.state), ["running", "running", "running", "running", "running", "encrypted"]);
  // Each step, in order, for the Desktop's « Chiffrement de vos données… » (in a worker thread: this one stays free to say it).
  assert.deepEqual(told.slice(1, 5).map((m) => [m.phase, m.step, m.steps]), [["read", 1, 4], ["copy", 2, 4], ["encrypt", 3, 4], ["check", 4, 4]]);
  assert.ok(told.slice(1, 5).every((m) => typeof m.bytes === "number" && m.bytes > 0));
  // What goes to the Desktop never carries the key.
  assert.ok(!JSON.stringify(posted).includes(KEY));
  opened.sqlite.close();
  // The next start opens it with the same key, and says it is encrypted.
  const next = desktop(keyAnswer({ state: "ok", hex: KEY }));
  const again = await openLocalDatabase({ dbPath: path, port: next.port, env: ENV, log: quiet });
  assert.deepEqual(next.posted[0], { type: "db-key-request", database: "encrypted" });
  assert.equal(next.posted.some((m) => m.type === "db-encryption"), false);
  // Pages read are decrypted once, then served from SQLite's own cache.
  assert.equal(again.sqlite.pragma("cache_size", { simple: true }), -encryptedCacheKiB());
  again.sqlite.close();
});

test("a new installation starts encrypted", async () => {
  const at = dir();
  const path = join(at, "local.db");
  const { port, posted } = desktop(keyAnswer({ state: "ok", hex: KEY }));
  const opened = await openLocalDatabase({ dbPath: path, port, env: ENV, log: quiet });
  assert.deepEqual(posted[0], { type: "db-key-request", database: "absent" });
  opened.sqlite.pragma("journal_mode = WAL");
  opened.sqlite.exec(`CREATE TABLE notes (t TEXT); INSERT INTO notes VALUES ('${SECRET}')`);
  opened.sqlite.close();
  assert.equal(databaseFileState(path), "encrypted");
  assert.ok(!readFileSync(path).includes(Buffer.from(SECRET)));
});

test("without protected storage, or with the keyring locked, a clear database stays as it is", async () => {
  for (const state of ["unavailable", "locked"]) {
    const at = dir();
    const path = closedClearDatabase(at, 5);
    const { port } = desktop(keyAnswer({ state }));
    const opened = await openLocalDatabase({ dbPath: path, port, env: ENV, log: quiet });
    assert.equal(opened.encryption, "clear");
    assert.equal(opened.clearBecause, state);
    assert.equal((opened.sqlite.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n, 5);
    opened.sqlite.close();
    assert.equal(databaseFileState(path), "clear");
  }
});

test("an encrypted database this run cannot open: the server refuses to start, the file untouched", async () => {
  const at = dir();
  const path = closedClearDatabase(at, 5);
  encryptDatabaseFile(path, KEY, { log: quiet });
  const before = readFileSync(path);
  const cases: Array<[unknown, string]> = [
    [keyAnswer({ state: "locked" }), "locked"],
    [keyAnswer({ state: "unavailable" }), "unavailable"],
    [keyAnswer({ state: "lost" }), "lost"],
    // Malformed: never read as "no key".
    [keyAnswer({ state: "ok", hex: "short" }), "locked"],
    [keyAnswer({ state: "whatever" }), "locked"],
    [keyAnswer({ state: "ok", hex: OTHER }), "key_mismatch"],
  ];
  for (const [answer, reason] of cases) {
    const { port } = desktop(answer as (m: { type: string }) => unknown);
    await assert.rejects(openLocalDatabase({ dbPath: path, port, env: ENV, log: quiet }), (error: unknown) => error instanceof DatabaseRefusal && error.reason === reason);
  }
  // No answer at all counts as locked.
  await assert.rejects(openLocalDatabase({ dbPath: path, port: desktop(null).port, env: ENV, log: quiet, keyTimeoutMs: 50 }), (error: unknown) => error instanceof DatabaseRefusal && error.reason === "locked");
  // A server started without the Desktop's key store (an older Desktop, or on its own over the Desktop's folder).
  await assert.rejects(openLocalDatabase({ dbPath: path, port: null, env: {}, log: quiet }), (error: unknown) => error instanceof DatabaseRefusal && error.reason === "no_key_store");
  await assert.rejects(openLocalDatabase({ dbPath: path, port: desktop(null).port, env: {}, log: quiet }), (error: unknown) => error instanceof DatabaseRefusal && error.reason === "no_key_store");
  assert.ok(readFileSync(path).equals(before));
  assert.deepEqual(readdirSync(at).filter((name) => !name.includes(".unencrypted-")).sort(), ["local.db"]);
});

test("on its own (a Pi, `twoody serve`), the server keeps its database in clear and asks nothing", async () => {
  const at = dir();
  const path = closedClearDatabase(at, 2);
  const opened = await openLocalDatabase({ dbPath: path, port: null, env: {}, log: quiet });
  assert.equal(opened.encryption, "clear");
  assert.equal(opened.clearBecause, null);
  opened.sqlite.close();
  assert.equal(databaseFileState(path), "clear");
});

test("migration backups: a new one is encrypted with the database; the clear ones of earlier versions are encrypted, their clear copies sent to the Trash", async () => {
  const at = dir();
  const path = closedClearDatabase(at, 20);
  mkdirSync(join(at, "backups"));
  copyFileSync(path, join(at, "backups", "local-v6-2026-10-10T09-50-59-924Z.db"));
  copyFileSync(path, join(at, "backups", "local-v8-2026-10-11T06-11-04-286Z.db"));
  encryptDatabaseFile(path, KEY, { log: quiet });
  const db = openEncryptedDatabase(path, KEY);
  const fresh = backupBefore(db, at, 9);
  db.close();
  assert.equal(databaseFileState(fresh), "encrypted");
  assert.deepEqual(clearBackups(at).map((file) => basename(file)), ["local-v6-2026-10-10T09-50-59-924Z.db", "local-v8-2026-10-11T06-11-04-286Z.db"]);

  const trashed: string[] = [];
  const { port } = desktop((message) => {
    if (message.type !== "db-trash") return null;
    trashed.push(message.path as string);
    return { type: "db-trash-result", id: message.id, ok: true };
  });
  // The backups are encrypted by an unref'd worker (it never holds the server's exit).
  await heldOpen(encryptClearBackups(at, KEY, port, quiet));
  assert.deepEqual(clearBackups(at), []);
  for (const name of ["local-v6-2026-10-10T09-50-59-924Z.db", "local-v8-2026-10-11T06-11-04-286Z.db"]) {
    const backup = openEncryptedDatabase(join(at, "backups", name), KEY);
    assert.equal((backup.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n, 20);
    backup.close();
  }
  assert.equal(trashed.length, 2);
  assert.ok(trashed.every((file) => /\.unencrypted-[0-9TZ-]+\.db$/.test(file) && databaseFileState(file) === "clear"));

  // The main database's clear copy, still aside: asked to the Trash at each start until it is gone.
  const asked: string[] = [];
  const refusing = desktop((message) => (message.type === "db-trash" ? (asked.push(message.path as string), { type: "db-trash-result", id: message.id, ok: false }) : null));
  assert.equal(await trashClearCopies(at, refusing.port, quiet), 0);
  assert.ok(asked.some((file) => basename(file).startsWith("local.unencrypted-")));
});

test("the hand-over: a malformed or missing answer is never a key", async () => {
  assert.deepEqual(await databaseKeyFromDesktop(desktop(keyAnswer({ state: "ok", hex: KEY.toUpperCase() })).port, "clear"), { state: "locked" });
  assert.deepEqual(await databaseKeyFromDesktop(desktop(null).port, "clear", { timeoutMs: 20 }), { state: "locked" });
  assert.equal(await trashThroughDesktop(desktop(null).port, "/nowhere", { timeoutMs: 20 }), false);
});

test("the page cache of an encrypted database: 1/32 of the memory, between SQLite's 16 MB and 1 GB", () => {
  const GB = 1024 ** 3;
  assert.equal(encryptedCacheKiB(8 * GB), 262_144);
  assert.equal(encryptedCacheKiB(24 * GB), 786_432);
  assert.equal(encryptedCacheKiB(64 * GB), 1_048_576);
  assert.equal(encryptedCacheKiB(256 * 1024 ** 2), 16_000);
});
