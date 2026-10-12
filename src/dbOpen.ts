import Database from "better-sqlite3-multiple-ciphers";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import {
  clearBackups,
  clearCopiesIn,
  DatabaseKeyError,
  encryptDatabaseFile,
  encryptedCacheKiB,
  ENCRYPTION_PHASES,
  openEncryptedDatabase,
  resumeEncryption,
  type EncryptionPhase,
  type EncryptionResult,
} from "./dbCipher.js";
import { databaseKeyFromDesktop, desktopKeepsDatabaseKey, trashThroughDesktop, type KeyParentPort } from "./dbKeyHandOver.js";
import { unsealedAsides } from "./secretFile.js";

// Opens local.db for db.ts: encrypted inside Twoody Desktop when it hands a
// key over (dbKeyHandOver.ts), in clear otherwise — and never a new, empty
// database in front of an encrypted one this run cannot open.

export type DatabaseEncryption = "encrypted" | "clear";

export interface OpenedDatabase {
  sqlite: Database.Database;
  encryption: DatabaseEncryption;
  /// Why it is in clear, inside the Desktop (for /health and the log).
  clearBecause: "no_key_store" | "unavailable" | "locked" | "no_space" | "failed" | null;
}

export class DatabaseRefusal extends Error {
  constructor(readonly reason: "locked" | "lost" | "unavailable" | "key_mismatch" | "no_key_store", message: string) {
    super(message);
  }
}

const REFUSALS: Record<DatabaseRefusal["reason"], string> = {
  locked: "the local database is encrypted and its key is sealed in a keyring that cannot be opened now: unlock the keyring (or allow Twoody in it), then open Twoody again",
  lost: "the local database is encrypted and this computer no longer keeps its key: it cannot be read. Nothing was changed",
  unavailable: "the local database is encrypted and this computer has no unlocked keyring to open its key: unlock the keyring, then open Twoody again",
  key_mismatch: "the local database does not open with the key this computer keeps. Nothing was changed",
  no_key_store: "the local database is encrypted: only Twoody Desktop, which keeps its key, can open it",
};

export async function openLocalDatabase({
  dbPath,
  port,
  env = process.env,
  log = (line: string) => console.log(line),
  keyTimeoutMs,
}: {
  dbPath: string;
  port: KeyParentPort | null;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  keyTimeoutMs?: number;
}): Promise<OpenedDatabase & { key: string | null }> {
  const { state } = resumeEncryption(dbPath, log);
  if (!port || !desktopKeepsDatabaseKey(env)) {
    if (state === "encrypted") throw new DatabaseRefusal("no_key_store", REFUSALS.no_key_store);
    return { sqlite: new Database(dbPath), encryption: "clear", clearBecause: port ? "no_key_store" : null, key: null };
  }
  const answer = await databaseKeyFromDesktop(port, state, keyTimeoutMs ? { timeoutMs: keyTimeoutMs } : undefined);
  if (answer.state !== "ok") {
    if (state === "encrypted") throw new DatabaseRefusal(answer.state, REFUSALS[answer.state]);
    if (answer.state === "locked") log("[db] the database key is sealed in a keyring that cannot be opened now: the database stays in clear for this run");
    else if (answer.state === "unavailable") log("[db] no protected storage on this computer: the database stays in clear (data_at_rest says whether its volume is encrypted)");
    return { sqlite: new Database(dbPath), encryption: "clear", clearBecause: answer.state === "lost" ? "locked" : answer.state, key: null };
  }
  const hex = answer.hex;
  if (state === "clear") {
    port.postMessage({ type: "db-encryption", state: "running" });
    log("[db] encrypting the local database (once)…");
    // Each step told to the Desktop, which shows it (« Chiffrement de vos
    // données sur cet ordinateur… »).
    const result = await encryptInWorker(dbPath, hex, (phase, bytes) => {
      port.postMessage({ type: "db-encryption", state: "running", phase, step: ENCRYPTION_PHASES.indexOf(phase) + 1, steps: ENCRYPTION_PHASES.length, bytes });
    }, log);
    port.postMessage({ type: "db-encryption", ...describe(result) });
    if (result.state === "no_space" || result.state === "failed") {
      log(result.state === "no_space"
        ? `[db] not enough free space to encrypt the database (${mb(result.needed)} needed, ${mb(result.free)} free): it stays in clear for this run`
        : `[db] the database could not be encrypted (${result.reason}): it stays in clear for this run, unchanged`);
      return { sqlite: new Database(dbPath), encryption: "clear", clearBecause: result.state, key: null };
    }
    if (result.state === "encrypted") log(`[db] the local database is encrypted (${result.tables} tables, ${result.rows} rows, ${mb(result.bytes)} in ${(result.ms / 1000).toFixed(1)} s: read ${result.phases.read} ms, copy ${result.phases.copy} ms, encrypt ${result.phases.encrypt} ms, check ${result.phases.check} ms); its clear copy goes to the Trash`);
  }
  try {
    const sqlite = openEncryptedDatabase(dbPath, hex);
    sqlite.pragma(`cache_size = -${encryptedCacheKiB()}`);
    return { sqlite, encryption: "encrypted", clearBecause: null, key: hex };
  } catch (error) {
    if (error instanceof DatabaseKeyError) throw new DatabaseRefusal("key_mismatch", REFUSALS.key_mismatch);
    throw error;
  }
}

/// encryptDatabaseFile in a worker thread, so that this thread stays free to
/// pass its steps on to the Desktop; in this thread if the worker cannot
/// run (the encryption takes up where a stopped worker left it).
export function encryptInWorker(path: string, hex: string, onPhase: (phase: EncryptionPhase, bytes: number) => void, log: (line: string) => void = () => undefined): Promise<EncryptionResult> {
  return new Promise((resolve) => {
    let settled = false;
    const inThread = (why: string) => {
      if (settled) return;
      settled = true;
      log(`[db] the encryption worker stopped (${why}): encrypting in the server's own thread`);
      resolve(encryptDatabaseFile(path, hex, { log, onPhase }));
    };
    let worker: Worker;
    try {
      worker = new Worker(new URL("./dbCipherWorker.js", import.meta.url), { workerData: { paths: [path], hex } });
    } catch (error) {
      inThread(error instanceof Error ? error.message : String(error));
      return;
    }
    worker.on("message", (message: { type?: string; phase?: EncryptionPhase; bytes?: number; result?: EncryptionResult }) => {
      if (message.type === "phase" && message.phase) onPhase(message.phase, message.bytes ?? 0);
      else if (message.type === "result" && message.result && !settled) {
        settled = true;
        resolve(message.result);
      }
    });
    worker.on("error", (error) => inThread(error.message));
    worker.on("exit", (code) => inThread(`exit ${code}`));
  });
}

function mb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function describe(result: EncryptionResult): Record<string, unknown> {
  switch (result.state) {
    case "encrypted":
      return { state: "encrypted", ms: result.ms, bytes: result.bytes, tables: result.tables, rows: result.rows, phases: result.phases };
    case "no_space":
      return { state: "no_space", needed: result.needed, free: result.free };
    case "failed":
      return { state: "failed" };
    default:
      return { state: "encrypted" };
  }
}

/// The clear copies put aside here and in backups/, moved to the Trash by
/// the Desktop one by one; what it cannot move stays, and is asked again at
/// the next start.
export async function trashClearCopies(dataDir: string, port: KeyParentPort, log: (line: string) => void = (line) => console.log(line)): Promise<number> {
  let moved = 0;
  for (const path of [...clearCopiesIn(dataDir), ...clearCopiesIn(join(dataDir, "backups"))]) {
    if (await trashThroughDesktop(port, path)) moved += 1;
    else log(`[db] a clear copy put aside could not be moved to the Trash; asked again at the next start`);
  }
  return moved;
}

/// The folders the secret files' clear copies were put in when they were
/// sealed (secretFile.ts sealSecretFilesInPlace), moved to the Trash by the
/// Desktop; what it cannot move stays, asked again at the next start.
export async function trashUnsealedSecrets(dataDir: string, port: KeyParentPort, log: (line: string) => void = (line) => console.log(line)): Promise<number> {
  let moved = 0;
  for (const path of unsealedAsides(dataDir)) {
    if (await trashThroughDesktop(port, path)) moved += 1;
    else log(`[secrets] the clear copies of sealed secret files could not be moved to the Trash; asked again at the next start`);
  }
  return moved;
}

/// The migration backups earlier versions wrote in clear, encrypted with the
/// same key one by one, in a worker thread (the work is synchronous and
/// takes seconds per file: the server keeps answering meanwhile). Their
/// clear copies go to the Trash as each is done.
export function encryptClearBackups(dataDir: string, hex: string, port: KeyParentPort, log: (line: string) => void = (line) => console.log(line)): Promise<void> {
  const paths = clearBackups(dataDir);
  if (paths.length === 0) return Promise.resolve();
  log(`[db] encrypting ${paths.length} migration backup(s) written in clear by earlier versions, in the background`);
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./dbCipherWorker.js", import.meta.url), { workerData: { paths, hex } });
    worker.unref();
    const trashing: Promise<unknown>[] = [];
    worker.on("message", (message: { type?: string; path: string; result?: EncryptionResult }) => {
      if (message.type !== "result" || !message.result) return;
      const { result } = message;
      if (result.state === "encrypted" || result.state === "resumed") {
        for (const aside of result.aside) trashing.push(trashThroughDesktop(port, aside).then((ok) => ok || log("[db] a clear backup put aside could not be moved to the Trash; asked again at the next start")));
      } else if (result.state === "no_space") {
        log(`[db] not enough free space to encrypt a migration backup (${mb(result.needed)} needed): it stays in clear for now`);
      } else if (result.state === "failed") {
        log(`[db] a migration backup could not be encrypted (${result.reason}): it stays as it was`);
      }
    });
    const done = () => void Promise.all(trashing).then(() => resolve());
    worker.on("error", (error) => {
      log(`[db] encrypting the migration backups stopped: ${error.message}`);
      done();
    });
    worker.on("exit", done);
  });
}
