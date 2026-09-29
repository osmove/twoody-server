import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startFakeBackend } from "./helpers/fakeBackend.js";

// Sessions this computer gives to the account's other computers (second
// security review, 29/09/2026):
//
//   - a request from another computer (role "peer", or `requester_kind:
//     "computer"` / `requester_computer_id` from the backend) only ever gets
//     a session limited to /api/v1/peer/*, named and logged by the account's
//     name for that computer, not the one it chose;
//   - when the account stops listing that computer, the session given to it
//     goes — on a headless server that approved it, and on the Mac, whose
//     Desktop approved it through /auth/pair — so it reaches this computer
//     no more, not even on the LAN's /tunnel where the backend has no say;
//   - GET and PATCH /api/v1/peers: the Desktop and the devices paired here
//     (the iPhone), never a peer session nor a session given to a computer.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-computer-sessions-"));
process.env.TWOODY_PAIRING_CODE = "K7M2Q9XR";
process.env.TWOODY_ACCOUNT_BRIDGE = "0";
process.env.TWOODY_ACCOUNT_TUNNEL = "0";
process.env.TWOODY_HEARTBEAT_MS = "3600000";
process.env.TWOODY_ACCOUNT_POLL_MS = "3600000";
delete process.env.TWOODY_USER_TOKEN;
delete process.env.TWOODY_DEVICE_TOKEN;
delete process.env.TWOODY_ADMIN_TOKEN;

const backend = await startFakeBackend();
process.env.TWOODY_BACKEND_URL = backend.url;

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { approveRequest, fetchPending, readPending, startApprovalLoop } = await import("../src/account/approvals.js");
const { newPairingKey } = await import("../src/account/keys.js");
const { resetLinkForTests } = await import("../src/account/link.js");
const { setDesktopAccount } = await import("../src/account/service.js");
const { linkedAccount, removeAccountFile, writeAccountFile } = await import("../src/account/store.js");
const { authSessions, db } = await import("../src/db.js");
const { pairDevice } = await import("../src/pairing.js");
const { forgetAccountComputers, revokeSessionsOfRemovedComputers, sessionsGivenToComputers, startPeerStatusPoller, syncPeersWithAccount } = await import("../src/peers/index.js");
const { allTunnelPeers } = await import("../src/tunnel/identity.js");

const app = await buildApp();
test.after(async () => {
  resetLinkForTests();
  setDesktopAccount(null);
  await app.close();
  await backend.close();
});

const lan = { remoteAddress: "192.168.1.30" };
const desktop = (await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } })).json();
const userId: string = desktop.user_id;
const key = (byte: string) => byte.repeat(32);
const sessionRow = (id: string) => db.select().from(authSessions).all().find((s) => s.id === id) ?? null;
const hasTunnelKey = (hex: string) => allTunnelPeers().some((p) => p.publicKey.toString("hex") === hex);

async function until(check: () => boolean, ms = 3_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("on the Mac: the Desktop pairs another computer through /auth/pair with its id; it gets a peer session, gone once the account no longer lists it", async () => {
  const mac = backend.addComputer({ name: "Mac de Jimmy", public_key: key("11"), kind: "desktop" });
  const pi = backend.addComputer({ name: "Raspberry Pi", public_key: key("22"), kind: "server" });
  // The Desktop hands the embedded server its account ({type:"account"}).
  setDesktopAccount({ backendUrl: backend.url, userToken: backend.userToken, computerId: String(mac.id), computerName: "Mac de Jimmy" });
  forgetAccountComputers();
  try {
    // The Desktop's main process, approving the Pi's request (role device
    // given, but the backend says it is a computer): a peer session anyway.
    const paired = await app.inject({
      method: "POST",
      url: "/auth/pair",
      remoteAddress: "127.0.0.1",
      payload: { setup_token: "K7M2Q9XR", device_name: "Raspberry Pi", tunnel_public_key: key("a1"), requester_computer_id: pi.id },
    });
    assert.equal(paired.statusCode, 201);
    assert.equal(paired.json().role, "peer");
    const row = sessionRow(paired.json().session_id)!;
    assert.equal(row.clientKind, "peer:Raspberry Pi");
    assert.equal(row.requesterComputerId, String(pi.id));
    assert.equal(row.origin, "account");
    const token = paired.json().token;
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/me", headers: { "x-user-token": token }, ...lan })).statusCode, 403, "peer-limited");
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/peer/status", headers: { "x-user-token": token }, ...lan })).statusCode, 200);

    // Still listed: nothing goes.
    assert.deepEqual(await syncPeersWithAccount(userId), []);
    assert.ok(sessionRow(row.id));

    // Removed from the account (DELETE /account_computers/:id): at the next
    // look at the list — here the poller's first — the session and its
    // tunnel key go, and the Pi is refused even on the LAN.
    assert.equal((await fetch(`${backend.url}/api/v1/account_computers/${pi.id}`, { method: "DELETE", headers: { "X-User-Token": backend.userToken } })).status < 300, true);
    assert.ok(hasTunnelKey(key("a1")));
    const stop = startPeerStatusPoller(() => [userId], 3_600_000);
    try {
      await until(() => sessionRow(row.id) === null);
    } finally {
      stop();
    }
    assert.equal(hasTunnelKey(key("a1")), false, "its tunnel key went with it");
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/peer/status", headers: { "x-user-token": token }, ...lan })).statusCode, 401);
  } finally {
    setDesktopAccount(null);
  }
});

test("a list that cannot be had, or that does not name this computer, revokes nothing", async () => {
  const mac = backend.addComputer({ name: "Mac mini", public_key: key("33"), kind: "desktop" });
  const given = pairDevice({ deviceName: "Ailleurs", role: "peer", origin: "account", requesterComputerId: "9999" });
  setDesktopAccount({ backendUrl: backend.url, userToken: backend.userToken, computerId: String(mac.id), computerName: "Mac mini" });
  try {
    backend.forced.set("GET /account_computers", 502);
    await syncPeersWithAccount(userId);
    assert.ok(sessionRow(given.sessionId), "the backend did not answer");
    backend.forced.set("GET /account_computers", { status: 200, body: { computers: "nope" } });
    await syncPeersWithAccount(userId);
    assert.ok(sessionRow(given.sessionId), "an answer that is not a list");
    backend.forced.delete("GET /account_computers");
    assert.equal(revokeSessionsOfRemovedComputers(new Set(["1", "2"])), 0, "a list without this computer (another account's)");
    assert.ok(sessionRow(given.sessionId));
    assert.equal(revokeSessionsOfRemovedComputers(new Set([String(mac.id)])), 1);
    assert.equal(sessionRow(given.sessionId), null);
  } finally {
    setDesktopAccount(null);
  }
});

function link() {
  const pairingKey = newPairingKey();
  const computer = backend.addComputer({ name: "Raspberry Pi du salon", public_key: pairingKey.pub, kind: "server" });
  writeAccountFile({
    backend_url: backend.url,
    user_token: backend.userToken,
    device_token: "device-token-of-the-pi",
    computer: { id: String(computer.id), credential: computer.credential, name: "Raspberry Pi du salon" },
    pairing_key: pairingKey,
    approvers: [{ public_key: key("ab"), kind: "computer", name: "Mac" }],
  });
  forgetAccountComputers();
  return computer;
}

function pending(computerId: number, fields: Partial<(typeof backend.authorizations)[number]> & { public_key: string; name: string }) {
  const id = 900 + backend.authorizations.length;
  backend.authorizations.push({
    id,
    computer_id: computerId,
    role: "device",
    state: "pending",
    sealed_response: null,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    endorsements: [],
    ...fields,
  });
  return id;
}

test("on a headless server: a computer's request only ever gets a peer session, under the account's name for it", async () => {
  const self = link();
  const mac = backend.addComputer({ name: "Mac de Jimmy", public_key: key("44"), kind: "desktop" });
  const logs: string[] = [];
  try {
    // Role peer, named by itself « Twoody Desktop »: the account says « Mac de Jimmy ».
    pending(self.id, { name: "Twoody Desktop", public_key: key("c1"), role: "peer", requester_kind: "computer", requester_computer_id: mac.id, requester_name: "Mac de Jimmy" });
    // Role device, but the backend says a computer asked: peer anyway.
    pending(self.id, { name: "iPhone", public_key: key("c2"), role: "device", requester_kind: "computer", requester_computer_id: mac.id, requester_name: "Mac de Jimmy" });
    // Role peer from an older backend that says nothing more: peer, its own name.
    pending(self.id, { name: "Mac mini", public_key: key("c3"), role: "peer" });
    // A phone: a full device session.
    pending(self.id, { name: "iPhone de Claire", public_key: key("c4"), role: "device", requester_kind: "device" });

    // The console's list says who, as the account knows it.
    const listed = (await app.inject({ method: "GET", url: "/account/approvals", remoteAddress: "127.0.0.1" })).json().requests;
    assert.deepEqual(
      listed.map((r: { name: string; role: string; requester_kind: string | null; requester_computer_id: string | null }) => [r.name, r.role, r.requester_kind, r.requester_computer_id]),
      [
        ["Mac de Jimmy", "peer", "computer", String(mac.id)],
        ["Mac de Jimmy", "peer", "computer", String(mac.id)],
        ["Mac mini", "peer", "computer", null],
        ["iPhone de Claire", "device", "device", null],
      ],
    );
    // So does the console's log.
    const loop = startApprovalLoop({ everyMs: 3_600_000, log: (m) => logs.push(m) });
    await loop.tick();
    loop.stop();
    assert.ok(logs.some((l) => l.includes('"Mac de Jimmy" asks to use this server (a computer of the account)')), logs.join("\n"));
    assert.ok(!logs.some((l) => l.includes("Twoody Desktop")), "never the name it chose");

    const account = linkedAccount()!;
    const before = new Set(db.select({ id: authSessions.id }).from(authSessions).all().map((s) => s.id));
    for (const request of await fetchPending(account)) await approveRequest(account, request);
    const made = db.select().from(authSessions).all().filter((s) => !before.has(s.id));
    assert.deepEqual(
      made.map((s) => [s.clientKind, s.origin, s.requesterComputerId]).sort(),
      [
        ["pair:iPhone de Claire", "account", null],
        ["peer:Mac de Jimmy", "account", String(mac.id)],
        ["peer:Mac de Jimmy", "account", String(mac.id)],
        ["peer:Mac mini", "account", null],
      ].sort(),
    );

    // Removed from the account: its two sessions go, the others stay.
    const phone = made.find((s) => s.clientKind === "pair:iPhone de Claire")!;
    const macMini = made.find((s) => s.clientKind === "peer:Mac mini")!;
    await fetch(`${backend.url}/api/v1/account_computers/${mac.id}`, { method: "DELETE", headers: { "X-User-Token": backend.userToken } });
    await syncPeersWithAccount(userId);
    const after = new Set(db.select({ id: authSessions.id }).from(authSessions).all().map((s) => s.id));
    assert.deepEqual(made.filter((s) => after.has(s.id)).map((s) => s.id).sort(), [phone.id, macMini.id].sort());
    assert.equal(hasTunnelKey(key("c1")), false);
    assert.equal(hasTunnelKey(key("c2")), false);
    assert.ok(hasTunnelKey(key("c4")));
    assert.deepEqual(sessionsGivenToComputers(), []);
  } finally {
    removeAccountFile();
    forgetAccountComputers();
  }
});

test("GET and PATCH /api/v1/peers: the Desktop and a device paired here, never a peer session or one given to a computer", async () => {
  const byCode = (await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: "K7M2Q9XR", device_name: "iPhone de Jimmy" }, ...lan })).json();
  const throughAccount = pairDevice({ deviceName: "iPhone de Claire", role: "device", origin: "account" });
  const peer = pairDevice({ deviceName: "Raspberry Pi", role: "peer", origin: "account" });
  const toComputer = pairDevice({ deviceName: "Mac", role: "device", origin: "account", requesterComputerId: "41" });
  const as = (token: string) => ({ authorization: `Bearer ${token}` });

  for (const token of [desktop.token, byCode.token, throughAccount.token]) {
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/peers", headers: as(token), ...lan })).statusCode, 200);
    assert.equal((await app.inject({ method: "PATCH", url: "/api/v1/peers/77", headers: as(token), payload: { trusted: true }, ...lan })).statusCode, 404, "past the check: no such peer");
  }
  for (const token of [peer.token, toComputer.token]) {
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/peers", headers: as(token), ...lan })).statusCode, 403);
    assert.equal((await app.inject({ method: "PATCH", url: "/api/v1/peers/77", headers: as(token), payload: { trusted: true }, ...lan })).statusCode, 403);
  }
  // Asking another computer for access, or forgetting one: the Desktop's only.
  for (const token of [byCode.token, throughAccount.token]) {
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/peers", headers: as(token), payload: { computer_id: "77" }, ...lan })).statusCode, 403);
    assert.equal((await app.inject({ method: "DELETE", url: "/api/v1/peers/77", headers: as(token), ...lan })).statusCode, 403);
  }
});

test("readPending: a computer is a peer whatever role it gives, and the account's name wins", () => {
  const expires = new Date(Date.now() + 60_000).toISOString();
  const [a, b, c] = readPending({
    requests: [
      { id: 1, name: "moi", public_key: key("d1"), expires_at: expires, role: "device", requester_kind: "computer" },
      { id: 2, name: "moi", public_key: key("d2"), expires_at: expires, requester_computer_id: 12, requester_name: "  Mac de Jimmy  " },
      { id: 3, name: "iPhone", public_key: key("d3"), expires_at: expires, role: "admin" },
    ],
  });
  assert.deepEqual([a!.role, a!.requester_kind, a!.name], ["peer", "computer", "moi"]);
  assert.deepEqual([b!.role, b!.requester_computer_id, b!.name], ["peer", "12", "Mac de Jimmy"]);
  assert.deepEqual([c!.role, c!.requester_kind], ["device", null]);
});
