import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startFakeBackend } from "./helpers/fakeBackend.js";

// A computer removed from the account (docs/multi-computer-design.md,
// review of 29/09/2026):
//
//   - the removed server learns it from its heartbeat (403 computer_revoked
//     or 401 session_revoked / session_expired, twice in a row; nothing
//     else counts): its loops stop, account.json keeps only its own key and device
//     token (0600), and what the account approved on it goes;
//   - the computer that sent it turns stops listing it among its peers once
//     the account no longer does, so the router stops using it, on the LAN
//     as through the relay.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-account-removal-"));
process.env.TWOODY_ACCOUNT_BRIDGE = "0";
process.env.TWOODY_ACCOUNT_TUNNEL = "0";
process.env.TWOODY_HEARTBEAT_MS = "3600000";
process.env.TWOODY_ACCOUNT_POLL_MS = "3600000";
delete process.env.TWOODY_USER_TOKEN;
delete process.env.TWOODY_DEVICE_TOKEN;

const backend = await startFakeBackend();
process.env.TWOODY_BACKEND_URL = backend.url;

const { buildApp } = await import("../src/app.js");
const { approveRequest, readPending } = await import("../src/account/approvals.js");
const { newPairingKey } = await import("../src/account/keys.js");
const { linkState, logout, resetLinkForTests, startLink } = await import("../src/account/link.js");
const { startAccountService } = await import("../src/account/service.js");
const { accountPath, linkedAccount, readAccountFile, writeAccountFile } = await import("../src/account/store.js");
const { accountPeers, authSessions, db } = await import("../src/db.js");
const { ensureLocalUser, pairDevice } = await import("../src/pairing.js");
const { accountComputers, linkedPeers, listPeers, requestPeer, syncPeersWithAccount } = await import("../src/peers/index.js");

const app = await buildApp();
test.after(async () => {
  resetLinkForTests();
  await app.close();
  await backend.close();
});

function link() {
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
  return { computer, key };
}

test("a heartbeat refused twice unlinks the server: loops stopped, account.json unlinked (0600), the account's approvals gone", async () => {
  const { computer, key } = link();
  const account = linkedAccount()!;
  backend.authorizations.push({ id: 810, computer_id: computer.id, name: "iPhone de Claire", public_key: "cd".repeat(32), role: "device", state: "pending", sealed_response: null, expires_at: new Date(Date.now() + 60_000).toISOString(), endorsements: [] });
  await approveRequest(account, readPending({ requests: [{ id: 810, name: "iPhone de Claire", public_key: "cd".repeat(32), expires_at: new Date(Date.now() + 60_000).toISOString(), role: "device" }] })[0]!);
  const own = pairDevice({ deviceName: "iPhone de Jimmy", origin: "code" });
  assert.equal(db.select().from(authSessions).all().filter((s) => s.origin === "account").length, 1);

  const logs: string[] = [];
  const service = startAccountService({ localBaseUrl: "http://127.0.0.1:1", log: (m) => logs.push(m) });
  try {
    await service.heartbeat();
    assert.ok(computer.heartbeats >= 1, "linked: it beats");
    assert.ok(service.approvals, "the approval loop runs");

    const path = `POST /account_computers/${computer.id}/heartbeat`;
    // Refusals the backend did not name never count: a bare 401 / 403, a
    // proxy's page, another error code — however many.
    for (const answer of [401, 403, { status: 403, html: "<html>Forbidden by the proxy</html>" }, { status: 403, body: { error: "forbidden" } }, { status: 401, body: { error: "computer_revoked" } }, { status: 403, body: { error: "session_revoked" } }, { status: 403, body: { error: "invalid_computer_credential" } }]) {
      backend.forced.set(path, answer);
      await service.heartbeat();
      await service.heartbeat();
      await service.heartbeat();
      assert.equal(linkState(), "linked", `not unlinked by ${JSON.stringify(answer)}`);
    }
    // Two in a row, not two in all: something else in between starts again.
    backend.forced.set(path, { status: 401, body: { error: "session_revoked" } });
    await service.heartbeat();
    backend.forced.set(path, 502);
    await service.heartbeat();
    backend.forced.set(path, { status: 403, body: { error: "computer_revoked" } });
    await service.heartbeat();
    assert.equal(linkState(), "linked", "one refusal is not enough");
    assert.equal(logs.filter((l) => l.includes("invalid_computer_credential")).length, 1, "a wrong credential is said, once, and does not unlink");
    backend.forced.set(path, { status: 401, body: { error: "session_expired" } });
    await service.heartbeat();
    backend.forced.delete(path);

    assert.equal(linkState(), "unlinked");
    assert.equal(service.approvals, null, "the loops stopped");
    const file = readAccountFile()!;
    assert.deepEqual(file, { device_token: "device-token-of-the-pi", pairing_key: key, approvers: [] }, "only this computer's own key and device token are kept");
    assert.equal(statSync(accountPath()).mode & 0o777, 0o600);
    const sessions = db.select().from(authSessions).all();
    assert.ok(!sessions.some((s) => s.origin === "account"), "what the account approved here went");
    assert.ok(sessions.some((s) => s.id === own.sessionId), "a device paired here by code stays");
    assert.ok(logs.some((l) => l.includes("refused this server (401)") && l.includes("twoody-server login")), logs.join("\n"));

    const beats = computer.heartbeats;
    await service.heartbeat();
    assert.equal(computer.heartbeats, beats, "no more heartbeats");
  } finally {
    service.stop();
  }
});

test("the computer that sends turns sets aside the peers the account no longer lists", async () => {
  link();
  const userId = ensureLocalUser().id;
  const kept = backend.addComputer({ name: "Mac mini", public_key: "12".repeat(32), kind: "desktop" });
  const now = new Date();
  const row = (computerId: string, name: string) => ({
    computerId,
    userId,
    name,
    kind: "server",
    platform: "linux",
    state: "linked",
    url: "http://192.168.1.50:3000",
    token: `token-of-${name}`,
    tunnelKey: "34".repeat(32),
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
  db.insert(accountPeers).values([row(String(kept.id), "Mac mini"), row("999", "Raspberry Pi retiré")]).run();
  assert.equal(linkedPeers(userId).length, 2);

  // The backend does not answer: nothing changes.
  backend.forced.set("GET /account_computers", 502);
  assert.deepEqual(await syncPeersWithAccount(userId), []);
  assert.equal(linkedPeers(userId).length, 2);
  backend.forced.delete("GET /account_computers");

  assert.deepEqual(await syncPeersWithAccount(userId), ["999"]);
  assert.deepEqual(linkedPeers(userId).map((p) => p.computerId), [String(kept.id)]);
  const removed = listPeers(userId).find((p) => p.computerId === "999")!;
  assert.equal(removed.state, "removed");
  assert.equal(removed.error, "removed_from_account");
  assert.equal(removed.token, null, "its session is forgotten");
  assert.equal(removed.url, null);

  const listed = await app.inject({ method: "GET", url: "/api/v1/peers", remoteAddress: "127.0.0.1", headers: { authorization: `Bearer ${pairDevice({ deviceName: "Twoody Desktop", origin: "owner" }).token}` } });
  assert.equal(listed.json().peers.find((p: { computer_id: string }) => p.computer_id === "999").state, "removed");
});

test("every call with the account's session carries the device token given at link time, whatever TWOODY_DEVICE_TOKEN says", async () => {
  resetLinkForTests();
  writeAccountFile({ device_token: "device-token-of-the-pi", pairing_key: newPairingKey(), approvers: [] });
  process.env.TWOODY_DEVICE_TOKEN = "another-device-token";
  process.env.TWOODY_LINK_POLL_MS = "20";
  const service = startAccountService({ localBaseUrl: "http://127.0.0.1:1" });
  try {
    const view = await startLink();
    const login = backend.logins.at(-1)!;
    assert.equal(login.device_token, "device-token-of-the-pi", "the login carries the file's device token");
    backend.approveLogin(view.user_code!, null);
    const deadline = Date.now() + 3_000;
    while (linkState() !== "linked") {
      if (Date.now() > deadline) throw new Error("not linked");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(linkedAccount()!.device_token, "device-token-of-the-pi");

    const from = backend.calls.length;
    await service.heartbeat();
    await service.approvals!.tick();
    await accountComputers({ fresh: true });
    const other = backend.addComputer({ name: "Mac mini", public_key: "56".repeat(32) });
    await requestPeer(ensureLocalUser().id, String(other.id));
    await logout();
    const withSession = backend.calls.slice(from).map((call, i) => [call, backend.deviceTokens[from + i]]);
    assert.ok(withSession.length >= 5, JSON.stringify(withSession));
    for (const [call, token] of withSession) assert.equal(token, "device-token-of-the-pi", call);
    assert.ok(withSession.some(([call]) => call!.endsWith("/heartbeat")));
    assert.ok(withSession.some(([call]) => call!.endsWith("/pending")));
    assert.ok(withSession.some(([call]) => call === "GET /account_computers"));
    assert.ok(withSession.some(([call]) => call!.endsWith("/request_access")));
    assert.ok(withSession.some(([call]) => call!.startsWith("DELETE /account_computers/")));

    // Beside TWOODY_USER_TOKEN, TWOODY_DEVICE_TOKEN is its pair.
    link();
    process.env.TWOODY_USER_TOKEN = backend.userToken;
    assert.equal(linkedAccount()!.device_token, "another-device-token");
  } finally {
    service.stop();
    delete process.env.TWOODY_DEVICE_TOKEN;
    delete process.env.TWOODY_USER_TOKEN;
    delete process.env.TWOODY_LINK_POLL_MS;
  }
});
