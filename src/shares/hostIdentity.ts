import { readFileSync, statSync } from "node:fs";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { fromHex, toHex } from "../compute/sealBase.js";

// This computer's sealed-turn identity (compute/computeHost.ts), public
// half only: what the safety number of a grantee's device is computed with
// (« Appareils en attente », GET /local_shares). The keys belong to the
// bridge client, wherever it runs:
//
//   - in this very process (a Pi, a server linked to an account): the
//     bridge client registers its identity here when it serves shares;
//   - in the Desktop's bridge worker, another process: read from its key
//     file, next to its bridge device id in the app's data folder — the
//     folder holding this server's data directory
//     (TWOODY_COMPUTE_KEYS_PATH says otherwise). Never created nor written
//     here; only the public keys are derived and kept.
//
// No database import: the bridge client (and its worker) import this file.

export interface HostIdentity {
  encPublic: string;
  signPublic: string;
}

let registered: (() => HostIdentity | null) | null = null;

/// The bridge client running in this process, when it serves shares.
export function registerShareHostIdentity(source: (() => HostIdentity | null) | null): void {
  registered = source;
}

let cached: { path: string; mtimeMs: number; identity: HostIdentity | null } | null = null;

/// The identity in a computeHost key file, public half; null when there is
/// none or it cannot be read.
export function identityFromKeyFile(path: string): HostIdentity | null {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  if (cached?.path === path && cached.mtimeMs === mtimeMs) return cached.identity;
  let identity: HostIdentity | null = null;
  try {
    const stored = JSON.parse(readFileSync(path, "utf8")) as { v?: unknown; identity?: { enc_private?: unknown; sign_private?: unknown } };
    const enc = stored.identity?.enc_private;
    const sign = stored.identity?.sign_private;
    if (stored.v === 1 && typeof enc === "string" && typeof sign === "string") {
      identity = { encPublic: toHex(x25519.getPublicKey(fromHex(enc))), signPublic: toHex(ed25519.getPublicKey(fromHex(sign))) };
    }
  } catch {
    identity = null;
  }
  cached = { path, mtimeMs, identity };
  return identity;
}

/// This computer's identity for shares, if it can be known here.
export function shareHostIdentity(desktopKeyFile: string | null): HostIdentity | null {
  const own = registered?.() ?? null;
  if (own) return own;
  const path = process.env.TWOODY_COMPUTE_KEYS_PATH?.trim() || desktopKeyFile;
  return path ? identityFromKeyFile(path) : null;
}
