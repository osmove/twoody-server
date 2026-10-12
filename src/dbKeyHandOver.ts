import { randomUUID } from "node:crypto";
import { isDatabaseKey, type DatabaseFile } from "./dbCipher.js";

// The local database's key inside Twoody Desktop (twoody-desktop
// src/main/databaseKey.ts): made and sealed there by safeStorage, handed to
// this process at start, never written to a file nor put in the
// environment here. The Desktop says it keeps it with
// TWOODY_DB_KEY_STORE=desktop; a server started without it (a Pi, `twoody
// serve`, an older Desktop) keeps its database in clear.
//
// The exchange, once, before the database is opened (db.ts):
//   server  → Desktop  {type: "db-key-request", database: absent|clear|encrypted}
//   Desktop → server   {type: "db-key", state, hex?}
//       "ok"           the key: the one sealed, or one made, sealed and read
//                      back before it is handed over (only for a database
//                      that is absent or clear)
//       "unavailable"  no protected storage on this computer (Linux without
//                      a keyring), or the key could not be sealed: the
//                      database stays in clear, as the tunnel key stays in
//                      its file
//       "locked"       a sealed key the Desktop cannot open now
//       "lost"         the database is encrypted and no key is kept
// No answer within the timeout counts as "locked". An encrypted database
// opens with "ok" only; anything else and the server does not start rather
// than make a new, empty one in its place.
//
// Then, as the server goes:
//   server  → Desktop  {type: "db-encryption", state: running|encrypted|no_space|failed, …}
//       while a clear database is encrypted (the Desktop waits longer for it)
//   server  → Desktop  {type: "db-trash", id, path}  a clear copy put aside
//   Desktop → server   {type: "db-trash-result", id, ok}
//   server  → Desktop  {type: "db-refused", reason}  just before it stops

export interface KeyParentPort {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  removeListener?(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

export type DatabaseKeyAnswer = { state: "ok"; hex: string } | { state: "unavailable" } | { state: "locked" } | { state: "lost" };

export function desktopKeepsDatabaseKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TWOODY_DB_KEY_STORE === "desktop";
}

/// Electron's port to the Desktop's main process, when this server runs
/// inside it.
export function desktopParentPort(): KeyParentPort | null {
  return ((process as unknown as { parentPort?: KeyParentPort }).parentPort ?? null);
}

export function databaseKeyFromDesktop(port: KeyParentPort, database: DatabaseFile, { timeoutMs = 60_000 } = {}): Promise<DatabaseKeyAnswer> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (answer: DatabaseKeyAnswer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      port.removeListener?.("message", listener);
      resolve(answer);
    };
    const listener = ({ data }: { data: unknown }) => {
      const message = (data ?? {}) as { type?: unknown; state?: unknown; hex?: unknown };
      if (message.type !== "db-key") return;
      if (message.state === "ok" && isDatabaseKey(message.hex)) finish({ state: "ok", hex: message.hex });
      else if (message.state === "unavailable" || message.state === "lost") finish({ state: message.state });
      // "locked", or anything malformed: never read as "no key".
      else finish({ state: "locked" });
    };
    // A keychain prompt may wait for the person: a minute.
    const timer = setTimeout(() => finish({ state: "locked" }), timeoutMs);
    port.on("message", listener);
    port.postMessage({ type: "db-key-request", database });
  });
}

/// Asks the Desktop to move a clear copy put aside to the Trash (this process
/// cannot reach it); false when it could not, or did not answer.
export function trashThroughDesktop(port: KeyParentPort, path: string, { timeoutMs = 60_000 } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const id = randomUUID();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      port.removeListener?.("message", listener);
      resolve(ok);
    };
    const listener = ({ data }: { data: unknown }) => {
      const message = (data ?? {}) as { type?: unknown; id?: unknown; ok?: unknown };
      if (message.type === "db-trash-result" && message.id === id) finish(message.ok === true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    port.on("message", listener);
    port.postMessage({ type: "db-trash", id, path });
  });
}
