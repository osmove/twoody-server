import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { startFakeBackend } from "./helpers/fakeBackend.js";
import { meshVault } from "./helpers/meshVault.js";

// What a malicious account (it rewrites its rows and listings, it cannot
// forge a signature) must not be able to do to this computer's links and
// vault (security review, 30/09/2026):
//
//   - swap the computer at the end of a link that works (a « relink »),
//     by listing another pairing key for it and answering with its own
//     tunnel key;
//   - pin a key other than the one whose security code the person
//     compared (« Ajouter un ordinateur » by its code);
//   - get turns sent to a computer only its listing vouches for;
//   - bring a device the Desktop revoked back into the roster;
//   - give two epoch keys one number (2**53 + 1 === 2**53);
//   - have the Desktop open a file outside the folders the person grants.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-peer-keys-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
process.env.TWOODY_PEER_POLL_MS = "3600000";
delete process.env.TWOODY_USER_TOKEN;

const backend = await startFakeBackend();

const { buildApp } = await import("../src/app.js");
const { sealPairing } = await import("../src/account/pairingSeal.js");
const { newPairingKey } = await import("../src/account/keys.js");
const { writeAccountFile } = await import("../src/account/store.js");
const { accountComputers: accountPeers, db, documentFolders, documents } = await import("../src/db.js");
const { ensureLocalUser, pairDevice } = await import("../src/pairing.js");
const { checkPeerRequest, closeAllPeerLinks, peerById, requestPeer, PeerUnavailableError } = await import("../src/peers/index.js");
/// Forgets the Pi here, without asking it anything (it is not there).
const forgetPi = () => db.delete(accountPeers).where(eq(accountPeers.computerId, PI)).run();

const { routablePeers } = await import("../src/router/index.js");
const { tunnelIdentity } = await import("../src/tunnel/identity.js");
const { buildRoster } = await import("../src/vault/roster.js");
const { readVaultMessage } = await import("../src/vault/service.js");
const { createDeviceKeys, createEpochKey, toHex, unwrapEpochKey, wrapEpochKey } = await import("../src/vault/crypto.js");
const { isIndexedPath } = await import("../src/documents/library.js");
const { folderRisk } = await import("../src/documents/folderRisk.js");
const { eq } = await import("drizzle-orm");

const hex = () => randomBytes(32).toString("hex");
const self = backend.addComputer({ name: "Mac de Jimmy", public_key: hex(), kind: "desktop" });
writeAccountFile({
  backend_url: backend.url, account_id: 7, user_token: backend.userToken, device_token: "dev",
  computer: { id: String(self.id), credential: self.credential, name: "Mac de Jimmy" }, pairing_key: newPairingKey(), approvers: [],
});
const app = await buildApp();
test.after(async () => {
  closeAllPeerLinks();
  await app.close();
  backend.close();
});
const user = ensureLocalUser();
const ownKey = tunnelIdentity().publicKey.toString("hex");

// The Pi as it really is, and what the account puts in its place.
const genuine = { pairing: newPairingKey(), tunnel: hex() };
const attacker = { pairing: newPairingKey(), tunnel: hex() };
const pi = backend.addComputer({ name: "Raspberry Pi", public_key: genuine.pairing.pub, kind: "server" });
const PI = String(pi.id);

/// The account approves request `rid` with an answer sealed by `host`.
function approve(rid: string, host: { priv: string }, tunnelKey: string) {
  const authorization = backend.authorizations.find((a) => String(a.id) === rid)!;
  authorization.state = "approved";
  authorization.sealed_response = sealPairing(host.priv, ownKey, rid, {
    localServerUrl: "http://127.0.0.1:9", localServerToken: `peer-${randomBytes(4).toString("hex")}`, computerTunnelKey: tunnelKey, computerName: "Raspberry Pi", kind: "server",
  });
}

function linkGenuinePi() {
  const now = new Date();
  db.delete(accountPeers).where(eq(accountPeers.computerId, PI)).run();
  db.insert(accountPeers).values({
    computerId: PI, userId: user.id, name: "Raspberry Pi", kind: "server", state: "linked", hostKey: genuine.pairing.pub,
    url: "http://127.0.0.1:9", token: "genuine-token", tunnelKey: genuine.tunnel, checkedTunnelKey: genuine.tunnel, enabled: true, createdAt: now, updatedAt: now,
  }).run();
}

test("a relink keeps the pairing key and tunnel key of the link that works, whatever key the account lists now", async () => {
  linkGenuinePi();
  pi.public_key = attacker.pairing.pub; // the listing rewritten
  try {
    const asked = await requestPeer(user.id, PI, { checkedTunnelKey: genuine.tunnel });
    assert.equal(asked.public_key, ownKey, "this server's own tunnel key: the only requester key the Desktop vouches for");
    assert.equal(peerById(user.id, PI)!.hostKey, genuine.pairing.pub, "the listed key never replaces the working link's");
    // The account answers with the other computer's seal and tunnel key.
    approve(asked.request_id, attacker.pairing, attacker.tunnel);
    assert.equal(await checkPeerRequest(user.id, PI), "failed");
    const row = peerById(user.id, PI)!;
    assert.deepEqual([row.state, row.tunnelKey, row.token], ["linked", genuine.tunnel, "genuine-token"], "the link that works stays the genuine one");
    // Even an answer the genuine key opens must carry the tunnel key checked.
    const again = await requestPeer(user.id, PI, {});
    approve(again.request_id, genuine.pairing, attacker.tunnel);
    assert.equal(await checkPeerRequest(user.id, PI), "failed");
    assert.equal(peerById(user.id, PI)!.error, "tunnel_key_mismatch");
    assert.equal(peerById(user.id, PI)!.tunnelKey, genuine.tunnel);
    // The genuine computer's answer still replaces it.
    const genuineAgain = await requestPeer(user.id, PI, { checkedTunnelKey: genuine.tunnel });
    approve(genuineAgain.request_id, genuine.pairing, genuine.tunnel);
    assert.equal(await checkPeerRequest(user.id, PI), "linked");
    assert.equal(peerById(user.id, PI)!.tunnelKey, genuine.tunnel);
  } finally {
    pi.public_key = genuine.pairing.pub;
  }
});

test("a code de sécurité checked against another key than the working link's asks nothing", async () => {
  linkGenuinePi();
  const before = backend.authorizations.length;
  await assert.rejects(requestPeer(user.id, PI, { checkedTunnelKey: attacker.tunnel }), (err: unknown) => err instanceof PeerUnavailableError && err.code === "key_mismatch");
  assert.equal(backend.authorizations.length, before);
});

test("added by its code: the answer must carry the tunnel key whose code the person compared", async () => {
  forgetPi();
  pi.public_key = attacker.pairing.pub; // the login approved with another pairing key
  try {
    const asked = await requestPeer(user.id, PI, { checkedTunnelKey: genuine.tunnel });
    approve(asked.request_id, attacker.pairing, attacker.tunnel);
    assert.equal(await checkPeerRequest(user.id, PI), "failed");
    const row = peerById(user.id, PI)!;
    assert.deepEqual([row.state, row.error, row.tunnelKey], ["failed", "tunnel_key_mismatch", null]);
    // Asked again without saying the key: the one checked still holds.
    const again = await requestPeer(user.id, PI, {});
    approve(again.request_id, attacker.pairing, attacker.tunnel);
    assert.equal(await checkPeerRequest(user.id, PI), "failed");
    assert.equal(peerById(user.id, PI)!.tunnelKey, null);
  } finally {
    pi.public_key = genuine.pairing.pub;
  }
});

test("turns go to a roster computer, or to a link whose code de sécurité the person checked — never to one only the account vouches for", async () => {
  linkGenuinePi();
  assert.deepEqual(routablePeers(user.id).map((p) => p.computerId), [PI]);
  db.update(accountPeers).set({ checkedTunnelKey: null }).where(eq(accountPeers.computerId, PI)).run();
  assert.deepEqual(routablePeers(user.id), [], "an old link, or one the account alone vouches for");
  db.update(accountPeers).set({ checkedTunnelKey: attacker.tunnel }).where(eq(accountPeers.computerId, PI)).run();
  assert.deepEqual(routablePeers(user.id), [], "checked under another key");

  // The Desktop records the person's check, for the link's own key only.
  const owner = { authorization: `Bearer ${pairDevice({ deviceName: "Twoody Desktop", origin: "owner" }).token}` };
  const wrong = await app.inject({ method: "PATCH", url: `/api/v1/peers/${PI}`, headers: owner, payload: { checked_tunnel_key: attacker.tunnel } });
  assert.equal(wrong.statusCode, 409);
  const phone = { authorization: `Bearer ${pairDevice({ deviceName: "iPhone", tunnelPublicKey: hex() }).token}` };
  assert.equal((await app.inject({ method: "PATCH", url: `/api/v1/peers/${PI}`, headers: phone, remoteAddress: "192.168.1.50", payload: { checked_tunnel_key: genuine.tunnel } })).statusCode, 403, "a phone does not check codes for the Desktop");
  const right = await app.inject({ method: "PATCH", url: `/api/v1/peers/${PI}`, headers: owner, payload: { checked_tunnel_key: genuine.tunnel } });
  assert.equal(right.statusCode, 200, right.body);
  assert.deepEqual([right.json().checked, right.json().tunnel_public_key], [true, genuine.tunnel]);
  assert.deepEqual(routablePeers(user.id).map((p) => p.computerId), [PI]);

  // POST /peers takes the checked key and answers with this server's own.
  forgetPi();
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/peers", headers: owner, payload: { computer_id: PI, checked_tunnel_key: "zz" } })).statusCode, 422);
  const posted = await app.inject({ method: "POST", url: "/api/v1/peers", headers: owner, payload: { computer_id: PI, checked_tunnel_key: genuine.tunnel.toUpperCase() } });
  assert.equal(posted.statusCode, 202, posted.body);
  assert.equal(posted.json().public_key, ownKey);
  assert.equal(peerById(user.id, PI)!.expectedTunnelKey, genuine.tunnel);
  forgetPi();
});

test("what the Desktop revoked stays out of the roster, whatever the account says", () => {
  const vault = meshVault("7");
  const iphone = vault.person("iPhone");
  const piDevice = vault.computer("Raspberry Pi", PI, iphone);
  const macDevice = vault.computer("Mac de Jimmy", "88", iphone, { canApprove: true });
  const keys = createDeviceKeys();
  const handed = readVaultMessage({
    type: "vault", deviceId: iphone.id, userId: "7",
    keys: { encPrivate: toHex(keys.encPrivate), encPublic: toHex(keys.encPublic), signPrivate: toHex(keys.signPrivate), signPublic: toHex(keys.signPublic) },
    epochs: { "1": hex(), "9007199254740992": hex(), "1e3": hex() }, anchors: [],
    revoked: [piDevice.id, 42, "x".repeat(65)],
  })!;
  assert.deepEqual(handed.revoked, [piDevice.id], "strings only");
  assert.deepEqual([...handed.epochs.keys()], [1], "never 2**53, never a number written otherwise");
  const before = buildRoster(vault.input([iphone]));
  assert.ok(before.computers.has(PI));
  const roster = buildRoster({ ...vault.input([iphone]), revoked: handed.revoked });
  assert.equal(roster.computers.has(PI), false, "the account shows it trusted: it stays revoked");
  assert.ok(roster.computers.has("88"));
  // Revoking a device that vouched: nothing is walked through it either.
  const vouched = vault.computer("Pi 2", "99", macDevice);
  assert.ok(buildRoster(vault.input([iphone])).computers.has("99"));
  assert.equal(buildRoster({ ...vault.input([iphone]), revoked: [macDevice.id] }).computers.has("99"), false);
  assert.ok(vouched);
});

test("epoch numbers are safe integers: an envelope at 2**53 is neither made nor opened", () => {
  const from = { ...createDeviceKeys(), deviceId: "a" };
  const to = { ...createDeviceKeys(), deviceId: "b" };
  const epochKey = createEpochKey();
  for (const epoch of [2 ** 53, 2 ** 53 + 1, 0, -1, 1.5, 2 ** 31]) {
    assert.throws(() => wrapEpochKey({ epochKey, epoch, userId: "7", to, from }), { code: "bad_epoch" }, String(epoch));
  }
  const fine = wrapEpochKey({ epochKey, epoch: 3, userId: "7", to, from });
  const signers = new Map([["a", from.signPublic]]);
  assert.deepEqual(unwrapEpochKey(fine, { userId: "7", device: to, signers }), epochKey);
  assert.throws(() => unwrapEpochKey({ ...fine, epoch: 2 ** 53 }, { userId: "7", device: to, signers }), { code: "bad_epoch" });
});

test("the Desktop opens an indexed file only inside a folder the person still grants", () => {
  // Where folderRisk lets a folder be granted (not under /private/var on a Mac).
  const home = realpathSync(homedir());
  const tmpBase = realpathSync(tmpdir());
  const base = folderRisk(join(tmpBase, "x"), home) === null ? tmpBase : home;
  const root = realpathSync(mkdtempSync(join(base, "twoody-open-test-")));
  try {
    const granted = join(root, "Documents");
    const outside = join(root, "Secret");
    mkdirSync(granted);
    mkdirSync(outside);
    writeFileSync(join(granted, "bail.pdf"), "bail");
    writeFileSync(join(outside, "keys.txt"), "keys");
    symlinkSync(join(outside, "keys.txt"), join(granted, "lien.txt"));
    const now = new Date();
    db.insert(documentFolders).values({ id: "f-granted", userId: user.id, path: granted, createdAt: now }).run();
    const row = (id: string, path: string) =>
      db.insert(documents).values({ id, userId: user.id, folderId: "f-granted", path, name: id, ext: "pdf", size: 1, mtimeMs: 1, status: "indexed" } as typeof documents.$inferInsert).run();
    row("d-inside", join(granted, "bail.pdf"));
    row("d-forged", join(outside, "keys.txt"));
    row("d-link", join(granted, "lien.txt"));
    assert.equal(isIndexedPath(user.id, join(granted, "bail.pdf")), true);
    assert.equal(isIndexedPath(user.id, join(outside, "keys.txt")), false, "a row naming a file outside its folder");
    assert.equal(isIndexedPath(user.id, join(granted, "lien.txt")), false, "a link out of the folder");
    assert.equal(isIndexedPath(user.id, join(granted, "absent.pdf")), false);
    // A folder folderRisk refuses now (granted before as the whole home).
    db.update(documentFolders).set({ path: home }).where(eq(documentFolders.id, "f-granted")).run();
    assert.equal(isIndexedPath(user.id, join(granted, "bail.pdf")), home === base ? true : false);
    db.delete(documents).where(eq(documents.folderId, "f-granted")).run();
    db.delete(documentFolders).where(eq(documentFolders.id, "f-granted")).run();
  } finally {
    if (process.platform === "darwin") {
      const trash = join(homedir(), ".Trash");
      mkdirSync(trash, { recursive: true });
      renameSync(root, join(trash, basename(root)));
    } else rmSync(root, { recursive: true, force: true });
  }
});
