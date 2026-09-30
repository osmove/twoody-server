import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import { linkedPeers, peerById, peerDocumentCounts, peerPathHint, peerRequest, peerStatus, PeerUnavailableError, type PeerRow } from "../peers/index.js";
import { serveRawDocument } from "../peerDocuments/raw.js";
import { createRateLimiter } from "../rateLimit.js";
import { isSelf, selfIdentity } from "../router/index.js";
import { STATUS_MAX_AGE_MS } from "../router/score.js";
import { trustedNow } from "../vault/roster.js";
import type { DocumentAccess } from "./access.js";
import { smallTalk } from "./query.js";
import { documentLocations, followUpQuestion, retrieveDocuments, scopedFolders } from "./retrieval.js";
import { EMBED_MODEL } from "./semantic.js";
import { fuseRankedLists } from "./vectorMath.js";

// Document retrieval across the person's trusted computers
// (docs/mesh-design.md §2, lot S4), by the computer building the turn:
//
//   - its own retrieval, and at the same time POST /api/v1/peer/documents/
//     search (lot S3) to every computer of the verified vault roster it is
//     linked with and that is not known to be offline;
//   - each computer is waited for 1.5 s on the local network, 3 s through
//     the relay (peers/index.ts peerPathHint); one that is late, offline or
//     does not answer is left out, and the turn says so in one line;
//   - the lists are fused (documents/vectorMath.ts fuseRankedLists): RRF,
//     cosines compared only under the same embedding model, ≤ 3 passages of
//     a document, a place for each computer with a passage above the floor,
//     trimmed to the context budget;
//   - a source is named after its computer (computer_id, computer_name)
//     and cited as twoody://doc/<computer_id>/<document_id>; no absolute
//     path ever comes from another computer, and none leaves this one once
//     a turn is shared (routes/queries.ts).
//
// The request's document access applies to every computer: « off » asks
// none; folders chosen by id ask only the computers they belong to
// ("<computer_id>:<folder_id>"; a bare id is this computer's). A computer
// not in the roster is never asked, whatever the account lists.

/// How long a computer is waited for, by the way its search goes.
const deadlines = { direct: 1_500, relay: 3_000 };
/// A computer that did not answer is not asked again for this long (its
/// absence is still said).
const DOWN_MS = 30_000;
const LOCAL_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function setFanOutDeadlines(next: Partial<typeof deadlines>): void {
  Object.assign(deadlines, next);
}

type SearchBody = {
  q: string;
  hint?: string;
  scope: { mode: "all" } | { mode: "selected"; folder_ids: string[] };
  limit: number;
  budget_chars: number;
  deadline_ms: number;
};
/// One search sent to a computer; answers its status and JSON body.
export type PeerSearch = (peer: PeerRow, body: SearchBody, signal: AbortSignal) => Promise<{ status: number; body: unknown }>;

const tunnelSearch: PeerSearch = async (peer, body, signal) => {
  const response = await peerRequest(peer, "/api/v1/peer/documents/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};
/// The search through the sealed tunnel, as the fan-out sends it.
export const tunnelPeerSearch: PeerSearch = (peer, body, signal) => tunnelSearch(peer, body, signal);
let search: PeerSearch = tunnelSearch;
/// Tests: another way to reach the computers (a fake peer with its latency); null puts the tunnel back.
export function setPeerSearch(next: PeerSearch | null): void {
  search = next ?? tunnelSearch;
}

const down = new Map<string, number>();
export function forgetUnreachable(): void {
  down.clear();
}

/// A passage as the turn uses it, wherever it was found. `path` only for
/// this computer's own, and only kept where the turn is not shared.
export interface MeshPassage {
  computer_id: string;
  computer_name: string;
  local: boolean;
  document_id: string;
  name: string;
  page: number | null;
  text: string;
  snippet: string;
  match?: "content" | "name" | "semantic";
  cosine?: number;
  folder?: string;
  rel_path?: string;
  path?: string;
}

export interface MeshFile {
  id: string;
  name: string;
  modified_at: string;
  chars: number;
  /// Another computer's file: its name.
  computer?: string;
}

export type ComputerOutcome = {
  computer_id: string;
  computer_name: string;
  /// answered; late (past its deadline); offline (its status is stale);
  /// unreachable (did not answer, or did not a moment ago); busy (429);
  /// refused (it does not trust this computer); none (no documents shared)
  status: "answered" | "late" | "offline" | "unreachable" | "busy" | "refused" | "none";
  transport: "direct" | "relay" | null;
  took_ms: number | null;
  passages: number;
};

export interface MeshRetrieval {
  passages: MeshPassage[];
  files: MeshFile[];
  total: number;
  /// This computer first, then each computer asked (or left out).
  computers: ComputerOutcome[];
  /// One line for the model when a computer is missing from the excerpts.
  note: string | null;
  /// Whether another computer's passage is among `passages`.
  remote: boolean;
  timing: { local_ms: number; remote_ms: number | null; total_ms: number };
}

/// The citation link of a source: streamed from the computer that holds it.
export function citationLink(computerId: string, documentId: string): string {
  return `twoody://doc/${encodeURIComponent(computerId)}/${encodeURIComponent(documentId)}`;
}

/// This computer's folder ids in a request's access: bare ids, or ids
/// qualified with this computer's id. Undefined: no choice (all folders).
export function localFolderIds(access: DocumentAccess, selfId = selfIdentity().id): string[] | undefined {
  if (!access.folderIds) return undefined;
  return access.folderIds.flatMap((id) => {
    const at = id.indexOf(":");
    if (at < 0) return [id];
    return id.slice(0, at) === selfId || isSelf(id.slice(0, at)) ? [id.slice(at + 1)] : [];
  });
}

/// What a computer is asked to search under the request's access: null, not asked.
export function remoteScope(access: DocumentAccess, computerId: string): SearchBody["scope"] | null {
  if (access.mode === "off") return null;
  if (!access.folderIds) return { mode: "all" };
  const ids = [
    ...new Set(
      access.folderIds.flatMap((id) => {
        const at = id.indexOf(":");
        return at > 0 && id.slice(0, at) === computerId && LOCAL_ID.test(id.slice(at + 1)) ? [id.slice(at + 1)] : [];
      }),
    ),
  ].slice(0, 200);
  return ids.length ? { mode: "selected", folder_ids: ids } : null;
}

/// The computers of the verified roster this one is linked with, over the
/// key the roster binds (never account_peers.trusted, never the listing).
export function meshPeers(userId: string): PeerRow[] {
  return linkedPeers(userId).filter((peer) => !isSelf(peer.computerId) && trustedNow(peer.computerId, peer.tunnelKey));
}

const DISPLAY_NAME = /^[^/\\\u0000-\u001f]{1,255}$/;
const cleanName = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const name = value.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f]/g, "").slice(0, 255);
  return DISPLAY_NAME.test(name) ? name : null;
};
const cleanRelPath = (value: unknown): string | undefined => {
  if (typeof value !== "string" || !value || value.length > 1024) return undefined;
  if (/^([a-z]:)?[\\/~]/i.test(value) || value.includes("\\") || /[\u0000-\u001f]/.test(value)) return undefined;
  if (value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
  return value;
};

/// Another computer's passage, as far as it holds to the contract: never a path.
function readPassage(raw: unknown, peer: PeerRow): MeshPassage | null {
  const p = raw as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return null;
  const name = cleanName(p.name);
  if (typeof p.document_id !== "string" || !LOCAL_ID.test(p.document_id) || !name || typeof p.text !== "string" || !p.text.trim()) return null;
  const match = p.match === "content" || p.match === "name" || p.match === "semantic" ? p.match : undefined;
  return {
    computer_id: peer.computerId,
    computer_name: peer.name,
    local: false,
    document_id: p.document_id,
    name,
    page: Number.isInteger(p.page) && (p.page as number) >= 1 ? (p.page as number) : null,
    text: p.text.slice(0, 10_000),
    snippet: typeof p.snippet === "string" ? p.snippet.slice(0, 300) : p.text.slice(0, 240),
    ...(match ? { match } : {}),
    ...(typeof p.cosine === "number" && p.cosine >= -1 && p.cosine <= 1 ? { cosine: p.cosine } : {}),
    ...(cleanName(p.folder) ? { folder: cleanName(p.folder)! } : {}),
    ...(cleanRelPath(p.rel_path) ? { rel_path: cleanRelPath(p.rel_path)! } : {}),
  };
}

function readFile(raw: unknown, peer: PeerRow): MeshFile | null {
  const f = raw as Record<string, unknown> | null;
  const name = cleanName(f?.name);
  if (!f || typeof f.document_id !== "string" || !LOCAL_ID.test(f.document_id) || !name) return null;
  return {
    id: f.document_id,
    name,
    modified_at: typeof f.modified_at === "string" && !Number.isNaN(Date.parse(f.modified_at)) ? f.modified_at : new Date(0).toISOString(),
    chars: Number.isInteger(f.chars) && (f.chars as number) >= 0 ? (f.chars as number) : 0,
    computer: peer.name,
  };
}

type Asked = { outcome: ComputerOutcome; passages: MeshPassage[]; files: MeshFile[]; embedModel: string | null };

async function ask(peer: PeerRow, body: Omit<SearchBody, "deadline_ms">): Promise<Asked> {
  const transport = peerPathHint(peer);
  const deadline = deadlines[transport];
  const outcome = (status: ComputerOutcome["status"], took: number | null = null, passages = 0): ComputerOutcome => ({
    computer_id: peer.computerId,
    computer_name: peer.name,
    status,
    transport,
    took_ms: took,
    passages,
  });
  const started = Date.now();
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  // Never waited for past its deadline, whatever the link does meanwhile (a
  // handshake still under way does not see the abort).
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("late");
    }, deadline);
  });
  // The computer answers with what it found a little before the deadline.
  const asked = search(peer, { ...body, deadline_ms: Math.min(3_000, Math.max(100, deadline - 250)) }, controller.signal);
  // Found out of reach after the deadline: not waited for on the next turns either.
  asked.catch((err) => {
    if (err instanceof PeerUnavailableError) down.set(peer.computerId, Date.now() + DOWN_MS);
  });
  try {
    const answer = await Promise.race([asked, late]);
    if (answer === "late") return { outcome: outcome("late", Date.now() - started), passages: [], files: [], embedModel: null };
    const took = Date.now() - started;
    if (answer.status === 429) return { outcome: outcome("busy", took), passages: [], files: [], embedModel: null };
    if (answer.status === 403) {
      const error = (answer.body as { error?: unknown } | null)?.error;
      return { outcome: outcome(error === "documents_off" ? "none" : "refused", took), passages: [], files: [], embedModel: null };
    }
    const result = answer.body as { computer_id?: unknown; embed_model?: unknown; passages?: unknown; files?: unknown } | null;
    // An answer for another computer than the one asked is no answer.
    if (answer.status !== 200 || !result || result.computer_id !== peer.computerId || !Array.isArray(result.passages)) {
      return { outcome: outcome("unreachable", took), passages: [], files: [], embedModel: null };
    }
    const passages = result.passages.slice(0, 8).map((p) => readPassage(p, peer)).filter((p): p is MeshPassage => !!p);
    const files = (Array.isArray(result.files) ? result.files.slice(0, 20) : []).map((f) => readFile(f, peer)).filter((f): f is MeshFile => !!f);
    down.delete(peer.computerId);
    return {
      outcome: outcome("answered", took, passages.length),
      passages,
      files,
      embedModel: typeof result.embed_model === "string" && result.embed_model ? result.embed_model : null,
    };
  } catch {
    if (controller.signal.aborted) return { outcome: outcome("late", Date.now() - started), passages: [], files: [], embedModel: null };
    return { outcome: outcome("unreachable", Date.now() - started), passages: [], files: [], embedModel: null };
  } finally {
    clearTimeout(timer);
  }
}

const MISSING: Partial<Record<ComputerOutcome["status"], string>> = {
  late: "did not answer in time",
  offline: "is offline",
  unreachable: "could not be reached",
  busy: "was busy",
  refused: "refused the search",
};

/// One line for the model: which computers' documents are not in the excerpts.
export function missingNote(computers: ComputerOutcome[]): string | null {
  const missing = computers.filter((c) => MISSING[c.status]);
  if (!missing.length) return null;
  const said = missing.map((c) => `${c.computer_name} (${MISSING[c.status]})`).join(", ");
  return `[Documents on ${said} were not searched for this message: its documents are missing from these excerpts. If the answer may be there, say so briefly.]`;
}

/**
 * This computer's retrieval and every trusted computer's, for one turn.
 * `localFolders`: this computer's folders the request may read (queries.ts
 * computes them from the access and the grants). `remote: false` asks no
 * other computer (a conversation-only answer, say).
 */
export async function retrieveAcrossComputers(args: {
  userId: string;
  question: string;
  history: Array<{ role: string; content: string; sourcesJson?: string | null }>;
  access: DocumentAccess;
  localFolders: string[];
  budgetChars: number;
  remote?: boolean;
}): Promise<MeshRetrieval> {
  const started = Date.now();
  const me = selfIdentity();
  const followUp = followUpQuestion(args.question);
  const peers =
    args.remote === false || args.access.mode === "off" || (!followUp && smallTalk(args.question))
      ? []
      : meshPeers(args.userId).flatMap((peer) => {
          const scope = remoteScope(args.access, peer.computerId);
          if (!scope) return [];
          const counts = peerDocumentCounts(peer.computerId);
          if (counts && counts.indexed === 0) return [];
          return [{ peer, scope }];
        });

  const hint = followUp ? [...args.history].reverse().find((row) => row.role === "user")?.content.slice(-2_000) : undefined;
  const q = args.question.trim().slice(0, 2_000);
  let remoteDone = 0;
  const remote = Promise.all(
    peers.map(async ({ peer, scope }): Promise<Asked> => {
      const skip = (status: ComputerOutcome["status"]): Asked => ({
        outcome: { computer_id: peer.computerId, computer_name: peer.name, status, transport: null, took_ms: null, passages: 0 },
        passages: [],
        files: [],
        embedModel: null,
      });
      const status = peerStatus(peer.computerId);
      if (status && Date.now() - status.at >= STATUS_MAX_AGE_MS) return skip("offline");
      if ((down.get(peer.computerId) ?? 0) > Date.now()) return skip("unreachable");
      if (!q) return skip("none");
      return ask(peer, { q, ...(hint ? { hint } : {}), scope, limit: 6, budget_chars: Math.max(200, Math.min(10_000, args.budgetChars)) });
    }),
  ).then((all) => {
    remoteDone = Date.now();
    return all;
  });

  const local = await retrieveDocuments(args.userId, args.question, args.history, args.localFolders);
  const localMs = Date.now() - started;
  const answers = await remote;
  const where = documentLocations(args.userId, local.passages.map((p) => p.document_id));
  const own: MeshPassage[] = local.passages.map((p) => ({
    computer_id: me.id,
    computer_name: me.name,
    local: true,
    document_id: p.document_id,
    name: p.name,
    page: p.page,
    text: p.text,
    snippet: p.snippet,
    ...(p.match ? { match: p.match } : {}),
    ...(typeof p.cosine === "number" ? { cosine: p.cosine } : {}),
    ...(where.get(p.document_id) ?? {}),
    path: p.path,
  }));

  const lists = answers.filter((a) => a.passages.length);
  const passages = lists.length
    ? fuseRankedLists(
        [
          { key: me.id, passages: own, embedModel: local.semantic === "used" ? EMBED_MODEL : null },
          ...lists.map((a) => ({ key: a.outcome.computer_id, passages: a.passages, embedModel: a.embedModel })),
        ],
        { limit: 8, budgetChars: args.budgetChars },
      )
    : // This computer alone: its retrieval as it always was.
      own;
  const files: MeshFile[] = [...local.files, ...answers.flatMap((a) => a.files)].slice(0, 40);
  const computers: ComputerOutcome[] = [
    { computer_id: me.id, computer_name: me.name, status: "answered", transport: null, took_ms: localMs, passages: own.length },
    ...answers.map((a) => a.outcome),
  ];
  return {
    passages,
    files,
    total: local.total + answers.reduce((sum, a) => sum + a.files.length, 0),
    computers,
    note: missingNote(computers),
    remote: passages.some((p) => !p.local),
    timing: { local_ms: localMs, remote_ms: peers.length ? remoteDone - started : null, total_ms: Date.now() - started },
  };
}

// ── a cited document of another computer, through this one ───────────────

export const REMOTE_RAW_PER_MINUTE = 60;
const rawLimiter = createRateLimiter({ limit: REMOTE_RAW_PER_MINUTE, windowMs: 60_000 });
const PASSED_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges", "content-disposition"];

/**
 * GET /local_documents/remote/:computer_id/files/:id/raw: the file a
 * citation names, for a client with no session of its own on the computer
 * that holds it (the phone asking the answering computer). This computer
 * asks that one over their sealed tunnel, with Range, under its own `peer:`
 * session — the other computer checks it is trusted, applies its grants and
 * caps (25 MB an answer through the relay, 32 MB on the local network) and
 * writes it in its audit (« Appareils »). Here: 60 files a minute per
 * client, a line in the log, and nothing for a computer outside the roster
 * (404, as for a document that is not there). This computer's own id
 * serves its own file.
 */
export async function serveRemoteRaw(
  req: FastifyRequest,
  reply: FastifyReply,
  args: { userId: string; client: string; computerId: string; documentId: string },
): Promise<void> {
  const verdict = rawLimiter.hit(args.client);
  if (!verdict.allowed) {
    reply.header("Retry-After", String(Math.max(1, verdict.retryAfterSeconds))).code(429).send({ error: "rate_limited", retry_after_s: Math.max(1, verdict.retryAfterSeconds) });
    return;
  }
  if (!LOCAL_ID.test(args.documentId)) {
    reply.code(404).send({ error: "not_found" });
    return;
  }
  if (isSelf(args.computerId)) {
    const folderIds = scopedFolders(args.userId, { mode: "all" }).map((f) => f.id);
    const sent = await serveRawDocument(req, reply, { userId: args.userId, documentId: args.documentId, folderIds });
    req.log.info({ computer_id: args.computerId, document_id: args.documentId, bytes: sent?.bytes ?? 0 }, "cited document served");
    return;
  }
  const peer = peerById(args.userId, args.computerId);
  if (!peer || peer.state !== "linked" || !peer.enabled || !trustedNow(peer.computerId, peer.tunnelKey)) {
    reply.code(404).send({ error: "not_found" });
    return;
  }
  const range = Array.isArray(req.headers.range) ? req.headers.range[0] : req.headers.range;
  let response: Response;
  try {
    response = await peerRequest(peer, `/api/v1/peer/documents/files/${encodeURIComponent(args.documentId)}/raw`, {
      headers: range && /^bytes=\d*-\d*$/.test(range.trim()) ? { range: range.trim() } : {},
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    reply.code(503).send({ error: "computer_unavailable", computer_id: peer.computerId, computer_name: peer.name, message: err instanceof Error ? err.message : String(err) });
    return;
  }
  req.log.info({ computer_id: peer.computerId, document_id: args.documentId, status: response.status, bytes: response.headers.get("content-length") }, "cited document passed on from another computer");
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => undefined);
    reply.code(404).send({ error: "not_found" });
    return;
  }
  reply.code(response.status);
  for (const name of PASSED_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) reply.header(name, value);
  }
  reply
    .header("X-Content-Type-Options", "nosniff")
    .header("Content-Security-Policy", "sandbox; default-src 'none'")
    .header("Cache-Control", "private, no-store")
    .header("X-Twoody-Computer", peer.computerId);
  if (!response.body || req.method === "HEAD") {
    await response.body?.cancel().catch(() => undefined);
    reply.send();
    return;
  }
  reply.send(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>));
}
