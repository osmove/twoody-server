import { eq } from "drizzle-orm";
import { createAuthSession, generateId, PLACEHOLDER_USER_NAME, type SessionOrigin } from "./auth.js";
import { authSessions, db, documentFolders, users } from "./db.js";
import { forgetTunnelPeersOfSession, rememberTunnelPeer, tunnelIdentity } from "./tunnel/identity.js";
import { tunnelPeersChanged } from "./tunnel/index.js";

// Giving a device a session on this computer and exchanging tunnel keys
// with it: what `/auth/pair` does once it has checked the setup token, and
// what the account approval loop does once a request passed its rules
// (account/approvals.ts).

export type PairingRole = "device" | "peer";

/// The session kind a role gets. A peer — another of the account's
/// computers sending its questions here — is limited to /api/v1/peer/*
/// (peerSessions.ts).
export function sessionKindFor(role: PairingRole, deviceName: string): string {
  return `${role === "peer" ? "peer" : "pair"}:${deviceName}`;
}

/// The one account of this server, made on the fly (as /auth/pair always
/// did) when there is none yet.
export function ensureLocalUser(): typeof users.$inferSelect {
  const [existing] = db.select().from(users).limit(1).all();
  if (existing) return existing;
  const userId = generateId();
  db.insert(users)
    .values({
      id: userId,
      email: `local-${userId.slice(0, 8)}@self-hosted.twoody`,
      name: PLACEHOLDER_USER_NAME,
      // No password set; signin stays blocked. Pair-token-only access is
      // the design here.
      passwordDigest: null,
      createdAt: new Date(),
    })
    .run();
  return db.select().from(users).where(eq(users.id, userId)).limit(1).all()[0]!;
}

export function pairDevice(args: {
  deviceName: string;
  tunnelPublicKey?: string | null;
  role?: PairingRole;
  origin?: SessionOrigin | null;
  /// The requester's id among the account's computers, when another
  /// computer of the account asked: its session goes when the account stops
  /// listing it.
  requesterComputerId?: string | null;
  /// The phone's vault device, when its signed device-access-v1 let it in
  /// (account/approvals.ts rule 5): its session goes when that device
  /// leaves the vault roster.
  vaultDeviceId?: string | null;
  /// Which rule of account/approvals.ts let it in, and the device-access it
  /// carried (JSON), kept with the session (sessionTrust.ts).
  approvalRule?: string | null;
  deviceAccessJson?: string | null;
}): {
  token: string;
  sessionId: string;
  user: typeof users.$inferSelect;
  tunnelPublicKey?: string;
} {
  const user = ensureLocalUser();
  const { token, sessionId } = createAuthSession(user.id, sessionKindFor(args.role ?? "device", args.deviceName), args.origin ?? null, args.requesterComputerId ?? null, args.vaultDeviceId ?? null, { rule: args.approvalRule ?? null, deviceAccessJson: args.deviceAccessJson ?? null });
  // The key swap, when the device brought one. The key goes with the
  // session: removing the device takes both.
  if (args.tunnelPublicKey) {
    rememberTunnelPeer({ userId: user.id, publicKey: Buffer.from(args.tunnelPublicKey, "hex"), name: args.deviceName, sessionId });
    // A tunnel already waiting at the relay starts waiting for this device
    // too, without a restart.
    tunnelPeersChanged();
    return { token, sessionId, user, tunnelPublicKey: tunnelIdentity().publicKey.toString("hex") };
  }
  return { token, sessionId, user };
}

/// Undoes a pairing: the session and the key that came with it.
export function unpairSession(sessionId: string): void {
  db.delete(authSessions).where(eq(authSessions.id, sessionId)).run();
  if (forgetTunnelPeersOfSession(sessionId) > 0) tunnelPeersChanged();
}

/// Fresh: nobody uses this server yet — no local account, no folder
/// granted. Only then is the account link code shown on the network, and a
/// neighbour on the LAN adopting the machine costs nothing.
export function isFresh(): boolean {
  return db.select({ id: users.id }).from(users).limit(1).all().length === 0 && db.select({ id: documentFolders.id }).from(documentFolders).limit(1).all().length === 0;
}
