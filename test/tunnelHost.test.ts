import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import test from "node:test";
import { Channel, createIdentity, startHandshake } from "../src/tunnel/channel.js";
import { createTunnelHost } from "../src/tunnel/host.js";
import { decode, encode, type Message } from "../src/tunnel/protocol.js";

// The two ends of the tunnel in one process, with a real HTTP server
// standing in for twoody-server. Nothing here is mocked except the
// distance: the frames are sealed and opened for real, and the "phone"
// only ever sees bytes, which is all it would see through a relay.

/// A Twoody server, for the purposes of these tests.
function localServer(): Promise<{ url: string; close(): Promise<void>; seen: Array<{ method: string; url: string; headers: Record<string, unknown>; body: string }> }> {
  const seen: Array<{ method: string; url: string; headers: Record<string, unknown>; body: string }> = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers as Record<string, unknown>, body: Buffer.concat(chunks).toString() });

      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json", "x-twoody": "oui" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url?.startsWith("/echo")) {
        res.writeHead(201, { "content-type": "text/plain" });
        res.end(`${req.method} ${req.url} ${Buffer.concat(chunks).toString()}`);
        return;
      }
      if (req.url === "/stream") {
        // Three pieces, with a pause between them: the point is that the
        // first arrives long before the last.
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const piece of ["un", "deux", "trois"]) {
          res.write(`data: ${piece}\n\n`);
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
        res.end();
        return;
      }
      if (req.url === "/slow") {
        setTimeout(() => {
          res.writeHead(200);
          res.end("tard");
        }, 5_000).unref();
        return;
      }
      if (req.url === "/big") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(Buffer.alloc(300 * 1024, 0x62));
        return;
      }
      res.writeHead(404);
      res.end("non");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        seen,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/// The phone's end: seals requests, collects what comes back.
function phoneSide(localBaseUrl: string, timeoutMs?: number) {
  const phone = createIdentity();
  const computer = createIdentity();
  const phoneHandshake = startHandshake();
  const computerHandshake = startHandshake();
  const phoneChannel = new Channel({
    role: "initiator",
    handshake: phoneHandshake,
    identity: phone,
    peerEphemeral: computerHandshake.ephemeralPublicKey,
    peerStatic: computer.publicKey,
  });
  const computerChannel = new Channel({
    role: "responder",
    handshake: computerHandshake,
    identity: computer,
    peerEphemeral: phoneHandshake.ephemeralPublicKey,
    peerStatic: phone.publicKey,
  });

  const received: Array<{ message: Message; body: Buffer; at: number }> = [];
  const errors: unknown[] = [];
  const waiters: Array<() => void> = [];

  const host = createTunnelHost({
    channel: computerChannel,
    localBaseUrl,
    timeoutMs,
    onError: (err) => errors.push(err),
    send: (frame) => {
      received.push({ ...decode(phoneChannel.open(frame)), at: Date.now() });
      while (waiters.length) waiters.pop()!();
    },
  });

  return {
    host,
    errors,
    received,
    /// Seals a request the way the phone would.
    request: (message: Message, body?: Buffer) => host.receive(phoneChannel.seal(encode(message, body))),
    /// The frames for one exchange, in order.
    frames: (id: number) => received.filter((entry) => "id" in entry.message && entry.message.id === id),
    /// Waits until `predicate` holds, or gives up.
    until: async (predicate: () => boolean, label: string) => {
      const deadline = Date.now() + 5_000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 20);
        });
      }
    },
    keys: { phoneChannel, computerChannel, phone, computer },
  };
}

test("a request from the phone is served by the server on this computer", async (t) => {
  const server = await localServer();
  t.after(() => server.close());
  const side = phoneSide(server.url);
  t.after(() => side.host.close());

  await side.request({ t: "req", id: 1, method: "GET", path: "/health", headers: { "x-user-token": "secret" } });

  const [head, ...rest] = side.frames(1);
  assert.equal(head.message.t, "res");
  assert.equal((head.message as { status: number }).status, 200);
  assert.equal((head.message as { headers: Record<string, string> }).headers["x-twoody"], "oui");
  assert.equal(Buffer.concat(rest.filter((f) => f.message.t === "chunk").map((f) => f.body)).toString(), '{"ok":true}');
  assert.equal(rest.at(-1)!.message.t, "end");
  // The headers the phone set travel; the ones that describe the hop do not.
  assert.equal(server.seen[0].headers["x-user-token"], "secret");
  assert.equal(side.errors.length, 0);
});

test("a request carries its method and its body", async (t) => {
  const server = await localServer();
  t.after(() => server.close());
  const side = phoneSide(server.url);
  t.after(() => side.host.close());

  await side.request(
    { t: "req", id: 7, method: "POST", path: "/echo?a=1", headers: { "content-type": "application/json" } },
    Buffer.from('{"message":"bonjour"}'),
  );

  const frames = side.frames(7);
  assert.equal((frames[0].message as { status: number }).status, 201);
  const body = Buffer.concat(frames.filter((f) => f.message.t === "chunk").map((f) => f.body)).toString();
  assert.equal(body, 'POST /echo?a=1 {"message":"bonjour"}');
});

test("a large body sent in pieces through the relay is served whole", async (t) => {
  const server = await localServer();
  t.after(() => server.close());
  const side = phoneSide(server.url);
  t.after(() => side.host.close());

  // A voice message is often more than a relay frame holds (~96 KB).
  const audio = Buffer.alloc(200 * 1024, "a");
  await side.request({ t: "req", id: 9, method: "POST", path: "/echo", headers: { "content-type": "text/plain" }, streamed: true });
  for (let at = 0; at < audio.length; at += 48 * 1024) await side.request({ t: "chunk", id: 9 }, audio.subarray(at, at + 48 * 1024));
  assert.equal(side.frames(9).length, 0, "nothing is served before the end");
  await side.request({ t: "end", id: 9 });

  const frames = side.frames(9);
  assert.equal((frames[0].message as { status: number }).status, 201);
  const body = Buffer.concat(frames.filter((f) => f.message.t === "chunk").map((f) => f.body)).toString();
  assert.equal(body, `POST /echo ${audio.toString()}`);
  assert.equal(side.errors.length, 0);
});

test("pieces of no request in progress are refused, not served", async (t) => {
  const server = await localServer();
  t.after(() => server.close());
  const side = phoneSide(server.url);
  t.after(() => side.host.close());

  await side.request({ t: "chunk", id: 4 }, Buffer.from("stray"));
  await side.request({ t: "end", id: 4 });
  assert.equal(side.frames(4).length, 0);
  assert.equal(side.errors.length, 2);
  assert.equal(server.seen.length, 0);
});

test("a streamed answer arrives in pieces, as it is written", async (t) => {
  const server = await localServer();
  t.after(() => server.close());
  const side = phoneSide(server.url);
  t.after(() => side.host.close());

  const started = Date.now();
  const done = side.request({ t: "req", id: 2, method: "GET", path: "/stream", headers: {} });

  // The first piece is readable well before the last is written: that is
  // the whole reason the answer is not one frame.
  await side.until(() => side.frames(2).some((f) => f.message.t === "chunk"), "the first chunk");
  const firstChunkAt = side.frames(2).find((f) => f.message.t === "chunk")!.at;
  await done;

  const frames = side.frames(2);
  const chunks = frames.filter((f) => f.message.t === "chunk");
  assert.ok(chunks.length >= 3, `expected the pieces to arrive separately, got ${chunks.length}`);
  assert.equal(Buffer.concat(chunks.map((f) => f.body)).toString(), "data: un\n\ndata: deux\n\ndata: trois\n\n");
  assert.ok(firstChunkAt - started < 40, "the first piece waited for the last");
  assert.equal(frames.at(-1)!.message.t, "end");
});

test("the tunnel reaches this computer's server and nothing else", async (t) => {
  const server = await localServer();
  t.after(() => server.close());
  const side = phoneSide(server.url);
  t.after(() => side.host.close());

  // A path may legitimately start with a slash; two of them change the
  // host, which is how a tunnel becomes an open proxy.
  await side.request({ t: "req", id: 3, method: "GET", path: "//example.com/", headers: {} });

  const frames = side.frames(3);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].message.t, "err");
  assert.match((frames[0].message as { message: string }).message, /only reaches the Twoody server/);
  assert.equal(server.seen.length, 0);
});

test("the phone can stop a request it no longer wants", async (t) => {
  const server = await localServer();
  t.after(() => server.close());
  const side = phoneSide(server.url);
  t.after(() => side.host.close());

  const running = side.request({ t: "req", id: 4, method: "GET", path: "/slow", headers: {} });
  await side.until(() => side.host.inFlight === 1, "the request to start");
  await side.request({ t: "abort", id: 4 });
  await running;

  assert.equal(side.frames(4).at(-1)!.message.t, "err");
  assert.equal(side.host.inFlight, 0);
});

test("a request that never answers is given up on", async (t) => {
  const server = await localServer();
  t.after(() => server.close());
  const side = phoneSide(server.url, 120);
  t.after(() => side.host.close());

  await side.request({ t: "req", id: 5, method: "GET", path: "/slow", headers: {} });

  const frames = side.frames(5);
  assert.equal(frames.at(-1)!.message.t, "err");
  assert.equal(side.host.inFlight, 0);
});

test("a frame the relay made up is dropped without an answer", async (t) => {
  const server = await localServer();
  t.after(() => server.close());
  const side = phoneSide(server.url);
  t.after(() => side.host.close());

  await side.host.receive(Buffer.alloc(64, 0x41));
  await side.host.receive(Buffer.from("pas une frame"));

  assert.equal(side.received.length, 0, "answering would tell the relay which guess was closer");
  assert.equal(side.errors.length, 2);
  assert.equal(server.seen.length, 0);
});

test("a message that opens but makes no sense is refused, not served", async (t) => {
  const server = await localServer();
  t.after(() => server.close());
  const side = phoneSide(server.url);
  t.after(() => side.host.close());

  // Sealed by the real phone key, so the channel accepts it; the
  // protocol should not.
  for (const nonsense of [{ t: "req", id: -1, method: "GET", path: "/health" }, { t: "req", id: 9, method: "GET", path: "health" }, { t: "req", id: 9, method: "GET", path: "/health", headers: { "x-a": "b\r\nx-c: d" } }, { t: "nope" }]) {
    await side.host.receive(side.keys.phoneChannel.seal(Buffer.concat([lengthOf(nonsense), Buffer.from(JSON.stringify(nonsense))])));
  }

  assert.equal(server.seen.length, 0);
  assert.equal(side.received.length, 0);
  assert.equal(side.errors.length, 4);
});

test("two requests with the same id do not become one", async (t) => {
  const server = await localServer();
  t.after(() => server.close());
  const side = phoneSide(server.url);
  t.after(() => side.host.close());

  const first = side.request({ t: "req", id: 6, method: "GET", path: "/slow", headers: {} });
  await side.until(() => side.host.inFlight === 1, "the first request to start");
  await side.request({ t: "req", id: 6, method: "GET", path: "/health", headers: {} });

  assert.equal(side.frames(6).length, 1);
  assert.equal(side.frames(6)[0].message.t, "err");
  await side.request({ t: "abort", id: 6 });
  await first;
});

test("an answer bigger than one frame comes back whole", async (t) => {
  const server = await localServer();
  t.after(() => server.close());
  const side = phoneSide(server.url);
  t.after(() => side.host.close());

  await side.request({ t: "req", id: 8, method: "GET", path: "/big", headers: {} });

  const chunks = side.frames(8).filter((f) => f.message.t === "chunk");
  assert.ok(chunks.length > 1, "a 300 KB answer should be cut into frames");
  assert.ok(chunks.every((f) => f.body.length <= 64 * 1024));
  assert.equal(Buffer.concat(chunks.map((f) => f.body)).length, 300 * 1024);
});

test("closing stops what is in flight", async (t) => {
  const server = await localServer();
  t.after(() => server.close());
  const side = phoneSide(server.url);

  const running = side.request({ t: "req", id: 10, method: "GET", path: "/slow", headers: {} });
  await side.until(() => side.host.inFlight === 1, "the request to start");
  side.host.close();
  await running;

  assert.equal(side.host.inFlight, 0);
  // Nothing is sent after close, not even the error for the request it
  // just stopped: the frame would have nowhere to go.
  assert.equal(side.frames(10).length, 0);
});

function lengthOf(header: unknown): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(Buffer.byteLength(JSON.stringify(header)), 0);
  return bytes;
}
