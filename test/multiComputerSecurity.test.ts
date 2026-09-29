import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startFakeBackend } from "./helpers/fakeBackend.js";

// Who counts as the Desktop, as this machine, as the owner — and leaving
// the account (docs/multi-computer-design.md, review of 29/09/2026):
//
//   - the Desktop is known by how its session was given (signup, signin, the
//     setup token), never by a name the requester chose: a phone approved
//     through the account and calling itself « Twoody Desktop » is not it;
//   - the admin token is compared in constant time;
//   - a request a reverse proxy forwarded is not this machine's;
//   - twoody-server logout keeps account.json when the account did not
//     confirm, unless forced, and drops what the account approved here.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-multi-security-"));
process.env.TWOODY_PAIRING_CODE = "K7M2Q9XR";
delete process.env.TWOODY_USER_TOKEN;
delete process.env.TWOODY_DEVICE_TOKEN;
delete process.env.TWOODY_ADMIN_TOKEN;

const backend = await startFakeBackend();
process.env.TWOODY_BACKEND_URL = backend.url;

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken, isOwnerSession } = await import("../src/auth.js");
const { approveRequest, readPending } = await import("../src/account/approvals.js");
const { newPairingKey } = await import("../src/account/keys.js");
const { linkState, logout } = await import("../src/account/link.js");
const { readAccountFile, writeAccountFile, linkedAccount } = await import("../src/account/store.js");
const { authSessions, db } = await import("../src/db.js");
const { safeEqual } = await import("../src/adminAccess.js");
const { ownerRequest } = await import("../src/localAccess.js");

const app = await buildApp();
test.after(async () => {
  await app.close();
  await backend.close();
});

const lan = { remoteAddress: "192.168.1.30" };
const desktop = (await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } })).json();

function link(): { computerId: string } {
  const key = newPairingKey();
  const computer = backend.addComputer({ name: "Raspberry Pi", public_key: key.pub, kind: "server" });
  writeAccountFile({
    backend_url: backend.url,
    user_token: backend.userToken,
    device_token: "device-token-of-the-pi",
    computer: { id: String(computer.id), credential: computer.credential, name: "Raspberry Pi" },
    pairing_key: key,
    approvers: [{ public_key: "ab".repeat(32), kind: "computer", name: "Mac" }],
  });
  return { computerId: String(computer.id) };
}

async function approveThroughAccount(name: string, publicKey: string): Promise<{ token: string; sessionId: string }> {
  const account = linkedAccount()!;
  const id = 700 + backend.authorizations.length;
  backend.authorizations.push({
    id,
    computer_id: Number(account.computer.id),
    name,
    public_key: publicKey,
    role: "device",
    state: "pending",
    sealed_response: null,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    endorsements: [],
  });
  const before = new Set(db.select({ id: authSessions.id }).from(authSessions).all().map((s) => s.id));
  const [request] = readPending({ requests: [{ id, name, public_key: publicKey, expires_at: new Date(Date.now() + 60_000).toISOString(), role: "device" }] });
  await approveRequest(account, request!);
  const [session] = db.select().from(authSessions).all().filter((s) => !before.has(s.id));
  return { token: "", sessionId: session!.id };
}

test("the Desktop is its setup-token session, not a name: « Twoody Desktop » approved through the account or paired by code may see and switch the peers, never ask for or forget one", async () => {
  link();
  assert.ok(isOwnerSession(desktop.session_id));
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/peers", headers: { authorization: `Bearer ${desktop.token}` }, ...lan })).statusCode, 200);

  const approved = await approveThroughAccount("Twoody Desktop", "cd".repeat(32));
  const [row] = db.select().from(authSessions).all().filter((s) => s.id === approved.sessionId);
  assert.equal(row!.clientKind, "pair:Twoody Desktop", "it is called what it asked to be called");
  assert.equal(row!.origin, "account");
  assert.equal(isOwnerSession(approved.sessionId), false);

  const byCode = (await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: "K7M2Q9XR", device_name: "Twoody Desktop" }, ...lan })).json();
  assert.equal(isOwnerSession(byCode.session_id), false);
  for (const token of [byCode.token]) {
    // A device paired with this computer sees the peers and switches them
    // (the iPhone's « Appareils »)…
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/peers", headers: { authorization: `Bearer ${token}` }, ...lan })).statusCode, 200);
    assert.equal((await app.inject({ method: "PATCH", url: "/api/v1/peers/1", headers: { authorization: `Bearer ${token}` }, payload: { enabled: false }, ...lan })).statusCode, 404, "past the check: no such peer");
    // …but asking another computer for access, or forgetting one, stays the Desktop's.
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/peers", headers: { authorization: `Bearer ${token}` }, payload: { computer_id: "1" }, ...lan })).statusCode, 403);
    assert.equal((await app.inject({ method: "DELETE", url: "/api/v1/peers/1", headers: { authorization: `Bearer ${token}` }, ...lan })).statusCode, 403);
  }
});

test("the admin token is compared in constant time, and only it counts once set", () => {
  assert.equal(safeEqual("secret-admin-token", "secret-admin-token"), true);
  assert.equal(safeEqual("secret-admin-token", "secret-admin-tokeN"), false);
  assert.equal(safeEqual("short", "secret-admin-token"), false);
  process.env.TWOODY_ADMIN_TOKEN = "secret-admin-token";
  try {
    const request = (headers: Record<string, string>, ip = "127.0.0.1") => ({ ip, headers }) as never;
    assert.equal(ownerRequest(request({ authorization: "Bearer secret-admin-token" }, "192.168.1.30")), true);
    assert.equal(ownerRequest(request({ "x-admin-token": "secret-admin-token" }, "192.168.1.30")), true);
    assert.equal(ownerRequest(request({ authorization: "Bearer secret-admin-tokeN" })), false);
    assert.equal(ownerRequest(request({})), false, "loopback is not enough once a token is set");
  } finally {
    delete process.env.TWOODY_ADMIN_TOKEN;
  }
});

test("a request a reverse proxy forwarded from 127.0.0.1 is not this machine's", async () => {
  const fp = readAccountFile()!.pairing_key.pub.slice(0, 8);
  for (const header of ["x-forwarded-for", "forwarded", "x-real-ip"]) {
    const headers = { [header]: header === "forwarded" ? "for=203.0.113.9" : "203.0.113.9" };
    const seen = await app.inject({ method: "GET", url: "/account/link", remoteAddress: "127.0.0.1", headers });
    assert.deepEqual(seen.json(), { state: "linked", fp }, header);
    assert.equal((await app.inject({ method: "DELETE", url: "/account/link", remoteAddress: "127.0.0.1", headers })).statusCode, 403, header);
    assert.equal((await app.inject({ method: "GET", url: "/admin", remoteAddress: "127.0.0.1", headers })).statusCode, 403, header);
  }
  assert.ok((await app.inject({ method: "GET", url: "/account/link", remoteAddress: "127.0.0.1" })).json().account_computer_id);
});

test("logout: kept when the account does not confirm, left with --force, and what the account approved here goes", async () => {
  const { computerId } = linkedAccount() ? { computerId: linkedAccount()!.computer.id } : link();
  const approved = await approveThroughAccount("iPhone de Claire", "ef".repeat(32));
  const path = `DELETE /account_computers/${computerId}`;

  backend.forced.set(path, 500);
  const refused = await app.inject({ method: "DELETE", url: "/account/link", remoteAddress: "127.0.0.1" });
  assert.equal(refused.statusCode, 502);
  assert.equal(refused.json().error, "leave_unconfirmed");
  assert.equal(linkState(), "linked", "still linked");
  assert.ok(readAccountFile()?.computer, "account.json kept");
  assert.ok(db.select().from(authSessions).all().some((s) => s.id === approved.sessionId), "nothing dropped");

  const forced = await app.inject({ method: "DELETE", url: "/account/link?force=1", remoteAddress: "127.0.0.1" });
  assert.equal(forced.statusCode, 200);
  assert.equal(forced.json().confirmed, false);
  assert.equal(forced.json().state, "unlinked");
  assert.equal(readAccountFile()?.computer, undefined, "account.json no longer links it");
  assert.ok(!db.select().from(authSessions).all().some((s) => s.origin === "account"), "the sessions the account approved went");
  assert.ok(db.select().from(authSessions).all().some((s) => s.id === desktop.session_id), "the Desktop's stays");
  backend.forced.delete(path);

  // A backend that no longer knows the computer confirms it.
  link();
  backend.forced.set(`DELETE /account_computers/${linkedAccount()!.computer.id}`, 404);
  assert.deepEqual(await logout(), { confirmed: true, sessionsDropped: 0 });
  assert.equal(readAccountFile(), null);
});
