import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A headless computer (a Pi) as a member of the person's encrypted history
// (docs/mesh-design.md §1, §3, lot S1), against a stand-in for the account
// that keeps twoody-backend's B1 rules: it registers as a computer device,
// shows its keys over the tunnel only, takes its keys from the iPhone that
// approved and bound it — never from a device that may not approve — then
// brings the history into its discussions, seals its own turns, catches
// up on demand, and forgets everything once removed.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-vault-computer-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { sqlite } = await import("../src/db.js");
const { setBackendFetch } = await import("../src/account/backend.js");
const { writeAccountFile } = await import("../src/account/store.js");
const { newPairingKey } = await import("../src/account/keys.js");
const { tunnelIdentity } = await import("../src/tunnel/identity.js");
const crypto = await import("../src/vault/crypto.js");
const { signBinding } = await import("../src/vault/contracts.js");
const client = await import("../src/vault/client.js");
const { createVaultSync } = await import("../src/vault/sync.js");
const { memoryStore } = await import("../src/vault/store.js");
const service = await import("../src/vault/service.js");
const { fakeVaultBackend } = await import("./helpers/fakeVault.js");

const USER_ID = 42;
const PI = "9f3d5b72-4c6e-4a8f-8b2d-3e5f7a9b1c22";
const MAC = "8e2c4a61-3b5d-4f7e-9a1c-2d4e6f8a0b11";
const BACKEND = "https://account.test";
const fake = fakeVaultBackend({ userId: USER_ID, computers: [PI, MAC] });
setBackendFetch(fake.fetch);

const pairing = newPairingKey();
writeAccountFile({
  backend_url: BACKEND, account_id: USER_ID, user_token: fake.serverSession(PI), device_token: "pi-device-token",
  computer: { id: PI, credential: "pi-credential", name: "Pi du salon" }, pairing_key: pairing, approvers: [],
});

const app = await buildApp();
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "iPhone" } });
const owner = paired.json().user_id as string;
const local = { authorization: `Bearer ${paired.json().token}` };

/// The iPhone: a person device with its own session, founding the vault.
const phoneCreds = { backendUrl: BACKEND, userToken: fake.personSession() };
const phoneApi = client.accountVaultApi(() => phoneCreds);
const phone = { keys: crypto.createDeviceKeys(), id: "", epochs: new Map<number, Uint8Array>() };
const { backendCall } = await import("../src/account/backend.js");
const post = (path: string, body: unknown) => backendCall(phoneCreds, path, { body }).then((r) => r.body as Record<string, any>);
const phoneSync = createVaultSync({ api: phoneApi, epochKeys: () => phone.epochs, userId: USER_ID, store: memoryStore() });
const VAULT_ID = "5f0c2a4e-8b1d-4c3e-9a7f-2d6e1b0c9a8f";

const vaultService = service.startVaultService({ firstTickMs: 3_600_000, intervalMs: 3_600_000 });
test.after(() => vaultService.stop());

test("the iPhone founds the history; the Pi waits, then registers as a computer device", async () => {
  // Before anyone founded it: the Pi never does.
  assert.equal((await vaultService.tick()).status, "none");
  assert.equal(fake.devices.length, 0);

  const founded = await post("vault/devices", { label: "iPhone", enc_public: crypto.toHex(phone.keys.encPublic), sign_public: crypto.toHex(phone.keys.signPublic) });
  assert.equal(founded.founding, true);
  phone.id = founded.device.id;
  phone.epochs.set(1, crypto.createEpochKey());
  await post("vault/envelopes", { envelopes: [crypto.wrapEpochKey({ epochKey: phone.epochs.get(1)!, epoch: 1, userId: USER_ID, to: { deviceId: phone.id, encPublic: phone.keys.encPublic }, from: { deviceId: phone.id, signPrivate: phone.keys.signPrivate } })] });
  await post(`vault/devices/${phone.id}/approval`, { approver_id: phone.id, signature: crypto.signApproval({ userId: USER_ID, device: founded.device, approverId: phone.id, signPrivate: phone.keys.signPrivate }) });

  assert.equal((await vaultService.tick()).status, "pending");
  const pi = fake.devices.find((d) => d.kind === "computer")!;
  assert.deepEqual([pi.account_computer_id, pi.status, pi.label], [PI, "pending", "Pi du salon"]);
  // The keys were on disk, 0600, before the account heard of them.
  const path = service.vaultKeysPath();
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual([saved.deviceId, saved.signPublic, saved.userId, saved.accountComputerId], [pi.id, pi.sign_public, "42", PI]);
  // Not trusted yet: the account keeps the events from it.
  await assert.rejects(backendCall({ backendUrl: BACKEND, userToken: readAccountToken() }, "vault/events"), /403/);
  // Ticking again registers nothing more.
  await vaultService.tick();
  assert.equal(fake.devices.filter((d) => d.kind === "computer").length, 1);
});

function readAccountToken(): string {
  return JSON.parse(readFileSync(join(process.env.TWOODY_DATA_DIR!, "account.json"), "utf8")).user_token;
}

test("its vault keys are read through the tunnel only, public halves only", async () => {
  const outside = await app.inject({ url: "/api/v1/peer/vault/identity", headers: local });
  assert.equal(outside.statusCode, 403);
  assert.equal(outside.json().error, "pinned_channel_required");
  assert.equal((await app.inject({ url: "/api/v1/peer/vault/identity", headers: { "x-twoody-via-tunnel": "relay" } })).statusCode, 401);
  // The tunnel's marker typed by someone on the network: not the tunnel.
  const forged = await app.inject({ url: "/api/v1/peer/vault/identity", headers: { ...local, "x-twoody-via-tunnel": "relay" }, remoteAddress: "192.168.1.20" });
  assert.equal(forged.statusCode, 403);
  const proxied = await app.inject({ url: "/api/v1/peer/vault/identity", headers: { ...local, "x-twoody-via-tunnel": "relay", "x-forwarded-for": "192.168.1.20" } });
  assert.equal(proxied.statusCode, 403);

  const shown = await app.inject({ url: "/api/v1/peer/vault/identity", headers: { ...local, "x-twoody-via-tunnel": "relay" } });
  assert.equal(shown.statusCode, 200);
  const identity = shown.json();
  const pi = fake.devices.find((d) => d.kind === "computer")!;
  assert.deepEqual(
    [identity.vault_device_id, identity.enc_public, identity.sign_public, identity.kind, identity.account_computer_id, identity.can_approve, identity.custody],
    [pi.id, pi.enc_public, pi.sign_public, "computer", PI, false, "server"],
  );
  assert.equal(identity.fingerprint, crypto.fingerprint(crypto.fromHex(pi.enc_public), crypto.fromHex(pi.sign_public)));
  assert.equal(identity.tunnel_public_key, tunnelIdentity().publicKey.toString("hex"));
  assert.equal(identity.pairing_public_key, pairing.pub);
  assert.doesNotMatch(shown.body, /Private|private/);
});

/// What « Faire confiance à cet ordinateur » does on the iPhone, from the
/// identity read over the tunnel: approval, binding (can_approve=false),
/// the epoch keys.
async function phoneTrusts(identity: Record<string, any>, { pin = true } = {}) {
  if (pin) {
    const pinned = await app.inject({ method: "POST", url: "/api/v1/peer/vault/anchor", headers: { ...local, "x-twoody-via-tunnel": "relay" }, payload: { vault_device_id: phone.id, sign_public: crypto.toHex(phone.keys.signPublic) } });
    assert.equal(pinned.statusCode, 200, pinned.body);
  }
  const device = { id: identity.vault_device_id, enc_public: identity.enc_public, sign_public: identity.sign_public };
  const bound = { vault_device_id: device.id, account_computer_id: identity.account_computer_id, tunnel_public_key: identity.tunnel_public_key, pairing_public_key: identity.pairing_public_key, can_approve: false };
  const binding = JSON.stringify({ ...bound, approver_id: phone.id, signature: signBinding({ userId: USER_ID, binding: bound, signPrivate: phone.keys.signPrivate }) });
  await post(`vault/devices/${device.id}/approval`, { approver_id: phone.id, signature: crypto.signApproval({ userId: USER_ID, device, approverId: phone.id, signPrivate: phone.keys.signPrivate }), binding });
  await post("vault/envelopes", { envelopes: [...phone.epochs].map(([epoch, epochKey]) => crypto.wrapEpochKey({ epochKey, epoch, userId: USER_ID, to: { deviceId: device.id, encPublic: crypto.fromHex(device.enc_public) }, from: { deviceId: phone.id, signPrivate: phone.keys.signPrivate } })) });
}

const identityNow = async () => (await app.inject({ url: "/api/v1/peer/vault/identity", headers: { ...local, "x-twoody-via-tunnel": "direct" } })).json();

test("approved and bound by the iPhone, the Pi takes its keys once the iPhone is pinned over the tunnel", async () => {
  // Approved, but nobody named itself over the tunnel: the Pi takes nothing.
  await phoneTrusts(await identityNow(), { pin: false });
  assert.equal((await vaultService.tick()).status, "pending");
  assert.equal(service.vaultEpochKeys().size, 0);
  // Pinning is for the tunnel only, and for a well-formed person device.
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/peer/vault/anchor", headers: local, payload: { vault_device_id: phone.id, sign_public: crypto.toHex(phone.keys.signPublic) } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/peer/vault/anchor", headers: { ...local, "x-twoody-via-tunnel": "relay" }, payload: { vault_device_id: "nope", sign_public: crypto.toHex(phone.keys.signPublic) } })).statusCode, 422);

  await phoneTrusts(await identityNow());
  assert.equal((await vaultService.tick()).status, "trusted");
  assert.equal(service.vaultEpochKeys().get(1)?.length, 32);
  assert.deepEqual(service.vaultEpochKeys().get(1), phone.epochs.get(1));
  assert.equal((await identityNow()).status, "trusted");
  const verify = client.createComputerVaultClient({ api: client.accountVaultApi(() => ({ backendUrl: BACKEND, userToken: readAccountToken() })), store: client.fileKeyStore(service.vaultKeysPath()), userId: USER_ID, accountComputerId: PI });
  const status = await verify.status();
  assert.equal(status.status, "trusted");
  assert.equal(status.binding, "valid");
});

test("the history comes into the Pi's discussions, once however often it syncs", async () => {
  await phoneSync.recordTurn(VAULT_ID, { ref: "r1", text: "Résume mon CV", reply: "Product Owner", model: "qwen3", created_at: "2026-09-30T09:00:00.000Z" });
  await phoneSync.recordTitle(VAULT_ID, "Mon CV");
  await phoneSync.flush();

  await vaultService.tick();
  const count = () => (sqlite.prepare("SELECT COUNT(*) AS n FROM messages m JOIN discussions d ON d.id = m.discussion_id WHERE d.vault_id = ?").get(VAULT_ID) as { n: number }).n;
  const discussion = sqlite.prepare("SELECT id, title, user_id FROM discussions WHERE vault_id = ?").get(VAULT_ID) as { id: string; title: string; user_id: string };
  assert.deepEqual([discussion.title, discussion.user_id, count()], ["Mon CV", owner, 2]);

  // Again, and after a restart (the pull cursor on disk, the counts gone):
  // nothing added twice.
  await vaultService.tick();
  service.resetVaultForTests();
  const again = service.startVaultService({ firstTickMs: 3_600_000, intervalMs: 3_600_000 });
  try {
    assert.equal((await again.tick()).status, "trusted");
  } finally {
    again.stop();
  }
  assert.equal(count(), 2);
  assert.equal(statSync(service.vaultHistoryPath()).mode & 0o777, 0o600);
  const shown = (await app.inject({ url: `/discussions/${discussion.id}`, headers: local })).json();
  assert.deepEqual(shown.messages.map((m: { content: string }) => m.content), ["Résume mon CV", "Product Owner"]);
  // A new service for the rest of the file.
  vaultService.stop();
  Object.assign(vaultService, service.startVaultService({ firstTickMs: 3_600_000, intervalMs: 3_600_000 }));
  await vaultService.tick();
});

test("a turn the Pi answers is sealed for the iPhone, with who answered and no path", async () => {
  const discussion = (sqlite.prepare("SELECT id FROM discussions WHERE vault_id = ?").get(VAULT_ID) as { id: string }).id;
  const at = Math.floor(Date.parse("2026-09-30T09:05:00Z") / 1000);
  const insert = sqlite.prepare("INSERT INTO messages (id, discussion_id, user_id, role, content, provider, model, vault_ref, created_at, sources_json, answered_by_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  insert.run("q2", discussion, owner, "user", "Et mon contrat ?", null, null, "r2", at, null, null);
  insert.run("a2", discussion, owner, "assistant", "Il finit en mars [1].", "builtin", "qwen3", "r2#reply", at,
    JSON.stringify([{ n: 1, document_id: "doc-7", name: "contrat.pdf", path: "/home/pi/Documents/contrat.pdf", page: 2, snippet: "jusqu'au 31 mars" }]),
    JSON.stringify({ computer_id: PI, computer_name: "Pi du salon", model: "qwen3", routed: "auto", auto: true }));

  const sealed = await service.sealAnsweredTurn(discussion, "r2");
  assert.equal(sealed.sealed, true);
  assert.equal("pending" in sealed && sealed.pending, 0, "sent at once");

  await phoneSync.pull();
  const turns = await phoneSync.conversation(VAULT_ID);
  const r2 = turns.find((t) => t.ref === "r2")!;
  assert.deepEqual([r2.text, r2.reply, r2.model, r2.host], ["Et mon contrat ?", "Il finit en mars [1].", "qwen3", "Pi du salon"]);
  assert.deepEqual(r2.answered_by, { computer_id: PI, computer_name: "Pi du salon", model: "qwen3", routed: "auto", auto: true });
  assert.deepEqual(r2.sources, [{ n: 1, document_id: "doc-7", name: "contrat.pdf", page: 2, snippet: "jusqu'au 31 mars", computer_id: PI }]);
  assert.doesNotMatch(JSON.stringify(turns), /\/home\/pi/);
  // On the account: ciphertext only.
  assert.doesNotMatch(JSON.stringify(fake.events), /contrat|Pi du salon/);

  // Not synchronised, or not answered: nothing sealed.
  assert.equal((await service.sealAnsweredTurn(discussion, "nope")).sealed, false);
  assert.equal((await service.sealAnsweredTurn(discussion, null)).sealed, false);
});

test("catch-up: a question naming turns the Pi has not seen pulls them first", async () => {
  await phoneSync.recordTurn(VAULT_ID, { ref: "r3", text: "Et la période d'essai ?", reply: "Trois mois.", created_at: "2026-09-30T09:10:00.000Z" });
  await phoneSync.flush();
  const caught = await service.ensureConversation(VAULT_ID, ["r1", "r2", "r3"], 2000);
  assert.equal(caught.status, "complete");
  assert.deepEqual(caught.missing, []);
  const history = sqlite.prepare("SELECT content FROM messages WHERE discussion_id = ? ORDER BY created_at, rowid").all(caught.discussionId) as Array<{ content: string }>;
  assert.deepEqual(history.map((m) => m.content).slice(-2), ["Et la période d'essai ?", "Trois mois."]);

  const missing = await service.ensureConversation(VAULT_ID, ["r3", "r9"], 500);
  assert.deepEqual([missing.status, missing.missing], ["missing", ["r9"]]);
  const unknown = await service.ensureConversation("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", ["x"], 500);
  assert.deepEqual([unknown.status, unknown.discussionId], ["missing", null]);
  await assert.rejects(service.ensureConversation("not-a-uuid", [], 10), /bad_conversation_id/);
});

test("a conversation deleted on the iPhone goes from the Pi", async () => {
  await phoneSync.deleteConversation(VAULT_ID);
  await phoneSync.flush();
  await vaultService.tick();
  assert.equal(sqlite.prepare("SELECT id FROM discussions WHERE vault_id = ?").get(VAULT_ID), undefined);
});

test("keys only from a person device: a computer that may not approve is refused", async () => {
  // The Mac mini, enrolled as a computer and bound can_approve=false by the
  // iPhone, then given the keys — as a compromised Pi or Mac would try to
  // pass them on.
  const mac = { keys: crypto.createDeviceKeys() };
  const macSession = { backendUrl: BACKEND, userToken: fake.serverSession(MAC) };
  const created = (await backendCall(macSession, "vault/devices", { body: { label: "Mac mini", enc_public: crypto.toHex(mac.keys.encPublic), sign_public: crypto.toHex(mac.keys.signPublic), kind: "computer", account_computer_id: MAC } })).body as Record<string, any>;
  await phoneTrusts({ vault_device_id: created.device.id, enc_public: created.device.enc_public, sign_public: created.device.sign_public, account_computer_id: MAC, tunnel_public_key: "11".repeat(32), pairing_public_key: "22".repeat(32) });

  const devices = (await phoneApi.state()).devices!;
  const byId = new Map(devices.map((d) => [d.id, d]));
  const macDevice = byId.get(created.device.id)!;
  const piDevice = devices.find((d) => d.account_computer_id === PI && d.status !== "revoked")!;
  assert.equal(client.mayApprove(USER_ID, byId.get(phone.id), byId), true);
  assert.equal(client.mayApprove(USER_ID, macDevice, byId), false, "binding says can_approve=false");
  assert.equal(client.mayApprove(USER_ID, { ...macDevice, binding: null }, byId), false, "a computer without a binding");
  // A binding turned to can_approve=true without the iPhone's signature.
  const forged = { ...JSON.parse(macDevice.binding as string), can_approve: true };
  assert.equal(client.mayApprove(USER_ID, { ...macDevice, binding: JSON.stringify(forged) }, byId), false);
  // A Desktop someone sits at, bound can_approve=true by the iPhone: may.
  const bound = { ...forged, signature: undefined, approver_id: undefined };
  delete bound.signature;
  delete bound.approver_id;
  const signedTrue = { ...bound, approver_id: phone.id, signature: signBinding({ userId: USER_ID, binding: bound, signPrivate: phone.keys.signPrivate }) };
  assert.equal(client.mayApprove(USER_ID, { ...macDevice, binding: JSON.stringify(signedTrue) }, byId), true);
  // …but not when it binds itself.
  const selfSigned = { ...bound, approver_id: macDevice.id, signature: signBinding({ userId: USER_ID, binding: bound, signPrivate: mac.keys.signPrivate }) };
  assert.equal(client.mayApprove(USER_ID, { ...macDevice, binding: JSON.stringify(selfSigned) }, byId), false);

  // An envelope and an approval from the Mac, as a lying account would
  // pass them on: the Pi takes neither.
  const rogueKey = crypto.createEpochKey();
  const piLocal = client.fileKeyStore(service.vaultKeysPath()).read()!;
  const rogueEnvelope = crypto.wrapEpochKey({ epochKey: rogueKey, epoch: 2, userId: USER_ID, to: { deviceId: piDevice.id, encPublic: piLocal.keys.encPublic }, from: { deviceId: macDevice.id, signPrivate: mac.keys.signPrivate } });
  const anchors = piLocal.anchors;
  assert.deepEqual(anchors, [{ id: phone.id, sign_public: crypto.toHex(phone.keys.signPublic) }]);
  const signers = client.trustedSigners(USER_ID, devices, anchors);
  assert.deepEqual([...signers.keys()], [phone.id]);
  const lying: typeof client.accountVaultApi extends (...args: any[]) => infer R ? R : never = {
    ...phoneApi,
    state: async () => ({ devices, epoch: 2 }),
    envelopes: async () => ({ envelopes: [...fake.envelopes.filter((e) => e.to_device === piDevice.id), rogueEnvelope] }),
  };
  const piClient = client.createComputerVaultClient({ api: lying, store: client.memoryKeyStore(piLocal), userId: USER_ID, accountComputerId: PI });
  const taken = await piClient.checkApproval();
  assert.equal(taken.refused, 1);
  assert.deepEqual([...piClient.epochKeys().keys()], [1]);

  // An approval signed by the Mac links nobody.
  const stranger = { id: "7b1e2d3c-4a5b-4c6d-8e7f-9a0b1c2d3e4f", label: "?", enc_public: "33".repeat(32), sign_public: crypto.toHex(crypto.createDeviceKeys().signPublic), status: "trusted" as const, approved_at: "now", kind: "person" as const };
  const approvedByMac = { ...stranger, approval: { approver_id: macDevice.id, signature: crypto.signApproval({ userId: USER_ID, device: stranger, approverId: macDevice.id, signPrivate: mac.keys.signPrivate }) } };
  const verified = client.verifiedIds(USER_ID, [...devices, approvedByMac], anchors);
  assert.ok(verified.has(phone.id));
  assert.ok(verified.has(piDevice.id) && verified.has(macDevice.id), "computers the iPhone approved and bound");
  assert.ok(!verified.has(approvedByMac.id));
});

test("trust flows forward only: an approver the account invents is never reached", async () => {
  const devices = (await phoneApi.state()).devices!;
  const piLocal = client.fileKeyStore(service.vaultKeysPath()).read()!;
  const piDevice = devices.find((d) => d.account_computer_id === PI && d.status !== "revoked")!;
  const phoneDevice = devices.find((d) => d.id === phone.id)!;
  // The account invents X, self-approved like a founder, and swaps the
  // iPhone's own approval for one X signed (the iPhone's keys are public).
  const x = crypto.createDeviceKeys();
  const X = { id: "6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d", label: "iPhone", enc_public: crypto.toHex(x.encPublic), sign_public: crypto.toHex(x.signPublic), status: "trusted" as const, approved_at: "now", kind: "person" as const, approval: null as null | { approver_id: string; signature: string } };
  X.approval = { approver_id: X.id, signature: crypto.signApproval({ userId: USER_ID, device: X, approverId: X.id, signPrivate: x.signPrivate }) };
  const swapped = { ...phoneDevice, approval: { approver_id: X.id, signature: crypto.signApproval({ userId: USER_ID, device: phoneDevice, approverId: X.id, signPrivate: x.signPrivate }) } };
  const lied = [...devices.filter((d) => d.id !== phone.id), swapped, X];
  const verified = client.verifiedIds(USER_ID, lied, piLocal.anchors);
  assert.ok(verified.has(phone.id), "the pinned iPhone");
  assert.ok(!verified.has(X.id), "never reached backward from the iPhone");
  assert.deepEqual([...client.trustedSigners(USER_ID, lied, piLocal.anchors).keys()], [phone.id]);
  // X's key for a new epoch is refused.
  const rogue = crypto.wrapEpochKey({ epochKey: crypto.createEpochKey(), epoch: 2, userId: USER_ID, to: { deviceId: piDevice.id, encPublic: piLocal.keys.encPublic }, from: { deviceId: X.id, signPrivate: x.signPrivate } });
  const piClient = client.createComputerVaultClient({
    api: { ...phoneApi, state: async () => ({ devices: lied, epoch: 2 }), envelopes: async () => ({ envelopes: [rogue] }) },
    store: client.memoryKeyStore(piLocal), userId: USER_ID, accountComputerId: PI,
  });
  assert.equal((await piClient.checkApproval()).refused, 1);
  assert.deepEqual([...piClient.epochKeys().keys()], [1]);
  // An anchor whose key the account changed counts for nothing.
  const rekeyed = devices.map((d) => (d.id === phone.id ? { ...d, sign_public: X.sign_public } : d));
  assert.equal(client.verifiedIds(USER_ID, rekeyed, piLocal.anchors).size, 0);
  // A computer stripped of its kind, binding and account computer still
  // needs an approval from a reached device to be reached at all (v1
  // approvals do not commit to the kind: see the lot S1 report).
});

test("removed from the history, the Pi forgets what it opened and waits again", async () => {
  const piDevice = fake.devices.find((d) => d.account_computer_id === PI && d.status !== "revoked")!;
  const oldKeys = readFileSync(service.vaultKeysPath(), "utf8");
  await post(`vault/devices/${piDevice.id}/revoke`, {});
  assert.equal(fake.needsRotation, true);
  const after = await vaultService.tick();
  assert.equal(after.status, "pending");
  assert.equal(service.vaultEpochKeys().size, 0);
  assert.notEqual(readFileSync(service.vaultKeysPath(), "utf8"), oldKeys, "new keys");
  assert.ok(!existsSync(service.vaultHistoryPath()) || !/Trois mois/.test(readFileSync(service.vaultHistoryPath(), "utf8")));
  const fresh = fake.devices.filter((d) => d.account_computer_id === PI);
  assert.deepEqual(fresh.map((d) => d.status), ["revoked", "pending"]);
  // Pending: the account keeps the events from it.
  await assert.rejects(backendCall({ backendUrl: BACKEND, userToken: readAccountToken() }, "vault/events"), /403/);
});
