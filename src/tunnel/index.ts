import { db, users } from "../db.js";
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

export interface TunnelServiceOptions {
  backendUrl: string;
  userToken: string;
  deviceToken?: string;
  /// Where the Twoody server on this machine answers.
  localBaseUrl: string;
  onError?(err: unknown): void;
}

export interface TunnelService {
  /// One entry per paired device.
  readonly links: ReadonlyArray<{ rendezvous: string; connected: boolean }>;
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

export function startTunnelService(options: TunnelServiceOptions): TunnelService | null {
  const identity = tunnelIdentity();
  const links: TunnelHostLink[] = [];

  // Every account on this server, which on a single-user install is the
  // one account. A peer is paired with an account, not with the
  // machine, so the link is opened per account.
  for (const { id } of db.select({ id: users.id }).from(users).all()) {
    for (const peer of tunnelPeersFor(id)) {
      links.push(
        startTunnelHostLink({
          backendUrl: options.backendUrl,
          userToken: options.userToken,
          deviceToken: options.deviceToken,
          identity,
          peerStaticKey: peer.publicKey,
          localBaseUrl: options.localBaseUrl,
          onError: options.onError,
        }),
      );
    }
  }

  if (links.length === 0) return null;
  return {
    get links() {
      return links.map((link) => ({ rendezvous: link.rendezvous, connected: link.connected }));
    },
    stop(): void {
      for (const link of links) link.stop();
    },
  };
}
