import { createHash } from "node:crypto";
import { shareCaller, type ShareLabel } from "./guest.js";

// The grantee's side of reading an original (lot L5, docs/sharing-
// contracts.md §6): a file of a folder someone shares with « Lire les
// fichiers », asked a chunk at a time through the Desktop (share-call, sealed
// to the owner's computer and back through the account), each chunk checked
// against its hash and against the version the first one described, the
// whole file against its hash once every byte is in. Nothing is written to
// disk here: the caller gets the bytes as they come (routes/
// sharedFolders.ts streams them to this computer's app or the person's
// phone).
//
// Nothing the owner's computer says is taken on trust beyond what can be
// checked: the offset must be the one asked, the bytes as many as said and
// hashed as said, the size within 25 MB, the file the same from the first
// chunk to the last.

export const CHUNK_BYTES = 1024 * 1024;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/// One chunk asked through the Desktop: the relay is given 30 s there.
const CALL_TIMEOUT_MS = 40_000;
/// How long one chunk may be waited for, refusals that pass included (the
/// account lets 30 requests a minute through per share and device, one at a
/// time).
const CHUNK_PATIENCE_MS = 90_000;

export interface SharedFile {
  name: string;
  path: string;
  size: number;
  modified_at: string;
  sha256: string;
  content_type: string;
}

export type FileRef = { path: string } | { document_id: string };

export class SharedFileError extends Error {
  constructor(
    public readonly code: string,
    public readonly share: ShareLabel | null = null,
  ) {
    super(code);
    this.name = "SharedFileError";
  }
}

let sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());
let clock = () => Date.now();

/// Tests: no real waiting.
export function setDownloadTiming(timing: { sleep?: (ms: number) => Promise<void>; now?: () => number } | null): void {
  sleep = timing?.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.()));
  clock = timing?.now ?? (() => Date.now());
}

/// How long to wait before asking again, for a refusal that passes; null
/// for one that does not.
function waitFor(code: string): number | null {
  switch (code) {
    case "busy":
    case "desktop_busy":
      return 1_500;
    case "rate_limited":
      return 10_000;
    case "timeout":
      return 2_000;
    default:
      return null;
  }
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const HEX64 = /^[0-9a-f]{64}$/;
const NAME = /^[^\u0000-\u001f/\\]{1,255}$/;

function readFile(value: unknown): SharedFile | null {
  const file = value as Record<string, unknown> | null;
  if (!file || typeof file !== "object") return null;
  const { name, path, size, modified_at, sha256, content_type } = file;
  if (typeof name !== "string" || !NAME.test(name) || name === "." || name === "..") return null;
  if (typeof path !== "string" || path.length > 4096 || path.startsWith("/") || path.split("/").some((part) => part === ".." || part === "")) return null;
  if (!Number.isSafeInteger(size) || (size as number) < 0) return null;
  if (typeof modified_at !== "string" || modified_at.length > 40 || typeof sha256 !== "string" || !HEX64.test(sha256)) return null;
  return { name, path, size: size as number, modified_at, sha256, content_type: typeof content_type === "string" ? content_type.slice(0, 120) : "application/octet-stream" };
}

const sameVersion = (a: SharedFile, b: SharedFile) => a.size === b.size && a.sha256 === b.sha256 && a.modified_at === b.modified_at && a.path === b.path;

export interface Chunk {
  file: SharedFile;
  bytes: Buffer;
  eof: boolean;
  share: ShareLabel | null;
}

/// One chunk at `offset`, checked; refusals that pass waited out.
export async function fetchChunk(uuid: string, ref: FileRef, offset: number, options: { expected?: SharedFile; aborted?: () => boolean; length?: number } = {}): Promise<Chunk> {
  const length = Math.min(CHUNK_BYTES, Math.max(1, options.length ?? CHUNK_BYTES));
  const call = shareCaller();
  if (!call) throw new SharedFileError("no_account");
  const started = clock();
  let label: ShareLabel | null = null;
  for (;;) {
    if (options.aborted?.()) throw new SharedFileError("aborted", label);
    const outcome = await call(uuid, { op: "raw", ...ref, offset, length }, CALL_TIMEOUT_MS).catch(() => ({ ok: false as const, code: "unreachable", share: null }));
    label = outcome.share ?? label;
    let code: string;
    if (!outcome.ok) code = outcome.code;
    else {
      const result = outcome.result as Record<string, unknown> | null;
      if (!result || typeof result !== "object") throw new SharedFileError("bad_answer", label);
      if (result.ok !== true) code = typeof result.error === "string" && /^[a-z_]{1,40}$/.test(result.error) ? result.error : "bad_answer";
      else return checkedChunk(result, offset, length, options.expected, label);
    }
    const wait = waitFor(code);
    if (wait === null || clock() - started + wait > CHUNK_PATIENCE_MS) throw new SharedFileError(code, label);
    await sleep(wait);
  }
}

function checkedChunk(result: Record<string, unknown>, offset: number, length: number, expected: SharedFile | undefined, share: ShareLabel | null): Chunk {
  const file = readFile(result.file);
  if (!file) throw new SharedFileError("bad_answer", share);
  if (file.size > MAX_FILE_BYTES) throw new SharedFileError("too_large", share);
  if (expected && !sameVersion(expected, file)) throw new SharedFileError("changed", share);
  if (result.offset !== offset || offset > file.size) throw new SharedFileError("bad_answer", share);
  if (typeof result.data !== "string" || result.data.length > Math.ceil(CHUNK_BYTES / 3) * 4 || !BASE64.test(result.data)) throw new SharedFileError("bad_answer", share);
  const bytes = Buffer.from(result.data, "base64");
  const wanted = Math.min(length, file.size - offset);
  // Every byte asked for, no more: a short chunk would leave the download
  // going round, a long one would write past the file.
  if (bytes.length !== wanted || result.length !== bytes.length) throw new SharedFileError("bad_answer", share);
  if (typeof result.chunk_sha256 !== "string" || createHash("sha256").update(bytes).digest("hex") !== result.chunk_sha256) throw new SharedFileError("bad_answer", share);
  const eof = offset + bytes.length >= file.size;
  if (result.eof !== eof) throw new SharedFileError("bad_answer", share);
  return { file, bytes, eof, share };
}

/**
 * The file from `start` to `end` (inclusive; the file's end when absent
 * or past it), chunk by chunk to `write`. The whole file, from 0 to its
 * end: its hash is checked before its last chunk is handed over — a caller
 * that got every byte got the file as it is on the owner's disk. A part of
 * it: the caller checks the whole once it holds every part, against the
 * hash the first chunk gave (`first`, fetched by the caller to answer with
 * the file's description before any byte).
 */
export async function downloadSharedFile(
  uuid: string,
  ref: FileRef,
  options: {
    start?: number;
    end?: number;
    first?: Chunk;
    write: (bytes: Buffer) => Promise<void> | void;
    aborted?: () => boolean;
  },
): Promise<{ file: SharedFile; bytes: number; share: ShareLabel | null }> {
  const start = options.start ?? 0;
  const first = options.first ?? (await fetchChunk(uuid, ref, start, { aborted: options.aborted }));
  const file = first.file;
  const last = Math.min(options.end ?? file.size - 1, file.size - 1);
  const whole = start === 0 && last === file.size - 1 ? createHash("sha256") : null;
  let chunk = first;
  let offset = start;
  for (;;) {
    whole?.update(chunk.bytes);
    offset += chunk.bytes.length;
    if (chunk.eof || offset > last) {
      if (whole && whole.digest("hex") !== file.sha256) throw new SharedFileError("bad_answer", chunk.share);
      await options.write(chunk.bytes);
      return { file, bytes: offset - start, share: first.share };
    }
    await options.write(chunk.bytes);
    chunk = await fetchChunk(uuid, ref, offset, { expected: file, aborted: options.aborted, length: last - offset + 1 });
  }
}
