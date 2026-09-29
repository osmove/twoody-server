import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startFakeBackend, startFakeRuntime } from "./helpers/fakeBackend.js";

// Two Twoody servers on this machine, as a Mac and a Raspberry Pi of the
// same account (docs/multi-computer-design.md), with the account's backend
// faked by a small HTTP server honouring the Lot 1 contract:
//
//   1. the Pi (another process) starts unlinked; `POST /account/link` gives
//      a code; the Mac approves it with its pairing key as approver; the Pi
//      polls, writes account.json (0600) and sends its status;
//   2. the Mac's server asks for peer access (POST /api/v1/peers); the Mac
//      endorses the request; the Pi approves it by rule 2 and seals its
//      answer; the Mac's server opens it;
//   3. the Mac's server reaches the Pi through the Pi's /tunnel (sealed
//      WebSocket on the LAN): status, and answers — by name and
//      « Automatique » — with answered_by saying the Pi;
//   4. the Pi's peer session opens nothing but /api/v1/peer/*.

const root = fileURLToPath(new URL("..", import.meta.url));
const vectors = JSON.parse(readFileSync(new URL("./fixtures/endorsement-v1.json", import.meta.url), "utf8"));
const mac = vectors.approvers.mac;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

async function until<T>(check: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 20_000, what = "condition"): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const backend = await startFakeBackend();
const piRuntime = await startFakeRuntime({ models: ["qwen3:8b"], reply: (model) => `Le Pi répond avec ${model}.` });
const macRuntime = await startFakeRuntime({ models: ["gemma3:4b"], reply: () => "Le Mac répond." });

// The Mac, known to the account already (the Desktop registered it).
const macComputer = backend.addComputer({ name: "Mac de Jimmy", public_key: mac.public, kind: "desktop" });

// ── the Pi: its own process ─────────────────────────────────────────────
const piPort = await freePort();
const piDir = mkdtempSync(join(tmpdir(), "twoody-smoke-pi-"));
const pi: ChildProcess = spawn(process.execPath, ["--import", "tsx", join(root, "src", "index.ts")], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(piPort),
    HOST: "127.0.0.1",
    LOG_LEVEL: "warn",
    TWOODY_DATA_DIR: piDir,
    TWOODY_BONJOUR_DISABLED: "1",
    TWOODY_BACKEND_URL: backend.url,
    TWOODY_USER_TOKEN: "",
    TWOODY_ADMIN_TOKEN: "",
    TWOODY_COMPUTER_NAME: "Raspberry Pi",
    TWOODY_PUBLIC_URL: `http://127.0.0.1:${piPort}`,
    BRIDGE_LOCAL_LLM_ENDPOINT: piRuntime.url,
    TWOODY_LINK_POLL_MS: "150",
    TWOODY_ACCOUNT_POLL_MS: "200",
    TWOODY_HEARTBEAT_MS: "300",
    TWOODY_ACCOUNT_BRIDGE: "0",
    TWOODY_ACCOUNT_TUNNEL: "0",
    TWOODY_MACHINE_SAMPLER: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let piOutput = "";
pi.stdout!.on("data", (chunk) => (piOutput += chunk));
pi.stderr!.on("data", (chunk) => (piOutput += chunk));
const piUrl = `http://127.0.0.1:${piPort}`;
const piFetch = (path: string, init: RequestInit = {}) =>
  fetch(`${piUrl}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });

// ── the Mac's server: in this process ───────────────────────────────────
process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-smoke-mac-"));
process.env.TWOODY_BACKEND_URL = backend.url;
process.env.TWOODY_USER_TOKEN = backend.userToken;
process.env.TWOODY_COMPUTER_ID = String(macComputer.id);
process.env.TWOODY_COMPUTER_NAME = "Mac de Jimmy";
process.env.TWOODY_PEER_POLL_MS = "150";
delete process.env.BRIDGE_LOCAL_LLM_ENDPOINT;

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { accountPeers, db } = await import("../src/db.js");
const { endorse } = await import("../src/account/endorsement.js");
const { readStatus } = await import("../src/account/status.js");
const { closeAllPeerLinks, refreshPeerStatus, peerById, setPeerHandshakeTimeouts } = await import("../src/peers/index.js");
const { tunnelIdentity } = await import("../src/tunnel/identity.js");

// The whole suite runs in parallel: the Pi may take more than the LAN's
// 2.5 s to answer its first hello.
setPeerHandshakeTimeouts({ lan: 15_000, relay: 1_000 });

const app = await buildApp();
test.after(async () => {
  closeAllPeerLinks();
  pi.kill("SIGTERM");
  await app.close();
  await backend.close();
  await piRuntime.close();
  await macRuntime.close();
});

const desktop = (await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } })).json();
const auth = { "x-user-token": desktop.token };
await app.inject({ method: "POST", url: "/providers/local", headers: auth, payload: { url: macRuntime.url, model: "gemma3:4b" } });

let piComputerId = "";

test("the Pi joins the account by a code the Mac approves, and sends its status", async () => {
  await until(async () => (await piFetch("/health").catch(() => null))?.ok, 20_000, `the Pi to start (${piOutput})`);
  const before = await (await piFetch("/account/link")).json();
  assert.equal(before.state, "unlinked");
  assert.equal(before.fresh, true);
  assert.match(before.fp, /^[0-9a-f]{8}$/);

  const started = await piFetch("/account/link", { method: "POST", body: "{}" });
  assert.equal(started.status, 201);
  const { user_code } = await started.json();
  const login = backend.logins.find((l) => l.user_code === user_code)!;
  assert.equal(login.public_key.slice(0, 8), before.fp, "the code is the login of the server found here");
  backend.approveLogin(user_code, { kind: "computer", public_key: mac.public, name: "Mac de Jimmy" });

  const linked = await until(async () => {
    const view = await (await piFetch("/account/link")).json();
    return view.state === "linked" ? view : null;
  }, 10_000, "the Pi to be linked");
  piComputerId = String(linked.account_computer_id);
  assert.equal(statSync(join(piDir, "account.json")).mode & 0o777, 0o600);
  const file = JSON.parse(readFileSync(join(piDir, "account.json"), "utf8"));
  assert.equal(file.computer.id, piComputerId);
  assert.deepEqual(file.approvers.map((a: { public_key: string }) => a.public_key), [mac.public]);

  const computer = backend.computers.find((c) => String(c.id) === piComputerId)!;
  await until(() => computer.status, 10_000, "a heartbeat with a status");
  const status = readStatus(computer.status);
  assert.ok(status, "the heartbeat's status follows the schema");
  assert.deepEqual(status!.models, [{ id: "qwen3:8b", loaded: true }]);
});

test("the Mac's server becomes the Pi's peer: requested, endorsed by the Mac, approved by the Pi, opened", async () => {
  const asked = await app.inject({ method: "POST", url: "/api/v1/peers", headers: auth, payload: { computer_id: piComputerId } });
  assert.equal(asked.statusCode, 202, asked.payload);
  const { request_id } = asked.json();
  const authorization = backend.authorizations.find((a) => String(a.id) === String(request_id))!;
  assert.equal(authorization.role, "peer");
  assert.equal(authorization.public_key, tunnelIdentity().publicKey.toString("hex"));

  // Not endorsed yet: the Pi leaves it pending.
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(authorization.state, "pending");

  // The Desktop, the Pi's approver, vouches for it.
  const piComputer = backend.computers.find((c) => String(c.id) === piComputerId)!;
  const endorsement = endorse(mac.private_pkcs8_base64, piComputer.public_key, {
    hostId: piComputerId,
    rid: String(authorization.id),
    requesterKey: authorization.public_key,
    expiresAt: authorization.expires_at,
  });
  const endorsed = await fetch(`${backend.url}/api/v1/account_computers/${piComputerId}/authorizations/${authorization.id}/endorse`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user-token": backend.userToken },
    body: JSON.stringify({ approver_key: mac.public, endorsement }),
  });
  assert.equal(endorsed.status, 204);

  await until(() => peerById(desktop.user_id, piComputerId)?.state === "linked", 10_000, `the peer to be linked (${piOutput})`);
  const peer = peerById(desktop.user_id, piComputerId)!;
  assert.equal(peer.url, piUrl);
  assert.equal(peer.name, "Raspberry Pi");
  assert.equal(authorization.state, "consumed");
});

test("through the Pi's /tunnel: its status, and answers by name and by « Automatique »", async () => {
  const peer = peerById(desktop.user_id, piComputerId)!;
  const entry = await refreshPeerStatus(peer);
  assert.ok(entry, "the status came through the tunnel");
  assert.deepEqual(entry!.status.models, [{ id: "qwen3:8b", loaded: true }]);

  const providers = (await app.inject({ method: "GET", url: "/providers", headers: auth })).json();
  assert.equal(providers.auto, true);
  const piEntry = providers.computers.find((c: { id: string }) => c.id === piComputerId);
  assert.equal(piEntry.peer, true);
  assert.equal(piEntry.online, true);
  assert.deepEqual(piEntry.models.map((m: { id: string }) => m.id), ["qwen3:8b"]);
  assert.equal(providers.computers[0].self, true);
  assert.equal(providers.computers[0].id, String(macComputer.id));

  const final = (payload: string) => {
    const block = payload.split("\n\n").find((b) => b.startsWith("event: final"));
    assert.ok(block, payload.slice(-500));
    return JSON.parse(block!.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
  };

  const named = final((await app.inject({ method: "POST", url: "/queries", headers: auth, payload: { content: "Bonjour le Pi", provider: `computer:${piComputerId}`, model: "qwen3:8b" } })).payload);
  assert.equal(named.text, "Le Pi répond avec qwen3:8b.");
  assert.deepEqual(named.answered_by, { computer_id: piComputerId, computer_name: "Raspberry Pi", model: "qwen3:8b", routed: "explicit", auto: false });
  assert.equal(named.provider, "peer_openai");

  const automatic = final((await app.inject({ method: "POST", url: "/queries", headers: auth, payload: { content: "Qui a ce modèle ?", provider: "auto", model: "qwen3:8b" } })).payload);
  assert.equal(automatic.answered_by.computer_id, piComputerId);
  assert.equal(automatic.answered_by.routed, "auto");

  const here = final((await app.inject({ method: "POST", url: "/queries", headers: auth, payload: { content: "Et toi ?", provider: "auto", model: "gemma3:4b" } })).payload);
  assert.equal(here.answered_by.computer_id, String(macComputer.id));
  assert.equal(here.text, "Le Mac répond.");

  // The Pi's runtime got the question, marked as a conversation turn
  // passed on by a peer, and kept nothing of it but a usage event.
  const call = piRuntime.calls.find((c) => JSON.stringify(c.body.messages).includes("Bonjour le Pi"))!;
  assert.ok(call);
  assert.equal(call.body.x_purpose, undefined, "the purpose stays between the servers");
  // All of it on the LAN socket: nothing went to the relay.
  assert.ok(!backend.calls.some((c) => c.includes("tunnel/frames")), "the relay was not used");
  assert.ok(call.body.max_tokens <= 4096);
});

test("the Pi's peer session opens nothing but /api/v1/peer/*", async () => {
  const [row] = db.select().from(accountPeers).all();
  const headers = { "x-user-token": row!.token! };
  assert.equal((await piFetch("/api/v1/peer/status", { headers })).status, 200);
  for (const path of ["/api/v1/me", "/api/v1/discussions", "/api/v1/memories", "/api/v1/local_documents/folders"]) {
    assert.equal((await piFetch(path, { headers })).status, 403, path);
  }
});
