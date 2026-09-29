import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, type KeyObject } from "node:crypto";
import { HEX_KEY, x25519 } from "./keys.js";

// The account pairing envelope, v1: a port of Twoody Desktop's
// `sealPairing` (src/main/accountPairingCrypto.ts), byte for byte, and of
// the app's `openAccountPairing` (utils/accountPairing.js).
//
//   secret = X25519(host_priv, requester_pub)
//   aad    = "twoody-account-pairing-v1:" + request_id
//   key    = HKDF-SHA256(secret, salt=aad, info="credential envelope", 32)
//   frame  = 0x01 ‖ nonce(12) ‖ AES-256-GCM(key, nonce, aad, JSON(payload)) ‖ tag(16), base64
//
// The requester opens it with its private key and the host's public key.
// It carries a session on this computer, so it is never logged.

export function sealPairing(hostPrivate: string | KeyObject, requesterPublic: string, requestId: string, payload: unknown): string {
  if (!HEX_KEY.test(requesterPublic)) throw new Error("Invalid device key");
  const aad = Buffer.from(`twoody-account-pairing-v1:${requestId}`);
  const key = Buffer.from(hkdfSync("sha256", x25519(hostPrivate, requesterPublic), aad, Buffer.from("credential envelope"), 32));
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), nonce, ciphertext, cipher.getAuthTag()]).toString("base64");
}

/// Opens an envelope sealed for `requesterPrivate` by the host whose
/// public key is `hostPublic`. Throws when it does not open.
export function openPairing(requesterPrivate: string | KeyObject, hostPublic: string, requestId: string, sealed: string): unknown {
  if (!HEX_KEY.test(hostPublic) || typeof sealed !== "string" || sealed.length > 16000) throw new Error("invalid_enrollment");
  const frame = Buffer.from(sealed, "base64");
  if (frame[0] !== 1 || frame.length < 30) throw new Error("invalid_enrollment");
  const aad = Buffer.from(`twoody-account-pairing-v1:${requestId}`);
  const key = Buffer.from(hkdfSync("sha256", x25519(requesterPrivate, hostPublic), aad, Buffer.from("credential envelope"), 32));
  const decipher = createDecipheriv("aes-256-gcm", key, frame.subarray(1, 13));
  decipher.setAAD(aad);
  decipher.setAuthTag(frame.subarray(frame.length - 16));
  const plain = Buffer.concat([decipher.update(frame.subarray(13, frame.length - 16)), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}
