import { isAbsolute, join, relative, sep } from "node:path";
import { inflight } from "../account/inflight.js";
import { db, sqlite, users } from "../db.js";
import { browseGranted } from "../documents/browse.js";
import { retrieveDocuments } from "../documents/retrieval.js";
import { semanticStatus } from "../documents/semantic.js";
import { checkShareRequest, isolatedInside, readShareRequest, type ShareError } from "./policy.js";
import { RAW_CHUNK_BYTES, MAX_SHARED_FILE_BYTES, readSharedChunk, type RawAudit, type RawRef } from "./raw.js";
import { recordShareAccess } from "./store.js";
import { within as sameOrInside } from "../documents/samePath.js";

// A grantee's request on a folder shared from this computer, once its
// sealed body is open (docs/sharing-contracts.md §2): checked
// (shares/policy.ts), audited whatever its outcome, then answered with the
// JSON value the bridge worker seals back. Reached two ways: POST
// /local_shares/serve from the Desktop's main process, for its bridge
// worker (routes/localShares.ts), or in-process when this server runs the
// bridge client itself (a Pi, `serveShareInProcess`).
//
// Nothing in an answer says where the folder is: every path is relative to
// the shared folder (« Contrats/2026/bail.pdf »), and a document outside it
// — or in an isolated project's folder inside it — is never named. The
// originals (`raw`, lot L5) go out a chunk at a time (shares/raw.ts).

export const MAX_PASSAGES = 8;
export const MAX_PASSAGE_CHARS = 10_000;
export const MAX_QUERY = 2_000;
/// The text of one document an answer carries, at most.
export const MAX_TEXT_CHARS = 100_000;
const BROWSE_PAGE = 100;
const SEMANTIC_DEADLINE_MS = 2_500;

export type ShareAnswer = { ok: true; [key: string]: unknown } | { ok: false; error: ShareError };

export type ShareOpBody =
  | { op: "folders" }
  | { op: "search"; query: string; limit: number }
  | { op: "browse"; path: string; offset: number }
  | { op: "text"; document_id: string }
  | { op: "raw"; ref: RawRef; offset: number; length: number };

const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/// The sealed body, as the contract has it; null when it is not one of its
/// operations (an unknown field is refused, not dropped).
export function readShareOp(value: unknown): ShareOpBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  const only = (...allowed: string[]) => keys.every((key) => key === "op" || allowed.includes(key));
  switch (body.op) {
    case "folders":
      return only() ? { op: "folders" } : null;
    case "search": {
      if (!only("query", "limit") || typeof body.query !== "string") return null;
      const query = body.query.replace(/[\u0000-\u001f]/g, " ").trim();
      if (!query || body.query.length > MAX_QUERY) return null;
      const limit = body.limit === undefined ? MAX_PASSAGES : body.limit;
      if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_PASSAGES) return null;
      return { op: "search", query, limit: limit as number };
    }
    case "browse": {
      if (!only("path", "offset")) return null;
      const path = body.path === undefined ? "" : body.path;
      const offset = body.offset === undefined ? 0 : body.offset;
      if (typeof path !== "string" || path.length > 4096 || !Number.isInteger(offset) || (offset as number) < 0 || (offset as number) > 1_000_000) return null;
      return { op: "browse", path, offset: offset as number };
    }
    case "text":
      return only("document_id") && typeof body.document_id === "string" && DOCUMENT_ID.test(body.document_id) ? { op: "text", document_id: body.document_id } : null;
    case "raw": {
      // A path a browse gave, or a cited document's id: one, not both.
      if (!only("path", "document_id", "offset", "length")) return null;
      const byPath = body.path !== undefined;
      if (byPath === (body.document_id !== undefined)) return null;
      if (byPath && (typeof body.path !== "string" || !body.path || body.path.length > 4096)) return null;
      if (!byPath && (typeof body.document_id !== "string" || !DOCUMENT_ID.test(body.document_id))) return null;
      const offset = body.offset === undefined ? 0 : body.offset;
      const length = body.length === undefined ? RAW_CHUNK_BYTES : body.length;
      if (!Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > MAX_SHARED_FILE_BYTES) return null;
      if (!Number.isSafeInteger(length) || (length as number) < 1 || (length as number) > RAW_CHUNK_BYTES) return null;
      return { op: "raw", ref: byPath ? { path: body.path as string } : { document_id: body.document_id as string }, offset: offset as number, length: length as number };
    }
    default:
      return null;
  }
}

/// `path` said from the shared folder, with forward slashes; null when it is
/// not inside it.
export function sharedPath(rootPath: string, path: string): string | null {
  const rel = relative(rootPath, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/// Whether `path` lies in (or is) one of `folders`, compared as this disk
/// does (documents/samePath.ts).
const insideAny = (folders: string[], path: string) => folders.some((folder) => sameOrInside(folder, path));

/// The check made before a request is opened: `{op: "check"}` as the bridge
/// worker sends it (the Desktop's main process passes on an object only),
/// or null.
function isCheck(op: unknown): boolean {
  if (op === null) return true;
  return !!op && typeof op === "object" && !Array.isArray(op) && Object.keys(op).length === 1 && (op as { op?: unknown }).op === "check";
}

/**
 * Serves one request. `payload` is what the bridge worker hands over:
 * {share_uuid, grantee_user_id, guest: {enc_public, sign_public}, op}; `op`
 * {op: "check"} (or null) is the check made before the request is opened
 * (checks 1–6 of policy.ts), which answers {ok: true} or the refusal.
 * A guest who seals « check » as its body gets that same {ok: true}: the
 * two calls look alike once the Desktop passed them on, and a check reads
 * nothing.
 */
export async function serveShareRequest(userId: string, payload: unknown, now = Date.now()): Promise<ShareAnswer> {
  const record = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  const request = record ? readShareRequest(record) : null;
  if (!record || !request) {
    recordShareAccess(userId, { shareId: null, guestUserId: null, guestFingerprint: null, op: "request", outcome: "bad_request", at: now });
    return { ok: false, error: "bad_request" };
  }
  const audit = (op: string, outcome: string, document?: RawAudit) =>
    recordShareAccess(userId, { shareId: request.shareUuid, guestUserId: request.granteeUserId, guestFingerprint: request.guest.fingerprint, op, outcome, at: now, document });

  if (record.op === undefined || isCheck(record.op)) {
    const verdict = checkShareRequest(userId, request, null, now);
    if (!verdict.ok) {
      audit("request", verdict.outcome);
      return { ok: false, error: verdict.error };
    }
    return { ok: true };
  }
  const body = readShareOp(record.op);
  if (!body) {
    // Still checked, so that a malformed body on someone else's share is
    // said as what it is: no share for them.
    const verdict = checkShareRequest(userId, request, null, now);
    audit("request", verdict.ok ? "bad_request" : verdict.outcome);
    return { ok: false, error: verdict.ok ? "bad_request" : verdict.error };
  }
  const verdict = checkShareRequest(userId, request, body.op, now);
  if (!verdict.ok) {
    audit(body.op, verdict.outcome);
    return { ok: false, error: verdict.error };
  }
  const { answer, document } = await run(userId, verdict.share.folder_label, verdict.scope, body);
  audit(body.op, answer.ok ? "ok" : answer.error, document);
  return answer;
}

type Scope = Extract<ReturnType<typeof checkShareRequest>, { ok: true }>["scope"];

/// The answer, and for a document read (text, raw) what the audit keeps
/// of it: which one, its name, the bytes sent — so that « Consultations »
/// says who opened what. Never a path.
async function run(userId: string, label: string, scope: Scope, body: ShareOpBody): Promise<{ answer: ShareAnswer; document?: RawAudit }> {
  const folderIds = scope.folders.map((folder) => folder.id);
  const documents = scope.folders.reduce((sum, folder) => sum + folder.indexed, 0);
  switch (body.op) {
    case "folders":
      return { answer: { ok: true, folder: { label, documents } } };
    case "search":
      return { answer: { ok: true, folder: { label, documents }, passages: await search(userId, scope, folderIds, body) } };
    case "browse":
      return { answer: await browse(userId, scope, body) };
    case "text": {
      const answer = text(userId, scope, folderIds, body.document_id);
      const read = answer.ok ? (answer.document as { document_id: string; name: string; text: string }) : null;
      return { answer, document: read ? { document_id: read.document_id, name: read.name, bytes: Buffer.byteLength(read.text) } : undefined };
    }
    case "raw": {
      const { answer, audit } = await readSharedChunk(userId, scope, isolatedInside(userId, scope.root.path), { ref: body.ref, offset: body.offset, length: body.length });
      return { answer, document: audit };
    }
  }
}

async function search(userId: string, scope: Scope, folderIds: string[], body: { query: string; limit: number }) {
  const status = semanticStatus(userId);
  // The person in front of this computer comes first, as for a computer of
  // the mesh (routes/peerDocuments.ts): no semantic half while it generates.
  const semantic = status.enabled && status.available && inflight() === 0;
  const found = await retrieveDocuments(userId, body.query, [], folderIds, {
    absolutePaths: false,
    semantic,
    semanticDeadlineMs: SEMANTIC_DEADLINE_MS,
    limit: body.limit,
  });
  // Where each document is, from the shared folder itself (retrieveDocuments
  // says it from the granted folder holding it, which may be one nested in
  // the shared folder).
  const ids = [...new Set(found.passages.map((passage) => passage.document_id))];
  const paths = new Map<string, string>();
  if (ids.length) {
    const rows = sqlite
      .prepare(`SELECT id, path FROM documents WHERE user_id = ? AND id IN (${ids.map(() => "?").join(",")}) AND folder_id IN (${folderIds.map(() => "?").join(",")})`)
      .all(userId, ...ids, ...folderIds) as Array<{ id: string; path: string }>;
    const isolated = isolatedInside(userId, scope.root.path);
    for (const row of rows) {
      const rel = sharedPath(scope.root.path, row.path);
      if (rel && !insideAny(isolated, row.path)) paths.set(row.id, rel);
    }
  }
  const passages: Array<{ document_id: string; name: string; path: string; page: number | null; text: string; score: number }> = [];
  let used = 0;
  for (const [index, passage] of found.passages.entries()) {
    if (passages.length >= body.limit || used >= MAX_PASSAGE_CHARS) break;
    const path = paths.get(passage.document_id);
    if (!path) continue;
    const room = MAX_PASSAGE_CHARS - used;
    const excerpt = passage.text.length > room ? passage.text.slice(0, room) : passage.text;
    used += excerpt.length;
    passages.push({
      document_id: passage.document_id,
      name: passage.name,
      path,
      page: typeof passage.page === "number" && passage.page >= 1 ? passage.page : null,
      text: excerpt,
      // The cosine when the semantic half found it, else the rank's share.
      score: typeof passage.cosine === "number" ? Math.max(-1, Math.min(1, passage.cosine)) : Math.round((1 / (index + 1)) * 1000) / 1000,
    });
  }
  return passages;
}

async function browse(userId: string, scope: Scope, body: { path: string; offset: number }): Promise<ShareAnswer> {
  const isolated = isolatedInside(userId, scope.root.path);
  // An isolated project's folder is not there, for a share: not listed,
  // not entered, not searched by name.
  if (body.path && insideAny(isolated, join(scope.root.path, ...body.path.split("/")))) return { ok: false, error: "bad_request" };
  const result = await browseGranted(userId, scope.folders, { root: scope.root.id, path: body.path, sort: "name", order: "asc", offset: body.offset, limit: BROWSE_PAGE, q: null });
  if ("error" in result) return { ok: false, error: "bad_request" };
  const entries = result.entries
    .filter((entry) => !insideAny(isolated, join(scope.root.path, ...entry.path.split("/"))))
    .map((entry) => ({
      name: entry.name,
      path: entry.path,
      kind: entry.kind === "dir" ? "folder" : "file",
      size: entry.kind === "file" ? entry.size : null,
      modified_at: entry.modified ?? null,
      document_id: entry.document_id ?? null,
    }));
  return { ok: true, entries, next_offset: result.next_offset };
}

function text(userId: string, scope: Scope, folderIds: string[], documentId: string): ShareAnswer {
  const file = sqlite
    .prepare(`SELECT id, name, path FROM documents WHERE id = ? AND user_id = ? AND status = 'indexed' AND folder_id IN (${folderIds.map(() => "?").join(",")})`)
    .get(documentId, userId, ...folderIds) as { id: string; name: string; path: string } | undefined;
  const path = file ? sharedPath(scope.root.path, file.path) : null;
  if (!file || !path || insideAny(isolatedInside(userId, scope.root.path), file.path)) return { ok: false, error: "bad_request" };
  let out = "";
  let truncated = false;
  const chunks = sqlite.prepare("SELECT text FROM document_chunks WHERE document_id = ? AND user_id = ? ORDER BY position, rowid").iterate(file.id, userId) as Iterable<{ text: string }>;
  for (const chunk of chunks) {
    const next = out ? `${out}\n\n${chunk.text}` : chunk.text;
    if (next.length > MAX_TEXT_CHARS) {
      out = next.slice(0, MAX_TEXT_CHARS);
      truncated = true;
      break;
    }
    out = next;
  }
  return { ok: true, document: { document_id: file.id, name: file.name, path, text: out, truncated } };
}

/// This server's one person: whose shares a bridge client run in-process
/// serves (a Pi). Null when there is none, or more than one — then no share
/// is served, rather than someone else's.
export function soleUserId(): string | null {
  const rows = db.select({ id: users.id }).from(users).limit(2).all();
  return rows.length === 1 ? rows[0]!.id : null;
}

/// The bridge client's `serveShare` when it runs inside this server.
export async function serveShareInProcess(payload: unknown): Promise<unknown> {
  const userId = soleUserId();
  if (!userId) return { ok: false, error: "unknown_share" };
  return serveShareRequest(userId, payload);
}

