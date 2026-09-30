import { and, eq, isNotNull } from "drizzle-orm";
import { accountCredentials, type AccountCredentials } from "../account/service.js";
import { backendCall, BackendError } from "../account/backend.js";
import { openPairing } from "../account/pairingSeal.js";
import { readStatus, type ComputerStatus } from "../account/status.js";
import { computerName } from "../account/link.js";
import { accountPeers, authSessions, db } from "../db.js";
import { unpairSession } from "../pairing.js";
import { KEY_BYTES, rendezvousId } from "../tunnel/channel.js";
import { startTunnelClient, type TunnelClient } from "../tunnel/client.js";
import { createDirectTransport } from "../tunnel/directTransport.js";
import { tunnelIdentity } from "../tunnel/identity.js";
import { isPrivateUrl, LOCAL_ONLY, relayFetch } from "../outbound.js";

// The account's other computers, seen from the one that sends them
// questions (docs/multi-computer-design.md §3).
//
// A peer is paired through the account: this computer asks for access
// (`request_access`, role "peer") with its own tunnel key; the other one —
// a Raspberry Pi — approves by its rules (account/approvals.ts), usually
// on the Desktop's endorsement, and seals back its address, a `peer:`
// session and its tunnel key. From then on everything goes through the
// sealed tunnel: its `/tunnel` socket on the local network first, the
// account's relay when that does not answer.

export type PeerRow = typeof accountPeers.$inferSelect;

export class PeerUnavailableError extends Error {
  constructor(
    message: string,
    readonly code: "unreachable" | "busy" | "no_model" | "not_linked" | "refused" = "unreachable",
  ) {
    super(message);
    this.name = "PeerUnavailableError";
  }
}

export function listPeers(userId: string): PeerRow[] {
  return db.select().from(accountPeers).where(eq(accountPeers.userId, userId)).all();
}

/// Peers this computer may route to: paired, enabled.
export function linkedPeers(userId: string): PeerRow[] {
  return listPeers(userId).filter((p) => p.state === "linked" && p.enabled && p.token && p.tunnelKey);
}

export function peerById(userId: string, computerId: string): PeerRow | null {
  return db.select().from(accountPeers).where(and(eq(accountPeers.userId, userId), eq(accountPeers.computerId, computerId))).limit(1).all()[0] ?? null;
}

// ── links ────────────────────────────────────────────────────────────────

/// How long a peer has to answer the hello: on the LAN, then at the relay.
const handshake = { lan: 2_500, relay: 8_000 };

/// Tests on a loaded machine give them longer.
export function setPeerHandshakeTimeouts(timeouts: Partial<typeof handshake>): void {
  Object.assign(handshake, timeouts);
}
const DIRECT_RETRY_MS = 60_000;

interface Link {
  direct: TunnelClient | null;
  relay: TunnelClient | null;
  directFailedAt: number;
  key: string;
}

const links = new Map<string, Link>();

function linkFor(peer: PeerRow): Link {
  const key = `${peer.url ?? ""}|${peer.tunnelKey}|${peer.token}`;
  const existing = links.get(peer.computerId);
  if (existing && existing.key === key) return existing;
  existing?.direct?.stop();
  existing?.relay?.stop();
  const link: Link = { direct: null, relay: null, directFailedAt: 0, key };
  links.set(peer.computerId, link);
  return link;
}

export function closePeerLink(computerId: string): void {
  const link = links.get(computerId);
  link?.direct?.stop();
  link?.relay?.stop();
  links.delete(computerId);
}

export function closeAllPeerLinks(): void {
  for (const id of [...links.keys()]) closePeerLink(id);
}

let relayFetchOverride: typeof fetch | null = null;
/// Tests stand in for the relay with this.
export function setPeerRelayFetch(fetchImpl: typeof fetch | null): void {
  relayFetchOverride = fetchImpl;
}

function directClient(peer: PeerRow): TunnelClient {
  const identity = tunnelIdentity();
  const peerKey = Buffer.from(peer.tunnelKey!, "hex");
  const rendezvous = rendezvousId(identity.publicKey, peerKey);
  return startTunnelClient({
    backendUrl: "http://direct.invalid",
    userToken: "",
    identity,
    peerStaticKey: peerKey,
    handshakeTimeoutMs: handshake.lan,
    helloRetryMs: null,
    createTransport: (hooks) => createDirectTransport({ url: peer.url!, rendezvous, onFrames: hooks.onFrames, onError: hooks.onError, onReset: hooks.onReset }),
  });
}

function relayClient(peer: PeerRow, creds: AccountCredentials): TunnelClient {
  return startTunnelClient({
    backendUrl: creds.backendUrl,
    userToken: creds.userToken,
    deviceToken: creds.deviceToken,
    identity: tunnelIdentity(),
    peerStaticKey: Buffer.from(peer.tunnelKey!, "hex"),
    handshakeTimeoutMs: handshake.relay,
    fetchImpl: relayFetchOverride ?? relayFetch(creds.backendUrl),
  });
}

export interface PeerRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/// One request to a peer's server, sealed: the LAN socket first (unless it
/// failed in the last minute), then the relay. Carries the peer session.
export async function peerRequest(peer: PeerRow, path: string, init: PeerRequestInit = {}): Promise<Response> {
  if (!peer.token || !peer.tunnelKey || Buffer.from(peer.tunnelKey, "hex").length !== KEY_BYTES) {
    throw new PeerUnavailableError(`${peer.name} is not paired with this computer`, "not_linked");
  }
  const link = linkFor(peer);
  const headers = { ...(init.headers ?? {}), "x-user-token": peer.token };
  const failures: string[] = [];

  const lanAllowed = peer.url && Date.now() - link.directFailedAt > DIRECT_RETRY_MS && (!LOCAL_ONLY || (await isPrivateUrl(peer.url)));
  if (lanAllowed) {
    try {
      link.direct ??= directClient(peer);
      return noteAnswer(peer, await link.direct.request(path, { ...init, headers }));
    } catch (err) {
      if (init.signal?.aborted) throw err;
      failures.push(err instanceof Error ? err.message : String(err));
      link.directFailedAt = Date.now();
      link.direct?.stop();
      link.direct = null;
    }
  }
  const creds = accountCredentials();
  if (!creds) {
    throw new PeerUnavailableError(`${peer.name} does not answer${failures.length ? ` (${failures.join("; ")})` : ""}`);
  }
  try {
    link.relay ??= relayClient(peer, creds);
    return noteAnswer(peer, await link.relay.request(path, { ...init, headers }));
  } catch (err) {
    if (init.signal?.aborted) throw err;
    link.relay?.stop();
    link.relay = null;
    throw new PeerUnavailableError(`${peer.name} does not answer (${[...failures, err instanceof Error ? err.message : String(err)].join("; ")})`);
  }
}

/// A peer that answers 401 no longer knows this computer's session: it
/// left the account, or was removed from it, or forgot this computer. It
/// is set aside (state « revoked ») so that no turn goes to it any more,
/// and the account's list is looked at again. A 404 or 410 has the list
/// looked at again too.
function noteAnswer(peer: PeerRow, response: Response): Response {
  if (response.status === 401) {
    markPeer(peer.computerId, "revoked", "session_revoked");
    requestPeerSync(peer.userId);
  } else if (response.status === 404 || response.status === 410) {
    requestPeerSync(peer.userId);
  }
  return response;
}

/// Sets a peer aside: nothing is routed to it, and what reached it is
/// forgotten (its session, address and key). DELETE /peers/:id forgets it.
function markPeer(computerId: string, state: "revoked" | "removed", error: string): void {
  closePeerLink(computerId);
  statuses.delete(computerId);
  const poll = polls.get(computerId);
  if (poll) clearTimeout(poll);
  polls.delete(computerId);
  db.update(accountPeers)
    .set({ state, error, token: null, url: null, tunnelKey: null, requestId: null, updatedAt: new Date() })
    .where(eq(accountPeers.computerId, computerId))
    .run();
}

// ── status ───────────────────────────────────────────────────────────────

export interface PeerStatusEntry {
  status: ComputerStatus;
  at: number;
  /// This entry's load and the one before: the router looks at two samples.
  loads: Array<ComputerStatus["load"]>;
}

const statuses = new Map<string, PeerStatusEntry>();

export function peerStatus(computerId: string): PeerStatusEntry | null {
  return statuses.get(computerId) ?? null;
}

/// Only for tests.
export function setPeerStatus(computerId: string, status: ComputerStatus | null, at = Date.now()): void {
  if (!status) {
    statuses.delete(computerId);
    return;
  }
  const previous = statuses.get(computerId);
  statuses.set(computerId, { status, at, loads: [...(previous?.loads.slice(-1) ?? []), status.load] });
}

export async function refreshPeerStatus(peer: PeerRow): Promise<PeerStatusEntry | null> {
  try {
    const response = await peerRequest(peer, "/api/v1/peer/status", { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return statuses.get(peer.computerId) ?? null;
    }
    const status = readStatus(await response.json().catch(() => null));
    if (!status) return statuses.get(peer.computerId) ?? null;
    setPeerStatus(peer.computerId, status);
    return statuses.get(peer.computerId)!;
  } catch {
    return statuses.get(peer.computerId) ?? null;
  }
}

let poller: NodeJS.Timeout | null = null;
let listingPoller: NodeJS.Timeout | null = null;

/// Asks each linked peer for its status every 20 s, and the account which
/// computers it still has every 5 min (TWOODY_PEER_LISTING_MS): a peer
/// removed from the account is set aside (syncPeersWithAccount).
export function startPeerStatusPoller(userIds: () => string[], everyMs = 20_000): () => void {
  const tick = async () => {
    for (const userId of userIds()) {
      await Promise.all(linkedPeers(userId).map((peer) => refreshPeerStatus(peer)));
    }
  };
  const override = Number(process.env.TWOODY_PEER_LISTING_MS);
  const listingEveryMs = Number.isFinite(override) && override > 0 ? override : 5 * 60_000;
  const sync = async () => {
    for (const userId of userIds()) {
      if (listPeers(userId).length > 0 || sessionsGivenToComputers().length > 0) await syncPeersWithAccount(userId).catch(() => undefined);
    }
  };
  if (poller) clearInterval(poller);
  if (listingPoller) clearInterval(listingPoller);
  poller = setInterval(() => void tick(), everyMs);
  poller.unref();
  listingPoller = setInterval(() => void sync(), listingEveryMs);
  listingPoller.unref();
  void sync();
  void tick();
  return () => {
    if (poller) clearInterval(poller);
    if (listingPoller) clearInterval(listingPoller);
    poller = null;
    listingPoller = null;
  };
}

/// The peers the account no longer lists are set aside (state « removed »):
/// the router stops sending them turns, on the LAN as through the relay.
/// And the sessions this computer gave to computers the account no longer
/// lists go (revokeSessionsOfRemovedComputers). Nothing changes when the
/// list cannot be had. Returns the ids of the peers set aside.
export async function syncPeersWithAccount(userId: string): Promise<string[]> {
  const computers = await accountComputers({ fresh: true, strict: true });
  if (!computers) return [];
  const listed = new Set(computers.map((c) => c.id));
  revokeSessionsOfRemovedComputers(listed);
  const removed: string[] = [];
  for (const peer of listPeers(userId)) {
    if (listed.has(peer.computerId) || peer.state === "removed") continue;
    markPeer(peer.computerId, "removed", "removed_from_account");
    removed.push(peer.computerId);
  }
  return removed;
}

/// The sessions this computer gave to another computer of the account
/// (a peer, approved here or by the Desktop), with that computer's id.
export function sessionsGivenToComputers(): Array<{ id: string; requesterComputerId: string }> {
  return db
    .select({ id: authSessions.id, requesterComputerId: authSessions.requesterComputerId })
    .from(authSessions)
    .where(isNotNull(authSessions.requesterComputerId))
    .all()
    .flatMap((s) => (s.requesterComputerId ? [{ id: s.id, requesterComputerId: s.requesterComputerId }] : []));
}

/// A computer removed from the account keeps nothing here: the sessions
/// given to it (and the tunnel keys that came with them) go, so that it
/// reaches this computer neither through the relay (the backend refuses
/// it already) nor on the LAN's /tunnel, where only this computer can
/// refuse it. `listed` is the account's list as the backend just gave it.
///
/// A list that does not name this computer itself is not trusted for that:
/// another account's list, or this computer removed — which the heartbeat
/// or the Desktop deal with. Returns how many sessions went.
export function revokeSessionsOfRemovedComputers(listed: Set<string>): number {
  const self = accountCredentials()?.computerId ?? null;
  if (self && !listed.has(self)) return 0;
  let revoked = 0;
  for (const session of sessionsGivenToComputers()) {
    if (listed.has(session.requesterComputerId)) continue;
    unpairSession(session.id);
    revoked += 1;
  }
  return revoked;
}

const syncRequested = new Map<string, number>();

/// A sync soon, at most one every 30 s per account.
function requestPeerSync(userId: string): void {
  const last = syncRequested.get(userId) ?? 0;
  if (Date.now() - last < 30_000) return;
  syncRequested.set(userId, Date.now());
  void syncPeersWithAccount(userId).catch(() => undefined);
}

// ── pairing as a peer ────────────────────────────────────────────────────

export interface AccountComputer {
  id: string;
  name: string;
  public_key: string;
  online: boolean;
  kind: string | null;
  platform: string | null;
  host_id: string | null;
  last_seen_at: string | null;
  approval: string | null;
  approver_keys: string[];
  status: ComputerStatus | null;
}

let listing: { at: number; key: string; computers: AccountComputer[] } | null = null;

export function readAccountComputers(raw: unknown): AccountComputer[] {
  const list = (raw as { computers?: unknown } | null)?.computers;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry): AccountComputer[] => {
    const c = entry as Record<string, unknown> | null;
    if (!c || (typeof c.id !== "string" && typeof c.id !== "number") || typeof c.name !== "string") return [];
    return [
      {
        id: String(c.id),
        name: c.name.slice(0, 100),
        public_key: typeof c.public_key === "string" ? c.public_key : "",
        online: c.online === true,
        kind: typeof c.kind === "string" ? c.kind : null,
        platform: typeof c.platform === "string" ? c.platform : null,
        host_id: typeof c.host_id === "string" ? c.host_id : null,
        last_seen_at: typeof c.last_seen_at === "string" ? c.last_seen_at : null,
        approval: typeof c.approval === "string" ? c.approval : null,
        approver_keys: Array.isArray(c.approver_keys) ? (c.approver_keys as unknown[]).filter((k): k is string => typeof k === "string") : [],
        status: readStatus(c.status),
      },
    ];
  });
}

/// The account's computers, as the backend lists them (kept 30 s). When
/// the backend does not answer, the last list — unless `strict`, which
/// wants the backend's answer or null.
export async function accountComputers(options: { fresh?: boolean; strict?: boolean } = {}): Promise<AccountComputer[] | null> {
  const creds = accountCredentials();
  if (!creds) return null;
  const key = `${creds.backendUrl}|${creds.userToken}`;
  if (!options.fresh && listing && listing.key === key && Date.now() - listing.at < 30_000) return listing.computers;
  try {
    const { body } = await backendCall({ backendUrl: creds.backendUrl, userToken: creds.userToken, deviceToken: creds.deviceToken }, "account_computers", { timeoutMs: 8_000 });
    const list = (body as { computers?: unknown } | null)?.computers;
    // An answer that is not a list says nothing of which computers left.
    if (!Array.isArray(list)) return options.strict ? null : listing && listing.key === key ? listing.computers : null;
    listing = { at: Date.now(), key, computers: readAccountComputers(body) };
    return listing.computers;
  } catch {
    if (options.strict) return null;
    return listing && listing.key === key ? listing.computers : null;
  }
}

export function forgetAccountComputers(): void {
  listing = null;
}

const polls = new Map<string, NodeJS.Timeout>();

/// POST /peers: asks the computer `computerId` for peer access with this
/// server's tunnel key, and waits (in the background) for its sealed answer.
/// `requester`: the computer of the account that asks, when the session
/// this server acts with is not one (Twoody Desktop signs in as its
/// person) — its id and credential, which the backend checks and names the
/// request after; sent with this one call only, kept nowhere.
export async function requestPeer(
  userId: string,
  computerId: string,
  options: { name?: string; requester?: { computerId: string; credential: string } } = {},
): Promise<{ request_id: string; expires_at: string | null }> {
  const creds = accountCredentials();
  if (!creds) throw new PeerUnavailableError("this server is not linked to an account", "not_linked");
  if ((creds.computerId && creds.computerId === computerId) || options.requester?.computerId === computerId) {
    throw new PeerUnavailableError("a computer is not its own peer", "refused");
  }
  const computers = (await accountComputers({ fresh: true })) ?? [];
  const target = computers.find((c) => c.id === computerId);
  if (!target) throw new PeerUnavailableError("no such computer in the account", "not_linked");
  const { body } = await backendCall<{ id: string | number; expires_at?: string }>(
    { backendUrl: creds.backendUrl, userToken: creds.userToken, deviceToken: creds.deviceToken, requesterCredential: options.requester?.credential },
    `account_computers/${encodeURIComponent(computerId)}/request_access`,
    {
      body: {
        name: (options.name ?? creds.computerName ?? computerName()).slice(0, 100),
        public_key: tunnelIdentity().publicKey.toString("hex"),
        role: "peer",
        ...(options.requester ? { requester_computer_id: options.requester.computerId } : {}),
      },
    },
  );
  const requestId = String(body.id);
  const now = new Date();
  const values = {
    userId,
    name: target.name,
    kind: target.kind,
    platform: target.platform,
    state: "requested",
    requestId,
    requestExpiresAt: body.expires_at ? new Date(body.expires_at) : new Date(Date.now() + 5 * 60_000),
    hostKey: target.public_key,
    error: null,
    updatedAt: now,
  };
  const existing = peerById(userId, computerId);
  if (existing) {
    // A peer already linked keeps working until the new answer replaces it.
    db.update(accountPeers)
      .set(existing.state === "linked" ? { requestId, requestExpiresAt: values.requestExpiresAt, hostKey: target.public_key, updatedAt: now } : values)
      .where(eq(accountPeers.computerId, computerId))
      .run();
  } else {
    db.insert(accountPeers).values({ computerId, ...values, createdAt: now }).run();
  }
  watchPeerRequest(userId, computerId);
  return { request_id: requestId, expires_at: values.requestExpiresAt.toISOString() };
}

/// One look at the answer to a peer request. Exposed for tests.
export async function checkPeerRequest(userId: string, computerId: string): Promise<"pending" | "linked" | "failed"> {
  const peer = peerById(userId, computerId);
  const creds = accountCredentials();
  if (!peer?.requestId || !creds) return "failed";
  const fail = (error: string) => {
    db.update(accountPeers)
      .set({ ...(peer.state === "linked" ? {} : { state: "failed" }), requestId: null, error, updatedAt: new Date() })
      .where(eq(accountPeers.computerId, computerId))
      .run();
    return "failed" as const;
  };
  if (peer.requestExpiresAt && peer.requestExpiresAt.getTime() < Date.now()) return fail("expired");
  const userCreds = { backendUrl: creds.backendUrl, userToken: creds.userToken, deviceToken: creds.deviceToken };
  const path = `account_computers/${encodeURIComponent(computerId)}/authorizations/${encodeURIComponent(peer.requestId)}`;
  let answer: { state?: string; sealed_response?: string | null };
  try {
    answer = (await backendCall<typeof answer>(userCreds, path)).body ?? {};
  } catch (err) {
    if (err instanceof BackendError && (err.status === 410 || err.status === 404)) {
      requestPeerSync(userId);
      return fail("expired");
    }
    return "pending";
  }
  if (answer.state === "denied") return fail("denied");
  if (answer.state !== "approved" || !answer.sealed_response || !peer.hostKey) return "pending";
  let opened: Record<string, unknown>;
  try {
    opened = openPairing(tunnelIdentity().privateKey, peer.hostKey, peer.requestId, answer.sealed_response) as Record<string, unknown>;
  } catch {
    return fail("unreadable_answer");
  }
  const url = typeof opened.localServerUrl === "string" ? opened.localServerUrl : null;
  const token = typeof opened.localServerToken === "string" ? opened.localServerToken : null;
  const tunnelKey = typeof opened.computerTunnelKey === "string" && /^[0-9a-f]{64}$/.test(opened.computerTunnelKey) ? opened.computerTunnelKey : null;
  if (!url || !token || !tunnelKey) return fail("unreadable_answer");
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return fail("unreadable_answer");
  } catch {
    return fail("unreadable_answer");
  }
  closePeerLink(computerId);
  db.update(accountPeers)
    .set({
      state: "linked",
      url,
      token,
      tunnelKey,
      name: typeof opened.computerName === "string" && opened.computerName ? opened.computerName.slice(0, 100) : peer.name,
      kind: typeof opened.kind === "string" ? opened.kind : peer.kind,
      requestId: null,
      error: null,
      enabled: true,
      updatedAt: new Date(),
    })
    .where(eq(accountPeers.computerId, computerId))
    .run();
  await backendCall(userCreds, `${path}/consume`, { body: {} }).catch(() => undefined);
  const linked = peerById(userId, computerId);
  if (linked) void refreshPeerStatus(linked);
  return "linked";
}

function watchPeerRequest(userId: string, computerId: string): void {
  const previous = polls.get(computerId);
  if (previous) clearTimeout(previous);
  const override = Number(process.env.TWOODY_PEER_POLL_MS);
  const every = Number.isFinite(override) && override > 0 ? override : 3_000;
  const tick = async () => {
    const state = await checkPeerRequest(userId, computerId).catch(() => "pending" as const);
    if (state === "pending") {
      const timer = setTimeout(() => void tick(), every);
      timer.unref();
      polls.set(computerId, timer);
    } else {
      polls.delete(computerId);
    }
  };
  const timer = setTimeout(() => void tick(), every);
  timer.unref();
  polls.set(computerId, timer);
}

/// DELETE /peers/:id: the peer forgets this computer's session when it can
/// be reached, and this computer forgets the peer.
export async function removePeer(userId: string, computerId: string): Promise<boolean> {
  const peer = peerById(userId, computerId);
  if (!peer) return false;
  const poll = polls.get(computerId);
  if (poll) clearTimeout(poll);
  polls.delete(computerId);
  if (peer.state === "linked") {
    await peerRequest(peer, "/api/v1/peer/session", { method: "DELETE", signal: AbortSignal.timeout(5_000) })
      .then((r) => r.body?.cancel())
      .catch(() => undefined);
  }
  closePeerLink(computerId);
  statuses.delete(computerId);
  db.delete(accountPeers).where(eq(accountPeers.computerId, computerId)).run();
  return true;
}
