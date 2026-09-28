import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { DATA_DIR, db, tunnelPeers } from "../db.js";
import { createIdentity, KEY_BYTES, type StaticIdentity } from "./channel.js";

// This computer's long-lived tunnel key, and the devices it is paired
// with.
//
// The key outlives everything else: it is what a phone recognises the
// computer by, and changing it asks every paired device to pair again.
// So it is written once, to a file only this account can read, and read
// back afterwards.
//
// The trust in the whole tunnel rests on the moment these keys are
// exchanged, which is the pairing on the LAN — the person read a token
// printed in their own terminal and typed it into their own phone, on
// their own network. Nothing afterwards asks a server to vouch for
// anyone, which is why the relay cannot put itself in the middle.

const IDENTITY_PATH = join(DATA_DIR, "tunnel-identity");

/// X25519 keys are 32 bytes and the DER wrappers around them are fixed,
/// so the raw bytes are stored and the wrapper rebuilt. It is smaller
/// than PEM and exactly as precise.
const PRIVATE_KEY_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

let cached: StaticIdentity | null = null;

/// The key pair for this computer, made the first time it is asked for.
export function tunnelIdentity(): StaticIdentity {
  if (cached) return cached;

  if (existsSync(IDENTITY_PATH)) {
    const parsed = readIdentity(readFileSync(IDENTITY_PATH, "utf8").trim());
    if (parsed) {
      cached = parsed;
      return parsed;
    }
    // A file that is there but unreadable is worse than none: every
    // paired device would be refused with nothing said about why.
    console.warn(`[tunnel] ${IDENTITY_PATH} does not hold a key this version understands; making a new one. Paired devices must pair again.`);
  }

  const identity = createIdentity();
  writeFileSync(IDENTITY_PATH, `${privateKeyHex(identity.privateKey)}\n`, { mode: 0o600 });
  chmodSync(IDENTITY_PATH, 0o600);
  cached = identity;
  return identity;
}

/// Remembers a device as paired with this computer. The key is what the
/// tunnel recognises it by from then on.
export function rememberTunnelPeer(args: { userId: string; publicKey: Buffer; name?: string; sessionId?: string }): void {
  if (args.publicKey.length !== KEY_BYTES) throw new Error(`a tunnel key is ${KEY_BYTES} bytes`);
  const publicKey = args.publicKey.toString("hex");
  const existing = db.select().from(tunnelPeers).where(eq(tunnelPeers.publicKey, publicKey)).limit(1).all();
  if (existing.length > 0) {
    db.update(tunnelPeers)
      .set({ name: args.name ?? existing[0]!.name, lastSeenAt: new Date(), sessionId: args.sessionId ?? existing[0]!.sessionId })
      .where(eq(tunnelPeers.publicKey, publicKey))
      .run();
    return;
  }
  db.insert(tunnelPeers)
    .values({ publicKey, userId: args.userId, name: args.name ?? null, pairedAt: new Date(), lastSeenAt: new Date(), sessionId: args.sessionId ?? null })
    .run();
}

/// Forgets the keys of the devices that paired with this session.
/// Returns how many were forgotten.
export function forgetTunnelPeersOfSession(sessionId: string): number {
  const linked = db.select().from(tunnelPeers).where(eq(tunnelPeers.sessionId, sessionId)).all();
  if (linked.length > 0) db.delete(tunnelPeers).where(eq(tunnelPeers.sessionId, sessionId)).run();
  return linked.length;
}

/// The devices this computer will answer through the tunnel — one link
/// each.
export function tunnelPeersFor(userId: string): Array<{ publicKey: Buffer; name: string | null }> {
  return db
    .select()
    .from(tunnelPeers)
    .where(eq(tunnelPeers.userId, userId))
    .all()
    .map((row) => ({ publicKey: Buffer.from(row.publicKey, "hex"), name: row.name }));
}

/// Every device paired with this computer, whoever it belongs to: the
/// direct tunnel finds a phone by its rendezvous before knowing whose it is.
export function allTunnelPeers(): Array<{ publicKey: Buffer; userId: string }> {
  return db
    .select()
    .from(tunnelPeers)
    .all()
    .map((row) => ({ publicKey: Buffer.from(row.publicKey, "hex"), userId: row.userId }));
}

/// Undoes a pairing: that device can no longer reach this computer from
/// outside, whatever it still holds.
export function forgetTunnelPeer(args: { userId: string; publicKey: Buffer }): void {
  db.delete(tunnelPeers).where(and(eq(tunnelPeers.userId, args.userId), eq(tunnelPeers.publicKey, args.publicKey.toString("hex")))).run();
}

/// Only for tests, which want a fresh identity per case.
export function forgetTunnelIdentity(): void {
  cached = null;
}

function privateKeyHex(key: KeyObject): string {
  return Buffer.from(key.export({ type: "pkcs8", format: "der" })).subarray(-KEY_BYTES).toString("hex");
}

function readIdentity(hex: string): StaticIdentity | null {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  try {
    const privateKey = createPrivateKey({
      key: Buffer.concat([PRIVATE_KEY_PREFIX, Buffer.from(hex, "hex")]),
      format: "der",
      type: "pkcs8",
    });
    const publicKey = Buffer.from(createPublicKey(privateKey).export({ type: "spki", format: "der" })).subarray(-KEY_BYTES);
    return { publicKey, privateKey };
  } catch {
    return null;
  }
}
