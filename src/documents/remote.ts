import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import { linkedPeers, peerById, peerDocumentCounts, peerPathHint, peerRequest, peerStatus, PeerUnavailableError, type PeerRow } from "../peers/index.js";
import { serveRawDocument } from "../peerDocuments/raw.js";
import { createRateLimiter } from "../rateLimit.js";
import { isSelf, selfIdentity } from "../router/index.js";
import { STATUS_MAX_AGE_MS } from "../router/score.js";
import { rosterSnapshot, trustedNow } from "../vault/roster.js";
import { requesterHeaders, type Requester } from "../sessionTrust.js";
import type { DocumentAccess } from "./access.js";
import { smallTalk } from "./query.js";
import { documentLocations, followUpQuestion, retrieveDocuments, scopedFolders } from "./retrieval.js";
import { EMBED_MODEL } from "./semantic.js";
import { fuseRankedLists } from "./vectorMath.js";
import { shareCaller, shareCitationLink, shareDisplayName, sharedFolderUuids, shareDeadlineMs, shareMissingSentence, type ShareLabel } from "../shares/guest.js";

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
// Only for this server's owner or one of the person's own devices
// (sessionTrust.ts meshRequester), named to the other computer for its
// audit: a household member's phone, a device paired by code or a firmware
// device reaches this computer's documents and no other's.
//
// The request's document access applies to every computer: « off » asks
// none; folders chosen by id ask only the computers they belong to
// ("<computer_id>:<folder_id>"; a bare id is this computer's). A computer
// not in the roster is never asked, whatever the account lists.
//
// Folders other people share with the person (docs/sharing-contracts.md
// §3, shares/guest.ts) are asked too when the access names them one by one
// ("share:<uuid>", never with « all »): through the Desktop, which seals
// the search to the owner's computer, each waited for 4 s, fused with the
// rest, named « Contrats · de Jimmy » and cited as
// twoody://share/<uuid>/<document_id>. One out of reach is said in a line:
// « Le dossier « Contrats » de Jimmy n'est pas joignable… ».

/// How long a computer is waited for, by the way its search goes.
const deadlines = { direct: 1_500, relay: 3_000 };
/// A computer that did not answer is not asked again for this long (its
/// absence is still said).
const DOWN_MS = 30_000;
const LOCAL_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function setFanOutDeadlines(next: Partial<typeof deadlines>): void {
  Object.assign(deadlines, next);
}

/// How long a computer is waited for on this transport (file listings use the same).
export function fanOutDeadline(transport: "direct" | "relay"): number {
  return deadlines[transport];
}

/// Whether a computer did not answer a moment ago (not asked again yet).
export function recentlyUnreachable(computerId: string): boolean {
  return (down.get(computerId) ?? 0) > Date.now();
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
export type PeerSearch = (peer: PeerRow, body: SearchBody, signal: AbortSignal, requester?: Requester | null) => Promise<{ status: number; body: unknown }>;

const tunnelSearch: PeerSearch = async (peer, body, signal, requester) => {
  const response = await peerRequest(peer, "/api/v1/peer/documents/search", {
    method: "POST",
    headers: { "content-type": "application/json", ...requesterHeaders(requester) },
    body: JSON.stringify(body),
    signal,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};
/// The search through the sealed tunnel, as the fan-out sends it.
export const tunnelPeerSearch: PeerSearch = (peer, body, signal, requester) => tunnelSearch(peer, body, signal, requester);
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
  /// A passage of a folder someone else shares with the person: which share,
  /// as the Desktop names it.
  share?: { uuid: string; label: string | null; owner_name: string | null };
}

export interface MeshFile {
  id: string;
  name: string;
  modified_at: string;
  chars: number;
  /// Another computer's file: its name.
  computer?: string;
  /// The folder holding it, from its granted folder: « jimmy/Documents/_Archives/2012/Downloads ».
  folder?: string;
}

/// The folder holding a document, said from its granted folder
/// (« jimmy/Documents/_Archives/2012/Downloads »): the granted folder's name
/// and the document's path inside it, without the file's own name.
export function folderOf(folder: string | undefined, relPath: string | undefined): string | undefined {
  if (!folder) return undefined;
  const at = relPath ? relPath.lastIndexOf("/") : -1;
  return at > 0 ? `${folder}/${relPath!.slice(0, at)}` : folder;
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

/// A shared folder asked for a turn.
export type ShareOutcome = {
  share_uuid: string;
  label: string | null;
  owner_name: string | null;
  /// answered; late (past 4 s); unreachable (its owner's computer, the
  /// account or the Desktop did not answer); busy (rate limited); pending
  /// (this device not yet approved by the owner); refused (revoked, expired,
  /// stopped…); none (nothing to ask)
  status: "answered" | "late" | "unreachable" | "busy" | "pending" | "refused" | "none";
  took_ms: number | null;
  passages: number;
};

export interface MeshRetrieval {
  passages: MeshPassage[];
  files: MeshFile[];
  total: number;
  /// This computer first, then each computer asked (or left out).
  computers: ComputerOutcome[];
  /// The shared folders the access named, asked or not.
  shares?: ShareOutcome[];
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

/// A passage's citation link: its computer's, or its share's.
export function passageLink(passage: Pick<MeshPassage, "computer_id" | "document_id" | "share">): string {
  return passage.share ? shareCitationLink(passage.share.uuid, passage.document_id) : citationLink(passage.computer_id, passage.document_id);
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
/// key the roster binds (never account_computers.trusted, never the listing).
export function meshPeers(userId: string): PeerRow[] {
  return linkedPeers(userId).filter((peer) => !isSelf(peer.computerId) && trustedNow(peer.computerId, peer.tunnelKey));
}

const DISPLAY_NAME = /^[^/\\\u0000-\u001f]{1,255}$/;
export const cleanName = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const name = value.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f]/g, "").slice(0, 255);
  return DISPLAY_NAME.test(name) ? name : null;
};
export const cleanRelPath = (value: unknown): string | undefined => {
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
  const folder = folderOf(cleanName(f.folder) ?? undefined, cleanRelPath(f.rel_path));
  return {
    id: f.document_id,
    name,
    modified_at: typeof f.modified_at === "string" && !Number.isNaN(Date.parse(f.modified_at)) ? f.modified_at : new Date(0).toISOString(),
    chars: Number.isInteger(f.chars) && (f.chars as number) >= 0 ? (f.chars as number) : 0,
    computer: peer.name,
    ...(folder ? { folder } : {}),
  };
}

type Asked = { outcome: ComputerOutcome; passages: MeshPassage[]; files: MeshFile[]; embedModel: string | null };

async function ask(peer: PeerRow, body: Omit<SearchBody, "deadline_ms">, requester: Requester): Promise<Asked> {
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
  const asked = search(peer, { ...body, deadline_ms: Math.min(3_000, Math.max(100, deadline - 250)) }, controller.signal, requester);
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

// ── folders shared with the person ───────────────────────────────────────

/// What a refusal of the owner's computer, the account or the Desktop
/// means for the turn.
function shareStatusOf(code: unknown): ShareOutcome["status"] {
  switch (code) {
    case "device_not_approved":
      return "pending";
    case "rate_limited":
    case "busy":
    case "desktop_busy":
      return "busy";
    case "unknown_share":
    case "revoked":
    case "expired":
    case "right":
    case "folder_gone":
    case "documents_off":
    case "share_unavailable":
    case "unknown_key":
    case "key_changed":
      return "refused";
    case "timeout":
      return "late";
    // host_error, bad_request, too_large, and any code not known yet: said
    // as « n'est pas joignable », as the account's final event means them.
    default:
      return "unreachable";
  }
}

/// A shared folder's passage, as far as it holds to the contract: a path
/// inside the shared folder at most, never an absolute one.
function readSharedPassage(raw: unknown, uuid: string, share: ShareLabel | null): MeshPassage | null {
  const p = raw as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return null;
  const name = cleanName(p.name);
  if (typeof p.document_id !== "string" || !LOCAL_ID.test(p.document_id) || !name || typeof p.text !== "string" || !p.text.trim()) return null;
  const relPath = cleanRelPath(p.path);
  return {
    computer_id: `share:${uuid}`,
    computer_name: shareDisplayName(share),
    local: false,
    document_id: p.document_id,
    name,
    page: Number.isInteger(p.page) && (p.page as number) >= 1 ? (p.page as number) : null,
    text: p.text.slice(0, 10_000),
    snippet: p.text.slice(0, 240),
    folder: share?.label ?? "Dossier partagé",
    // The folder holding it, from the shared folder: « Contrats/2026 ».
    ...(relPath ? { rel_path: relPath } : {}),
    share: { uuid, label: share?.label ?? null, owner_name: share?.owner_name ?? null },
  };
}

type AskedShare = { outcome: ShareOutcome; passages: MeshPassage[] };

/// One shared folder's search, through the Desktop, within 4 s.
async function askShare(uuid: string, q: string): Promise<AskedShare> {
  const started = Date.now();
  const outcome = (status: ShareOutcome["status"], share: ShareLabel | null, passages = 0, took: number | null = Date.now() - started): ShareOutcome => ({
    share_uuid: uuid,
    label: share?.label ?? null,
    owner_name: share?.owner_name ?? null,
    status,
    took_ms: took,
    passages,
  });
  const call = shareCaller();
  // Without the Desktop (a Pi), or nothing to look for.
  if (!call) return { outcome: outcome("unreachable", null, 0, null), passages: [] };
  if (!q) return { outcome: outcome("none", null, 0, null), passages: [] };
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), shareDeadlineMs());
  });
  try {
    const answer = await Promise.race([call(uuid, { op: "search", query: q, limit: 8 }, shareDeadlineMs()), late]);
    if (answer === "late") return { outcome: outcome("late", null), passages: [] };
    if (!answer.ok) return { outcome: outcome(shareStatusOf(answer.code), answer.share), passages: [] };
    const result = answer.result as { ok?: unknown; error?: unknown; passages?: unknown } | null;
    if (!result || result.ok !== true) return { outcome: outcome(shareStatusOf(result?.error), answer.share), passages: [] };
    const passages: MeshPassage[] = [];
    let used = 0;
    for (const raw of Array.isArray(result.passages) ? result.passages.slice(0, 8) : []) {
      const passage = readSharedPassage(raw, uuid, answer.share);
      if (!passage || used >= 10_000) continue;
      passage.text = passage.text.slice(0, 10_000 - used);
      used += passage.text.length;
      passages.push(passage);
    }
    return { outcome: outcome("answered", answer.share, passages.length), passages };
  } catch {
    return { outcome: outcome("unreachable", null), passages: [] };
  } finally {
    clearTimeout(timer);
  }
}

/// The lines for the model about shared folders that were not searched.
export function sharesNote(shares: ShareOutcome[]): string | null {
  const said = shares.flatMap((share) => {
    const label = share.label && share.owner_name ? { label: share.label, owner_name: share.owner_name } : null;
    if (share.status === "late" || share.status === "unreachable" || share.status === "busy") return [shareMissingSentence(label, "unreachable")];
    if (share.status === "pending" || share.status === "refused") return [shareMissingSentence(label, share.status)];
    return [];
  });
  // Said first, as a fact about the folder: told only that its documents
  // were missing, Qwen3.5 9B answered « ce n'est pas dans les documents
  // fournis » (bench of 10/10/2026), as if the folder had been read.
  return said.length ? `[Begin your answer by telling the person this, in their language: ${said.join(" ")} Its documents were not searched: never say the answer is not in them.]` : null;
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
 * other computer (a conversation-only answer, say), nor does a request
 * without `requester` (not the owner, not one of the person's devices).
 */
export async function retrieveAcrossComputers(args: {
  userId: string;
  question: string;
  history: Array<{ role: string; content: string; sourcesJson?: string | null }>;
  access: DocumentAccess;
  localFolders: string[];
  budgetChars: number;
  remote?: boolean;
  /// Who asked (sessionTrust.ts meshRequester); null: no other computer.
  requester?: Requester | null;
}): Promise<MeshRetrieval> {
  const started = Date.now();
  const me = selfIdentity();
  const followUp = followUpQuestion(args.question);
  const requester = args.requester ?? null;
  const peers =
    !requester || args.remote === false || args.access.mode === "off" || (!followUp && smallTalk(args.question))
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
  // Folders shared with the person, named one by one in the access: for the
  // person only (their own devices), never a conversation given to someone
  // else's computer. Only the question is sent.
  const shareUuids = !requester || args.remote === false || (!followUp && smallTalk(args.question)) ? [] : sharedFolderUuids(args.access);
  const sharesAsked = Promise.all(shareUuids.map((uuid) => askShare(uuid, q)));
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
      return ask(peer, { q, ...(hint ? { hint } : {}), scope, limit: 6, budget_chars: Math.max(200, Math.min(10_000, args.budgetChars)) }, requester!);
    }),
  ).then((all) => {
    remoteDone = Date.now();
    return all;
  });

  const local = await retrieveDocuments(args.userId, args.question, args.history, args.localFolders);
  const localMs = Date.now() - started;
  const answers = await remote;
  const shared = await sharesAsked;
  const where = documentLocations(args.userId, [...local.passages.map((p) => p.document_id), ...local.files.map((f) => f.id)]);
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
  const sharedLists = shared.filter((a) => a.passages.length);
  const passages = lists.length || sharedLists.length
    ? fuseRankedLists(
        [
          { key: me.id, passages: own, embedModel: local.semantic === "used" ? EMBED_MODEL : null },
          ...lists.map((a) => ({ key: a.outcome.computer_id, passages: a.passages, embedModel: a.embedModel })),
          // A shared folder's scores are its owner's: ranked by place only.
          ...sharedLists.map((a) => ({ key: `share:${a.outcome.share_uuid}`, passages: a.passages, embedModel: null })),
        ],
        { limit: 8, budgetChars: args.budgetChars },
      )
    : // This computer alone: its retrieval as it always was.
      own;
  const ownFiles: MeshFile[] = local.files.map((f) => {
    const place = where.get(f.id);
    const folder = folderOf(place?.folder, place?.rel_path);
    return { ...f, ...(folder ? { folder } : {}) };
  });
  const files: MeshFile[] = [...ownFiles, ...answers.flatMap((a) => a.files)].slice(0, 40);
  const computers: ComputerOutcome[] = [
    { computer_id: me.id, computer_name: me.name, status: "answered", transport: null, took_ms: localMs, passages: own.length },
    ...answers.map((a) => a.outcome),
  ];
  const shares = shared.map((a) => a.outcome);
  const note = [missingNote(computers), sharesNote(shares)].filter((line): line is string => !!line).join("\n") || null;
  return {
    passages,
    files,
    total: local.total + answers.reduce((sum, a) => sum + a.files.length, 0),
    computers,
    ...(shares.length ? { shares } : {}),
    note,
    remote: passages.some((p) => !p.local),
    timing: { local_ms: localMs, remote_ms: peers.length ? remoteDone - started : shareUuids.length ? Date.now() - started : null, total_ms: Date.now() - started },
  };
}

// ── a cited document of another computer, through this one ───────────────

/// Another computer's documents as its Documents section shows them.
export type ComputerFolders = {
  computer_id: string;
  computer_name: string;
  /// online (it listed its folders); offline (not linked, or its status is
  /// stale); unreachable (did not answer); refused (it does not trust this one).
  status: "online" | "offline" | "unreachable" | "refused";
  /// `id` is the one a document access names: "<computer_id>:<folder_id>".
  folders: Array<{ id: string; folder_id: string; name: string; documents: number; indexed: number }>;
  indexing: boolean;
};

const count = (value: unknown) => (Number.isInteger(value) && (value as number) >= 0 ? (value as number) : 0);

/**
 * GET /local_documents/computers: each other computer of the verified vault
 * roster, with its granted folders (names and counts, never a path) as it
 * lists them over the sealed tunnel (GET /peer/documents/folders), asked in
 * parallel, each for at most `timeoutMs`. A member not linked, or whose
 * status is stale, is listed offline without being asked.
 */
export async function foldersOfComputers(userId: string, timeoutMs = 4_000, requester: Requester | null = null): Promise<ComputerFolders[]> {
  if (!requester) return [];
  const members = [...(rosterSnapshot()?.computers.values() ?? [])].filter((member) => !isSelf(member.accountComputerId));
  return Promise.all(
    members.map(async (member): Promise<ComputerFolders> => {
      const peer = peerById(userId, member.accountComputerId);
      const base = { computer_id: member.accountComputerId, computer_name: peer?.name || member.label, folders: [], indexing: false };
      if (!peer || peer.state !== "linked" || !peer.enabled || !trustedNow(peer.computerId, peer.tunnelKey)) return { ...base, status: "offline" };
      const status = peerStatus(peer.computerId);
      if (status && Date.now() - status.at >= STATUS_MAX_AGE_MS) return { ...base, status: "offline" };
      if ((down.get(peer.computerId) ?? 0) > Date.now()) return { ...base, status: "unreachable" };
      try {
        const response = await peerRequest(peer, "/api/v1/peer/documents/folders", { headers: requesterHeaders(requester), signal: AbortSignal.timeout(timeoutMs) });
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel().catch(() => undefined);
          return { ...base, status: "refused" };
        }
        const body = (await response.json().catch(() => null)) as { folders?: unknown; index?: { running?: unknown } } | null;
        if (!response.ok || !Array.isArray(body?.folders)) return { ...base, status: "unreachable" };
        const folders = (body.folders as Array<Record<string, unknown> | null>).flatMap((raw) => {
          const name = cleanName(raw?.name);
          if (!raw || typeof raw.id !== "string" || !LOCAL_ID.test(raw.id) || !name) return [];
          return [{ id: `${peer.computerId}:${raw.id}`, folder_id: raw.id, name, documents: count(raw.documents), indexed: count(raw.indexed) }];
        });
        return { ...base, status: "online", folders: folders.slice(0, 200), indexing: body.index?.running === true };
      } catch (err) {
        if (err instanceof PeerUnavailableError) down.set(peer.computerId, Date.now() + DOWN_MS);
        return { ...base, status: "unreachable" };
      }
    }),
  );
}

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
 * serves its own file. Another computer's only to this server's owner or
 * one of the person's own devices (`requester`, named to that computer
 * for its audit): anyone else 403 person_device_required.
 */
export async function serveRemoteRaw(
  req: FastifyRequest,
  reply: FastifyReply,
  args: { userId: string; client: string; computerId: string; documentId: string; requester?: Requester | null },
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
  if (!args.requester) {
    reply.code(403).send({ error: "person_device_required" });
    return;
  }
  const peer = meshPeerOf(args.userId, args.computerId);
  if (!peer) {
    reply.code(404).send({ error: "not_found" });
    return;
  }
  await passRemoteFile(req, reply, peer, `/api/v1/peer/documents/files/${encodeURIComponent(args.documentId)}/raw`, args.requester, args.documentId);
}

/// A computer of the verified roster this one is linked with, or null.
function meshPeerOf(userId: string, computerId: string): PeerRow | null {
  const peer = peerById(userId, computerId);
  return peer && peer.state === "linked" && peer.enabled && trustedNow(peer.computerId, peer.tunnelKey) ? peer : null;
}

/// Asks `peer` for a file at `path` (its raw route) over the sealed tunnel,
/// with the client's Range, and passes the answer on.
async function passRemoteFile(req: FastifyRequest, reply: FastifyReply, peer: PeerRow, path: string, requester: Requester, logId: string | null): Promise<void> {
  const args = { documentId: logId, requester };
  const range = Array.isArray(req.headers.range) ? req.headers.range[0] : req.headers.range;
  let response: Response;
  try {
    response = await peerRequest(peer, path, {
      headers: { ...(range && /^bytes=\d*-\d*$/.test(range.trim()) ? { range: range.trim() } : {}), ...requesterHeaders(args.requester) },
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    reply.code(503).send({ error: "computer_unavailable", computer_id: peer.computerId, computer_name: peer.name, message: err instanceof Error ? err.message : String(err) });
    return;
  }
  req.log.info({ computer_id: peer.computerId, document_id: args.documentId, requester: args.requester.id, status: response.status, bytes: response.headers.get("content-length") }, "document passed on from another computer");
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

// ── another computer's folders, browsed through this one ─────────────────

export const REMOTE_BROWSE_PER_MINUTE = 120;
const browseLimiter = createRateLimiter({ limit: REMOTE_BROWSE_PER_MINUTE, windowMs: 60_000 });
const BROWSE_KEYS = ["root", "path", "sort", "order", "offset", "limit", "q"] as const;

type RemoteEntry = { name: string; path: string; kind: "dir" | "file"; size: number | null; modified: string; type: string; indexed: boolean; document_id?: string };

/// Another computer's browse answer, as far as it holds to the contract: never an absolute path.
export function readPeerBrowse(body: unknown): Record<string, unknown> | null {
  const b = body as Record<string, unknown> | null;
  const root = b?.root as Record<string, unknown> | null | undefined;
  const rootName = cleanName(root?.name);
  if (!b || !root || typeof root.id !== "string" || !LOCAL_ID.test(root.id) || !rootName || !Array.isArray(b.entries)) return null;
  const relOrRoot = (value: unknown) => (value === "" ? "" : cleanRelPath(value));
  const path = relOrRoot(b.path);
  if (path === undefined) return null;
  const crumbs = (Array.isArray(b.breadcrumbs) ? b.breadcrumbs.slice(0, 64) : []).flatMap((raw) => {
    const c = raw as Record<string, unknown> | null;
    const name = cleanName(c?.name);
    const at = relOrRoot(c?.path);
    return name && at !== undefined ? [{ name, path: at }] : [];
  });
  const entries = b.entries.slice(0, 200).flatMap((raw): RemoteEntry[] => {
    const e = raw as Record<string, unknown> | null;
    const name = cleanName(e?.name);
    const at = cleanRelPath(e?.path);
    if (!e || !name || !at || (e.kind !== "dir" && e.kind !== "file")) return [];
    return [
      {
        name,
        path: at,
        kind: e.kind,
        size: e.kind === "file" && Number.isSafeInteger(e.size) && (e.size as number) >= 0 ? (e.size as number) : null,
        modified: typeof e.modified === "string" && !Number.isNaN(Date.parse(e.modified)) ? new Date(e.modified).toISOString() : new Date(0).toISOString(),
        type: typeof e.type === "string" && /^[a-z0-9]{1,16}$/.test(e.type) ? e.type : e.kind === "dir" ? "folder" : "file",
        indexed: e.indexed === true,
        ...(typeof e.document_id === "string" && LOCAL_ID.test(e.document_id) ? { document_id: e.document_id } : {}),
      },
    ];
  });
  const int = (value: unknown) => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null);
  return {
    root: { id: root.id, name: rootName },
    path,
    breadcrumbs: crumbs.length ? crumbs : [{ name: rootName, path: "" }],
    entries,
    total: int(b.total) ?? entries.length,
    offset: int(b.offset) ?? 0,
    next_offset: int(b.next_offset),
    sort: ["name", "date", "size"].includes(b.sort as string) ? b.sort : "name",
    order: b.order === "desc" ? "desc" : "asc",
    ...(typeof b.query === "string" ? { query: b.query.slice(0, 200) } : {}),
    limited: b.limited === true,
  };
}

/**
 * GET /local_documents/remote/:computer_id/browse: a folder of another
 * computer of the person's verified roster (its GET /api/v1/peer/documents/
 * browse, over the sealed tunnel, under this computer's `peer:` session —
 * that computer checks it is trusted, applies its grants and writes it in
 * its audit), for this server's owner or one of the person's own devices.
 * 120 a minute per client. Returns the status and body to send.
 */
export async function browseRemote(args: {
  userId: string;
  client: string;
  computerId: string;
  query: Record<string, unknown>;
  requester: Requester | null;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const verdict = browseLimiter.hit(args.client);
  if (!verdict.allowed) return { status: 429, body: { error: "rate_limited", retry_after_s: Math.max(1, verdict.retryAfterSeconds) } };
  if (!args.requester) return { status: 403, body: { error: "person_device_required" } };
  const peer = meshPeerOf(args.userId, args.computerId);
  if (!peer) return { status: 404, body: { error: "not_found" } };
  const params = new URLSearchParams();
  for (const key of BROWSE_KEYS) {
    const value = args.query[key];
    if (typeof value === "string" || typeof value === "number") params.set(key, String(value));
  }
  let response: Response;
  try {
    response = await peerRequest(peer, `/api/v1/peer/documents/browse?${params}`, { headers: requesterHeaders(args.requester), signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    if (err instanceof PeerUnavailableError) down.set(peer.computerId, Date.now() + DOWN_MS);
    return { status: 503, body: { error: "computer_unavailable", computer_id: peer.computerId, computer_name: peer.name } };
  }
  const body = await response.json().catch(() => null);
  const named = { computer_id: peer.computerId, computer_name: peer.name };
  if (response.status === 401 || response.status === 403) {
    const error = (body as { error?: unknown } | null)?.error;
    return { status: 403, body: { error: error === "documents_off" ? "documents_off" : "not_trusted", ...named } };
  }
  if (response.status === 404 || response.status === 400 || response.status === 429) {
    const error = response.status === 404 ? "not_found" : response.status === 400 ? "bad_request" : "rate_limited";
    return { status: response.status, body: { error, ...named } };
  }
  const result = response.ok && (body as { computer_id?: unknown } | null)?.computer_id === peer.computerId ? readPeerBrowse(body) : null;
  if (!result) return { status: 502, body: { error: "computer_unavailable", ...named } };
  down.delete(peer.computerId);
  return { status: 200, body: { ...named, ...result } };
}

/// GET /local_documents/remote/:computer_id/browse/raw: a file browsed on
/// another computer, as serveRemoteRaw passes a cited document on.
export async function serveRemoteBrowsedFile(
  req: FastifyRequest,
  reply: FastifyReply,
  args: { userId: string; client: string; computerId: string; root: unknown; path: unknown; requester: Requester | null },
): Promise<void> {
  const verdict = rawLimiter.hit(args.client);
  if (!verdict.allowed) {
    reply.header("Retry-After", String(Math.max(1, verdict.retryAfterSeconds))).code(429).send({ error: "rate_limited", retry_after_s: Math.max(1, verdict.retryAfterSeconds) });
    return;
  }
  if (!args.requester) {
    reply.code(403).send({ error: "person_device_required" });
    return;
  }
  const peer = meshPeerOf(args.userId, args.computerId);
  if (!peer || typeof args.root !== "string" || !LOCAL_ID.test(args.root) || !cleanRelPath(args.path)) {
    reply.code(404).send({ error: "not_found" });
    return;
  }
  const params = new URLSearchParams({ root: args.root, path: args.path as string });
  await passRemoteFile(req, reply, peer, `/api/v1/peer/documents/browse/raw?${params}`, args.requester, null);
}
