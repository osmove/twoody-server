import { test } from "node:test";
import assert from "node:assert/strict";
import { createRelayTransport } from "../src/tunnel/relayTransport.js";

// The computer's end of the relay over a WebSocket (tunnel/cableLink.ts):
// frames pushed to it as the phone leaves them, its own sent on the
// socket — no long poll while the socket is open.

function fakeCable() {
  const sockets: FakeSocket[] = [];
  const posts: string[] = [];
  class FakeSocket {
    url: string;
    identifier = "";
    sent: unknown[] = [];
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    onerror?: () => void;
    constructor(url: URL | string) {
      this.url = String(url);
      sockets.push(this);
      setTimeout(() => {
        this.onopen?.();
        this.deliver({ type: "welcome" });
      }, 0);
    }
    deliver(message: unknown) {
      this.onmessage?.({ data: JSON.stringify(message) });
    }
    send(raw: string) {
      const message = JSON.parse(raw);
      if (message.command === "subscribe") {
        this.identifier = message.identifier;
        setTimeout(() => this.deliver({ type: "confirm_subscription", identifier: this.identifier }), 0);
      } else {
        this.sent.push(JSON.parse(message.data));
      }
    }
    close() {
      this.onclose?.();
    }
  }
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    posts.push(`${init?.method ?? "GET"} ${String(input)}`);
    if (String(input).endsWith("/api/v1/cable/tickets")) return new Response(JSON.stringify({ ticket: "billet" }), { status: 200 });
    // Nothing waiting, after a moment — as a long poll would answer.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(JSON.stringify({ frames: [], peer_listening: false }), { status: 200 });
  }) as typeof fetch;
  return { sockets, posts, fetchImpl, WebSocketImpl: FakeSocket as unknown as typeof WebSocket };
}

test("through the socket: the phone's frames arrive pushed, this end's leave on it, and nothing polls", async () => {
  const cable = fakeCable();
  const received: string[] = [];
  const transport = createRelayTransport({
    backendUrl: "https://relay.twoody.invalid",
    userToken: "jeton",
    rendezvous: "ab".repeat(16),
    as: "host",
    onFrames: (frames) => {
      received.push(...frames.map((frame) => frame.toString()));
    },
    fetchImpl: cable.fetchImpl,
    WebSocketImpl: cable.WebSocketImpl,
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    const [socket] = cable.sockets;
    assert.equal(socket.url, "wss://relay.twoody.invalid/cable?ticket=billet");
    assert.deepEqual(JSON.parse(socket.identifier), { channel: "TunnelChannel", rendezvous: "ab".repeat(16), as: "host" });

    socket.deliver({ identifier: socket.identifier, message: { frames: [Buffer.from("bonjour").toString("base64")], peer_listening: true } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(received, ["bonjour"]);
    assert.equal(transport.peerListening, true);

    await transport.send([Buffer.from("la réponse")]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(socket.sent, [{ action: "push", frames: [Buffer.from("la réponse").toString("base64")] }]);
    assert.deepEqual(cable.posts, ["POST https://relay.twoody.invalid/api/v1/cable/tickets"], "no poll, no POST of frames");
  } finally {
    transport.stop();
  }
});

test("a socket that closes hands over to the poll", async () => {
  const cable = fakeCable();
  const transport = createRelayTransport({
    backendUrl: "https://relay.twoody.invalid",
    userToken: "jeton",
    rendezvous: "cd".repeat(16),
    as: "host",
    onFrames: () => {},
    fetchImpl: cable.fetchImpl,
    WebSocketImpl: cable.WebSocketImpl,
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    cable.sockets[0].close();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(cable.posts.some((line) => line.startsWith("GET https://relay.twoody.invalid/api/v1/tunnel/frames")));
  } finally {
    transport.stop();
  }
});
