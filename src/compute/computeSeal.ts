import {ed25519, x25519} from '@noble/curves/ed25519.js';
import {xchacha20poly1305} from '@noble/ciphers/chacha.js';
import {hkdf} from '@noble/hashes/hkdf.js';
import {sha256} from '@noble/hashes/sha2.js';
import {randomBytes as systemRandomBytes} from '@noble/hashes/utils.js';
import {ml_kem768} from '@noble/post-quantum/ml-kem.js';

import {canonicalHeader, fingerprint, fromHex, toHex} from './sealBase.js';

// A question someone asks a computer shared with them, sealed from their
// device to that computer (cockpit checklists/shared-compute-e2ee.md): the
// account relays blocks it cannot read, cannot forge, replay, reorder or
// cut short without it showing.
//
//   identities   each side: X25519 (key agreement) + Ed25519 (signature),
//                pinned together by their fingerprint
//   host prekey  X25519 + ML-KEM-768, signed by the host's Ed25519 key,
//                replaced every day and erased after 48 h
//   question     X3DH-like, hybrid post-quantum:
//                DH(IK_g, SPK) ‖ DH(EK_g, IK_h) ‖ DH(EK_g, SPK) ‖ ML-KEM(SPK)
//                → HKDF, bound to both identities, the grant and the prekey;
//                the header is signed by the guest's device
//   answer       the host's own ephemeral X25519 and an ML-KEM encapsulation
//                to the guest's ephemeral key: what was answered cannot be
//                read later from any long-term key; numbered pieces, the
//                last one carrying the count
//
// The host's computer reads what it computes: nothing here changes that.
// ML-KEM (@noble/post-quantum) is not independently audited yet; being
// hybrid, the exchange is never weaker than its X25519 part.
//
// Kept equal to twoody-desktop's src/shared/computeSeal.ts (the source),
// with the same vectors; the same code lives in twoody-app
// (utils/computeSeal.js) and twoody-server. Pure functions; `random` can
// be injected, for test vectors only.

export const COMPUTE_VERSION = 1;
export const REQUEST_SKEW_MS = 5 * 60 * 1000;
export const PREKEY_LIFETIME_MS = 48 * 60 * 60 * 1000;
/// How long a host remembers the request ids it has opened: a request
/// older than the clock window is refused anyway, so twice that suffices.
export const REPLAY_MEMORY_MS = 2 * REQUEST_SKEW_MS;
/// What a block relayed by the account may weigh before any work is done
/// on it: a question (history included) or one piece of an answer.
export const MAX_SEALED_BYTES = 256 * 1024;
/// The most pieces an answer may have.
export const MAX_CHUNKS = 100_000;

const X25519_HEX = 64;
const MLKEM_PUBLIC_HEX = 1184 * 2;
const MLKEM_CIPHERTEXT_HEX = 1088 * 2;
const NONCE_HEX = 48;
const SIGNATURE_HEX = 128;
const isHex = (value: unknown, length?: number) =>
  typeof value === 'string' && /^[0-9a-f]*$/.test(value) && value.length % 2 === 0 && (length === undefined || value.length === length);

type Random = (length: number) => Uint8Array;

export class ComputeSealError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'ComputeSealError';
  }
}

export interface ComputeIdentity {
  encPrivate: Uint8Array;
  encPublic: Uint8Array;
  signPrivate: Uint8Array;
  signPublic: Uint8Array;
}

export interface PublicIdentity {
  encPublic: string;
  signPublic: string;
}

export interface PrekeyBundle {
  id: string;
  x25519: string;
  mlkem: string;
  created_at: number;
  expires_at: number;
  signature: string;
}

export interface PrekeySecret {
  id: string;
  x25519Private: Uint8Array;
  mlkemSecret: Uint8Array;
  expiresAt: number;
}

export interface SealedRequest {
  v: number;
  grant_id: string;
  host_fp: string;
  guest_fp: string;
  spk_id: string;
  request_id: string;
  ts: number;
  ek: string;
  kem_ct: string;
  resp_kem: string;
  nonce: string;
  ciphertext: string;
  signature: string;
}

export interface ResponseHeader {
  ek_h: string;
  kem_ct: string;
}

export interface SealedChunk {
  seq: number;
  final: boolean;
  nonce: string;
  ciphertext: string;
}

const utf8 = (text: string) => new TextEncoder().encode(text);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

export function createComputeIdentity(random: Random = systemRandomBytes): ComputeIdentity {
  const encPrivate = random(32);
  const signPrivate = random(32);
  return {encPrivate, encPublic: x25519.getPublicKey(encPrivate), signPrivate, signPublic: ed25519.getPublicKey(signPrivate)};
}

export const publicIdentity = (identity: ComputeIdentity): PublicIdentity => ({
  encPublic: toHex(identity.encPublic),
  signPublic: toHex(identity.signPublic),
});

export const identityFingerprint = (identity: PublicIdentity): string =>
  fingerprint(fromHex(identity.encPublic), fromHex(identity.signPublic));

/// The number both people compare to know no one sits between them: the
/// same on both screens whatever the side, 60 digits in groups of 5, each
/// group from its own 3 bytes of an HKDF expansion (no byte used twice).
export function safetyNumber(a: PublicIdentity, b: PublicIdentity): string {
  const [first, second] = [identityFingerprint(a), identityFingerprint(b)].sort();
  const bytes = hkdf(sha256, canonicalHeader('twoody/compute/v1/safety', [first, second]), new Uint8Array(32), utf8('twoody/compute/v1/safety-number'), 36);
  const groups: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    const value = (bytes[i * 3] << 16) | (bytes[i * 3 + 1] << 8) | bytes[i * 3 + 2];
    groups.push(String(value % 100000).padStart(5, '0'));
  }
  return groups.join(' ');
}

function prekeySigned(hostSignPublic: string, bundle: Omit<PrekeyBundle, 'signature'>): Uint8Array {
  return canonicalHeader('twoody/compute/v1/prekey', [
    COMPUTE_VERSION, hostSignPublic, bundle.id, bundle.x25519, bundle.mlkem, bundle.created_at, bundle.expires_at,
  ]);
}

/// Today's prekey of a host: its public bundle (signed) and what stays on the host.
export function createHostPrekey({host, id, now, random = systemRandomBytes}: {
  host: ComputeIdentity; id: string; now: number; random?: Random;
}): {bundle: PrekeyBundle; secret: PrekeySecret} {
  const x25519Private = random(32);
  const mlkem = ml_kem768.keygen(random(64));
  const unsigned = {
    id,
    x25519: toHex(x25519.getPublicKey(x25519Private)),
    mlkem: toHex(mlkem.publicKey),
    created_at: now,
    expires_at: now + PREKEY_LIFETIME_MS,
  };
  const signature = toHex(ed25519.sign(prekeySigned(toHex(host.signPublic), unsigned), host.signPrivate));
  return {
    bundle: {...unsigned, signature},
    secret: {id, x25519Private, mlkemSecret: mlkem.secretKey, expiresAt: unsigned.expires_at},
  };
}

/// Whether a prekey is the host's and still in force. An unknown, forged or
/// expired one is refused, never replaced by the identity key alone.
export function prekeyValid(bundle: PrekeyBundle, host: PublicIdentity, now: number): boolean {
  try {
    if (!(now >= bundle.created_at - REQUEST_SKEW_MS && now < bundle.expires_at)) return false;
    const {signature, ...unsigned} = bundle;
    return ed25519.verify(fromHex(signature), prekeySigned(host.signPublic, unsigned), fromHex(host.signPublic));
  } catch {
    return false;
  }
}

/// What ties the keys to this guest, this host, this grant and this prekey.
function context(grantId: string, guest: PublicIdentity, host: PublicIdentity, spkId: string): Uint8Array {
  return canonicalHeader('twoody/compute/v1/context', [
    COMPUTE_VERSION, grantId, guest.encPublic, guest.signPublic, host.encPublic, host.signPublic, spkId,
  ]);
}

function requestKeys(secrets: Uint8Array[], ctx: Uint8Array): {requestKey: Uint8Array; chain: Uint8Array} {
  // 32 bytes of 0xFF first, as X3DH does, so the input never starts like a
  // bare X25519 output.
  const ikm = concat(new Uint8Array(32).fill(0xff), ...secrets);
  const okm = hkdf(sha256, ikm, new Uint8Array(32), concat(utf8('twoody/compute/v1/request'), ctx), 64);
  return {requestKey: okm.slice(0, 32), chain: okm.slice(32)};
}

function requestHeaderFields(request: Omit<SealedRequest, 'nonce' | 'ciphertext' | 'signature'>): unknown[] {
  return [
    request.v, request.grant_id, request.host_fp, request.guest_fp, request.spk_id,
    request.request_id, request.ts, request.ek, request.kem_ct, request.resp_kem,
  ];
}

function requestAad(request: Omit<SealedRequest, 'nonce' | 'ciphertext' | 'signature'>, ctx: Uint8Array): Uint8Array {
  return canonicalHeader('twoody/compute/v1/request', [...requestHeaderFields(request), toHex(ctx)]);
}

const signedPart = (aad: Uint8Array, nonce: string, ciphertext: string) =>
  canonicalHeader('twoody/compute/v1/request-signature', [toHex(sha256(aad)), nonce, toHex(sha256(fromHex(ciphertext)))]);

/// What the guest keeps to read the answer. Secret: forget it
/// (`forgetTurn`) as soon as the answer is final or abandoned.
export interface GuestTurn {
  grantId: string;
  requestId: string;
  requestHash: Uint8Array;
  guestEncPrivate: Uint8Array;
  ekPrivate: Uint8Array;
  respKemSecret: Uint8Array;
  chain: Uint8Array;
  ctx: Uint8Array;
}

export function sealComputeRequest({guest, host, prekey, grantId, requestId, now, body, random = systemRandomBytes}: {
  guest: ComputeIdentity;
  host: PublicIdentity;
  prekey: PrekeyBundle;
  grantId: string;
  requestId: string;
  now: number;
  body: unknown;
  random?: Random;
}): {request: SealedRequest; turn: GuestTurn} {
  if (!prekeyValid(prekey, host, now)) throw new ComputeSealError('prekey_invalid');
  const guestPublic = publicIdentity(guest);
  const ctx = context(grantId, guestPublic, host, prekey.id);

  const ekPrivate = random(32);
  const spk = fromHex(prekey.x25519);
  const {cipherText, sharedSecret} = ml_kem768.encapsulate(fromHex(prekey.mlkem), random(32));
  const {requestKey, chain} = requestKeys([
    x25519.getSharedSecret(guest.encPrivate, spk),
    x25519.getSharedSecret(ekPrivate, fromHex(host.encPublic)),
    x25519.getSharedSecret(ekPrivate, spk),
    sharedSecret,
  ], ctx);
  const respKem = ml_kem768.keygen(random(64));

  const header = {
    v: COMPUTE_VERSION,
    grant_id: grantId,
    host_fp: identityFingerprint(host),
    guest_fp: identityFingerprint(guestPublic),
    spk_id: prekey.id,
    request_id: requestId,
    ts: now,
    ek: toHex(x25519.getPublicKey(ekPrivate)),
    kem_ct: toHex(cipherText),
    resp_kem: toHex(respKem.publicKey),
  };
  const aad = requestAad(header, ctx);
  const nonce = random(24);
  const ciphertext = xchacha20poly1305(requestKey, nonce, aad).encrypt(utf8(JSON.stringify(body)));
  const signature = ed25519.sign(signedPart(aad, toHex(nonce), toHex(ciphertext)), guest.signPrivate);
  return {
    request: {...header, nonce: toHex(nonce), ciphertext: toHex(ciphertext), signature: toHex(signature)},
    turn: {
      grantId, requestId, requestHash: requestDigest(aad, ciphertext),
      guestEncPrivate: guest.encPrivate, ekPrivate, respKemSecret: respKem.secretKey, chain, ctx,
    },
  };
}

/// What the host keeps to seal the answer. Secret: forget it
/// (`forgetTurn`) as soon as the answer is final or abandoned.
export interface HostTurn {
  grantId: string;
  requestId: string;
  requestHash: Uint8Array;
  ek: Uint8Array;
  guestEnc: Uint8Array;
  respKem: Uint8Array;
  chain: Uint8Array;
  ctx: Uint8Array;
}

/// Opens a question on the host, after checking it comes from the pinned
/// guest device, for this grant and this host, now, and for the first time.
///
/// `markSeen(requestId)` is the caller's replay memory: an atomic
/// test-and-mark that answers false when the id was already there. It is
/// asked only once the request has opened, so a forged copy cannot burn a
/// legitimate id, and it must remember ids for REPLAY_MEMORY_MS at least.
export function openComputeRequest({host, prekeys, guest, request, grantId, now, markSeen}: {
  host: ComputeIdentity;
  prekeys: PrekeySecret[];
  guest: PublicIdentity;
  request: SealedRequest;
  grantId: string;
  now: number;
  markSeen: (requestId: string) => boolean;
}): {body: unknown; turn: HostTurn} {
  const hostPublic = publicIdentity(host);
  // Bounded before any work: the account relays this block.
  if (!request || typeof request !== 'object') throw new ComputeSealError('malformed');
  if (!isHex(request.ciphertext) || request.ciphertext.length > MAX_SEALED_BYTES * 2) throw new ComputeSealError('too_large');
  if (!isHex(request.ek, X25519_HEX) || !isHex(request.kem_ct, MLKEM_CIPHERTEXT_HEX) || !isHex(request.resp_kem, MLKEM_PUBLIC_HEX)
    || !isHex(request.nonce, NONCE_HEX) || !isHex(request.signature, SIGNATURE_HEX)) throw new ComputeSealError('malformed');
  if (request.v !== COMPUTE_VERSION) throw new ComputeSealError('version');
  if (request.grant_id !== grantId) throw new ComputeSealError('grant');
  if (request.host_fp !== identityFingerprint(hostPublic)) throw new ComputeSealError('host');
  if (request.guest_fp !== identityFingerprint(guest)) throw new ComputeSealError('guest');
  if (Math.abs(now - request.ts) > REQUEST_SKEW_MS) throw new ComputeSealError('stale');
  const prekey = prekeys.find((candidate) => candidate.id === request.spk_id);
  if (!prekey || now >= prekey.expiresAt) throw new ComputeSealError('prekey_unknown');

  const ctx = context(grantId, guest, hostPublic, prekey.id);
  const aad = requestAad(request, ctx);
  let signatureOk = false;
  try {
    signatureOk = ed25519.verify(fromHex(request.signature), signedPart(aad, request.nonce, request.ciphertext), fromHex(guest.signPublic));
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) throw new ComputeSealError('signature');

  const ek = fromHex(request.ek);
  const guestEnc = fromHex(guest.encPublic);
  const {requestKey, chain} = requestKeys([
    x25519.getSharedSecret(prekey.x25519Private, guestEnc),
    x25519.getSharedSecret(host.encPrivate, ek),
    x25519.getSharedSecret(prekey.x25519Private, ek),
    ml_kem768.decapsulate(fromHex(request.kem_ct), prekey.mlkemSecret),
  ], ctx);
  let plain: Uint8Array;
  try {
    plain = xchacha20poly1305(requestKey, fromHex(request.nonce), aad).decrypt(fromHex(request.ciphertext));
  } catch {
    throw new ComputeSealError('decrypt');
  }
  if (!markSeen(request.request_id)) throw new ComputeSealError('replay');
  return {
    body: JSON.parse(new TextDecoder().decode(plain)),
    turn: {
      grantId, requestId: request.request_id, requestHash: requestDigest(aad, fromHex(request.ciphertext)),
      ek, guestEnc, respKem: fromHex(request.resp_kem), chain, ctx,
    },
  };
}

/// The question an answer belongs to, bound into the answer's key.
const requestDigest = (aad: Uint8Array, ciphertext: Uint8Array) => sha256(concat(sha256(aad), ciphertext));

function responseKey(turn: {chain: Uint8Array; ctx: Uint8Array; requestHash: Uint8Array}, secrets: Uint8Array[]): Uint8Array {
  return hkdf(sha256, concat(turn.chain, ...secrets), new Uint8Array(32), concat(utf8('twoody/compute/v1/response'), turn.requestHash, turn.ctx), 32);
}

/// Wipes a turn's secrets once its answer is final or abandoned, and a
/// prekey's once it is 48 h old — as far as JavaScript lets anything be
/// wiped: the bytes are zeroed, copies the engine made are out of reach.
export function forgetTurn(turn: GuestTurn | HostTurn | PrekeySecret): void {
  for (const value of Object.values(turn)) if (value instanceof Uint8Array) value.fill(0);
}

const chunkAad = (grantId: string, requestId: string, ekH: string, seq: number, final: boolean) =>
  canonicalHeader('twoody/compute/v1/chunk', [COMPUTE_VERSION, grantId, requestId, ekH, seq, final ? 1 : 0]);

/// The host's side of the answer: a header to send first, then numbered pieces.
export function startComputeResponse(turn: HostTurn, random: Random = systemRandomBytes, {countFor = (seq: number) => seq + 1} = {}) {
  const ekHPrivate = random(32);
  const {cipherText, sharedSecret} = ml_kem768.encapsulate(turn.respKem, random(32));
  const key = responseKey(turn, [
    x25519.getSharedSecret(ekHPrivate, turn.ek),
    x25519.getSharedSecret(ekHPrivate, turn.guestEnc),
    sharedSecret,
  ]);
  const header: ResponseHeader = {ek_h: toHex(x25519.getPublicKey(ekHPrivate)), kem_ct: toHex(cipherText)};
  ekHPrivate.fill(0);
  let seq = 0;
  let closed = false;
  const seal = (payload: object, final: boolean): SealedChunk => {
    if (closed) throw new ComputeSealError('closed');
    const nonce = random(24);
    const ciphertext = xchacha20poly1305(key, nonce, chunkAad(turn.grantId, turn.requestId, header.ek_h, seq, final)).encrypt(utf8(JSON.stringify(payload)));
    const chunk = {seq, final, nonce: toHex(nonce), ciphertext: toHex(ciphertext)};
    seq += 1;
    if (final) closed = true;
    return chunk;
  };
  return {
    header,
    piece: (text: string) => seal({t: text}, false),
    /// The last piece: carries the count of pieces, itself included.
    finish: (text = '', extra: Record<string, unknown> = {}) => seal({...extra, t: text, n: countFor(seq)}, true),
  };
}

/// The guest's side: reads the pieces in order, refuses anything else.
export function openComputeResponse(turn: GuestTurn, header: ResponseHeader) {
  if (!isHex(header?.ek_h, X25519_HEX) || !isHex(header?.kem_ct, MLKEM_CIPHERTEXT_HEX)) throw new ComputeSealError('malformed');
  const key = responseKey(turn, [
    x25519.getSharedSecret(turn.ekPrivate, fromHex(header.ek_h)),
    x25519.getSharedSecret(turn.guestEncPrivate, fromHex(header.ek_h)),
    ml_kem768.decapsulate(fromHex(header.kem_ct), turn.respKemSecret),
  ]);
  let expected = 0;
  let done = false;
  return {
    get done() {
      return done;
    },
    open(chunk: SealedChunk): {text: string; final: boolean; extra: Record<string, unknown>} {
      if (done) throw new ComputeSealError('after_final');
      if (!chunk || !isHex(chunk.nonce, NONCE_HEX) || !isHex(chunk.ciphertext) || chunk.ciphertext.length > MAX_SEALED_BYTES * 2) {
        throw new ComputeSealError('malformed');
      }
      if (chunk.seq !== expected || chunk.seq >= MAX_CHUNKS) throw new ComputeSealError('sequence');
      let plain: Uint8Array;
      try {
        plain = xchacha20poly1305(key, fromHex(chunk.nonce), chunkAad(turn.grantId, turn.requestId, header.ek_h, chunk.seq, chunk.final)).decrypt(fromHex(chunk.ciphertext));
      } catch {
        throw new ComputeSealError('decrypt');
      }
      const {t, n, ...extra} = JSON.parse(new TextDecoder().decode(plain)) as {t?: string; n?: number} & Record<string, unknown>;
      if (chunk.final && n !== expected + 1) throw new ComputeSealError('count');
      expected += 1;
      if (chunk.final) done = true;
      return {text: typeof t === 'string' ? t : '', final: chunk.final, extra};
    },
  };
}
