import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireAuth } from "../auth.js";
import { inflight } from "../account/inflight.js";
import { accountCredentials } from "../account/service.js";
import { sqlite } from "../db.js";
import { folderName, indexStatus } from "../documents/library.js";
import { relativeToFolder, retrieveDocuments, scopedFolders } from "../documents/retrieval.js";
import { EMBED_MODEL, semanticStatus } from "../documents/semantic.js";
import { auditOf, recordAccess } from "../peerDocuments/audit.js";
import { onlyKnownFields, SEARCH_DEFAULTS, SEARCH_REQUEST_SCHEMA, type PeerDocumentsError } from "../peerDocuments/contract.js";
import { serveRawDocument } from "../peerDocuments/raw.js";
import { trustedPeerCaller, type PeerCaller } from "../peerDocuments/trust.js";
import { createRateLimiter } from "../rateLimit.js";
import { requirePairedPerson } from "./peers.js";
import { readRequester, type Requester } from "../sessionTrust.js";

// This computer's documents, for the account's other computers it trusts
// (docs/mesh-design.md §2), through the sealed tunnel:
//
//   POST /api/v1/peer/documents/search      {q, hint?, scope{mode, folder_ids?}, limit≤8, budget_chars≤10000, deadline_ms≤3000}
//        → {computer_id, took_ms, embed_model, index, passages[], files[≤20]}
//        exactly as test/fixtures/peer-documents-search.schema.json (lot P0) says;
//        errors {error: bad_request | not_trusted | documents_off | rate_limited, retry_after_s?}
//   GET  /api/v1/peer/documents/folders     granted folders: names and counts, no path
//   GET  /api/v1/peer/documents/files/:id?offset=   indexed text, 20 passages a page
//   GET  /api/v1/peer/documents/files/:id/raw        the file, with Range (peerDocuments/raw.ts)
//   GET  /api/v1/peers/:id/audit            what that computer read here (« Appareils »)
//
// Only a `peer:` session of a computer this one trusts (peerDocuments/
// trust.ts); anyone else 403. 30 requests a minute per session. Nothing
// leaves with an absolute path: a document is its granted folder's name
// and its path inside it. The caller's scope is intersected with this
// computer's grants, and folderRisk is applied here, whatever the caller
// asks. The semantic half of a search is skipped while this computer is
// generating: the person in front of it comes first.

export const PEER_DOCUMENTS_PER_MINUTE = 30;
const limiter = createRateLimiter({ limit: PEER_DOCUMENTS_PER_MINUTE, windowMs: 60_000 });
const MAX_FILES = 20;
const MAX_SNIPPET = 300;

type Caller = PeerCaller & { self: string; requester: Requester | null };
/// Search requests whose body named a field the contract does not.
const unknownFields = new WeakSet<FastifyRequest>();

function refuse(reply: FastifyReply, status: number, error: PeerDocumentsError, extra: Record<string, number> = {}) {
  return reply.code(status).send({ error, ...extra });
}

/// Who asks (from its session), within its budget, trusted — and this
/// computer's own id in the account, which every source is named after:
/// without an account there is no roster, so nobody is trusted.
async function peerCaller(req: FastifyRequest, reply: FastifyReply): Promise<Caller | null> {
  const auth = await requireAuth(req, reply);
  if (!auth) return null;
  if (auth.sessionId) {
    const verdict = limiter.hit(auth.sessionId);
    if (!verdict.allowed) {
      reply.header("Retry-After", String(verdict.retryAfterSeconds));
      refuse(reply, 429, "rate_limited", { retry_after_s: Math.max(1, verdict.retryAfterSeconds) });
      return null;
    }
  }
  const caller = await trustedPeerCaller(auth, req);
  const self = accountCredentials()?.computerId ?? null;
  if ("error" in caller || !self) {
    req.log.info({ reason: "error" in caller ? caller.reason : "no_account" }, "peer documents refused");
    refuse(reply, 403, "not_trusted");
    return null;
  }
  return { ...caller, self, requester: readRequester(req.headers) };
}

interface SearchBody {
  q: string;
  hint?: string;
  scope: { mode: "all" | "selected"; folder_ids?: string[] };
  limit?: number;
  budget_chars?: number;
  deadline_ms?: number;
}

export async function peerDocumentRoutes(app: FastifyInstance) {
  app.post<{ Body: SearchBody }>("/peer/documents/search", {
    schema: {
      tags: ["documents"],
      summary: "Passages of this computer's documents, for a computer of the account it trusts",
      body: SEARCH_REQUEST_SCHEMA,
    },
    // The caller is known before its body is judged; an unknown field is
    // refused, not dropped: read before Fastify's Ajv, which drops it.
    attachValidation: true,
    preValidation: async (req) => {
      if (!onlyKnownFields(req.body)) unknownFields.add(req);
    },
    handler: async (req, reply) => {
      const started = Date.now();
      const caller = await peerCaller(req, reply);
      if (!caller) return;
      if (req.validationError || unknownFields.has(req)) return refuse(reply, 400, "bad_request");
      const shared = scopedFolders(caller.userId, { mode: "all" });
      if (!shared.length) return refuse(reply, 403, "documents_off");

      const limit = req.body.limit ?? SEARCH_DEFAULTS.limit;
      const budget = req.body.budget_chars ?? SEARCH_DEFAULTS.budget_chars;
      const deadline = req.body.deadline_ms ?? SEARCH_DEFAULTS.deadline_ms;
      const folders = req.body.scope.mode === "all" ? shared : scopedFolders(caller.userId, { mode: "selected", folderIds: req.body.scope.folder_ids ?? [] });
      const available = (() => {
        const status = semanticStatus(caller.userId);
        return status.enabled && status.available;
      })();
      const generating = inflight() > 0;
      const found = await retrieveDocuments(caller.userId, req.body.q, req.body.hint ? [{ role: "user", content: req.body.hint }] : [], folders.map((f) => f.id), {
        absolutePaths: false,
        semantic: available && !generating,
        // Room left to answer once the semantic half is given up.
        semanticDeadlineMs: Math.max(0, deadline - (Date.now() - started) - 100),
        limit,
      });
      const semantic = !available ? "unavailable" : generating ? "skipped_generating" : found.semantic === "deadline" ? "skipped_deadline" : "used";

      const passages = [];
      let used = 0;
      for (const passage of found.passages) {
        if (passages.length >= limit || used >= budget) break;
        if (!passage.folder) continue;
        const room = budget - used;
        const text = passage.text.length > room ? passage.text.slice(0, room) : passage.text;
        used += text.length;
        passages.push({
          source_id: `${caller.self}:${passage.document_id}`,
          document_id: passage.document_id,
          name: passage.name,
          folder: passage.folder,
          rel_path: passage.rel_path,
          page: typeof passage.page === "number" && passage.page >= 1 ? passage.page : null,
          text,
          snippet: passage.snippet.slice(0, MAX_SNIPPET),
          match: passage.match ?? "content",
          rank: passages.length + 1,
          ...(typeof passage.cosine === "number" ? { cosine: Math.max(-1, Math.min(1, passage.cosine)) } : {}),
        });
      }
      const files = found.files
        .filter((file) => file.folder)
        .slice(0, MAX_FILES)
        .map((file) => ({
          source_id: `${caller.self}:${file.id}`,
          document_id: file.id,
          name: file.name,
          folder: file.folder,
          rel_path: file.rel_path,
          modified_at: file.modified_at,
          chars: file.chars,
        }));
      const status = indexStatus(caller.userId);
      const seen = new Map(passages.map((p) => [p.document_id, p.name]));
      recordAccess({ userId: caller.userId, computerId: caller.computerId, sessionId: caller.sessionId, requester: caller.requester, action: "search", documents: [...seen].map(([id, name]) => ({ id, name })) });
      return reply.send({
        computer_id: caller.self,
        took_ms: Date.now() - started,
        embed_model: semantic === "used" ? EMBED_MODEL : null,
        index: {
          documents: folders.reduce((sum, f) => sum + f.indexed, 0),
          pending: status.running ? Math.max(0, status.total - status.done) : 0,
          semantic,
        },
        passages,
        files,
      });
    },
  });

  app.get("/peer/documents/folders", {
    schema: { tags: ["documents"], summary: "This computer's granted folders, names and counts, for a computer of the account it trusts" },
    handler: async (req, reply) => {
      const caller = await peerCaller(req, reply);
      if (!caller) return;
      const folders = scopedFolders(caller.userId, { mode: "all" });
      recordAccess({ userId: caller.userId, computerId: caller.computerId, sessionId: caller.sessionId, requester: caller.requester, action: "folders" });
      return reply.send({
        computer_id: caller.self,
        folders: folders.map((f) => ({ id: f.id, name: f.name, documents: f.documents, indexed: f.indexed })),
        index: { running: indexStatus(caller.userId).running },
      });
    },
  });

  app.get<{ Params: { id: string }; Querystring: { offset?: number } }>("/peer/documents/files/:id", {
    schema: {
      tags: ["documents"],
      summary: "Indexed text of one of this computer's documents, 20 passages a page",
      params: { type: "object", required: ["id"], properties: { id: { type: "string", minLength: 1, maxLength: 200 } } },
      querystring: { type: "object", properties: { offset: { type: "integer", minimum: 0, maximum: 1000000 } } },
    },
    handler: async (req, reply) => {
      const caller = await peerCaller(req, reply);
      if (!caller) return;
      const folderIds = scopedFolders(caller.userId, { mode: "all" }).map((f) => f.id);
      const file = folderIds.length
        ? (sqlite
            .prepare(
              `SELECT d.id, d.name, d.path, d.mtime_ms, d.status, f.path AS folder_path FROM documents d
                 JOIN document_folders f ON f.id = d.folder_id AND f.user_id = d.user_id
                WHERE d.id = ? AND d.user_id = ? AND d.folder_id IN (${folderIds.map(() => "?").join(",")})`,
            )
            .get(req.params.id, caller.userId, ...folderIds) as { id: string; name: string; path: string; mtime_ms: number; status: string; folder_path: string } | undefined)
        : undefined;
      if (!file) return reply.code(404).send({ error: "not_found" });
      const offset = req.query.offset ?? 0;
      const rows = sqlite
        .prepare("SELECT page, text FROM document_chunks WHERE document_id = ? AND user_id = ? ORDER BY position, rowid LIMIT 21 OFFSET ?")
        .all(file.id, caller.userId, offset) as Array<{ page: number | null; text: string }>;
      recordAccess({ userId: caller.userId, computerId: caller.computerId, sessionId: caller.sessionId, requester: caller.requester, action: "read", documents: [{ id: file.id, name: file.name }] });
      return reply.send({
        computer_id: caller.self,
        file: {
          id: file.id,
          source_id: `${caller.self}:${file.id}`,
          name: file.name,
          folder: folderName(file.folder_path),
          rel_path: relativeToFolder(file.folder_path, file.path),
          modified_at: new Date(file.mtime_ms).toISOString(),
          status: file.status,
        },
        passages: rows.slice(0, 20),
        next_offset: rows.length > 20 ? offset + 20 : null,
      });
    },
  });

  app.get<{ Params: { id: string } }>("/peer/documents/files/:id/raw", {
    schema: {
      tags: ["documents"],
      summary: "One of this computer's documents, the file itself (Range; 25 MB an answer through the relay, 32 MB on the local network)",
      params: { type: "object", required: ["id"], properties: { id: { type: "string", minLength: 1, maxLength: 200 } } },
    },
    handler: async (req, reply) => {
      const caller = await peerCaller(req, reply);
      if (!caller) return;
      const folderIds = scopedFolders(caller.userId, { mode: "all" }).map((f) => f.id);
      const sent = await serveRawDocument(req, reply, { userId: caller.userId, documentId: req.params.id, folderIds });
      if (sent) recordAccess({ userId: caller.userId, computerId: caller.computerId, sessionId: caller.sessionId, requester: caller.requester, action: "raw", documents: [{ id: sent.id, name: sent.name }], bytes: sent.bytes });
      return reply;
    },
  });

  app.get<{ Params: { id: string }; Querystring: { before?: number; limit?: number } }>("/peers/:id/audit", {
    schema: {
      tags: ["providers"],
      summary: "What a computer of the account read of this one's documents, newest first (Desktop or a device paired with it)",
      params: { type: "object", required: ["id"], properties: { id: { type: "string", minLength: 1, maxLength: 64 } } },
      querystring: { type: "object", properties: { before: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 200 } } },
    },
    handler: async (req, reply) => {
      const auth = await requirePairedPerson(req, reply);
      if (!auth) return;
      return reply.send({ computer_id: req.params.id, ...auditOf(auth.userId, req.params.id, { before: req.query.before, limit: req.query.limit }) });
    },
  });
}
