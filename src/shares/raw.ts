import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { sqlite } from "../db.js";
import { browsedFile } from "../documents/browse.js";
import { contentType } from "../peerDocuments/raw.js";

// The originals of a folder shared with « Lire les fichiers » (lot L5,
// docs/sharing-contracts.md §6): one chunk of one file per request, sealed
// back by the bridge like any other answer. The file is found as a browse
// of the share would list it (documents/browse.ts browsedFile: inside the
// shared folder by its real path, no symbolic link on the way, nothing
// hidden or skipped, folderRisk applied), never in an isolated project's
// folder, then opened without following a link and checked to be that very
// file (same device and inode) before a byte is read: what is sent is what
// the descriptor holds, whatever the path points to by then.
//
// Every chunk says the whole file's hash, size and date, so that the
// grantee's computer knows the chunks are of one version, and can check
// the file once it has every byte.

/// One request carries at most this many bytes of a file (~2.8 MB once in
/// base64 and sealed in hex, through the account's relay).
export const RAW_CHUNK_BYTES = 1024 * 1024;
/// A file larger than this is not handed out through a share.
export const MAX_SHARED_FILE_BYTES = 25 * 1024 * 1024;

export type RawRef = { path: string } | { document_id: string };

export interface RawRequest {
  ref: RawRef;
  offset: number;
  length: number;
}

export interface RawScope {
  root: { id: string; name: string; path: string };
  folders: Array<{ id: string }>;
}

export type RawAnswer =
  | {
      ok: true;
      file: { name: string; path: string; size: number; modified_at: string; sha256: string; content_type: string };
      offset: number;
      length: number;
      data: string;
      chunk_sha256: string;
      eof: boolean;
    }
  | { ok: false; error: "not_found" | "too_large" | "bad_request" };

/// What the audit keeps of a chunk sent: which document, its name, how much.
export interface RawAudit {
  document_id: string | null;
  name: string | null;
  bytes: number | null;
}

const inside = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/// Whether `path` lies in (or is) one of `folders`.
const insideAny = (folders: string[], path: string) => folders.some((folder) => folder === path || inside(folder, path));

/// The path of an index row of the share's folders, from the shared folder.
function documentPath(userId: string, scope: RawScope, documentId: string): string | null {
  const ids = scope.folders.map((folder) => folder.id);
  if (!ids.length) return null;
  const row = sqlite
    .prepare(`SELECT path FROM documents WHERE id = ? AND user_id = ? AND folder_id IN (${ids.map(() => "?").join(",")})`)
    .get(documentId, userId, ...ids) as { path: string } | undefined;
  if (!row) return null;
  const rel = relative(scope.root.path, row.path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(/[\\/]/).join("/");
}

/// The index's id of a file of the share's folders, if it has one.
function documentIdOf(userId: string, scope: RawScope, abs: string): string | null {
  const ids = scope.folders.map((folder) => folder.id);
  if (!ids.length) return null;
  const row = sqlite
    .prepare(`SELECT id FROM documents WHERE user_id = ? AND path = ? AND folder_id IN (${ids.map(() => "?").join(",")}) LIMIT 1`)
    .get(userId, abs, ...ids) as { id: string } | undefined;
  return row?.id ?? null;
}

// The whole file's hash, kept for the version it was computed of: the
// chunks of one download do not each read the whole file.
const HASHES_KEPT = 64;
const hashes = new Map<string, string>();

async function wholeHash(handle: FileHandle, key: string): Promise<string> {
  const known = hashes.get(key);
  if (known) {
    hashes.delete(key);
    hashes.set(key, known);
    return known;
  }
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  for (let position = 0; ; ) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  const digest = hash.digest("hex");
  hashes.set(key, digest);
  while (hashes.size > HASHES_KEPT) hashes.delete(hashes.keys().next().value!);
  return digest;
}

/// Tests: the hashes forgotten.
export function forgetSharedFileHashes(): void {
  hashes.clear();
}

async function readRange(handle: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, offset + read);
    if (bytesRead === 0) break;
    read += bytesRead;
  }
  return buffer.subarray(0, read);
}

/**
 * One chunk of a file of the shared folder. `isolated`: the isolated
 * projects' folders lying inside it (shares/policy.ts isolatedInside).
 * Whether the share, the device and the right allow it is the caller's
 * business (shares/policy.ts checkShareRequest); this is about the file.
 */
export async function readSharedChunk(userId: string, scope: RawScope, isolated: string[], request: RawRequest): Promise<{ answer: RawAnswer; audit: RawAudit }> {
  const none = (error: "not_found" | "too_large" | "bad_request", audit: Partial<RawAudit> = {}) => ({
    answer: { ok: false as const, error },
    audit: { document_id: null, name: null, bytes: null, ...audit },
  });
  const rel = "document_id" in request.ref ? documentPath(userId, scope, request.ref.document_id) : request.ref.path;
  if (rel === null) return none("not_found");
  // As a browse of the share would list it, from the shared folder only.
  const file = await browsedFile([scope.root], scope.root.id, rel);
  if (!file || insideAny(isolated, file.abs)) return none("not_found");

  let handle: FileHandle;
  try {
    handle = await open(file.abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch {
    return none("not_found");
  }
  try {
    const stats = await handle.stat();
    try {
      const real = await realpath(file.abs);
      if (!inside(file.realRoot, real) || insideAny(isolated, real)) return none("not_found");
      const there = await stat(real);
      if (there.dev !== stats.dev || there.ino !== stats.ino) return none("not_found");
    } catch {
      return none("not_found");
    }
    if (!stats.isFile()) return none("not_found");
    const documentId = documentIdOf(userId, scope, file.abs);
    const named = { document_id: documentId, name: file.name };
    if (stats.size > MAX_SHARED_FILE_BYTES) return none("too_large", named);
    if (request.offset > stats.size) return none("bad_request", named);

    const sha256 = await wholeHash(handle, `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`);
    const bytes = await readRange(handle, request.offset, Math.min(request.length, stats.size - request.offset));
    const relPath = relative(file.realRoot, file.abs).split(/[\\/]/).join("/");
    const dot = file.name.lastIndexOf(".");
    return {
      answer: {
        ok: true,
        file: {
          name: file.name,
          path: relPath,
          size: stats.size,
          modified_at: new Date(stats.mtimeMs).toISOString(),
          sha256,
          content_type: contentType(dot > 0 ? file.name.slice(dot).toLowerCase() : ""),
        },
        offset: request.offset,
        length: bytes.length,
        data: bytes.toString("base64"),
        chunk_sha256: createHash("sha256").update(bytes).digest("hex"),
        eof: request.offset + bytes.length >= stats.size,
      },
      audit: { ...named, bytes: bytes.length },
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
