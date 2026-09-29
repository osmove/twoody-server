import { createHmac, hkdfSync, timingSafeEqual, type KeyObject } from "node:crypto";
import { HEX_KEY, x25519 } from "./keys.js";

// Endorsement v1 (docs/multi-computer-design.md §2).
//
// A computer without a screen cannot ask its person whether a new device
// may use it. A device the person already trusts can: when it approved
// this computer joining the account, its key was pinned here as an
// approver. It vouches for a later request with an HMAC keyed by the
// X25519 secret it shares with this computer — something neither the
// backend that carries it nor another account can produce.
//
//   key = HKDF-SHA256(X25519(approver_priv, host_pub), salt="twoody-endorse-v1:"+rid,
//                     info="approval endorsement", 32)
//   msg = "twoody-endorse-v1\n"+host_id+"\n"+rid+"\n"+requester_key+"\n"+expires_at
//   endorsement = base64(HMAC-SHA256(key, msg))
//
// host_id is the account computer's id (the :id of /account_computers/:id),
// rid the authorization request's id, requester_key its public_key (hex),
// expires_at its expires_at string exactly as the backend returned it.
// The host computes the same key from X25519(host_priv, approver_pub).

export interface EndorsedRequest {
  hostId: string;
  rid: string;
  requesterKey: string;
  expiresAt: string;
}

export function endorsementMessage(r: EndorsedRequest): string {
  return `twoody-endorse-v1\n${r.hostId}\n${r.rid}\n${r.requesterKey}\n${r.expiresAt}`;
}

function endorsementKey(privateKey: string | KeyObject, peerPublicHex: string, rid: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", x25519(privateKey, peerPublicHex), Buffer.from(`twoody-endorse-v1:${rid}`), Buffer.from("approval endorsement"), 32),
  );
}

/// What an approver sends: `approverPrivate` its private key, `hostPublic`
/// the host computer's pairing public key (hex).
export function endorse(approverPrivate: string | KeyObject, hostPublic: string, request: EndorsedRequest): string {
  return createHmac("sha256", endorsementKey(approverPrivate, hostPublic, request.rid))
    .update(endorsementMessage(request))
    .digest("base64");
}

/// What the host checks: `hostPrivate` its own pairing private key,
/// `approverPublic` a pinned approver key (hex).
export function verifyEndorsement(
  hostPrivate: string | KeyObject,
  approverPublic: string,
  request: EndorsedRequest,
  endorsement: unknown,
): boolean {
  if (typeof endorsement !== "string" || endorsement.length > 100 || !HEX_KEY.test(approverPublic)) return false;
  let given: Buffer;
  try {
    given = Buffer.from(endorsement, "base64");
  } catch {
    return false;
  }
  if (given.length !== 32) return false;
  let expected: Buffer;
  try {
    expected = createHmac("sha256", endorsementKey(hostPrivate, approverPublic, request.rid))
      .update(endorsementMessage(request))
      .digest();
  } catch {
    return false;
  }
  return timingSafeEqual(given, expected);
}
