import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

// Where the vault keeps what it must remember (docs/mesh-design.md §1):
//
//   headless (a Pi, a NAS)   DATA_DIR/vault.json (the device's keys, its
//                            vault device id, the epoch keys it was given)
//                            and DATA_DIR/vault-history.json (the outbox
//                            of sealed events, the pull cursor and the
//                            opened copy the local conversations come
//                            from), both 0600 from the first byte
//   inside Twoody Desktop    memory only: the Desktop keeps custody of the
//                            keys (safeStorage) and hands them over by
//                            message; nothing of the vault is written here
//
// The key/value shape is twoody-desktop's VaultStore, so that the ported
// sync logic (sync.ts) stays line for line the same.

export type VaultStore = { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> };

/// Written whole, through a temporary file, 0600 from the first byte.
export function writePrivateFile(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function readJsonFile(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/// Every key in one JSON file (0600). Reads are served from memory once
/// loaded; each write rewrites the file.
export function jsonFileStore(path: string): VaultStore & { clear(): void } {
  let values: Record<string, string> | null = null;
  const load = (): Record<string, string> => {
    if (values) return values;
    const raw = readJsonFile(path);
    values = raw && typeof raw === "object" && !Array.isArray(raw)
      ? Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
    return values;
  };
  return {
    async get(key) {
      return load()[key] ?? null;
    },
    async set(key, value) {
      const next = { ...load(), [key]: value };
      writePrivateFile(path, `${JSON.stringify(next)}\n`);
      values = next;
    },
    clear() {
      values = {};
      rmSync(path, { force: true });
    },
  };
}

/// The same, in memory: nothing reaches the disk.
export function memoryStore(): VaultStore & { clear(): void } {
  const values = new Map<string, string>();
  return {
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value) {
      values.set(key, value);
    },
    clear() {
      values.clear();
    },
  };
}
