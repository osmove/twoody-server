import { db, users } from "../db.js";
import { relayFetch } from "../outbound.js";
import { tunnelIdentity, tunnelPeersFor } from "./identity.js";
import { startTunnelHostLink, type TunnelHostLink } from "./hostLink.js";

// Waiting at the relay for the devices this computer is paired with.
//
// One link per paired device, because the rendezvous is derived from
// the pair of keys and two devices never share one. A household with
// two phones holds two long polls, which is the price of a relay that
// cannot tell the two apart.
//
// Off unless asked. It needs a Twoody account, because the relay is a
// service that has to be paid for and protected from being used as a
// free pipe, and because without one there is no name at the other end
// to hold the queues under. Everything on the same network keeps
// working without any of this.
//
// In local-only mode it is the one thing allowed out, and only through
// the one door that mode has (outbound.ts, `relayFetch`): the relay's
// frames endpoint, carrying frames sealed with keys the relay never
// sees. Nothing else this server does can use that door.

export interface TunnelServiceOptions {
  backendUrl: string;
  userToken: string;
  deviceToken?: string;
  /// Where the Twoody server on this machine answers.
  localBaseUrl: string;
  onError?(err: unknown): void;
  /// Told how many devices it waits for, whenever that changes — a
  /// device paired or removed while it runs.
  onLinksChanged?(paired: number): void;
  /// Told whether the relay answers, whenever that changes: null while no
  /// device is paired (nothing waits there, so nothing is known), then
  /// true once a wait comes back, false once they fail.
  onReachabilityChanged?(reachable: boolean | null): void;
  /// For tests standing in for the relay. Left out — as it always is
  /// outside tests — the tunnel goes through `relayFetch` and nowhere
  /// else.
  fetchImpl?: typeof fetch;
}

export interface TunnelService {
  /// One entry per paired device.
  readonly links: ReadonlyArray<{ rendezvous: string; connected: boolean }>;
  /// The relay this service waits at, as an origin.
  readonly relay: string;
  /// Whether the relay answers: null until a paired device's wait has
  /// come back or failed.
  readonly reachable: boolean | null;
  /// Opens a link for each device paired since the last look, and
  /// closes the link of each one that was removed.
  refresh(): void;
  stop(): void;
}

/// Reads the environment the bridge client already uses, since a
/// computer that lends its models to an account is the same computer
/// that would answer that account's phone.
export function readTunnelEnv(localBaseUrl: string): TunnelServiceOptions | null {
  if (process.env.TWOODY_TUNNEL !== "1") return null;
  const backendUrl = process.env.TWOODY_BACKEND_URL?.replace(/\/+$/, "");
  const userToken = process.env.TWOODY_USER_TOKEN;
  if (!backendUrl || !userToken) return null;
  return {
    backendUrl,
    userToken,
    deviceToken: process.env.TWOODY_DEVICE_TOKEN?.trim() || undefined,
    localBaseUrl,
  };
}

/// How Twoody Desktop talks to this server when it runs it as a utility
/// process (Electron's `process.parentPort`).
export interface TunnelParentPort {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

/// What a parent process may hand over to start the tunnel, checked. A
/// message is data from another process, and a malformed one should
/// start nothing rather than something half-configured.
export function tunnelCredentialsFrom(data: unknown): Pick<TunnelServiceOptions, "backendUrl" | "userToken" | "deviceToken"> | null {
  if (!data || typeof data !== "object") return null;
  const { backendUrl, userToken, deviceToken } = data as Record<string, unknown>;
  if (typeof backendUrl !== "string" || typeof userToken !== "string" || userToken.trim() === "") return null;
  try {
    const relay = new URL(backendUrl);
    if (relay.protocol !== "https:" && relay.protocol !== "http:") return null;
  } catch {
    return null;
  }
  return {
    backendUrl: backendUrl.replace(/\/+$/, ""),
    userToken,
    deviceToken: typeof deviceToken === "string" && deviceToken.trim() ? deviceToken.trim() : undefined,
  };
}

let running: TunnelService | null = null;

/// The service waiting at the relay right now, if any.
export function runningTunnel(): TunnelService | null {
  return running;
}

/// Called when a device has just left its key, or had it removed.
///
/// Pairing happens while the tunnel runs — pairing at home before
/// leaving is the whole point of it — so waiting for a restart would
/// leave a phone paired a minute ago unable to reach home, and a phone
/// removed a minute ago still able to.
export function tunnelPeersChanged(): void {
  running?.refresh();
}

export function startTunnelService(options: TunnelServiceOptions): TunnelService {
  running?.stop();

  const identity = tunnelIdentity();
  const fetchImpl = options.fetchImpl ?? relayFetch(options.backendUrl);
  const links = new Map<string, TunnelHostLink>();
  // Each link's last word on the relay. They all wait at the same one, so
  // any link it answers means it answers.
  const answered = new Map<string, boolean>();
  let reachable: boolean | null = null;
  // The first look is the starting state, reported by whoever started
  // the service; only what changes after it is news.
  let starting = true;

  function noteReachability(): void {
    const next = answered.size === 0 ? null : [...answered.values()].some(Boolean);
    if (next === reachable) return;
    reachable = next;
    options.onReachabilityChanged?.(next);
  }

  function refresh(): void {
    const before = links.size;
    const paired = new Set<string>();
    // Every account on this server, which on a single-user install is
    // the one account. A peer is paired with an account, not with the
    // machine, so the link is opened per account.
    for (const { id } of db.select({ id: users.id }).from(users).all()) {
      for (const peer of tunnelPeersFor(id)) {
        const key = `${id}:${peer.publicKey.toString("hex")}`;
        paired.add(key);
        if (links.has(key)) continue;
        links.set(
          key,
          startTunnelHostLink({
            backendUrl: options.backendUrl,
            userToken: options.userToken,
            deviceToken: options.deviceToken,
            identity,
            peerStaticKey: peer.publicKey,
            localBaseUrl: options.localBaseUrl,
            onError: options.onError,
            onReachable: (answers) => {
              if (!links.has(key)) return;
              answered.set(key, answers);
              noteReachability();
            },
            fetchImpl,
          }),
        );
      }
    }
    for (const [key, link] of links) {
      if (paired.has(key)) continue;
      link.stop();
      links.delete(key);
      answered.delete(key);
    }
    if (!starting && links.size !== before) options.onLinksChanged?.(links.size);
    noteReachability();
  }

  const service: TunnelService = {
    get links() {
      return [...links.values()].map((link) => ({ rendezvous: link.rendezvous, connected: link.connected }));
    },
    relay: new URL(options.backendUrl).origin,
    get reachable() {
      return reachable;
    },
    refresh,
    stop(): void {
      for (const link of links.values()) link.stop();
      links.clear();
      answered.clear();
      if (running === service) running = null;
    },
  };
  running = service;
  refresh();
  starting = false;
  return service;
}
