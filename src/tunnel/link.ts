import { KEY_BYTES } from "./channel.js";

// How the two devices say hello through the relay.
//
// Before anything is sealed there has to be one exchange in the clear:
// each side's ephemeral public key for this session. Sending them in
// the open costs nothing — they are public keys, and the relay learning
// them buys it nothing, because what authenticates the session is the
// static keys the two devices already hold from pairing on the LAN.
//
// A hello is the only frame that is not sealed, so it is the only one
// that has to be told apart by looking at it: it carries a marker no
// sealed frame can begin with, since a sealed frame begins with a
// counter that starts at zero.

export const HELLO_MARKER = Buffer.from("TWOODY-TUNNEL-1\n", "ascii");

export function helloFrame(ephemeralPublicKey: Buffer): Buffer {
  if (ephemeralPublicKey.length !== KEY_BYTES) throw new Error(`an ephemeral key is ${KEY_BYTES} bytes`);
  return Buffer.concat([HELLO_MARKER, ephemeralPublicKey]);
}

/// The ephemeral key inside a hello, or null when the frame is not one.
export function readHello(frame: Buffer): Buffer | null {
  if (frame.length !== HELLO_MARKER.length + KEY_BYTES) return null;
  if (!frame.subarray(0, HELLO_MARKER.length).equals(HELLO_MARKER)) return null;
  return frame.subarray(HELLO_MARKER.length);
}
