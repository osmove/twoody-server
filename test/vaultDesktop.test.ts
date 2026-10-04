import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Inside Twoody Desktop (docs/mesh-design.md §1, lot S1): the Desktop keeps
// custody of the vault keys (safeStorage) and hands them to its embedded
// server by message. The server holds them in memory — nothing of the
// vault reaches its data directory — never enrols itself, never seals the
// Desktop's turns twice, and still catches up on a conversation on demand.

const dataDir = mkdtempSync(join(tmpdir(), "twoody-vault-desktop-"));
process.env.TWOODY_DATA_DIR = dataDir;
const { sqlite } = await import("../src/db.js");
const { setBackendFetch } = await import("../src/account/backend.js");
const { setDesktopAccount } = await import("../src/account/service.js");
const crypto = await import("../src/vault/crypto.js");
const client = await import("../src/vault/client.js");
const { createVaultSync } = await import("../src/vault/sync.js");
const { memoryStore } = await import("../src/vault/store.js");
const service = await import("../src/vault/service.js");
const { fakeVaultBackend } = await import("./helpers/fakeVault.js");

const USER_ID = 42;
const BACKEND = "https://account.test";
const fake = fakeVaultBackend({ userId: USER_ID, computers: [] });
setBackendFetch(fake.fetch);
sqlite.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").run("owner", "owner@self-hosted.twoody", Date.now());

// The iPhone founds the vault; the Desktop (a person device) joins it.
const phoneCreds = { backendUrl: BACKEND, userToken: fake.personSession() };
const desktopCreds = { backendUrl: BACKEND, userToken: fake.personSession() };
const phoneApi = client.accountVaultApi(() => phoneCreds);
const { backendCall } = await import("../src/account/backend.js");
const as = (creds: typeof phoneCreds) => (path: string, body: unknown) => backendCall(creds, path, { body }).then((r) => r.body as Record<string, any>);
const phone = { keys: crypto.createDeviceKeys(), id: "", epochs: new Map([[1, crypto.createEpochKey()]]) };
const desktop = { keys: crypto.createDeviceKeys(), id: "" };
const VAULT_ID = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const phoneSync = createVaultSync({ api: phoneApi, epochKeys: () => phone.epochs, userId: USER_ID, store: memoryStore() });

const vaultFiles = () => readdirSync(dataDir).filter((name) => /vault/i.test(name));

test.before(async () => {
  phone.id = (await as(phoneCreds)("vault/devices", { label: "iPhone", enc_public: crypto.toHex(phone.keys.encPublic), sign_public: crypto.toHex(phone.keys.signPublic) })).device.id;
  const wrapFor = (id: string, encPublic: Uint8Array) => crypto.wrapEpochKey({ epochKey: phone.epochs.get(1)!, epoch: 1, userId: USER_ID, to: { deviceId: id, encPublic }, from: { deviceId: phone.id, signPrivate: phone.keys.signPrivate } });
  await as(phoneCreds)("vault/envelopes", { envelopes: [wrapFor(phone.id, phone.keys.encPublic)] });
  desktop.id = (await as(desktopCreds)("vault/devices", { label: "Mac", enc_public: crypto.toHex(desktop.keys.encPublic), sign_public: crypto.toHex(desktop.keys.signPublic) })).device.id;
  await as(phoneCreds)("vault/envelopes", { envelopes: [wrapFor(desktop.id, desktop.keys.encPublic)] });
  // What Twoody Desktop's main process holds, and tells its server.
  setDesktopAccount({ backendUrl: BACKEND, userToken: desktopCreds.userToken, computerId: null, computerName: "Mac de Jimmy" });
});

test("the hand-over is held in memory: no vault file, no enrolment", async () => {
  const handed = service.setDesktopVault({
    type: "vault", deviceId: desktop.id, userId: USER_ID,
    keys: { encPrivate: crypto.toHex(desktop.keys.encPrivate), encPublic: crypto.toHex(desktop.keys.encPublic), signPrivate: crypto.toHex(desktop.keys.signPrivate), signPublic: crypto.toHex(desktop.keys.signPublic) },
    epochs: { 1: crypto.toHex(phone.epochs.get(1)!) },
  });
  assert.equal(handed, true);
  assert.equal(service.vaultMode(), "desktop");
  assert.deepEqual(service.vaultEpochKeys().get(1), phone.epochs.get(1));
  const identity = service.vaultIdentity()!;
  assert.deepEqual([identity.custody, identity.vault_device_id, identity.sign_public, identity.status], ["desktop", desktop.id, crypto.toHex(desktop.keys.signPublic), "trusted"]);
  assert.doesNotMatch(JSON.stringify(identity), new RegExp(crypto.toHex(desktop.keys.signPrivate)));
  // Never a device of its own, and the Desktop keeps the anchors.
  assert.equal(fake.devices.length, 2);
  assert.throws(() => service.pinVaultAnchor({ id: phone.id, sign_public: crypto.toHex(phone.keys.signPublic) }), /desktop_custody/);
  assert.deepEqual(vaultFiles(), []);
});

test("catch-up pulls and imports a conversation, still without writing the vault anywhere", async () => {
  await phoneSync.recordTurn(VAULT_ID, { ref: "q1", text: "Quand part le train ?", reply: "À 8 h 12.", created_at: "2026-09-30T07:00:00.000Z" });
  await phoneSync.flush();
  const caught = await service.ensureConversation(VAULT_ID, ["q1"], 2000);
  assert.equal(caught.status, "complete");
  const rows = sqlite.prepare("SELECT role, content, vault_ref FROM messages WHERE discussion_id = ? ORDER BY rowid").all(caught.discussionId) as Array<{ role: string; content: string; vault_ref: string }>;
  assert.deepEqual(rows.map((r) => [r.role, r.content, r.vault_ref]), [["user", "Quand part le train ?", "q1"], ["assistant", "À 8 h 12.", "q1#reply"]]);
  // Twice: nothing added.
  assert.equal((await service.ensureConversation(VAULT_ID, ["q1"], 2000)).status, "complete");
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM messages WHERE discussion_id = ?").get(caught.discussionId) as { n: number }).n, 2);
  // The Desktop seals its own turns (recordLocalTurn): not here as well;
  // nor the titles the model writes (its conversation sync does).
  assert.equal((await service.sealAnsweredTurn(caught.discussionId!, "q1")).sealed, false);
  assert.equal((await service.sealDiscussionTitle(caught.discussionId!, "Train de 8 h 12")).sealed, false);
  assert.deepEqual(vaultFiles(), []);
});

test("keys given as bytes are taken too; a hand-over without keys takes the vault back", () => {
  assert.equal(service.setDesktopVault({ type: "vault", deviceId: desktop.id, userId: USER_ID, keys: { ...desktop.keys }, epochs: new Map([[1, phone.epochs.get(1)!]]) }), true);
  assert.equal(service.vaultEpochKeys().size, 1);
  assert.equal(service.setDesktopVault({ type: "vault", deviceId: desktop.id, keys: { encPrivate: "zz" }, epochs: {} }), false);
  assert.equal(service.setDesktopVault({ type: "vault", keys: null }), false);
  assert.equal(service.vaultMode(), "off");
  assert.equal(service.vaultEpochKeys().size, 0);
  assert.equal(service.vaultIdentity(), null);
  assert.deepEqual(vaultFiles(), []);
});
