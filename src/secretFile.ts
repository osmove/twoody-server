import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

// The embedded server's secret files sealed at rest (12/10/2026,
// docs/encrypted-storage.md « Secret files »). Inside Twoody Desktop the
// files that hold the person's secrets next to the database — the
// connectors' OAuth tokens (connectors.json), a mailbox's password or
// refresh token (email-credentials.json), Google's and Microsoft's refresh
// tokens (google-data.json, microsoft-graph.json), the pairing key
// (account.json), the person's name and granted folders (warm-seeds.json) —
// are encrypted with a key derived from the database key the Desktop hands
// over (dbKeyHandOver.ts): HKDF-SHA256 with an info of its own per file,
// then AES-256-GCM (96-bit random nonce, 128-bit tag, the file's name as
// associated data, so a sealed file put in another's place does not open).
// The same algorithms as the tunnel's and the pairing envelope's: nothing
// new to declare but their use for storage.
//
// A server on its own (a Pi, `twoody serve`) has no key: its files stay as
// they were, 0600, its protection the volume (dataAtRest.ts).
//
// A clear file of an earlier version is sealed in place at start
// (sealSecretFilesInPlace): the sealed text written next to it, flushed,
// read back and compared, then the clear file moved into a folder put aside
// for the Desktop to move to the Trash — never deleted (root AGENTS.md rule
// 6) — and the sealed one put in its place. Cut off anywhere, the next start
// takes it up.
//
// Twoody Desktop seals its own Twoody Code sessions the same way
// (twoody-desktop src/main/secretFile.ts, same format, same test vector).

const VERSION = "twoody/secret-file/v1";
const SALT = Buffer.from("twoody secret files", "utf8");

/// The files the embedded server seals, each by its name in DATA_DIR.
export const SECRET_FILES = ["connectors.json", "email-credentials.json", "google-data.json", "microsoft-graph.json", "account.json", "warm-seeds.json"] as const;

export interface SealedEnvelope {
  twoody: "sealed-file";
  v: 1;
  alg: "HKDF-SHA256+AES-256-GCM";
  iv: string;
  tag: string;
  data: string;
}

export class SecretFileLockedError extends Error {
  readonly code = "secret_file_locked";
  constructor(name: string) {
    super(`${name} is sealed and this run has no key to open it`);
  }
}

let rootKey: Buffer | null = null;

/// The database key (64 hex), handed over by the Desktop: from now on the
/// secret files are sealed with keys derived from it.
export function useSecretFileKey(hex: string | null): void {
  rootKey = hex && /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, "hex") : null;
}

export function secretFilesSealed(): boolean {
  return rootKey !== null;
}

/// HKDF-SHA256 of the database key, its info naming the file: one key per
/// file, none of them the database's.
export function fileKey(root: Buffer, name: string): Buffer {
  return Buffer.from(hkdfSync("sha256", root, SALT, Buffer.from(`${VERSION}:${name}`, "utf8"), 32));
}

export function sealText(root: Buffer, name: string, text: string, iv: Buffer = randomBytes(12)): string {
  const cipher = createCipheriv("aes-256-gcm", fileKey(root, name), iv);
  cipher.setAAD(Buffer.from(`${VERSION}:${name}`, "utf8"));
  const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const envelope: SealedEnvelope = { twoody: "sealed-file", v: 1, alg: "HKDF-SHA256+AES-256-GCM", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
  return JSON.stringify(envelope);
}

/// A file's text as written: sealed, or not.
export function isSealedText(raw: string): boolean {
  if (!raw.startsWith('{"twoody":"sealed-file"')) return false;
  try {
    const parsed = JSON.parse(raw) as Partial<SealedEnvelope>;
    return parsed.twoody === "sealed-file";
  } catch {
    return false;
  }
}

export function openText(root: Buffer, name: string, raw: string): string {
  const envelope = JSON.parse(raw) as Partial<SealedEnvelope>;
  if (envelope.twoody !== "sealed-file" || envelope.v !== 1 || envelope.alg !== "HKDF-SHA256+AES-256-GCM" || typeof envelope.iv !== "string" || typeof envelope.tag !== "string" || typeof envelope.data !== "string") {
    throw new Error(`${name}: not a sealed file this version reads`);
  }
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  if (iv.length !== 12 || tag.length !== 16) throw new Error(`${name}: malformed sealed file`);
  const decipher = createDecipheriv("aes-256-gcm", fileKey(root, name), iv);
  decipher.setAAD(Buffer.from(`${VERSION}:${name}`, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8");
}

/// A secret file's text, opened when sealed; null when there is none.
/// Throws SecretFileLockedError for a sealed file this run cannot open (the
/// caller must not write over it).
export function readSecretFile(path: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!isSealedText(raw)) return raw;
  if (!rootKey) throw new SecretFileLockedError(basename(path));
  return openText(rootKey, basename(path), raw);
}

/// Whether the file at `path` is sealed and this run cannot open it.
export function secretFileLocked(path: string): boolean {
  if (rootKey) return false;
  try {
    return isSealedText(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

/// What to write at `path` (or at a temporary file put there after): sealed
/// when this run has the key, as given otherwise — never over a sealed file
/// it cannot open.
export function secretFileContent(path: string, text: string): string {
  const name = basename(path);
  if (rootKey) return sealText(rootKey, name, text);
  if (secretFileLocked(path)) throw new SecretFileLockedError(name);
  return text;
}

/// Written whole through a temporary file, 0600 from the first byte.
export function writeSecretFile(path: string, text: string): void {
  const content = secretFileContent(path, text);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  try {
    chmodSync(temporary, 0o600);
  } catch {
    // Filesystems without POSIX modes.
  }
  renameSync(temporary, path);
}

/// The file removed at the person's request (a link undone): never a sealed
/// file this run cannot read, which it would only be guessing about.
export function removeSecretFile(path: string): void {
  if (secretFileLocked(path)) throw new SecretFileLockedError(basename(path));
  rmSync(path, { force: true });
}

// ── sealing the clear files of an earlier version ───────────────────────────

const ASIDE = /^secrets\.unsealed-[0-9TZ-]+$/;

export function isUnsealedAsideName(name: string): boolean {
  return ASIDE.test(name);
}

/// The folders of clear copies put aside in `dataDir`, oldest first, for
/// the Trash (one left by a start cut off is asked again).
export function unsealedAsides(dataDir: string): string[] {
  try {
    return readdirSync(dataDir).filter((name) => ASIDE.test(name)).sort().map((name) => join(dataDir, name));
  } catch {
    return [];
  }
}

function syncPath(path: string, flags = "r+") {
  try {
    const fd = openSync(path, flags);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Windows cannot open a folder to flush it; its renames are journaled.
  }
}

export interface SealResult {
  /// Files sealed in this run.
  sealed: string[];
  /// The folder their clear copies were put in, for the Trash (null: none).
  aside: string | null;
  failed: Array<{ name: string; reason: string }>;
}

/// Seals in place, with the key of this run, every secret file still in
/// clear in `dataDir`. Each: sealed text written to `<name>.sealing`,
/// flushed, read back and compared, then the clear file moved into
/// `secrets.unsealed-<stamp>/` and the sealed one renamed in its place. A
/// file that fails stays as it was.
export function sealSecretFilesInPlace(dataDir: string, names: readonly string[] = SECRET_FILES, { now = new Date(), log = () => undefined }: { now?: Date; log?: (line: string) => void } = {}): SealResult {
  const result: SealResult = { sealed: [], aside: null, failed: [] };
  if (!rootKey) return result;
  const root = rootKey;
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  for (const name of names) {
    const path = join(dataDir, name);
    const sealing = `${path}.sealing`;
    try {
      // Cut off between the two renames: the checked sealed copy goes in.
      if (!existsSync(path) && existsSync(sealing)) {
        try {
          openText(root, name, readFileSync(sealing, "utf8"));
          renameSync(sealing, path);
          syncPath(dataDir, "r");
          log(`[secrets] ${name}: the sealed copy checked before the last stop is now in place`);
          continue;
        } catch {
          // Not one that opens: the clear file put aside goes back, below.
        }
      }
      // Only when a sealing was under way: a file the person had removed
      // never comes back.
      if (!existsSync(path) && existsSync(sealing)) {
        const back = unsealedAsides(dataDir).map((dir) => join(dir, name)).filter((file) => existsSync(file)).pop();
        if (back) {
          renameSync(back, path);
          rmSync(sealing, { force: true });
          log(`[secrets] ${name} was missing: its clear copy put aside is back in its place`);
        }
      }
      if (!existsSync(path)) continue;
      const clear = readFileSync(path, "utf8");
      if (isSealedText(clear)) {
        rmSync(sealing, { force: true });
        continue;
      }
      const sealed = sealText(root, name, clear);
      writeFileSync(sealing, sealed, { mode: 0o600 });
      try {
        chmodSync(sealing, 0o600);
      } catch {
        // Filesystems without POSIX modes.
      }
      syncPath(sealing);
      if (openText(root, name, readFileSync(sealing, "utf8")) !== clear) throw new Error("the sealed copy does not read back the same");
      if (!result.aside) {
        result.aside = join(dataDir, `secrets.unsealed-${stamp}`);
        mkdirSync(result.aside, { recursive: true, mode: 0o700 });
      }
      renameSync(path, join(result.aside, name));
      renameSync(sealing, path);
      syncPath(dataDir, "r");
      result.sealed.push(name);
    } catch (error) {
      // Only this function's own sealed copy goes; the clear file stays.
      if (existsSync(path)) rmSync(sealing, { force: true });
      result.failed.push({ name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
