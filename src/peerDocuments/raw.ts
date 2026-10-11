import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { sqlite } from "../db.js";
import { VIA_TUNNEL_HEADER } from "../tunnel/host.js";

// The file itself, by its opaque id (docs/mesh-design.md §2), for a cited
// document opened on another computer or on the phone: GET …/files/:id/raw,
// with Range. Never a path in or out: the id is looked up in this
// computer's index, the file must still be inside the granted folder it was
// indexed from (a symlink swapped in since is refused), and one answer
// carries at most 25 MB through the account's relay — its queue is small
// (docs/mesh-design.md §8) — or 32 MB on the local network (what the tunnel
// protocol carries). Past that, the client asks for ranges.

export const RELAY_RAW_CAP = 25 * 1024 * 1024;
export const LAN_RAW_CAP = 32 * 1024 * 1024;

/// What one answer may carry for this request: through the relay (the
/// tunnel's marker says so, tunnel/host.ts), or on the local network — the
/// direct tunnel, or plain HTTP.
export function rawCapFor(req: FastifyRequest): number {
  const marker = req.headers[VIA_TUNNEL_HEADER];
  if (marker === undefined) return LAN_RAW_CAP;
  const value = (Array.isArray(marker) ? marker[0] : marker)?.trim();
  return value === "direct" ? LAN_RAW_CAP : RELAY_RAW_CAP;
}

export type ByteRange = { start: number; end: number } | "unsatisfiable" | null;

/// One `bytes=` range (RFC 9110 §14.1.2): start-end, start-, or -suffix.
/// Several ranges or a malformed header are ignored (the whole file is
/// meant); a range past the end is unsatisfiable.
export function parseRange(header: string | undefined, size: number): ByteRange {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  if (start >= size) return "unsatisfiable";
  if (end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".rtf": "application/rtf",
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".json": "application/json",
  // Pictures and Office files a viewer shows without running anything (a
  // file browsed in a granted folder, docs/mesh-design.md §2b).
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/// Text formats, markup included, are served as plain text: nothing a
/// viewer would run.
export function contentType(ext: string): string {
  if (CONTENT_TYPES[ext]) return CONTENT_TYPES[ext]!;
  if ([".txt", ".log", ".srt", ".vtt", ".yml", ".yaml", ".html", ".htm", ".xml"].includes(ext)) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

/// A type another computer said a file has, as this one passes it on: one
/// `contentType` gives, else application/octet-stream (a folder shared with
/// the person, lot L5 — its owner's computer is not trusted to name it).
export function servedContentType(value: unknown): string {
  const known = new Set([...Object.values(CONTENT_TYPES), "text/plain; charset=utf-8"]);
  return typeof value === "string" && known.has(value) ? value : "application/octet-stream";
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/// Streams document `id` to `reply` if it lies in one of `folderIds`.
/// Answers 404 for anything this caller may not know exists. Returns what
/// was sent (for the audit), or null when nothing of the file was.
export async function serveRawDocument(
  req: FastifyRequest,
  reply: FastifyReply,
  args: { userId: string; documentId: string; folderIds: string[] },
): Promise<{ id: string; name: string; bytes: number } | null> {
  if (!args.folderIds.length) {
    reply.code(404).send({ error: "not_found" });
    return null;
  }
  const doc = sqlite
    .prepare(
      `SELECT d.id, d.name, d.path, d.ext, f.path AS folder_path FROM documents d
         JOIN document_folders f ON f.id = d.folder_id AND f.user_id = d.user_id
        WHERE d.id = ? AND d.user_id = ? AND d.folder_id IN (${args.folderIds.map(() => "?").join(",")})`,
    )
    .get(args.documentId, args.userId, ...args.folderIds) as { id: string; name: string; path: string; ext: string | null; folder_path: string } | undefined;
  if (!doc) {
    reply.code(404).send({ error: "not_found" });
    return null;
  }
  const sent = await serveRawFile(req, reply, { path: doc.path, folderPath: doc.folder_path, name: doc.name, ext: doc.ext });
  return sent ? { id: doc.id, name: doc.name, bytes: sent.bytes } : null;
}

/// Streams the file at `file.path` to `reply` if it is still a regular file
/// inside `file.folderPath` (a granted folder), with Range and the caps
/// above; 404 otherwise. Whether the caller may ask for that folder at all
/// is the route's business. Returns the bytes sent, or null.
export async function serveRawFile(
  req: FastifyRequest,
  reply: FastifyReply,
  file: { path: string; folderPath: string; name: string; ext: string | null },
): Promise<{ bytes: number } | null> {
  const doc = { path: file.path, folder_path: file.folderPath, name: file.name, ext: file.ext };

  // Opened first, then checked: what is read is what the descriptor holds,
  // so the check is about that file — the path's real location must be in
  // the grant AND be the very file opened (same device and inode). A
  // symlink or directory swapped in between the two is caught either way;
  // checking the path and then opening it would read whatever the path
  // pointed to by then.
  let handle;
  try {
    handle = await open(doc.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch {
    reply.code(404).send({ error: "not_found" });
    return null;
  }
  let stats;
  try {
    stats = await handle.stat();
    const [real, root] = await Promise.all([realpath(doc.path), realpath(doc.folder_path)]);
    if (!inside(root, real)) throw new Error("outside_grant");
    const there = await stat(real);
    if (there.dev !== stats.dev || there.ino !== stats.ino) throw new Error("swapped");
  } catch {
    await handle.close();
    reply.code(404).send({ error: "not_found" });
    return null;
  }
  if (!stats.isFile()) {
    await handle.close();
    reply.code(404).send({ error: "not_found" });
    return null;
  }

  const size = stats.size;
  const cap = rawCapFor(req);
  const header = Array.isArray(req.headers.range) ? req.headers.range[0] : req.headers.range;
  const range = parseRange(header, size);
  if (range === "unsatisfiable") {
    await handle.close();
    reply.code(416).header("Content-Range", `bytes */${size}`).send({ error: "range_not_satisfiable", size });
    return null;
  }
  if (!range && size > cap) {
    await handle.close();
    reply.code(413).header("Accept-Ranges", "bytes").send({ error: "range_required", size, max_bytes: cap });
    return null;
  }
  const start = range?.start ?? 0;
  // A range larger than one answer carries is cut: the client reads
  // Content-Range and asks for the rest.
  const end = range ? Math.min(range.end, start + cap - 1) : size - 1;
  const length = size === 0 ? 0 : end - start + 1;

  reply
    .code(range ? 206 : 200)
    .header("Accept-Ranges", "bytes")
    .header("Content-Type", contentType((doc.ext ?? "").toLowerCase()))
    .header("Content-Length", String(length))
    .header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(doc.name)}`)
    .header("X-Content-Type-Options", "nosniff")
    .header("Content-Security-Policy", "sandbox; default-src 'none'")
    .header("Cache-Control", "private, no-store");
  if (range) reply.header("Content-Range", `bytes ${start}-${end}/${size}`);
  if (length === 0 || req.method === "HEAD") {
    await handle.close();
    reply.send();
    return { bytes: 0 };
  }
  reply.send(handle.createReadStream({ start, end, autoClose: true }));
  return { bytes: length };
}
