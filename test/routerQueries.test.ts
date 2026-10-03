import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startFakeRuntime } from "./helpers/fakeBackend.js";

// The router inside /queries (docs/multi-computer-design.md §3): a
// computer that fails before its first word gives way to the next
// (« Automatique » only), one chosen by name does not, and an answer that
// broke after its first word is not switched silently. Also: the peer
// session's limits, and /api/v1/peers for the Desktop only.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-router-queries-"));
delete process.env.TWOODY_BACKEND_URL;
delete process.env.TWOODY_USER_TOKEN;
delete process.env.BRIDGE_LOCAL_LLM_ENDPOINT;

const runtime = await startFakeRuntime({ models: ["qwen3:8b"], reply: () => "Bonjour depuis ce Mac." });
const cutting = await startFakeRuntime({ models: ["cut:1b"], reply: () => "Début puis coupure.", cutAfterFirst: true });

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { accountComputers: accountPeers, db } = await import("../src/db.js");
const { pairDevice } = await import("../src/pairing.js");
const { setPeerStatus } = await import("../src/peers/index.js");
const { readStatus } = await import("../src/account/status.js");
const { eq } = await import("drizzle-orm");
const { setRosterSource } = await import("../src/vault/roster.js");
const { meshVault } = await import("./helpers/meshVault.js");

const app = await buildApp();
test.after(async () => {
  await app.close();
  await runtime.close();
  await cutting.close();
});

const desktop = (await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } })).json();
const auth = { "x-user-token": desktop.token };
assert.equal((await app.inject({ method: "POST", url: "/providers/local", headers: auth, payload: { url: runtime.url, model: "qwen3:8b" } })).statusCode, 201);

// A peer that is paired but does not answer (nothing listens on port 9),
// added from « Appareils » with its security code checked.
const now = new Date();
const PEER_TUNNEL_KEY = randomBytes(32).toString("hex");
db.insert(accountPeers)
  .values({ computerId: "77", userId: desktop.user_id, name: "Raspberry Pi", kind: "server", platform: "linux", state: "linked", url: "http://127.0.0.1:9", token: "peer-token", tunnelKey: PEER_TUNNEL_KEY, checkedTunnelKey: PEER_TUNNEL_KEY, enabled: true, createdAt: now, updatedAt: now })
  .run();
const fastPeer = (models: Array<{ id: string; loaded: boolean }>, tps: Record<string, number>) =>
  setPeerStatus("77", readStatus({ app_version: "0.3.0", models, load: { cpu_pct: 5, gpu_pct: null, ram_used_pct: 30, at: null }, tps, inflight: 0, accepts: ["chat", "background"], tools: true })!);

function events(payload: string): Array<{ event: string; data: string }> {
  return payload
    .split("\n\n")
    .map((block) => {
      const lines = block.split("\n");
      const event = lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "";
      const data = lines.filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
      return { event, data };
    })
    .filter((e) => e.event);
}

test("« Automatique »: the faster peer fails before its first word, this computer answers, said as a fallback", async () => {
  fastPeer([{ id: "qwen3:8b", loaded: true }], { "qwen3:8b": 500 });
  const response = await app.inject({ method: "POST", url: "/queries", headers: auth, payload: { content: "Bonjour", provider: "auto", model: "qwen3:8b" } });
  const final = events(response.payload).find((e) => e.event === "final");
  assert.ok(final, response.payload.slice(-400));
  const body = JSON.parse(final!.data);
  assert.equal(body.text, "Bonjour depuis ce Mac.");
  assert.deepEqual(body.answered_by, { computer_id: "self", computer_name: body.answered_by.computer_name, model: "qwen3:8b", routed: "fallback", auto: true });

  const discussion = (await app.inject({ method: "GET", url: `/discussions/${body.discussion_id}`, headers: auth })).json();
  assert.equal(discussion.messages.at(-1).answered_by.routed, "fallback");
});

test("a computer chosen by name that does not answer is an error offering this one, not a silent switch", async () => {
  const response = await app.inject({ method: "POST", url: "/queries", headers: auth, payload: { content: "Et là ?", provider: "computer:77", model: "qwen3:8b" } });
  const all = events(response.payload);
  assert.equal(all.find((e) => e.event === "final"), undefined);
  const error = JSON.parse(all.find((e) => e.event === "error")!.data);
  assert.equal(error.error, "computer_unavailable");
  assert.equal(error.fallback.computer_id, "self");
  assert.equal(runtime.calls.filter((c) => c.body.messages.at(-1).content.includes("Et là")).length, 0, "this computer was not asked");
});

test("« Automatique » with this computer first: answered here, said as auto; the legacy request as before", async () => {
  setPeerStatus("77", null);
  const auto = events((await app.inject({ method: "POST", url: "/queries", headers: auth, payload: { content: "Salut", provider: "auto" } })).payload);
  assert.deepEqual(JSON.parse(auto.find((e) => e.event === "final")!.data).answered_by.routed, "auto");
  const legacy = events((await app.inject({ method: "POST", url: "/queries", headers: auth, payload: { content: "Salut" } })).payload);
  const body = JSON.parse(legacy.find((e) => e.event === "final")!.data);
  assert.equal(body.provider, "local_openai");
  assert.equal(body.answered_by.routed, "explicit");
});

test("an answer that broke after its first word is an error, never another computer's", async () => {
  // This computer answers first with a runtime that drops the line after
  // its first piece; the peer holds the model too, slower.
  const provider = (await app.inject({ method: "POST", url: "/providers/local", headers: auth, payload: { url: cutting.url, model: "cut:1b" } })).json().provider;
  await app.inject({ method: "POST", url: `/providers/${provider.id}/default`, headers: auth });
  fastPeer([{ id: "cut:1b", loaded: true }], { "cut:1b": 1 });
  const started = Date.now();
  const all = events((await app.inject({ method: "POST", url: "/queries", headers: auth, payload: { content: "Longue réponse", provider: "auto", model: "cut:1b" } })).payload);
  assert.ok(all.some((e) => e.event === "message"), "the first word came");
  assert.ok(all.some((e) => e.event === "error"));
  assert.equal(all.find((e) => e.event === "final"), undefined);
  assert.ok(Date.now() - started < 2_000, "the peer was not tried (its handshake alone takes 2.5 s)");
});

test("a peer session reaches /api/v1/peer/* and nothing else", async () => {
  const peer = pairDevice({ deviceName: "Mac mini", role: "peer" });
  const as = { "x-user-token": peer.token };
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/peer/status", headers: as })).statusCode, 200);
  for (const url of ["/api/v1/me", "/api/v1/discussions", "/me", "/providers", "/api/v1/peers", "/api/v1/memories"]) {
    const response = await app.inject({ method: "GET", url, headers: as });
    assert.equal(response.statusCode, 403, url);
    assert.equal(response.json().error, "peer_session_forbidden");
  }
  const post = await app.inject({ method: "POST", url: "/queries", headers: as, payload: { content: "x" } });
  assert.equal(post.statusCode, 403);
  const status = (await app.inject({ method: "GET", url: "/api/v1/peer/status", headers: as })).json();
  assert.ok(readStatus(status), "the status is one");
  assert.ok(status.models.some((m: { id: string }) => m.id === "qwen3:8b"));
});

test("/api/v1/peers is managed by the Desktop; a phone sees them but does not ask for one", async () => {
  const phone = pairDevice({ deviceName: "iPhone" });
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/peers", headers: { "x-user-token": phone.token }, remoteAddress: "192.168.1.9" })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/peers", headers: { "x-user-token": phone.token }, remoteAddress: "192.168.1.9", payload: { computer_id: "78" } })).statusCode, 403);
  const listed = await app.inject({ method: "GET", url: "/api/v1/peers", headers: auth });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().peers[0].computer_id, "77");
  assert.equal(listed.json().peers[0].token, undefined, "the peer session never leaves");
  // Without an account, asking for a new peer says so.
  const asked = await app.inject({ method: "POST", url: "/api/v1/peers", headers: auth, payload: { computer_id: "78" } });
  assert.equal(asked.statusCode, 409);
});

test("/providers without an account says nothing of computers; /me keeps « Tâches de fond »", async () => {
  const providers = (await app.inject({ method: "GET", url: "/providers", headers: auth })).json();
  assert.equal(providers.computers, undefined);
  assert.equal(providers.auto, undefined);
  await app.inject({ method: "PATCH", url: "/me", headers: auth, payload: { user: { background_computer: "computer:77" } } });
  assert.equal((await app.inject({ method: "GET", url: "/me", headers: auth })).json().background_computer, "computer:77");
  await app.inject({ method: "PATCH", url: "/me", headers: auth, payload: { user: { background_computer: "../etc" } } });
  assert.equal((await app.inject({ method: "GET", url: "/me", headers: auth })).json().background_computer, "auto");
});

test("« Tâches de fond »: an idle trusted peer set for it takes memory extraction; untrusted, busy or hot, this computer does", async () => {
  const { pickBackground } = await import("../src/router/index.js");
  const peerStatus = (inflight: number, cpu: number) =>
    setPeerStatus("77", readStatus({ app_version: "0.3.0", models: [{ id: "qwen3:8b", loaded: true }], load: { cpu_pct: cpu, gpu_pct: null, ram_used_pct: 30, at: null }, tps: { "qwen3:8b": 5 }, inflight, accepts: ["chat", "background"], tools: true })!);
  peerStatus(0, 10);
  assert.equal(await pickBackground({ userId: desktop.user_id, preference: "computer:77", model: "qwen3:8b" }), null, "not trusted: the work reads what is kept of the person");
  // The switch in « Appareils » alone trusts nothing: the vault roster does.
  db.update(accountPeers).set({ trusted: true }).where(eq(accountPeers.computerId, "77")).run();
  assert.equal(await pickBackground({ userId: desktop.user_id, preference: "computer:77", model: "qwen3:8b" }), null, "account_computers.trusted is not the roster");
  const vault = meshVault();
  const iphone = vault.person("iPhone");
  vault.computer("Raspberry Pi", "77", iphone, { tunnelKey: db.select().from(accountPeers).where(eq(accountPeers.computerId, "77")).all()[0]!.tunnelKey! });
  await setRosterSource(async () => vault.input([iphone])).refresh();
  assert.equal((await pickBackground({ userId: desktop.user_id, preference: "computer:77", model: "qwen3:8b" }))?.computerId, "77", "even slower, the chosen computer does it when idle");
  assert.equal(await pickBackground({ userId: desktop.user_id, preference: "self", model: "qwen3:8b" }), null);
  assert.equal(await pickBackground({ userId: desktop.user_id, preference: "computer:self", model: "qwen3:8b" }), null);
  peerStatus(1, 10);
  assert.equal(await pickBackground({ userId: desktop.user_id, preference: "computer:77", model: "qwen3:8b" }), null, "busy");
  peerStatus(0, 70);
  peerStatus(0, 70);
  assert.equal(await pickBackground({ userId: desktop.user_id, preference: "computer:77", model: "qwen3:8b" }), null, "CPU over 50 %");
  setPeerStatus("77", null);
  db.update(accountPeers).set({ trusted: false }).where(eq(accountPeers.computerId, "77")).run();
  setRosterSource(null);
});
