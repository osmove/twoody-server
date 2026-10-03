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
const { accountComputers: accountPeers, db, memories } = await import("../src/db.js");
const { endorse } = await import("../src/account/endorsement.js");
const { readStatus } = await import("../src/account/status.js");
const { closeAllPeerLinks, refreshPeerStatus, peerById, setPeerHandshakeTimeouts } = await import("../src/peers/index.js");
const { tunnelIdentity } = await import("../src/tunnel/identity.js");
const { setRosterSource } = await import("../src/vault/roster.js");
const { meshVault } = await import("./helpers/meshVault.js");
const { loginApproverProof } = await import("../src/vault/contracts.js");

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
/// The Pi's tunnel key, whose security code its console shows.
let piTunnelKey = "";

test("the Pi joins the account by a code the Mac approves, and sends its status", async () => {
  await until(async () => (await piFetch("/health").catch(() => null))?.ok, 20_000, `the Pi to start (${piOutput})`);
  const before = await (await piFetch("/account/link")).json();
  assert.equal(before.state, "unlinked");
  assert.equal(before.fresh, true);
  assert.match(before.fp, /^[0-9a-f]{8}$/);

  const started = await piFetch("/account/link", { method: "POST", body: "{}" });
  assert.equal(started.status, 201);
  // Asked from this machine: the Pi's console view, with the one-time
  // secret the person types on the Mac along with the code.
  const { user_code, approval_secret } = await started.json();
  const login = backend.logins.find((l) => l.user_code === user_code)!;
  piTunnelKey = login.tunnel_public_key!;
  assert.match(piTunnelKey, /^[0-9a-f]{64}$/);
  assert.equal(login.public_key.slice(0, 8), before.fp, "the code is the login of the server found here");
  const proof = loginApproverProof({ secret: approval_secret, userCode: user_code, approverPublicKey: mac.public, tunnelPublicKey: login.tunnel_public_key! });
  backend.approveLogin(user_code, { kind: "computer", public_key: mac.public, name: "Mac de Jimmy", proof });

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
  // Asked with the tunnel key whose security code the person compared.
  const asked = await app.inject({ method: "POST", url: "/api/v1/peers", headers: auth, payload: { computer_id: piComputerId, checked_tunnel_key: piTunnelKey } });
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
  assert.equal(peer.tunnelKey, piTunnelKey, "sealed to the key whose code was checked");
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
  assert.deepEqual(named.answered_by, { computer_id: piComputerId, computer_name: "Raspberry Pi", model: "qwen3:8b", routed: "explicit", auto: false, trusted: false });
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

test("the Desktop reads a peer's vault identity and names itself to it through the sealed link only", async () => {
  // The Pi is linked to no vault here: it says so, through its /tunnel
  // (its route answers 403 pinned_channel_required to anything else).
  const identity = await app.inject({ method: "GET", url: `/api/v1/peers/${piComputerId}/vault/identity`, headers: auth });
  assert.equal(identity.statusCode, 404, identity.payload);
  assert.equal(identity.json().error, "not_enrolled");
  // The Desktop's peer session on the Pi carries no device-access/v2 of
  // that vault device: it may not name it as the Pi's anchor (only the Pi's
  // owner, or that very device, routes/peerVault.ts). The Pi's answer is
  // passed on as it is.
  const anchor = await app.inject({ method: "POST", url: `/api/v1/peers/${piComputerId}/vault/anchor`, headers: auth, payload: { vault_device_id: "5b0c3c1e-8a1f-4d2e-9c7b-1f2e3d4c5b6a", sign_public: "ab".repeat(32) } });
  assert.equal(anchor.statusCode, 403, anchor.payload);
  assert.equal(anchor.json().error, "anchor_not_allowed");
  assert.equal((await app.inject({ method: "POST", url: `/api/v1/peers/${piComputerId}/vault/anchor`, headers: auth, payload: { vault_device_id: "x", sign_public: "not-a-key" } })).statusCode, 400);
  // No link with it: nothing is asked in clear.
  const unknown = await app.inject({ method: "GET", url: "/api/v1/peers/no-such-computer/vault/identity", headers: auth });
  assert.equal(unknown.statusCode, 409);
  assert.equal(unknown.json().error, "not_linked");
  // Only the Desktop's own session.
  const [row] = db.select().from(accountPeers).all();
  assert.ok(row?.token);
  const direct = await piFetch("/api/v1/peer/vault/identity", { headers: { "x-user-token": row!.token! } });
  assert.equal(direct.status, 403, "never over plain HTTP");
});

test("a peer not trusted gets the conversation only; trusted, what this computer knows of the person", async () => {
  const now = new Date();
  db.insert(memories).values([
    { id: "m-profile", userId: desktop.user_id, kind: "user", title: "Santé", content: "Jimmy est allergique aux arachides.", createdAt: now, updatedAt: now },
    { id: "m-project", userId: desktop.user_id, kind: "project", title: "Projet Tulipe", content: "Le code du coffre du projet Tulipe est 4512.", createdAt: now, updatedAt: now },
  ]).run();
  const final = (payload: string) => {
    const block = payload.split("\n\n").find((b) => b.startsWith("event: final"));
    assert.ok(block, payload.slice(-500));
    return JSON.parse(block!.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
  };
  const ask = async (content: string, provider: string, discussionId?: string) =>
    final((await app.inject({ method: "POST", url: "/queries", headers: auth, payload: { content, provider, ...(discussionId ? { discussion_id: discussionId } : {}) } })).payload);
  const lastPiCall = (marker: string) => JSON.stringify(piRuntime.calls.filter((c) => JSON.stringify(c.body.messages).includes(marker)).at(-1)?.body.messages ?? null);

  const listed = (await app.inject({ method: "GET", url: "/api/v1/peers", headers: auth })).json().peers.find((p: { computer_id: string }) => p.computer_id === piComputerId);
  assert.equal(listed.trusted, false, "not trusted until a person device enrols it in the vault");
  const providers = (await app.inject({ method: "GET", url: "/providers", headers: auth })).json();
  assert.equal(providers.computers.find((c: { id: string }) => c.id === piComputerId).trusted, false);
  assert.equal(providers.computers[0].trusted, true, "this computer is");

  // Here first, where the project's memory rides on the message; then the Pi, in the same conversation.
  const here = await ask("Parle-moi du projet Tulipe", `computer:${macComputer.id}`);
  assert.ok(JSON.stringify(macRuntime.calls.at(-1)!.body.messages).includes("4512"), "this computer is given it");
  const there = await ask("Et le projet Tulipe, où en est-il ?", `computer:${piComputerId}`, here.discussion_id);
  assert.equal(there.answered_by.trusted, false);
  const sent = lastPiCall("où en est-il");
  assert.ok(sent.includes("Parle-moi du projet Tulipe"), "the conversation goes");
  for (const secret of ["4512", "arachides", "remember about them"]) assert.ok(!sent.includes(secret), `${secret} stayed here: ${sent}`);

  // The switch alone trusts nothing (docs/mesh-design.md §1): the Pi must
  // be in the verified vault roster, bound to the tunnel key it answers with.
  const patched = await app.inject({ method: "PATCH", url: `/api/v1/peers/${piComputerId}`, headers: auth, payload: { trusted: true } });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().trusted, false);
  assert.equal(patched.json().computer_id, piComputerId);
  assert.equal((await app.inject({ method: "PATCH", url: `/api/v1/peers/${piComputerId}`, headers: auth, payload: { trusted: "yes" } })).statusCode, 422);
  const vault = meshVault();
  const iphone = vault.person("iPhone");
  vault.computer("Raspberry Pi", piComputerId, iphone, { tunnelKey: peerById(desktop.user_id, piComputerId)!.tunnelKey! });
  await setRosterSource(async () => vault.input([iphone])).refresh();
  const entry = (await app.inject({ method: "GET", url: "/providers", headers: auth })).json().computers.find((c: { id: string }) => c.id === piComputerId);
  assert.deepEqual([entry.trusted, entry.mesh], [true, true]);

  const trusted = await ask("Rappelle-moi le projet Tulipe", `computer:${piComputerId}`);
  assert.equal(trusted.answered_by.trusted, true);
  const given = lastPiCall("Rappelle-moi");
  assert.ok(given.includes("4512") && given.includes("arachides"), given);

  await app.inject({ method: "PATCH", url: `/api/v1/peers/${piComputerId}`, headers: auth, payload: { trusted: false } });
  setRosterSource(null);
});

test("the Pi's peer session opens nothing but /api/v1/peer/*", async () => {
  const [row] = db.select().from(accountPeers).all();
  const headers = { "x-user-token": row!.token! };
  assert.equal((await piFetch("/api/v1/peer/status", { headers })).status, 200);
  for (const path of ["/api/v1/me", "/api/v1/discussions", "/api/v1/memories", "/api/v1/local_documents/folders"]) {
    assert.equal((await piFetch(path, { headers })).status, 403, path);
  }
});

test("a Desktop asks as its computer of the account, by its credential, never quietly as a device", async () => {
  // Another Twoody Desktop of the account; the Mac's Desktop signs in as its
  // person, and says which computer asks with that computer's credential.
  const imac = backend.addComputer({ name: "iMac du bureau", public_key: "cd".repeat(32), kind: "desktop" });
  const post = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/v1/peers", headers: auth, payload: { computer_id: String(imac.id), ...payload } });

  const count = backend.authorizations.length;
  const wrong = await post({ requester_computer_id: String(macComputer.id), requester_credential: "not-the-mac-credential" });
  assert.equal(wrong.statusCode, 403, wrong.payload);
  assert.equal(wrong.json().error, "invalid_requester_credential");
  assert.equal((await post({ requester_computer_id: String(macComputer.id) })).statusCode, 422);
  assert.equal((await post({ requester_credential: macComputer.credential })).statusCode, 422);
  assert.equal((await post({ requester_computer_id: String(imac.id), requester_credential: imac.credential })).statusCode, 422, "not its own peer");
  assert.equal(backend.authorizations.length, count, "nothing reached the iMac");

  const asked = await post({ requester_computer_id: String(macComputer.id), requester_credential: macComputer.credential, name: "iPhone de Jimmy" });
  assert.equal(asked.statusCode, 202, asked.payload);
  const authorization = backend.authorizations.find((a) => String(a.id) === String(asked.json().request_id))!;
  assert.equal(authorization.role, "peer");
  assert.equal(authorization.requester_kind, "computer");
  assert.equal(authorization.requester_computer_id, macComputer.id);
  assert.equal(authorization.name, "Mac de Jimmy", "named after the account, not the name sent");
  assert.equal(authorization.public_key, tunnelIdentity().publicKey.toString("hex"));
  assert.equal(peerById(desktop.user_id, String(imac.id))?.state, "requested");
});
