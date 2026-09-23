import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Local-only mode has exactly one door, and only for the tunnel: the
// relay's frames endpoint, carrying frames sealed with keys the relay
// never sees. Everything here is an attempt to get through somewhere
// else, or by some other way, or with something other than the tunnel.
//
// This file runs in local-only mode — set before anything reads it,
// since the flag is read once, at import — and stands in for the
// network with a recorder: whatever reaches it would have left the
// machine.
process.env.TWOODY_LOCAL_ONLY = "1";
process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-relay-only-"));

const { LOCAL_ONLY, LocalOnlyError, RelayRefusedError, outboundFetch, relayFetch } = await import("../src/outbound.js");
const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { db, authSessions, tunnelPeers, users } = await import("../src/db.js");
const { forgetTunnelPeer } = await import("../src/tunnel/identity.js");
const { runningTunnel, startTunnelService, tunnelCredentialsFrom } = await import("../src/tunnel/index.js");

const app = await buildApp();

// `.invalid` never resolves, so nothing here can reach a real host even
// if a check below were wrong: the worst a bug can do is fail a test.
const RELAY = "https://relay.twoody.invalid";

interface Seen {
  line: string;
  token: string | null;
}
const seen: Seen[] = [];

/// Replaces the network. Each request that gets this far is written
/// down with the account token it carried, and answered like a relay
/// with nothing waiting — after a moment, as a long poll would.
function recordTheNetwork(): void {
  seen.length = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    seen.push({ line: `${method} ${url}`, token: headers.get("x-user-token") });
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(JSON.stringify({ frames: [], peer_listening: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const lines = () => seen.map((entry) => entry.line);

/// A phone pairs on this network, bringing its tunnel key: the only
/// moment keys are exchanged, and the one thing that gives the tunnel
/// anyone to wait for.
async function pairAPhone(key: string): Promise<void> {
  db.delete(tunnelPeers).run();
  db.delete(authSessions).run();
  db.delete(users).run();
  const response = await app.inject({
    method: "POST",
    url: "/auth/pair",
    payload: { setup_token: ensureSetupToken()!.token, device_name: "iPhone de Jimmy", tunnel_public_key: key },
  });
  assert.equal(response.statusCode, 201);
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("this file runs in local-only mode, or nothing below proves anything", () => {
  assert.equal(LOCAL_ONLY, true);
});

test("the ordinary gate still refuses the outside, the relay included", async () => {
  recordTheNetwork();
  await assert.rejects(outboundFetch("https://8.8.8.8/"), LocalOnlyError);
  // No door on the ordinary gate: the relay's own address is refused
  // there like any other.
  await assert.rejects(outboundFetch(`${RELAY}/api/v1/tunnel/frames`), LocalOnlyError);
  assert.deepEqual(lines(), []);
});

test("the door opens on the relay's frames endpoint, for waiting and for sending", async () => {
  recordTheNetwork();
  const through = relayFetch(RELAY);
  await through(new URL(`${RELAY}/api/v1/tunnel/frames?rendezvous=ab&as=host&wait=25`));
  await through(`${RELAY}/api/v1/tunnel/frames`, { method: "POST", body: "{}" });
  await through(new Request(`${RELAY}/api/v1/tunnel/frames`, { method: "POST", body: "{}" }));
  assert.deepEqual(lines(), [
    `GET ${RELAY}/api/v1/tunnel/frames?rendezvous=ab&as=host&wait=25`,
    `POST ${RELAY}/api/v1/tunnel/frames`,
    `POST ${RELAY}/api/v1/tunnel/frames`,
  ]);
});

test("anything that only resembles the door goes to the ordinary gate, and is refused there", async () => {
  recordTheNetwork();
  const through = relayFetch(RELAY);
  for (const url of [
    // The same host, another endpoint: the relay's backend is a whole
    // API, and the door is for one path of it.
    `${RELAY}/api/v1/queries`,
    `${RELAY}/api/v1/tunnel/`,
    `${RELAY}/api/v1/tunnel/framesX`,
    `${RELAY}/api/v1/tunnel/frames/`,
    // Spelled to start like the door and end somewhere else.
    `${RELAY}/api/v1/tunnel/frames/../../queries`,
    `${RELAY}/api/v1/tunnel/%2e%2e/%2e%2e/queries`,
    // A look-alike host, another port, another scheme.
    "https://relay.twoody.invalid.evil.invalid/api/v1/tunnel/frames",
    "https://relay.twoody.invalid:8443/api/v1/tunnel/frames",
    "http://relay.twoody.invalid/api/v1/tunnel/frames",
    "https://8.8.8.8/api/v1/tunnel/frames",
  ]) {
    await assert.rejects(through(url), LocalOnlyError, url);
  }
  assert.deepEqual(lines(), []);
});

test("this machine stays reachable through the same fetch: the tunnel answers from it", async () => {
  recordTheNetwork();
  await relayFetch(RELAY)("http://127.0.0.1:47821/health");
  assert.deepEqual(lines(), ["GET http://127.0.0.1:47821/health"]);
});

test("a relay under a path of its own has its door there, and only there", async () => {
  recordTheNetwork();
  const through = relayFetch(`${RELAY}/twoody/`);
  await through(`${RELAY}/twoody/api/v1/tunnel/frames`);
  await assert.rejects(through(`${RELAY}/api/v1/tunnel/frames`), LocalOnlyError);
  assert.deepEqual(lines(), [`GET ${RELAY}/twoody/api/v1/tunnel/frames`]);
});

// The frames are sealed; the account token that rides beside them in a
// header is not. Over cleartext to the internet it would be readable by
// anyone on the way, so the door does not open there — in any mode.
test("the door never opens over cleartext to the internet", async () => {
  recordTheNetwork();
  await assert.rejects(relayFetch("http://8.8.8.8")("http://8.8.8.8/api/v1/tunnel/frames"), RelayRefusedError);
  assert.deepEqual(lines(), []);
  // A relay on the private network is another matter: one run at home,
  // or in development.
  await relayFetch("http://192.168.1.50:3000")("http://192.168.1.50:3000/api/v1/tunnel/frames");
  assert.deepEqual(lines(), ["GET http://192.168.1.50:3000/api/v1/tunnel/frames"]);
});

test("a tunnel started in local-only mode sends nothing but its frames endpoint, and the token only there", async () => {
  await pairAPhone("a1".repeat(32));
  recordTheNetwork();
  // No fetch handed in: this is the path the real server takes.
  const service = startTunnelService({ backendUrl: RELAY, userToken: "jeton-du-compte", localBaseUrl: "http://127.0.0.1:1" });
  try {
    assert.equal(service.links.length, 1);
    await until(() => seen.length >= 2, "the tunnel to wait at the relay");
  } finally {
    service.stop();
  }
  for (const { line, token } of seen) {
    assert.match(line, /^GET https:\/\/relay\.twoody\.invalid\/api\/v1\/tunnel\/frames\?rendezvous=[0-9a-f]{32}&as=host&wait=25$/);
    assert.equal(token, "jeton-du-compte");
  }
});

test("a phone paired while the tunnel runs is waited for at once, and a removed one is let go", async () => {
  db.delete(tunnelPeers).run();
  recordTheNetwork();
  const told: number[] = [];
  const service = startTunnelService({
    backendUrl: RELAY,
    userToken: "jeton-du-compte",
    localBaseUrl: "http://127.0.0.1:1",
    onLinksChanged: (paired) => told.push(paired),
  });
  try {
    assert.equal(service.links.length, 0, "nobody paired yet");
    assert.deepEqual(told, [], "the starting state is not news");
    const key = "b2".repeat(32);
    await pairAPhone(key);
    // No restart: the pairing route told the running tunnel.
    assert.equal(service.links.length, 1);

    const [{ id }] = db.select({ id: users.id }).from(users).all();
    forgetTunnelPeer({ userId: id, publicKey: Buffer.from(key, "hex") });
    service.refresh();
    assert.equal(service.links.length, 0);
    // Whoever shows the count — the desktop — heard both.
    assert.deepEqual(told, [1, 0]);
  } finally {
    service.stop();
  }
});

test("clients are told where things go: the relay while the tunnel runs, nothing otherwise", async () => {
  recordTheNetwork();
  const read = async () => (await app.inject({ method: "GET", url: "/capabilities" })).json() as { local_only: boolean; tunnel_relay: string | null };

  assert.deepEqual(await read().then(({ local_only, tunnel_relay }) => ({ local_only, tunnel_relay })), { local_only: true, tunnel_relay: null });
  const service = startTunnelService({ backendUrl: `${RELAY}/`, userToken: "jeton-du-compte", localBaseUrl: "http://127.0.0.1:1" });
  try {
    assert.equal((await read()).tunnel_relay, RELAY);
  } finally {
    service.stop();
  }
  assert.equal((await read()).tunnel_relay, null);
  assert.equal(runningTunnel(), null);
});

test("credentials handed over by the desktop are checked before anything starts", () => {
  assert.deepEqual(tunnelCredentialsFrom({ type: "tunnel", backendUrl: "https://api.twoody.com/", userToken: "t", deviceToken: " d " }), {
    backendUrl: "https://api.twoody.com",
    userToken: "t",
    deviceToken: "d",
  });
  assert.equal(tunnelCredentialsFrom({ backendUrl: "https://api.twoody.com", userToken: "t", deviceToken: "  " })?.deviceToken, undefined);
  for (const bad of [
    null,
    "tunnel",
    {},
    { backendUrl: "https://api.twoody.com" },
    { backendUrl: "https://api.twoody.com", userToken: "  " },
    { backendUrl: "https://api.twoody.com", userToken: 42 },
    { backendUrl: "pas une adresse", userToken: "t" },
    { backendUrl: "ftp://api.twoody.com", userToken: "t" },
  ]) {
    assert.equal(tunnelCredentialsFrom(bad), null, JSON.stringify(bad));
  }
});
