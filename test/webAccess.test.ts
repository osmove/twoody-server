import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { startFakeBackend } from "./helpers/fakeBackend.js";

// A web page open in the person's browser, against this server
// (second security review, 29/09/2026):
//
//   - it could POST /account/link from https://evil.example and read the
//     code (201 + user_code), because loopback was trusted whatever page
//     sent the request, CORS answered every origin, and the Host was never
//     looked at (DNS rebinding);
//   - a paired phone or another computer, through the tunnel, reached
//     /admin: the tunnel's requests come from 127.0.0.1.
//
// And what must keep working: the Desktop's window (Origin "null" from its
// file://, or http://127.0.0.1:5173 in development) with its session, the
// Desktop's main process and the console (no Origin), the phone over the
// tunnel (Host 127.0.0.1) and on the LAN (Host = the Mac's address), Docker
// (Host = the service name or the host's address).

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-web-access-"));
process.env.TWOODY_PAIRING_CODE = "K7M2Q9XR";
process.env.TWOODY_LINK_POLL_MS = "3600000";
delete process.env.TWOODY_USER_TOKEN;
delete process.env.TWOODY_DEVICE_TOKEN;
delete process.env.TWOODY_ADMIN_TOKEN;
delete process.env.TWOODY_ALLOWED_HOSTS;
delete process.env.TWOODY_CORS_ORIGINS;
delete process.env.TWOODY_PUBLIC_URL;

const backend = await startFakeBackend();
process.env.TWOODY_BACKEND_URL = backend.url;

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { linkState, resetLinkForTests } = await import("../src/account/link.js");
const { corsOriginAllowed, fromOtherPage, hostnameOf, isAllowedHost } = await import("../src/webOrigin.js");
const { fromThisMachine } = await import("../src/localAccess.js");
const { Channel, createIdentity, rendezvousId, startHandshake } = await import("../src/tunnel/channel.js");
const { createTunnelHost, VIA_TUNNEL_HEADER } = await import("../src/tunnel/host.js");
const { helloFrame, readHello } = await import("../src/tunnel/link.js");
const { decode, encode } = await import("../src/tunnel/protocol.js");

const app = await buildApp();
await app.listen({ port: 0, host: "127.0.0.1" });
const port = (app.server.address() as { port: number }).port;
const self = `127.0.0.1:${port}`;

test.after(async () => {
  resetLinkForTests();
  await app.close();
  await backend.close();
});

const evil = { origin: "https://evil.example", "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" };

test("the probe: a web page cannot start a code on a fresh server, nor read one", async () => {
  // Fresh: no account here yet, the case where the network may start a code.
  for (const url of ["/account/link", "/api/v1/account/link"]) {
    const started = await app.inject({ method: "POST", url, remoteAddress: "127.0.0.1", headers: evil });
    assert.equal(started.statusCode, 403, url);
    assert.equal(started.json().error, "cross_site_forbidden");
    assert.equal(started.json().user_code, undefined);
    assert.equal(started.headers["access-control-allow-origin"], undefined, "and its answer is not readable by that page");
  }
  // A "simple" request (no preflight) with Sec-Fetch-Site only, or an
  // Origin only: refused just the same.
  assert.equal((await app.inject({ method: "POST", url: "/account/link", remoteAddress: "127.0.0.1", headers: { "sec-fetch-site": "cross-site" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/account/link", remoteAddress: "127.0.0.1", headers: { origin: "https://evil.example" } })).statusCode, 403);
  assert.equal(linkState(), "unlinked", "nothing was started");
  assert.equal(backend.logins.length, 0, "no code was asked of the account");

  // The console (twoody-server login, curl, the CLI) still can.
  const console = await app.inject({ method: "POST", url: "/account/link", remoteAddress: "127.0.0.1" });
  assert.equal(console.statusCode, 201);
  assert.match(console.json().user_code, /^[A-Z]{4}-[A-Z]{4}$/);

  // Reading it: only the console, or this server's own page.
  const read = (headers: Record<string, string>) => app.inject({ method: "GET", url: "/account/link", remoteAddress: "127.0.0.1", headers });
  for (const headers of [evil, { origin: "null" }, { "sec-fetch-site": "same-site" }, { origin: "http://127.0.0.1:5173", "sec-fetch-site": "same-site" }]) {
    const view = (await read(headers)).json();
    assert.equal(view.user_code, undefined, JSON.stringify(headers));
    assert.deepEqual(Object.keys(view).sort(), ["fp", "state"], "the network's view");
  }
  assert.ok((await read({})).json().user_code, "no Origin: the console");
  assert.ok((await read({ "sec-fetch-site": "none" })).json().user_code, "typed in the address bar");
  assert.ok((await read({ host: self, origin: `http://${self}`, "sec-fetch-site": "same-origin" })).json().user_code, "this server's own page");
  resetLinkForTests();
});

test("DNS rebinding: a name this server does not go by is refused before anything, same-origin or not", async () => {
  for (const url of ["/health", "/account/link", "/admin", "/api/v1/me"]) {
    const response = await app.inject({ method: "GET", url, remoteAddress: "127.0.0.1", headers: { host: `evil.example:${port}`, "sec-fetch-site": "same-origin" } });
    assert.equal(response.statusCode, 421, url);
    assert.equal(response.json().error, "host_not_allowed");
  }
  const posted = await app.inject({ method: "POST", url: "/account/link", remoteAddress: "127.0.0.1", headers: { host: `rebind.attacker.com:${port}`, origin: `http://rebind.attacker.com:${port}` } });
  assert.equal(posted.statusCode, 421);
  // Over a real socket too, the WebSocket upgrade included.
  const plain = await new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/health", agent: false, headers: { host: "evil.example", connection: "close" } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(plain, 421);
  const refused = await new Promise<number>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { host: "evil.example" } });
    socket.on("unexpected-response", (req, res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
      req.destroy();
    });
    socket.on("open", () => {
      socket.terminate();
      resolve(101);
    });
    socket.on("error", () => resolve(-1));
  });
  assert.equal(refused, 421);
});

test("the names it goes by: addresses, localhost, the local network's names, its own, and the configured ones", () => {
  for (const host of [
    "localhost:3000",
    "127.0.0.1:47821",
    "[::1]:3000",
    "192.168.1.20:3000",
    "10.0.0.7",
    "100.101.102.103:3000",
    "[fe80::1]:3000",
    "twoody:3000", // docker-compose's service name
    "raspberrypi.local:3000",
    "mon-serveur.local",
    "nas.lan:3000",
    "pi.home.arpa",
    "app.localhost:8081",
    `${hostname()}:3000`,
    `${hostname().split(".")[0]}.local:3000`,
  ]) {
    assert.equal(isAllowedHost(host), true, host);
  }
  for (const host of ["evil.example", "evil.example:3000", "127.0.0.1.nip.io", "localhost.evil.example", "twoody.example.com"]) {
    assert.equal(isAllowedHost(host), false, host);
  }
  assert.equal(hostnameOf("[::1]:3000"), "::1");
  assert.equal(hostnameOf("Raspberrypi.Local.:3000"), "raspberrypi.local");

  process.env.TWOODY_PUBLIC_URL = "https://twoody.example.com";
  process.env.TWOODY_ALLOWED_HOSTS = "pi.tailnet-1234.ts.net, .example.org";
  try {
    assert.equal(isAllowedHost("twoody.example.com"), true, "TWOODY_PUBLIC_URL's host");
    assert.equal(isAllowedHost("pi.tailnet-1234.ts.net:3000"), true);
    assert.equal(isAllowedHost("a.b.example.org"), true, "a suffix");
    assert.equal(isAllowedHost("example.org.evil.example"), false);
    process.env.TWOODY_ALLOWED_HOSTS = "*";
    assert.equal(isAllowedHost("anything.example"), true, "* turns it off");
  } finally {
    delete process.env.TWOODY_PUBLIC_URL;
    delete process.env.TWOODY_ALLOWED_HOSTS;
  }
});

test("CORS: the Desktop's window and pages served from this machine read the answers; a site does not", async () => {
  const preflight = (origin: string) =>
    app.inject({
      method: "OPTIONS",
      url: "/api/v1/peers",
      headers: { origin, "access-control-request-method": "PATCH", "access-control-request-headers": "authorization,content-type" },
    });
  for (const origin of ["null", "app://twoody", "http://127.0.0.1:5173", "http://localhost:8081", "http://[::1]:5173"]) {
    const answer = await preflight(origin);
    assert.equal(answer.headers["access-control-allow-origin"], origin, origin);
  }
  for (const origin of ["https://evil.example", "http://evil.example", "https://app.twoody.com", "http://192.168.1.66:8080", "file://"]) {
    const answer = await preflight(origin);
    assert.equal(answer.headers["access-control-allow-origin"], undefined, origin);
  }
  process.env.TWOODY_CORS_ORIGINS = "https://twoody.example.com";
  try {
    assert.equal(corsOriginAllowed("https://twoody.example.com"), true);
    assert.equal(corsOriginAllowed("https://twoody.example.com.evil.example"), false);
  } finally {
    delete process.env.TWOODY_CORS_ORIGINS;
  }
});

test("a request from another page is never this machine's; one without Origin, or from this server's own page, is", () => {
  const request = (headers: Record<string, string>, ip = "127.0.0.1") => ({ ip, headers: { host: self, ...headers } }) as never;
  assert.equal(fromThisMachine(request({})), true);
  assert.equal(fromThisMachine(request({ "sec-fetch-site": "none" })), true);
  assert.equal(fromThisMachine(request({ origin: `http://${self}`, "sec-fetch-site": "same-origin" })), true);
  assert.equal(fromThisMachine(request({ origin: "null" })), false, "the Desktop's window, or a sandboxed frame: its session speaks for it, not its address");
  assert.equal(fromThisMachine(request({ origin: "http://127.0.0.1:5173", "sec-fetch-site": "same-site" })), false);
  assert.equal(fromThisMachine(request(evil)), false);
  assert.equal(fromThisMachine(request({ origin: `http://${self}`, "sec-fetch-site": "cross-site" })), false);
  assert.equal(fromThisMachine(request({ [VIA_TUNNEL_HEADER]: "1" })), false);
  assert.equal(fromThisMachine(request({ "x-forwarded-for": "8.8.8.8" })), false);
  assert.equal(fromThisMachine(request({}, "192.168.1.30")), false);
  assert.equal(fromOtherPage(request({ origin: `http://${self}` })), false);
});

test("/admin: never from another page, never through the tunnel", async () => {
  const admin = (headers: Record<string, string>) => app.inject({ method: "GET", url: "/admin", remoteAddress: "127.0.0.1", headers });
  assert.equal((await admin({})).statusCode, 200, "this machine's browser, typed in the address bar");
  assert.equal((await admin({ "sec-fetch-site": "none" })).statusCode, 200);
  assert.equal((await admin({ [VIA_TUNNEL_HEADER]: "1" })).statusCode, 403, "a paired phone or a peer through the tunnel");
  assert.equal((await admin({ origin: "https://evil.example" })).statusCode, 403);
  assert.equal((await admin({ origin: "null" })).statusCode, 403);
  assert.equal((await admin({ "sec-fetch-site": "cross-site" })).statusCode, 403);
});

// ── the flows that must keep working ─────────────────────────────────────

const phone = createIdentity();
let desktopToken = "";
let phoneToken = "";
let computerKey = Buffer.alloc(0);

test("the Desktop-embedded flow: main process pairs (no Origin), the window uses its session with Origin null or the dev server's", async () => {
  // Main process (Node fetch): no Origin, Host 127.0.0.1:<port>.
  const desktop = await app.inject({
    method: "POST",
    url: "/api/v1/auth/pair",
    remoteAddress: "127.0.0.1",
    headers: { host: self },
    payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" },
  });
  assert.equal(desktop.statusCode, 201);
  desktopToken = desktop.json().token;
  // The main process pairs the phone with the code on the screen.
  const paired = await app.inject({
    method: "POST",
    url: "/auth/pair",
    remoteAddress: "127.0.0.1",
    headers: { host: self },
    payload: { setup_token: "K7M2Q9XR", device_name: "iPhone de Jimmy", tunnel_public_key: phone.publicKey.toString("hex") },
  });
  assert.equal(paired.statusCode, 201);
  phoneToken = paired.json().token;
  computerKey = Buffer.from(paired.json().tunnel_public_key, "hex");
  // Main process: /usage/samples and POST /api/v1/peers are this machine's.
  const samples = await app.inject({ method: "POST", url: "/usage/samples", remoteAddress: "127.0.0.1", headers: { host: self, authorization: `Bearer ${desktopToken}` }, payload: { samples: [] } });
  assert.notEqual(samples.statusCode, 403);
  const asked = await app.inject({ method: "POST", url: "/api/v1/peers", remoteAddress: "127.0.0.1", headers: { host: self, authorization: `Bearer ${desktopToken}` }, payload: { computer_id: "78" } });
  assert.equal(asked.statusCode, 409, "past the check: this server is not in an account");

  // The window: Origin null (file://) in production, the dev server's in
  // development; always cross-site to 127.0.0.1:<port>.
  for (const origin of ["null", "http://127.0.0.1:5173"]) {
    const window = { host: self, origin, "sec-fetch-site": "cross-site", authorization: `Bearer ${desktopToken}` };
    for (const url of ["/api/v1/me", "/api/v1/peers", "/api/v1/providers", "/api/v1/discussions"]) {
      const answer = await app.inject({ method: "GET", url, remoteAddress: "127.0.0.1", headers: window });
      assert.equal(answer.statusCode, 200, `${origin} ${url}`);
      assert.equal(answer.headers["access-control-allow-origin"], origin, `${origin} ${url}: readable by the window`);
    }
    const patched = await app.inject({ method: "PATCH", url: "/api/v1/peers/77", remoteAddress: "127.0.0.1", headers: window, payload: { trusted: true } });
    assert.equal(patched.statusCode, 404, "past the check: no such peer");
  }
});

test("the phone over the tunnel: its requests arrive from 127.0.0.1, are served with its session, and are never this machine's", async () => {
  const phoneHandshake = startHandshake();
  const computerHandshake = startHandshake();
  const { tunnelIdentity } = await import("../src/tunnel/identity.js");
  const phoneChannel = new Channel({ role: "initiator", handshake: phoneHandshake, identity: phone, peerEphemeral: computerHandshake.ephemeralPublicKey, peerStatic: computerKey });
  const computerChannel = new Channel({ role: "responder", handshake: computerHandshake, identity: tunnelIdentity(), peerEphemeral: phoneHandshake.ephemeralPublicKey, peerStatic: phone.publicKey });
  const inbox: Array<{ t: string; status?: number; body: Buffer }> = [];
  // The same host the relay (tunnel/hostLink.ts) and the LAN's /tunnel use.
  const host = createTunnelHost({
    channel: computerChannel,
    localBaseUrl: `http://${self}`,
    send: (frame) => {
      const { message, body } = decode(phoneChannel.open(frame));
      inbox.push({ t: message.t, status: (message as { status?: number }).status, body });
    },
  });
  try {
    const ask = async (id: number, method: string, path: string, headers: Record<string, string>) => {
      await host.receive(phoneChannel.seal(encode({ t: "req", id, method, path, headers })));
      const deadline = Date.now() + 5_000;
      while (!inbox.some((m) => m.t === "end" || m.t === "err")) {
        if (Date.now() > deadline) throw new Error("no answer");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const parts = inbox.splice(0);
      return { status: parts[0]!.status, body: Buffer.concat(parts.filter((p) => p.t === "chunk").map((p) => p.body)).toString() };
    };
    const me = await ask(1, "GET", "/api/v1/me", { "x-user-token": phoneToken });
    assert.equal(me.status, 200, "served with its session");
    // Whatever it sends — a Host, an Origin, the tunnel marker unset — it is not this machine.
    assert.equal((await ask(2, "GET", "/admin", { host: "localhost", [VIA_TUNNEL_HEADER]: "" })).status, 403);
    const link = JSON.parse((await ask(3, "GET", "/account/link", {})).body);
    assert.deepEqual(Object.keys(link).sort(), ["fp", "state"]);
    assert.equal((await ask(4, "DELETE", "/account/link", {})).status, 403);
    assert.equal((await ask(5, "GET", "/account/approvals", {})).status, 403);
    assert.equal((await ask(6, "POST", "/api/v1/peers", { "x-user-token": phoneToken, "content-type": "application/json" })).status, 403, "a phone does not ask for peers");
    assert.equal((await ask(7, "GET", "/api/v1/peers", { "x-user-token": phoneToken })).status, 200, "it sees them");
  } finally {
    host.close();
  }
});

test("the phone on the LAN: /tunnel with the Mac's address as Host", async () => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/tunnel?rendezvous=${rendezvousId(phone.publicKey, computerKey)}`, { headers: { host: `192.168.1.20:${port}` } });
  socket.binaryType = "nodebuffer";
  const inbox: Buffer[] = [];
  let wake: (() => void) | null = null;
  socket.on("message", (data: Buffer) => {
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
  try {
    const handshake = startHandshake();
    socket.send(helloFrame(handshake.ephemeralPublicKey));
    const hello = readHello(await next());
    assert.ok(hello);
    const channel = new Channel({ role: "initiator", handshake, identity: phone, peerEphemeral: hello!, peerStatic: computerKey });
    socket.send(channel.seal(encode({ t: "req", id: 1, method: "GET", path: "/admin", headers: {} })));
    const first = decode(channel.open(await next()));
    assert.equal((first.message as { status?: number }).status, 403, "the LAN's /tunnel is not this machine either");
  } finally {
    socket.terminate();
  }
});
