import type { FastifyInstance, FastifyReply } from "fastify";
import { PassThrough } from "node:stream";
import { servedContentType } from "../peerDocuments/raw.js";
import { downloadSharedFile, fetchChunk, SharedFileError, type Chunk, type FileRef } from "../shares/download.js";
import { shareCaller, type ShareLabel } from "../shares/guest.js";
import { SHARE_UUID } from "../shares/store.js";
import { owner } from "./localShares.js";

// The folders other people share with the person, read from this computer
// (lot L5, docs/sharing-contracts.md §6) — by this computer's app, or by the
// person's own phone through it:
//
//   GET /shared_folders/:uuid/browse?path=&offset=
//         → {ok: true, entries, next_offset, share} | {ok: false, error, share?}
//   GET /shared_folders/:uuid/file?path=… | ?document_id=…   (Range: bytes=N-)
//         → the file's bytes, X-Twoody-Sha256, X-Twoody-Size, X-Twoody-File-Name;
//           JSON {error, share?} before any byte otherwise
//
// Each call goes to the owner's computer sealed, through the Desktop
// (share-call, shares/guest.ts) and the account; that computer checks the
// share, the right, the device and the file every time. Here: only the
// person's own sessions (localShares.ts owner: never a household member's
// phone, a device paired by code, another computer), and nothing kept —
// the bytes go on as they come, the file checked against its hash
// (shares/download.ts).

const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BROWSE_TIMEOUT_MS = 30_000;

/// The HTTP status of a refusal, said before any byte.
function statusOf(code: string): number {
  switch (code) {
    case "bad_request":
      return 400;
    case "right":
    case "device_not_approved":
    case "key_changed":
    case "unknown_key":
      return 403;
    case "not_found":
    case "unknown_share":
    case "share_unavailable":
    case "revoked":
    case "expired":
    case "folder_gone":
    case "documents_off":
      return 404;
    case "too_large":
      return 413;
    case "rate_limited":
    case "busy":
    case "desktop_busy":
      return 429;
    case "changed":
    case "bad_answer":
    case "sequence":
      return 502;
    default:
      return 503;
  }
}

const refuse = (reply: FastifyReply, code: string, share: ShareLabel | null = null) =>
  reply.code(statusOf(code)).header("Cache-Control", "private, no-store").send({ error: code, ...(share ? { share } : {}) });

const NAME = /^[^\u0000-\u001f/\\]{1,255}$/;

/// A browse entry of the owner's computer, as far as it holds to the
/// contract (§2): names and relative paths only.
function readEntry(raw: unknown) {
  const entry = raw as Record<string, unknown> | null;
  if (!entry || typeof entry !== "object") return null;
  const { name, path, kind, size, modified_at, document_id } = entry;
  if (typeof name !== "string" || !NAME.test(name) || typeof path !== "string" || path.length > 4096) return null;
  if (path.startsWith("/") || path.split("/").some((part) => part === "" || part === "." || part === "..")) return null;
  if (kind !== "folder" && kind !== "file") return null;
  return {
    name,
    path,
    kind,
    size: kind === "file" && Number.isSafeInteger(size) && (size as number) >= 0 ? (size as number) : null,
    modified_at: typeof modified_at === "string" && modified_at.length <= 40 ? modified_at : null,
    document_id: typeof document_id === "string" && DOCUMENT_ID.test(document_id) ? document_id : null,
  };
}

/// `Range: bytes=N-` (the rest of the file from N); null for none, or for
/// any other form (the whole file is sent).
export function resumeFrom(header: string | string[] | undefined): number | null {
  const value = Array.isArray(header) ? header[0] : header;
  const match = value ? /^bytes=(\d{1,9})-$/.exec(value.trim()) : null;
  return match ? Number(match[1]) : null;
}

export async function sharedFolderRoutes(app: FastifyInstance) {
  app.get<{ Params: { uuid: string }; Querystring: { path?: string; offset?: string } }>("/shared_folders/:uuid/browse", {
    schema: { tags: ["documents"], summary: "Browse a folder someone shares with the person with « Lire les fichiers », through its owner's computer (the person's own sessions)" },
    handler: async (req, reply) => {
      const auth = await owner(req, reply);
      if (!auth) return;
      const uuid = req.params.uuid.toLowerCase();
      const path = req.query.path ?? "";
      const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
      if (!SHARE_UUID.test(uuid) || typeof path !== "string" || path.length > 4096 || !Number.isInteger(offset) || offset < 0 || offset > 1_000_000) {
        return reply.code(400).send({ ok: false, error: "bad_request" });
      }
      const call = shareCaller();
      if (!call) return reply.send({ ok: false, error: "no_account" });
      const outcome = await call(uuid, { op: "browse", path, offset }, BROWSE_TIMEOUT_MS).catch(() => ({ ok: false as const, code: "unreachable", share: null }));
      const share = outcome.share ?? null;
      if (!outcome.ok) return reply.send({ ok: false, error: outcome.code, ...(share ? { share } : {}) });
      const result = outcome.result as Record<string, unknown> | null;
      if (!result || result.ok !== true) {
        const error = typeof result?.error === "string" && /^[a-z_]{1,40}$/.test(result.error) ? result.error : "bad_answer";
        return reply.send({ ok: false, error, ...(share ? { share } : {}) });
      }
      const entries = (Array.isArray(result.entries) ? result.entries.slice(0, 200) : []).map(readEntry).filter((entry) => entry !== null);
      const next = result.next_offset;
      return reply.header("Cache-Control", "private, no-store").send({ ok: true, entries, next_offset: Number.isInteger(next) && (next as number) > offset ? next : null, ...(share ? { share } : {}) });
    },
  });

  app.get<{ Params: { uuid: string }; Querystring: { path?: string; document_id?: string } }>("/shared_folders/:uuid/file", {
    schema: { tags: ["documents"], summary: "A file of a folder someone shares with the person with « Lire les fichiers », fetched sealed in chunks from its owner's computer and checked against its hash (the person's own sessions)" },
    handler: async (req, reply) => {
      const auth = await owner(req, reply);
      if (!auth) return;
      const uuid = req.params.uuid.toLowerCase();
      const { path, document_id: documentId } = req.query;
      if (!SHARE_UUID.test(uuid) || (path === undefined) === (documentId === undefined)) return refuse(reply, "bad_request");
      if (path !== undefined && (typeof path !== "string" || !path || path.length > 4096)) return refuse(reply, "bad_request");
      if (documentId !== undefined && (typeof documentId !== "string" || !DOCUMENT_ID.test(documentId))) return refuse(reply, "bad_request");
      const ref: FileRef = path !== undefined ? { path } : { document_id: documentId! };
      const start = resumeFrom(req.headers.range) ?? 0;

      let gone = false;
      reply.raw.on("close", () => {
        if (!reply.raw.writableFinished) gone = true;
      });
      let first: Chunk;
      try {
        first = await fetchChunk(uuid, ref, start, { aborted: () => gone });
      } catch (error) {
        if (error instanceof SharedFileError) return refuse(reply, error.code, error.share);
        return refuse(reply, "unreachable");
      }
      const { file } = first;
      const out = new PassThrough();
      reply
        .code(start > 0 ? 206 : 200)
        .header("Content-Type", servedContentType(file.content_type))
        .header("Content-Length", String(file.size - start))
        .header("Accept-Ranges", "bytes")
        .header("X-Twoody-Sha256", file.sha256)
        .header("X-Twoody-Size", String(file.size))
        .header("X-Twoody-File-Name", encodeURIComponent(file.name))
        .header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`)
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "sandbox; default-src 'none'")
        .header("Cache-Control", "private, no-store");
      if (start > 0) reply.header("Content-Range", `bytes ${start}-${Math.max(start, file.size - 1)}/${file.size}`);
      void downloadSharedFile(uuid, ref, {
        start,
        first,
        aborted: () => gone,
        write: async (bytes) => {
          if (bytes.length && !out.write(bytes)) await new Promise<void>((resolve) => out.once("drain", resolve));
        },
      }).then(
        () => out.end(),
        // Cut short: the caller gets fewer bytes than it was told, and
        // keeps none of them.
        (error) => {
          req.log.warn({ code: error instanceof SharedFileError ? error.code : "error" }, "shared file not delivered");
          out.destroy(error instanceof Error ? error : new Error("shared_file_failed"));
        },
      );
      return reply.send(out);
    },
  });
}
