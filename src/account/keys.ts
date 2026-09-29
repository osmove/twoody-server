import {
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";

// X25519 keys as the account pairing speaks them: 32 raw bytes in hex for
// a public key; for a private key, 32 raw bytes in hex too (account.json),
// or the PKCS#8 DER in base64 the Desktop keeps (accountPairingCrypto.ts).

const PUBLIC_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const PRIVATE_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

export const HEX_KEY = /^[0-9a-f]{64}$/;

export function publicKeyObject(hex: string): KeyObject {
  if (!HEX_KEY.test(hex)) throw new Error("invalid public key");
  return createPublicKey({ key: Buffer.concat([PUBLIC_PREFIX, Buffer.from(hex, "hex")]), format: "der", type: "spki" });
}

/// A private key given as 64 hex characters (raw) or as PKCS#8 DER in base64.
export function privateKeyObject(key: string): KeyObject {
  if (HEX_KEY.test(key)) {
    return createPrivateKey({ key: Buffer.concat([PRIVATE_PREFIX, Buffer.from(key, "hex")]), format: "der", type: "pkcs8" });
  }
  return createPrivateKey({ key: Buffer.from(key, "base64"), format: "der", type: "pkcs8" });
}

export function publicHexOf(privateKey: string | KeyObject): string {
  const key = typeof privateKey === "string" ? privateKeyObject(privateKey) : privateKey;
  return Buffer.from(createPublicKey(key).export({ type: "spki", format: "der" })).subarray(-32).toString("hex");
}

export function privateHexOf(key: KeyObject): string {
  return Buffer.from(key.export({ type: "pkcs8", format: "der" })).subarray(-32).toString("hex");
}

export function x25519(privateKey: string | KeyObject, publicHex: string): Buffer {
  return diffieHellman({
    privateKey: typeof privateKey === "string" ? privateKeyObject(privateKey) : privateKey,
    publicKey: publicKeyObject(publicHex),
  });
}

/// A fresh pairing key pair, both halves in hex.
export function newPairingKey(): { priv: string; pub: string } {
  const pair = generateKeyPairSync("x25519");
  return { priv: privateHexOf(pair.privateKey), pub: publicHexOf(pair.privateKey) };
}
