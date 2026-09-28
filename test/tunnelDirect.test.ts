import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";

// The paired phone on the same network as this computer: its requests go
// sealed over a WebSocket to /tunnel, the channel the relay carries away
// from home. What crosses the network is checked byte by byte: nothing of
// the request or of the answer in clear.
process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-tunnel-direct-"));

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { Channel, createIdentity, rendezvousId, startHandshake } = await import("../src/tunnel/channel.js");
const { helloFrame, readHello } = await import("../src/tunnel/link.js");
const { decode, encode } = await import("../src/tunnel/protocol.js");

const app = await buildApp();
await app.listen({ port: 0, host: "127.0.0.1" });
const port = (app.server.address() as { port: number }).port;

const phone = createIdentity();
const paired = await app.inject({
  method: "POST",
  url: "/auth/pair",
  payload: { setup_token: ensureSetupToken()!.token, device_name: "iPhone de test", tunnel_public_key: phone.publicKey.toString("hex") },
});
assert.equal(paired.statusCode, 201);
const computerKey = Buffer.from(paired.json().tunnel_public_key, "hex");
const sessionToken: string = paired.json().token;

test.after(() => app.close());

/// Opens the socket, says hello, and returns a way to send requests and
/// what went over the wire.
async function connect(identity = phone, rendezvous = rendezvousId(phone.publicKey, computerKey)) {
  const wire: Buffer[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/tunnel?rendezvous=${rendezvous}`);
  socket.binaryType = "nodebuffer";
  const inbox: Buffer[] = [];
  let wake: (() => void) | null = null;
  const closed = new Promise<{ code: number; reason: string }>((resolve) => socket.on("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  socket.on("message", (data: Buffer) => {
    wire.push(data);
    inbox.push(data);
    wake?.();
  });
  const next = async (): Promise<Buffer> => {
    while (inbox.length === 0) await new Promise<void>((resolve) => (wake = resolve));
    return inbox.shift()!;
  };
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const handshake = startHandshake();
  const send = (frame: Buffer) => {
    wire.push(frame);
    socket.send(frame);
  };
  send(helloFrame(handshake.ephemeralPublicKey));
  const hello = readHello(await next());
  assert.ok(hello, "the computer answers the hello");
  const channel = new Channel({ role: "initiator", handshake, identity, peerEphemeral: hello!, peerStatic: computerKey });
  return {
    socket,
    wire,
    closed,
    send,
    async request(path: string, headers: Record<string, string> = {}) {
      send(channel.seal(encode({ t: "req", id: 1, method: "GET", path, headers })));
      const parts: Array<{ t: string; body: Buffer; status?: number }> = [];
      for (;;) {
        const { message, body } = decode(channel.open(await next()));
        parts.push({ t: message.t, body, status: (message as { status?: number }).status });
        if (message.t === "end" || message.t === "err") return parts;
      }
    },
  };
}

test("a request goes sealed to the local server, and its answer comes back sealed", async () => {
  const link = await connect();
  const parts = await link.request("/api/v1/me", { "x-user-token": sessionToken });
  assert.equal(parts[0].t, "res");
  assert.equal(parts[0].status, 200);
  const body = Buffer.concat(parts.filter((part) => part.t === "chunk").map((part) => part.body)).toString();
  assert.match(body, /"id"/);

  const onTheWire = Buffer.concat(link.wire).toString("latin1");
  for (const clear of [sessionToken, "/api/v1/me", "x-user-token", "\"id\""]) assert.ok(!onTheWire.includes(clear), `${clear} crossed the network`);
  link.socket.close();
});

test("an unknown rendezvous is refused before anything is said", async () => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/tunnel?rendezvous=${"0".repeat(32)}`);
  const code = await new Promise<number>((resolve) => socket.on("close", (closeCode) => resolve(closeCode)));
  assert.equal(code, 1008);
});

test("someone who knows the public keys but not the phone's private key is closed at the first frame", async () => {
  const intruder = createIdentity();
  const link = await connect(intruder, rendezvousId(phone.publicKey, computerKey));
  link.send(Buffer.alloc(64, 1));
  const { code } = await link.closed;
  assert.equal(code, 1008);
});

test("a second hello on the same socket ends it", async () => {
  const link = await connect();
  link.send(helloFrame(startHandshake().ephemeralPublicKey));
  const { code } = await link.closed;
  assert.equal(code, 1008);
});
