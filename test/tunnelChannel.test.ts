import assert from "node:assert/strict";
import test from "node:test";
import { Channel, ChannelError, createIdentity, rendezvousId, startHandshake, type StaticIdentity } from "../src/tunnel/channel.js";

// The relay between a phone and its computer forwards bytes it must not
// be able to read or forge. That property lives entirely in
// src/tunnel/channel.ts, so it is tested here on its own, with no socket
// and no server: two Channel objects in one process, and the frames
// passed between them by hand — which is exactly what a hostile relay
// would be able to do.

function pair(phone: StaticIdentity, computer: StaticIdentity) {
  const phoneSide = startHandshake();
  const computerSide = startHandshake();
  return {
    phone: new Channel({
      role: "initiator",
      handshake: phoneSide,
      identity: phone,
      peerEphemeral: computerSide.ephemeralPublicKey,
      peerStatic: computer.publicKey,
    }),
    computer: new Channel({
      role: "responder",
      handshake: computerSide,
      identity: computer,
      peerEphemeral: phoneSide.ephemeralPublicKey,
      peerStatic: phone.publicKey,
    }),
  };
}

test("the two devices end up with the same keys and can talk both ways", () => {
  const { phone, computer } = pair(createIdentity(), createIdentity());

  assert.equal(computer.open(phone.seal("bonjour")).toString(), "bonjour");
  assert.equal(phone.open(computer.seal("bonjour à toi")).toString(), "bonjour à toi");

  // And each recognises the other's confirmation, which is what lets a
  // session refuse to start rather than fail on the first real message.
  assert.ok(computer.accepts(phone.confirmation()));
  assert.ok(phone.accepts(computer.confirmation()));
});

test("a frame the relay edited is refused", () => {
  const { phone, computer } = pair(createIdentity(), createIdentity());
  const frame = phone.seal("virement de 10 €");

  for (const index of [2, 10, frame.length - 1]) {
    const tampered = Buffer.from(frame);
    tampered[index] ^= 0x01;
    assert.throws(() => computer.open(tampered), (err: ChannelError) => err.code === "not_authentic");
  }

  // Untouched, the original still opens: the failures above rejected the
  // edit, not the channel.
  assert.equal(computer.open(frame).toString(), "virement de 10 €");
});

test("a frame the relay kept and sent twice is refused", () => {
  const { phone, computer } = pair(createIdentity(), createIdentity());
  const frame = phone.seal("supprime le dossier");

  assert.equal(computer.open(frame).toString(), "supprime le dossier");
  assert.throws(() => computer.open(frame), (err: ChannelError) => err.code === "replayed");
});

test("an old frame the relay held back is refused once the session has moved on", () => {
  const { phone, computer } = pair(createIdentity(), createIdentity());
  const held = phone.seal("frame 0");
  for (let i = 1; i <= 2_000; i += 1) computer.open(phone.seal(`frame ${i}`));

  assert.throws(() => computer.open(held), (err: ChannelError) => err.code === "not_authentic" || err.code === "replayed");
});

test("frames that crossed in flight still open, in any order", () => {
  const { phone, computer } = pair(createIdentity(), createIdentity());
  const frames = [phone.seal("un"), phone.seal("deux"), phone.seal("trois")];

  assert.equal(computer.open(frames[2]).toString(), "trois");
  assert.equal(computer.open(frames[0]).toString(), "un");
  assert.equal(computer.open(frames[1]).toString(), "deux");
});

test("a frame from one direction cannot be replayed into the other", () => {
  const { phone, computer } = pair(createIdentity(), createIdentity());
  const fromPhone = phone.seal("c'est moi");

  // The relay bounces the phone's own frame back at it. Separate keys
  // per direction are what make this fail.
  assert.throws(() => phone.open(fromPhone), (err: ChannelError) => err.code === "not_authentic");
});

test("a relay that puts itself in the middle cannot read anything", () => {
  const phone = createIdentity();
  const computer = createIdentity();
  const relay = createIdentity();

  // The relay answers the phone with its own ephemeral key, hoping to
  // agree a session with it. It does not hold the computer's static key,
  // so the two sides derive different secrets and nothing opens.
  const phoneSide = startHandshake();
  const relaySide = startHandshake();
  const phoneChannel = new Channel({
    role: "initiator",
    handshake: phoneSide,
    identity: phone,
    peerEphemeral: relaySide.ephemeralPublicKey,
    peerStatic: computer.publicKey, // the phone still expects the computer
  });
  const relayChannel = new Channel({
    role: "responder",
    handshake: relaySide,
    identity: relay,
    peerEphemeral: phoneSide.ephemeralPublicKey,
    peerStatic: phone.publicKey,
  });

  assert.equal(relayChannel.accepts(phoneChannel.confirmation()), false);
  assert.throws(() => relayChannel.open(phoneChannel.seal("mot de passe")), (err: ChannelError) => err.code === "not_authentic");
});

test("a static key that is not the expected one fails the session", () => {
  const phone = createIdentity();
  const computer = createIdentity();
  const stranger = createIdentity();

  const phoneSide = startHandshake();
  const computerSide = startHandshake();
  const phoneChannel = new Channel({
    role: "initiator",
    handshake: phoneSide,
    identity: phone,
    peerEphemeral: computerSide.ephemeralPublicKey,
    peerStatic: stranger.publicKey, // paired with someone else's computer
  });
  const computerChannel = new Channel({
    role: "responder",
    handshake: computerSide,
    identity: computer,
    peerEphemeral: phoneSide.ephemeralPublicKey,
    peerStatic: phone.publicKey,
  });

  assert.equal(computerChannel.accepts(phoneChannel.confirmation()), false);
  assert.throws(() => computerChannel.open(phoneChannel.seal("salut")), (err: ChannelError) => err.code === "not_authentic");
});

test("two sessions between the same devices share nothing", () => {
  const phone = createIdentity();
  const computer = createIdentity();
  const first = pair(phone, computer);
  const second = pair(phone, computer);

  // Yesterday's frame does not open in today's session: that is what the
  // fresh ephemeral keys buy, and why a dropped connection starts over
  // instead of resuming.
  const yesterday = first.phone.seal("hier");
  assert.throws(() => second.computer.open(yesterday), (err: ChannelError) => err.code === "not_authentic");
});

test("a truncated frame is refused rather than crashing", () => {
  const { phone, computer } = pair(createIdentity(), createIdentity());
  const frame = phone.seal("bonjour");

  for (const length of [0, 8, 23]) {
    assert.throws(() => computer.open(frame.subarray(0, length)), (err: ChannelError) => err.code === "bad_frame");
  }
});

test("frames do not carry their content in the clear", () => {
  const { phone } = pair(createIdentity(), createIdentity());
  const secret = "mon numéro de sécurité sociale";
  assert.equal(phone.seal(secret).includes(Buffer.from(secret, "utf8")), false);
});

test("the rendezvous name is the same for both and says nothing about them", () => {
  const phone = createIdentity();
  const computer = createIdentity();
  const other = createIdentity();

  // Both sides compute it without asking the relay, and in either order.
  assert.equal(rendezvousId(phone.publicKey, computer.publicKey), rendezvousId(computer.publicKey, phone.publicKey));
  assert.notEqual(rendezvousId(phone.publicKey, computer.publicKey), rendezvousId(phone.publicKey, other.publicKey));

  const id = rendezvousId(phone.publicKey, computer.publicKey);
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(id.includes(phone.publicKey.toString("hex").slice(0, 8)), false);
});

test("an empty message is a message", () => {
  const { phone, computer } = pair(createIdentity(), createIdentity());
  assert.equal(computer.open(phone.seal(Buffer.alloc(0))).length, 0);
});

test("a big frame survives the round trip", () => {
  const { phone, computer } = pair(createIdentity(), createIdentity());
  const body = Buffer.alloc(512 * 1024, 0x61);
  assert.ok(computer.open(phone.seal(body)).equals(body));
});
