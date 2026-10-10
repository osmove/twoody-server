import { peerPathHint, peerRequest, peerStatus, type PeerRow } from "../peers/index.js";
import { selfIdentity } from "../router/index.js";
import { STATUS_MAX_AGE_MS } from "../router/score.js";
import { requesterHeaders, type Requester } from "../sessionTrust.js";
import type { DocumentAccess } from "./access.js";
import { aliasLabel, plain } from "./folderAliases.js";
import { formatListing, listGrantedFiles, type GrantedRoot, type ListedFile, type Listing, type ListingIntent } from "./fileListing.js";
import { cleanName, cleanRelPath, fanOutDeadline, meshPeers, recentlyUnreachable, remoteScope } from "./remote.js";

// A file listing (documents/fileListing.ts) on the computer that holds the
// folder: this one, or another computer of the person's verified vault
// roster, asked over the sealed tunnel (POST /api/v1/peer/documents/list,
// routes/peerDocuments.ts) under the same rules as a document search
// (documents/remote.ts): only for this server's owner or one of the
// person's own devices, only computers the roster trusts, the request's
// document access applied to every computer, each waited for 1.5 s on the
// local network and 3 s through the relay. A message that names one of the
// computers (« sur mon MacBook Air ») is listed there only.

export type ListingOutcome = {
  computer_id: string;
  computer_name: string;
  status: Listing["status"] | "unreachable" | "offline" | "refused" | "busy";
  total: number;
};

export interface MeshListing {
  /// What the model reads, one block per computer that has something to say.
  blocks: string[];
  computers: ListingOutcome[];
  /// Whether a computer settled the question about the named folder: it
  /// listed it, or said it is not granted there.
  settled: boolean;
}

/// The ways a computer's name may be said: « MacBook Air de Jimmy » is
/// also « MacBook Air », « Jimmy's Mac mini » also « Mac mini ».
function spokenNames(name: string): string[] {
  const flat = plain(name).replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  const names = [flat, flat.replace(/\s+(de|d'|du|of)\s*\S+$/, ""), flat.replace(/^\S+'s\s+/, "")];
  return [...new Set(names.map((n) => n.trim()).filter((n) => n.length >= 4))];
}

export function namesComputer(question: string, name: string): boolean {
  const said = ` ${plain(question).replace(/[-_]+/g, " ").replace(/\s+/g, " ")} `;
  return spokenNames(name).some((n) => said.includes(` ${n} `) || said.includes(` ${n}?`) || said.includes(` ${n},`) || said.includes(` ${n}.`));
}

function readListedFile(raw: unknown): ListedFile | null {
  const f = raw as Record<string, unknown> | null;
  const name = cleanName(f?.name);
  const folder = cleanRelPath(f?.folder) ?? cleanName(f?.folder);
  if (!f || !name || !folder) return null;
  return {
    name,
    folder,
    size: Number.isInteger(f.size) && (f.size as number) >= 0 ? (f.size as number) : 0,
    kind: typeof f.kind === "string" && /^[a-z0-9]{1,16}$/.test(f.kind) ? f.kind : "file",
    modified_at: typeof f.modified_at === "string" && !Number.isNaN(Date.parse(f.modified_at)) ? new Date(f.modified_at).toISOString() : new Date(0).toISOString(),
    ...(typeof f.added_at === "string" && !Number.isNaN(Date.parse(f.added_at)) ? { added_at: new Date(f.added_at).toISOString() } : {}),
  };
}

/// Another computer's listing, as far as it holds to the contract: never a path.
export function readPeerListing(body: unknown, intent: Pick<ListingIntent, "folder" | "folderName">): Listing | null {
  const b = body as Record<string, unknown> | null;
  const statuses: Listing["status"][] = ["ok", "not_granted", "not_selected", "missing", "none"];
  if (!b || typeof b !== "object" || !statuses.includes(b.status as Listing["status"])) return null;
  const label = intent.folder ? aliasLabel(intent.folder) : intent.folderName ? `the folder named « ${intent.folderName} »` : "every granted folder";
  const where = (Array.isArray(b.where) ? b.where : []).map((w) => cleanRelPath(w) ?? cleanName(w)).filter((w): w is string => !!w).slice(0, 10);
  const files = (Array.isArray(b.files) ? b.files.slice(0, 30) : []).map(readListedFile).filter((f): f is ListedFile => !!f);
  const others = (Array.isArray(b.others) ? b.others : []).map((w) => cleanRelPath(w) ?? cleanName(w)).filter((w): w is string => !!w).slice(0, 6);
  return {
    status: b.status as Listing["status"],
    label,
    where,
    total: Number.isInteger(b.total) && (b.total as number) >= 0 ? (b.total as number) : files.length,
    files,
    limited: b.limited === true,
    ...(others.length ? { others } : {}),
  };
}

async function askPeer(peer: PeerRow, intent: ListingIntent, scope: NonNullable<ReturnType<typeof remoteScope>>, requester: Requester): Promise<Listing | ListingOutcome["status"]> {
  const status = peerStatus(peer.computerId);
  if (status && Date.now() - status.at >= STATUS_MAX_AGE_MS) return "offline";
  if (recentlyUnreachable(peer.computerId)) return "unreachable";
  try {
    const response = await peerRequest(peer, "/api/v1/peer/documents/list", {
      method: "POST",
      headers: { "content-type": "application/json", ...requesterHeaders(requester) },
      body: JSON.stringify({
        ...(intent.folder ? { folder: intent.folder } : {}),
        ...(intent.folderName ? { folder_name: intent.folderName } : {}),
        sort: intent.sort,
        kinds: intent.kinds,
        limit: intent.limit,
        scope,
      }),
      signal: AbortSignal.timeout(fanOutDeadline(peerPathHint(peer))),
    });
    if (response.status === 429) {
      await response.body?.cancel().catch(() => undefined);
      return "busy";
    }
    if (response.status === 401 || response.status === 403) {
      const error = ((await response.json().catch(() => null)) as { error?: unknown } | null)?.error;
      return error === "documents_off" ? { status: "none", label: "", where: [], total: 0, files: [], limited: false } : "refused";
    }
    const body = await response.json().catch(() => null);
    if (!response.ok || (body as { computer_id?: unknown } | null)?.computer_id !== peer.computerId) return "unreachable";
    return readPeerListing(body, intent) ?? "unreachable";
  } catch {
    return "unreachable";
  }
}

/**
 * The listing a message asks for, on the computers it concerns. `roots`:
 * this computer's granted folders the request may read; `granted`: all of
 * them. Other computers only with `requester` and `remote`.
 */
export async function listFilesAcrossComputers(args: {
  userId: string;
  question: string;
  intent: ListingIntent;
  access: DocumentAccess;
  roots: GrantedRoot[];
  granted: GrantedRoot[];
  remote: boolean;
  requester: Requester | null;
  /// false: the other computers only (list_files lists this one itself).
  self?: boolean;
  /// The language of the person's app, for the screens named.
  locale?: string | null;
}): Promise<MeshListing> {
  const me = selfIdentity();
  const peers =
    args.requester && args.remote && args.access.mode !== "off"
      ? meshPeers(args.userId).flatMap((peer) => {
          const scope = remoteScope(args.access, peer.computerId);
          return scope ? [{ peer, scope }] : [];
        })
      : [];
  const selfNamed = namesComputer(args.question, me.name);
  const named = peers.filter(({ peer }) => namesComputer(args.question, peer.name));
  // A computer named in the message: that one only. None: all of them.
  const askSelf = args.self !== false && (selfNamed || !named.length);
  const asked = selfNamed || named.length ? named : peers;

  const [own, ...theirs] = await Promise.all([
    askSelf ? listGrantedFiles({ intent: args.intent, roots: args.roots, granted: args.granted }) : Promise.resolve(null),
    ...asked.map(({ peer, scope }) => askPeer(peer, args.intent, scope, args.requester!)),
  ]);

  const several = peers.length > 0;
  const results: Array<{ computer_id: string; computer_name: string; listing: Listing | null; status: ListingOutcome["status"] }> = [];
  if (own) results.push({ computer_id: me.id, computer_name: me.name, listing: own, status: own.status });
  asked.forEach(({ peer }, index) => {
    const answer = theirs[index]!;
    results.push(typeof answer === "string"
      ? { computer_id: peer.computerId, computer_name: peer.name, listing: null, status: answer }
      : { computer_id: peer.computerId, computer_name: peer.name, listing: answer, status: answer.status });
  });

  const listed = results.filter((r) => r.listing?.status === "ok");
  const said = (r: (typeof results)[number]) => formatListing(r.listing!, args.intent, several ? r.computer_name : null, args.locale ?? null);
  const blocks: string[] = [];
  if (listed.length) {
    blocks.push(...listed.map(said));
  } else {
    // Nobody could list it: each computer says why, the ones that hold no
    // such folder left out when another one has it granted elsewhere.
    for (const r of results) if (r.listing && r.listing.status !== "ok") blocks.push(said(r));
  }
  const missed = results.filter((r) => !r.listing && (named.length || !listed.length));
  if (missed.length) {
    blocks.push(`[File listing] ${missed.map((r) => r.computer_name).join(", ")} could not be asked for its files for this message (${missed.map((r) => r.status).join(", ")}): say so briefly if the answer may be there.]`);
  }
  return {
    blocks,
    computers: results.map((r) => ({ computer_id: r.computer_id, computer_name: r.computer_name, status: r.status, total: r.listing?.total ?? 0 })),
    settled: results.some((r) => r.listing && r.listing.status !== "none"),
  };
}
