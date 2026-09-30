import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes as systemRandomBytes } from "@noble/hashes/utils.js";
import { canonicalHeader as sharedCanonicalHeader } from "../compute/sealBase.js";

// The keys of a person's encrypted history, and what they seal: a port of
// twoody-desktop src/shared/vault.ts (itself the same code as twoody-app
// utils/vault.js), byte for byte, checked against twoody-app's vectors
// (test/fixtures/vault-vectors.json, test/vaultCrypto.test.ts). Every
// device must read what another wrote, so nothing here may drift from
// those two: change them together or not at all.
//
//   device keys   X25519 (receives epoch keys) + Ed25519 (signs what it gives)
//   epoch key     32 random bytes, one per epoch; a new one when a device
//                 is removed, wrapped for each trusted device and for the
//                 recovery code
//   conversation  HKDF-SHA256(epoch key, conversation id)
//   event         XChaCha20-Poly1305 under the conversation key, its
//                 routing header as associated data
//
// One difference, on purpose: sealEvent also takes the kind "memory"
// (docs/mesh-design.md §3, the memories stream the account accepts since
// twoody-backend 693ac548). The encoding is unchanged.
//
// Pure functions over Uint8Arrays; `random` can be injected, for test
// vectors only.

export const VAULT_VERSION = 1;
export type Random = (length: number) => Uint8Array;
export type EpochEnvelope = {
  v: number; user_id: string; epoch: number; to_device: string; from_device: string;
  epk: string; nonce: string; ciphertext: string; signature: string;
};
type EventHeader = { v: number; user_id: string; conversation_id: string; event_id: string; epoch: number; kind: string; created_at: string };
export type SealedEvent = EventHeader & { nonce: string; ciphertext: string };
export type DeviceKeys = { encPrivate: Uint8Array; encPublic: Uint8Array; signPrivate: Uint8Array; signPublic: Uint8Array };
const KEY_BYTES = 32;
const NONCE_BYTES = 24;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class VaultError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
export function fromHex(hex: string): Uint8Array {
  if (typeof hex !== "string" || hex.length % 2 || !/^[0-9a-f]*$/.test(hex)) throw new VaultError("bad_hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
const utf8 = (value: unknown): Uint8Array => encoder.encode(String(value));
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/// Canonical bytes of a header: its fields in a fixed order, each
/// length-prefixed, so no two headers share an encoding. The one encoding
/// of this repository (src/compute/sealBase.ts), the same as the vault's.
export function canonicalHeader(label: string, fields: unknown[]): Uint8Array {
  return sharedCanonicalHeader(label, fields);
}

/// A device's two key pairs. The private halves stay on this computer
/// (DATA_DIR/vault.json, or the Desktop's safeStorage), never anywhere else.
export function createDeviceKeys(random: Random = systemRandomBytes): DeviceKeys {
  const encPrivate = random(KEY_BYTES);
  const signPrivate = random(KEY_BYTES);
  return {
    encPrivate, encPublic: x25519.getPublicKey(encPrivate),
    signPrivate, signPublic: ed25519.getPublicKey(signPrivate),
  };
}

export const createEpochKey = (random: Random = systemRandomBytes): Uint8Array => random(KEY_BYTES);

/// Short fingerprint two people compare when a device is enrolled.
export function fingerprint(encPublic: Uint8Array, signPublic: Uint8Array): string {
  return (toHex(sha256(concat(utf8("twoody/vault/fp/v1"), encPublic, signPublic)).slice(0, 10)).match(/.{4}/g) as string[]).join("-");
}

function envelopeHeader({ userId, epoch, toDevice, fromDevice, epk }: { userId: unknown; epoch: number; toDevice: string; fromDevice: string; epk: Uint8Array }) {
  return canonicalHeader("twoody/vault/envelope/v1", [VAULT_VERSION, userId, epoch, toDevice, fromDevice, toHex(epk)]);
}

/// What an approver signs to vouch for a device of the vault (the same
/// statement as twoody-app's utils/vault.js and the account's VaultDevice).
function approvalStatement({ userId, deviceId, encPublic, signPublic, approverId }: { userId: unknown; deviceId: string; encPublic: string; signPublic: string; approverId: string }) {
  return canonicalHeader("twoody/vault/approval/v1", [VAULT_VERSION, userId, deviceId, encPublic, signPublic, approverId]);
}

type ApprovedDevice = { id: string; enc_public: string; sign_public: string };

export function signApproval({ userId, device, approverId, signPrivate }: { userId: string | number; device: ApprovedDevice; approverId: string; signPrivate: Uint8Array }): string {
  return toHex(ed25519.sign(approvalStatement({ userId, deviceId: device.id, encPublic: device.enc_public, signPublic: device.sign_public, approverId }), signPrivate));
}

export function approvalValid({ userId, device, approverId, approverSignPublic, signature }: { userId: string | number; device: ApprovedDevice; approverId: string; approverSignPublic: Uint8Array; signature: string }): boolean {
  try {
    return ed25519.verify(fromHex(signature), approvalStatement({ userId, deviceId: device.id, encPublic: device.enc_public, signPublic: device.sign_public, approverId }), approverSignPublic);
  } catch {
    return false;
  }
}

/// The highest epoch number a vault uses: a safe integer far from 2**53,
/// where `n + 1 === n` would give two epoch keys the same number.
export const MAX_EPOCH = 2 ** 31 - 1;

/// Whether `epoch` is an epoch number: a safe, positive integer up to MAX_EPOCH.
export function isEpoch(epoch: unknown): epoch is number {
  return typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch >= 1 && epoch <= MAX_EPOCH;
}

/// Wraps an epoch key for one device, signed by the device that gives it.
export function wrapEpochKey({ epochKey, epoch, userId, to, from, random = systemRandomBytes }: {
  epochKey: Uint8Array; epoch: number; userId: string | number;
  to: { deviceId: string; encPublic: Uint8Array }; from: { deviceId: string; signPrivate: Uint8Array }; random?: Random;
}): EpochEnvelope {
  if (!(epochKey instanceof Uint8Array) || epochKey.length !== KEY_BYTES) throw new VaultError("bad_epoch_key");
  if (!isEpoch(epoch)) throw new VaultError("bad_epoch");
  const ephemeral = random(KEY_BYTES);
  const epk = x25519.getPublicKey(ephemeral);
  const shared = x25519.getSharedSecret(ephemeral, to.encPublic);
  const aad = envelopeHeader({ userId, epoch, toDevice: to.deviceId, fromDevice: from.deviceId, epk });
  const key = hkdf(sha256, shared, concat(epk, to.encPublic), aad, KEY_BYTES);
  const nonce = random(NONCE_BYTES);
  const ciphertext = xchacha20poly1305(key, nonce, aad).encrypt(epochKey);
  const signature = ed25519.sign(concat(aad, nonce, ciphertext), from.signPrivate);
  return {
    v: VAULT_VERSION, user_id: String(userId), epoch, to_device: to.deviceId, from_device: from.deviceId,
    epk: toHex(epk), nonce: toHex(nonce), ciphertext: toHex(ciphertext), signature: toHex(signature),
  };
}

/// Opens an epoch key wrapped for this device. `signers` maps the device
/// ids this device trusts to their Ed25519 public keys: an envelope from
/// anyone else is refused, however well it decrypts.
export function unwrapEpochKey(envelope: EpochEnvelope, { userId, device, signers }: {
  userId: string | number; device: { deviceId: string; encPrivate: Uint8Array; encPublic: Uint8Array }; signers: Map<string, Uint8Array>;
}): Uint8Array {
  if (envelope?.v !== VAULT_VERSION) throw new VaultError("unsupported_version");
  if (String(envelope.user_id) !== String(userId) || envelope.to_device !== device.deviceId) throw new VaultError("not_for_this_device");
  if (!isEpoch(envelope.epoch)) throw new VaultError("bad_epoch");
  const signer = signers?.get?.(envelope.from_device);
  if (!signer) throw new VaultError("untrusted_signer");
  const epk = fromHex(envelope.epk);
  const nonce = fromHex(envelope.nonce);
  const ciphertext = fromHex(envelope.ciphertext);
  const aad = envelopeHeader({ userId, epoch: envelope.epoch, toDevice: device.deviceId, fromDevice: envelope.from_device, epk });
  if (!ed25519.verify(fromHex(envelope.signature), concat(aad, nonce, ciphertext), signer)) throw new VaultError("bad_signature");
  const shared = x25519.getSharedSecret(device.encPrivate, epk);
  const key = hkdf(sha256, shared, concat(epk, device.encPublic), aad, KEY_BYTES);
  try {
    return xchacha20poly1305(key, nonce, aad).decrypt(ciphertext);
  } catch {
    throw new VaultError("bad_envelope");
  }
}

export function conversationKey(epochKey: Uint8Array, conversationId: string): Uint8Array {
  return hkdf(sha256, epochKey, utf8("twoody/vault/conversation/v1"), utf8(conversationId), KEY_BYTES);
}

const EVENT_KINDS = new Set(["turn", "title", "tombstone", "memory"]);
function eventHeader(h: EventHeader) {
  return canonicalHeader("twoody/vault/event/v1", [VAULT_VERSION, h.user_id, h.conversation_id, h.event_id, h.epoch, h.kind, h.created_at]);
}

/// Seals one event of a conversation. Only the header travels in clear —
/// what the account needs to store and return it.
export function sealEvent({ epochKey, epoch, userId, conversationId, eventId, kind, createdAt, payload, random = systemRandomBytes }: {
  epochKey: Uint8Array; epoch: number; userId: string | number; conversationId: string; eventId: string;
  kind: string; createdAt: string; payload: unknown; random?: Random;
}): SealedEvent {
  if (!EVENT_KINDS.has(kind)) throw new VaultError("bad_kind");
  const header: EventHeader = { v: VAULT_VERSION, user_id: String(userId), conversation_id: conversationId, event_id: eventId, epoch, kind, created_at: createdAt };
  const nonce = random(NONCE_BYTES);
  const plaintext = utf8(JSON.stringify(payload ?? null));
  const ciphertext = xchacha20poly1305(conversationKey(epochKey, conversationId), nonce, eventHeader(header)).encrypt(plaintext);
  return { ...header, nonce: toHex(nonce), ciphertext: toHex(ciphertext) };
}

/// Opens an event with the epoch keys this device holds (epoch → key). A
/// header changed on the way — another conversation, epoch or date — fails.
export function openEvent(event: SealedEvent, epochKeys: Map<number, Uint8Array>): unknown {
  if (event?.v !== VAULT_VERSION) throw new VaultError("unsupported_version");
  const epochKey = epochKeys?.get?.(event.epoch);
  if (!epochKey) throw new VaultError("missing_epoch_key");
  try {
    const plaintext = xchacha20poly1305(conversationKey(epochKey, event.conversation_id), fromHex(event.nonce), eventHeader(event))
      .decrypt(fromHex(event.ciphertext));
    return JSON.parse(decoder.decode(plaintext));
  } catch {
    throw new VaultError("bad_event");
  }
}

// --- the recovery code: 32 bytes and a 2-byte checksum as 55 Crockford
// base32 characters in groups of four. Shown once; it opens the epoch
// keys when every device is lost. A computer never makes one; it is here
// so that the vectors check the whole port.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function recoveryCode(secret: Uint8Array): string {
  if (!(secret instanceof Uint8Array) || secret.length !== KEY_BYTES) throw new VaultError("bad_recovery_secret");
  const data = concat(secret, sha256(secret).slice(0, 2));
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return (out.match(/.{1,4}/g) as string[]).join("-");
}

export function recoverySecret(code: string): Uint8Array {
  const clean = String(code || "").toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new VaultError("bad_recovery_code");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  if (bytes.length < KEY_BYTES + 2) throw new VaultError("bad_recovery_code");
  const secret = new Uint8Array(bytes.slice(0, KEY_BYTES));
  const check = sha256(secret).slice(0, 2);
  if (check[0] !== bytes[KEY_BYTES] || check[1] !== bytes[KEY_BYTES + 1]) throw new VaultError("bad_recovery_code");
  return secret;
}

/// The recovery code seen as one more device: its key pair is derived from
/// the code, so an envelope for it opens with the code alone.
export function recoveryDevice(secret: Uint8Array) {
  const encPrivate = hkdf(sha256, secret, utf8("twoody/vault/recovery/v1"), utf8("x25519"), KEY_BYTES);
  const signPrivate = hkdf(sha256, secret, utf8("twoody/vault/recovery/v1"), utf8("ed25519"), KEY_BYTES);
  return {
    deviceId: "recovery",
    encPrivate, encPublic: x25519.getPublicKey(encPrivate),
    signPrivate, signPublic: ed25519.getPublicKey(signPrivate),
  };
}

// --- invitation proof (twoody-desktop inviteProof): a computer nobody sits
// at never scans a QR code, but a person-device's proof is checked the same
// way everywhere.

export const INVITE_TTL_MS = 15 * 60 * 1000;
export function inviteProof({ secret, userId, encPublic, signPublic }: { secret: Uint8Array; userId: string | number; encPublic: Uint8Array; signPublic: Uint8Array }): string {
  if (!(secret instanceof Uint8Array) || secret.length !== KEY_BYTES) throw new VaultError("bad_invite");
  return toHex(hmac(sha256, secret, canonicalHeader("twoody/vault/invite/v1", [VAULT_VERSION, userId, toHex(encPublic), toHex(signPublic)])));
}
