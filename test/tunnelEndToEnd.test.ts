import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Channel, createIdentity, startHandshake } from "../src/tunnel/channel.js";
import { startTunnelClient } from "../src/tunnel/client.js";
import { startTunnelHostLink } from "../src/tunnel/hostLink.js";
import { helloFrame, readHello } from "../src/tunnel/link.js";
import { encode } from "../src/tunnel/protocol.js";
import { createRelayTransport } from "../src/tunnel/relayTransport.js";

// The whole path, with nothing simulated but the distance: a phone
// calls `fetch`, the frames go through a relay that behaves like the
// one in the Rails app, the computer opens them and answers from its
// own HTTP server.
//
// The relay here keeps its own copy of every frame it carries, and the
// tests read that copy. That is the interesting question about a
// tunnel: not only whether the answer arrives, but whether the thing in
// the middle could have known what was in it.

function twoodyServer(): Promise<{ url: string; close(): Promise<void>; calls: string[] }> {
  const calls: string[] = [];
  const server: Server = createServer(async (req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, secret: "le contenu de la conversation" }));
      return;
    }
    if (req.url === "/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const piece of ["Bonjour", " Jimmy", " !"]) {
        res.write(`data: ${piece}\n\n`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        calls,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/// The relay, as the backend implements it: two queues under a name, a
/// long poll that answers as soon as there is something, and no idea
/// what any of it means.
function relay(): Promise<{ url: string; close(): Promise<void>; carried: Buffer[]; tokens: Set<string> }> {
  const queues = new Map<string, string[]>();
  const listening = new Map<string, number>();
  const carried: Buffer[] = [];
  const tokens = new Set<string>();

  const take = (key: string) => (queues.get(key) ?? []).splice(0);

  const server: Server = createServer((req, res) => {
    tokens.add(String(req.headers["x-user-token"] ?? ""));
    const url = new URL(req.url ?? "/", "http://relay.invalid");
    if (!url.pathname.startsWith("/api/v1/tunnel/frames")) {
      res.writeHead(404).end();
      return;
    }

    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const { rendezvous, to, frames } = JSON.parse(Buffer.concat(chunks).toString());
        const key = `${rendezvous}:${to}`;
        const queue = queues.get(key) ?? [];
        for (const frame of frames as string[]) {
          queue.push(frame);
          carried.push(Buffer.from(frame, "base64"));
        }
        queues.set(key, queue);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ queued: frames.length, peer_listening: Date.now() - (listening.get(key) ?? 0) < 5_000 }));
      });
      return;
    }

    const as = url.searchParams.get("as") ?? "";
    const rendezvous = url.searchParams.get("rendezvous") ?? "";
    const key = `${rendezvous}:${as}`;
    const peer = `${rendezvous}:${as === "host" ? "phone" : "host"}`;
    const deadline = Date.now() + Number(url.searchParams.get("wait") ?? 25) * 1000;
    const answer = () => {
      listening.set(key, Date.now());
      const frames = take(key);
      if (frames.length === 0 && Date.now() < deadline) {
        setTimeout(answer, 20);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ frames, peer_listening: Date.now() - (listening.get(peer) ?? 0) < 5_000 }));
    };
    answer();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        carried,
        tokens,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test("a phone away from home reaches the Twoody on its computer", async (t) => {
  const local = await twoodyServer();
  const middle = await relay();
  const phone = createIdentity();
  const computer = createIdentity();

  const link = startTunnelHostLink({
    backendUrl: middle.url,
    userToken: "token-de-l-ordinateur",
    identity: computer,
    peerStaticKey: phone.publicKey,
    localBaseUrl: local.url,
    waitSeconds: 2,
  });
  const client = startTunnelClient({
    backendUrl: middle.url,
    userToken: "token-du-telephone",
    identity: phone,
    peerStaticKey: computer.publicKey,
    waitSeconds: 2,
  });
  t.after(async () => {
    client.stop();
    link.stop();
    await local.close();
    await middle.close();
  });

  // Both derived the same name without telling the relay anything.
  assert.equal(client.rendezvous, link.rendezvous);

  const response = await client.request("/health");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, secret: "le contenu de la conversation" });
  assert.deepEqual(local.calls, ["GET /health"]);

  // The relay carried every byte of that and could read none of it.
  assert.ok(middle.carried.length > 0);
  const everything = Buffer.concat(middle.carried);
  assert.equal(everything.includes(Buffer.from("le contenu de la conversation")), false);
  assert.equal(everything.includes(Buffer.from("/health")), false);
  assert.equal(everything.includes(Buffer.from("token-du-telephone")), false);
});

test("an answer being written arrives as it is written", async (t) => {
  const local = await twoodyServer();
  const middle = await relay();
  const phone = createIdentity();
  const computer = createIdentity();

  const link = startTunnelHostLink({
    backendUrl: middle.url,
    userToken: "ordinateur",
    identity: computer,
    peerStaticKey: phone.publicKey,
    localBaseUrl: local.url,
    waitSeconds: 2,
  });
  const client = startTunnelClient({ backendUrl: middle.url, userToken: "telephone", identity: phone, peerStaticKey: computer.publicKey, waitSeconds: 2 });
  t.after(async () => {
    client.stop();
    link.stop();
    await local.close();
    await middle.close();
  });

  const response = await client.request("/stream");
  assert.equal(response.headers.get("content-type"), "text/event-stream");

  const pieces: Array<{ text: string; at: number }> = [];
  const started = Date.now();
  const reader = response.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pieces.push({ text: Buffer.from(value).toString(), at: Date.now() - started });
  }

  const text = pieces.map((piece) => piece.text).join("");
  assert.equal(text, "data: Bonjour\n\ndata:  Jimmy\n\ndata:  !\n\n");
  assert.ok(pieces.length > 1, `the answer arrived in one piece (${pieces.length})`);
  assert.ok(pieces[0].at < pieces.at(-1)!.at, "the first piece waited for the last");
});

test("a stranger holding the right name still cannot talk to the computer", async (t) => {
  const local = await twoodyServer();
  const middle = await relay();
  const phone = createIdentity();
  const computer = createIdentity();
  const stranger = createIdentity();

  const link = startTunnelHostLink({
    backendUrl: middle.url,
    userToken: "ordinateur",
    identity: computer,
    peerStaticKey: phone.publicKey,
    localBaseUrl: local.url,
    waitSeconds: 2,
  });

  // Not the client class, which derives its own rendezvous: this is
  // someone sitting at the computer's actual rendezvous — the relay
  // knows it, so anyone with the relay does — and speaking into it
  // without either device's static key.
  const handshake = startHandshake();
  const answers: Buffer[] = [];
  const transport = createRelayTransport({
    backendUrl: middle.url,
    userToken: "voleur",
    rendezvous: link.rendezvous,
    as: "phone",
    waitSeconds: 2,
    onFrames: (frames) => {
      for (const frame of frames) answers.push(frame);
    },
  });
  t.after(async () => {
    transport.stop();
    link.stop();
    await local.close();
    await middle.close();
  });

  await transport.send([helloFrame(handshake.ephemeralPublicKey)]);
  // The hello is answered: it is not authenticated, and staying silent
  // would only tell the impostor it had been noticed.
  await waitFor(() => answers.some((frame) => readHello(frame) !== null), "the computer's hello");
  const peerEphemeral = answers.map(readHello).find((key): key is Buffer => key !== null)!;

  const channel = new Channel({
    role: "initiator",
    handshake,
    identity: stranger,
    peerEphemeral,
    peerStatic: computer.publicKey,
  });
  answers.length = 0;
  await transport.send([channel.seal(encode({ t: "req", id: 1, method: "GET", path: "/health", headers: {} }))]);
  await new Promise((resolve) => setTimeout(resolve, 600));

  // What fails is everything after the hello: the frame does not open
  // on the other side, so it is dropped without an answer.
  assert.deepEqual(answers, [], "the computer answered someone it is not paired with");
  assert.deepEqual(local.calls, [], "the local server was reached by someone unpaired");
  assert.equal(link.connected, false);
});

test("a phone told its computer is not there does not wait for an answer", async (t) => {
  const middle = await relay();
  const phone = createIdentity();
  const computer = createIdentity();
  const client = startTunnelClient({
    backendUrl: middle.url,
    userToken: "telephone",
    identity: phone,
    peerStaticKey: computer.publicKey,
    waitSeconds: 1,
    handshakeTimeoutMs: 1_200,
  });
  t.after(async () => {
    client.stop();
    await middle.close();
  });

  await assert.rejects(client.request("/health"), /not connected|did not answer/);
});

test("a phone that reconnects takes its session back", async (t) => {
  const local = await twoodyServer();
  const middle = await relay();
  const phone = createIdentity();
  const computer = createIdentity();

  const link = startTunnelHostLink({
    backendUrl: middle.url,
    userToken: "ordinateur",
    identity: computer,
    peerStaticKey: phone.publicKey,
    localBaseUrl: local.url,
    waitSeconds: 2,
  });
  t.after(async () => {
    link.stop();
    await local.close();
    await middle.close();
  });

  const first = startTunnelClient({ backendUrl: middle.url, userToken: "telephone", identity: phone, peerStaticKey: computer.publicKey, waitSeconds: 2 });
  await (await first.request("/health")).json();
  first.stop();

  // The same phone, a new session: new ephemeral keys, and the old
  // frames are worthless in it.
  const second = startTunnelClient({ backendUrl: middle.url, userToken: "telephone", identity: phone, peerStaticKey: computer.publicKey, waitSeconds: 2 });
  t.after(() => second.stop());
  assert.deepEqual(await (await second.request("/health")).json(), { ok: true, secret: "le contenu de la conversation" });
  assert.equal(local.calls.length, 2);
});

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
