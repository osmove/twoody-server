import { createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, timingSafeEqual, type KeyObject } from "node:crypto";

// The encrypted channel between two of the same person's devices — a
// phone and the computer that runs their Twoody — when they are not on
// the same network and have to meet through a relay.
//
// The relay's whole job is to copy bytes from one socket to the other.
// It must not be able to read them, and it must not be able to insert
// its own: that is what this module is for. It is the piece that has to
// be right, so it is pure, it touches no socket, and it is tested on its
// own.
//
// The construction uses nothing exotic, only what Node ships:
//
//   - each device holds a long-lived X25519 key pair. The public halves
//     are exchanged when the phone pairs on the LAN, where the person
//     typed the pairing code — that face-to-face moment is the trust
//     anchor, and it is what stops the relay from impersonating either
//     side later;
//   - every session also draws a fresh X25519 pair. The shared secret
//     mixes both: the ephemeral halves give forward secrecy (recording
//     today's traffic and stealing the device's key tomorrow does not
//     open it), the static halves give authentication;
//   - HKDF-SHA256 turns that secret into two keys, one per direction, so
//     a frame from the phone can never be replayed back at the phone;
//   - AES-256-GCM seals each frame, with a counter as nonce. A counter
//     is never reused because it only ever goes up, and the receiver
//     refuses anything it has already seen — that is the replay
//     protection, and it is also why a dropped connection must start a
//     new session rather than resume this one.
//
// What this does NOT defend against: a relay that refuses to forward, or
// forwards late. It can silence a conversation; it cannot read or forge
// one. Denial of service is a relay's prerogative by construction.

export const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_COUNTER = 2n ** 64n - 1n;
/// How far out of order frames may arrive. Wide enough that a slow
/// network never costs a message, narrow enough that the set of opened
/// counters stays small.
const WINDOW = 1024n;

export interface StaticIdentity {
  publicKey: Buffer;
  privateKey: KeyObject;
}

/// A device's long-lived identity. Kept on that device; only the public
/// half ever travels, and only during pairing.
export function createIdentity(): StaticIdentity {
  const pair = generateKeyPairSync("x25519");
  return {
    publicKey: Buffer.from(pair.publicKey.export({ type: "spki", format: "der" })).subarray(-KEY_BYTES),
    privateKey: pair.privateKey,
  };
}

/// Rebuilds a key object from the 32 raw bytes a peer sent.
export function publicKeyFrom(raw: Buffer): KeyObject {
  if (raw.length !== KEY_BYTES) throw new Error(`a public key is ${KEY_BYTES} bytes, got ${raw.length}`);
  const spki = Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), raw]);
  return createPublicKey({ key: spki, format: "der", type: "spki" });
}

export interface Handshake {
  /// Sent to the peer in the clear. It proves nothing by itself; the
  /// static keys do that.
  ephemeralPublicKey: Buffer;
  privateKey: KeyObject;
}

export function startHandshake(): Handshake {
  const pair = generateKeyPairSync("x25519");
  return {
    ephemeralPublicKey: Buffer.from(pair.publicKey.export({ type: "spki", format: "der" })).subarray(-KEY_BYTES),
    privateKey: pair.privateKey,
  };
}

export type Role = "initiator" | "responder";

/// Mixes the two exchanges into the pair of directional keys. Both sides
/// feed the same material in the same order — the role only decides
/// which of the two keys is used for sending.
function deriveKeys(args: {
  role: Role;
  handshake: Handshake;
  identity: StaticIdentity;
  peerEphemeral: Buffer;
  peerStatic: Buffer;
}): { send: Buffer; receive: Buffer } {
  const peerEphemeralKey = publicKeyFrom(args.peerEphemeral);
  const peerStaticKey = publicKeyFrom(args.peerStatic);
  const ephemeral = diffieHellman({ privateKey: args.handshake.privateKey, publicKey: peerEphemeralKey });
  const authenticated = diffieHellman({ privateKey: args.identity.privateKey, publicKey: peerStaticKey });

  // The transcript binds the keys to who spoke and in which order, so a
  // relay cannot pair two halves of different conversations.
  const initiator = args.role === "initiator";
  const transcript = Buffer.concat(
    initiator
      ? [args.handshake.ephemeralPublicKey, args.peerEphemeral, args.identity.publicKey, args.peerStatic]
      : [args.peerEphemeral, args.handshake.ephemeralPublicKey, args.peerStatic, args.identity.publicKey],
  );
  const secret = Buffer.concat([ephemeral, authenticated]);
  const keys = Buffer.from(hkdfSync("sha256", secret, transcript, "twoody tunnel v1", KEY_BYTES * 2));
  const first = keys.subarray(0, KEY_BYTES);
  const second = keys.subarray(KEY_BYTES);
  return initiator ? { send: first, receive: second } : { send: second, receive: first };
}

export class ChannelError extends Error {
  constructor(public code: "bad_frame" | "replayed" | "not_authentic" | "exhausted", message: string) {
    super(message);
  }
}

/// One session. Both ends build it from the same four public values and
/// their own private ones; from then on it only seals and opens frames.
export class Channel {
  private sendCounter = 0n;
  private received = new Set<bigint>();
  private highestSeen = -1n;
  private readonly sendKey: Buffer;
  private readonly receiveKey: Buffer;

  constructor(args: { role: Role; handshake: Handshake; identity: StaticIdentity; peerEphemeral: Buffer; peerStatic: Buffer }) {
    const keys = deriveKeys(args);
    this.sendKey = keys.send;
    this.receiveKey = keys.receive;
  }

  /// A frame is `counter (8) | tag (16) | ciphertext`. The counter is in
  /// the clear because the receiver needs it to build the nonce; it
  /// leaks only how many frames went by, and it is authenticated, so it
  /// cannot be edited in flight.
  seal(plaintext: Buffer | string): Buffer {
    if (this.sendCounter > MAX_COUNTER) throw new ChannelError("exhausted", "this session has sent all the frames it can; start another");
    const counter = this.sendCounter;
    this.sendCounter += 1n;
    const nonce = nonceFor(counter);
    const cipher = createCipheriv("aes-256-gcm", this.sendKey, nonce);
    const header = counterBytes(counter);
    cipher.setAAD(header);
    const body = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, "utf8");
    const sealed = Buffer.concat([cipher.update(body), cipher.final()]);
    return Buffer.concat([header, cipher.getAuthTag(), sealed]);
  }

  open(frame: Buffer): Buffer {
    if (frame.length < 8 + TAG_BYTES) throw new ChannelError("bad_frame", "frame too short to hold a counter and a tag");
    const header = frame.subarray(0, 8);
    const counter = header.readBigUInt64BE(0);
    // Two ways a frame can be one the relay kept a copy of: its counter
    // is one already opened, or it is so far behind that it fell out of
    // the window. Forgetting old counters is what makes the window
    // affordable, so anything below it has to be refused outright —
    // otherwise holding a frame long enough would make it new again.
    if (counter + WINDOW < this.highestSeen) throw new ChannelError("replayed", `frame ${counter} is too old for this session`);
    if (this.received.has(counter)) throw new ChannelError("replayed", `frame ${counter} has already been opened`);

    const decipher = createDecipheriv("aes-256-gcm", this.receiveKey, nonceFor(counter));
    decipher.setAAD(header);
    decipher.setAuthTag(frame.subarray(8, 8 + TAG_BYTES));
    let plaintext: Buffer;
    try {
      plaintext = Buffer.concat([decipher.update(frame.subarray(8 + TAG_BYTES)), decipher.final()]);
    } catch {
      // Either the relay edited it or it was never ours. Same answer.
      throw new ChannelError("not_authentic", "this frame was not sealed by the other device");
    }

    // Frames can cross in flight, so a window of counters is remembered
    // rather than a single high-water mark.
    if (counter > this.highestSeen) this.highestSeen = counter;
    this.received.add(counter);
    for (const seen of this.received) {
      if (seen + WINDOW < this.highestSeen) this.received.delete(seen);
    }
    return plaintext;
  }

  /// Proves to the other side that both derived the same keys, before
  /// anything real is sent. Comparing in constant time costs nothing and
  /// avoids answering "how wrong was I" to someone guessing.
  confirmation(): Buffer {
    return Buffer.from(hkdfSync("sha256", this.sendKey, this.receiveKey, "twoody tunnel confirm", KEY_BYTES));
  }

  accepts(confirmation: Buffer): boolean {
    const expected = Buffer.from(hkdfSync("sha256", this.receiveKey, this.sendKey, "twoody tunnel confirm", KEY_BYTES));
    return confirmation.length === expected.length && timingSafeEqual(confirmation, expected);
  }
}

function counterBytes(counter: bigint): Buffer {
  const header = Buffer.alloc(8);
  header.writeBigUInt64BE(counter, 0);
  return header;
}

function nonceFor(counter: bigint): Buffer {
  const nonce = Buffer.alloc(NONCE_BYTES);
  nonce.writeBigUInt64BE(counter, NONCE_BYTES - 8);
  return nonce;
}

/// A rendezvous name the two devices agree on without telling the relay
/// who they are: it is derived from their two static keys, so the relay
/// sees an opaque id and cannot turn it back into a person.
export function rendezvousId(a: Buffer, b: Buffer): string {
  const [first, second] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return Buffer.from(hkdfSync("sha256", Buffer.concat([first, second]), Buffer.alloc(32), "twoody tunnel rendezvous", 16)).toString("hex");
}

export { randomBytes };
