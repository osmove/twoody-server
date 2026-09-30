import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The first anchor of a computer freshly linked with the one-time secret
// (sessionTrust.ts firstAnchorStatement). Jimmy's Pi, 30 Sept.: linked from
// his iPhone, whose tunnel key account.json pins as approver, it refused
// both the iPhone's device-access (checked against a roster still empty)
// and its anchor (no device-access kept): neither could come first. Now,
// while no anchor exists, the approver device's own statement, signed by
// the vault key it names, founds the first one — never a peer's, a
// console-approved session's, another key's, nor once an anchor exists.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-first-anchor-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
const { buildApp } = await import("../src/app.js");
const { setBackendFetch, backendCall } = await import("../src/account/backend.js");
const { writeAccountFile, readAccountFile } = await import("../src/account/store.js");
const { newPairingKey } = await import("../src/account/keys.js");
const { judge } = await import("../src/account/approvals.js");
const { pairDevice } = await import("../src/pairing.js");
const crypto = await import("../src/vault/crypto.js");
const { signApprovalV2, signBinding, signDeviceAccessV2 } = await import("../src/vault/contracts.js");
const service = await import("../src/vault/service.js");
const { meshRoster } = await import("../src/vault/roster.js");
const { fakeVaultBackend } = await import("./helpers/fakeVault.js");

const USER_ID = 42;
const PI = "9f3d5b72-4c6e-4a8f-8b2d-3e5f7a9b1c22";
const MAC = "4b7e2d19-8c3a-4f6e-9d1b-5a2c8e0f7d33";
const BACKEND = "https://account.test";
const fake = fakeVaultBackend({ userId: USER_ID, computers: [PI, MAC] });
setBackendFetch(fake.fetch as typeof fetch);

// The iPhone's tunnel key: the one that approved the login, with the secret.
const phoneKey = randomBytes(32).toString("hex");
const pairing = newPairingKey();
const approvers = [{ public_key: phoneKey, kind: "phone" as const, name: "iPhone" }];
writeAccountFile({
  backend_url: BACKEND, account_id: USER_ID, user_token: fake.serverSession(PI), device_token: "pi-device-token",
  computer: { id: PI, credential: "pi-credential", name: "twoody-pi-trixie" }, pairing_key: pairing, approvers,
});

const app = await buildApp();
test.after(() => app.close());
const vaultService = service.startVaultService({ firstTickMs: 3_600_000, intervalMs: 3_600_000 });
test.after(() => vaultService.stop());

const post = (path: string, body: unknown) => backendCall({ backendUrl: BACKEND, userToken: fake.personSession() }, path, { body }).then((r) => r.body as Record<string, any>);
const phone = { keys: crypto.createDeviceKeys(), id: "", epochs: new Map<number, Uint8Array>() };
const sealedFrom = (key: string) => ({ "x-twoody-via-tunnel": "relay", "x-twoody-tunnel-peer": key });
const accessFor = (tunnelKey: string, { signer = phone.keys, id = () => phone.id, computer = PI } = {}) => {
  const access = { vault_device_id: id(), tunnel_public_key: tunnelKey, account_computer_id: computer, exp: Math.floor(Date.now() / 1000) + 23 * 3600 };
  return { ...access, signature: signDeviceAccessV2({ userId: USER_ID, access, signPrivate: signer.signPrivate }) };
};
const anchorBody = (extra: Record<string, unknown> = {}) => ({ vault_device_id: phone.id, sign_public: crypto.toHex(phone.keys.signPublic), ...extra });
const pin = (headers: Record<string, string>, extra: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", url: "/api/v1/peer/vault/anchor", headers, payload: anchorBody(extra) });
const renew = (headers: Record<string, string>, body: unknown) => app.inject({ method: "POST", url: "/api/v1/session/device-access", headers, payload: body as object });

/// The session the account's approval gives the iPhone (approvals.ts
/// approveRequest): rule 1, no device-access carried — as on the Pi.
const verdict = judge(
  { id: "req-1", name: "iPhone", public_key: phoneKey, expires_at: new Date(Date.now() + 60_000).toISOString(), role: "device", endorsements: [], requester_kind: null, requester_computer_id: null, device_access: null },
  readAccountFile()!,
);
assert.deepEqual(verdict, { approve: true, rule: "approver" });
const phoneSession = pairDevice({ deviceName: "iPhone", tunnelPublicKey: phoneKey, origin: "account", approvalRule: "approver" });
const phoneHeaders = { authorization: `Bearer ${phoneSession.token}`, ...sealedFrom(phoneKey) };

test("the iPhone founds the history; the Pi registers, pending, with no anchor", async () => {
  const founded = await post("vault/devices", { label: "iPhone", enc_public: crypto.toHex(phone.keys.encPublic), sign_public: crypto.toHex(phone.keys.signPublic) });
  phone.id = founded.device.id;
  phone.epochs.set(1, crypto.createEpochKey());
  await post("vault/envelopes", { envelopes: [crypto.wrapEpochKey({ epochKey: phone.epochs.get(1)!, epoch: 1, userId: USER_ID, to: { deviceId: phone.id, encPublic: phone.keys.encPublic }, from: { deviceId: phone.id, signPrivate: phone.keys.signPrivate } })] });
  await post(`vault/devices/${phone.id}/approval`, { approver_id: phone.id, signature: signApprovalV2({ userId: USER_ID, device: founded.device, approverId: phone.id, kind: "person", signPrivate: phone.keys.signPrivate }) });
  assert.equal((await vaultService.tick()).status, "pending");
  assert.deepEqual(service.vaultAnchorsHeld(), []);
});

test("before the first anchor, no one else founds it", async () => {
  // Another device's key, even let in as rule 1: not a pinned approver.
  const otherKey = randomBytes(32).toString("hex");
  const other = pairDevice({ deviceName: "Autre", tunnelPublicKey: otherKey, origin: "account", approvalRule: "approver" });
  const otherHeaders = { authorization: `Bearer ${other.token}`, ...sealedFrom(otherKey) };
  assert.deepEqual((await renew(otherHeaders, accessFor(otherKey))).json(), { error: "not_a_person_device" });
  assert.deepEqual((await pin(otherHeaders, { device_access: accessFor(otherKey) })).json(), { error: "anchor_not_allowed" });

  // Keys pinned as approvers, but let in by the console, or a peer's.
  const consoleKey = randomBytes(32).toString("hex");
  const peerKey = randomBytes(32).toString("hex");
  writeAccountFile({ ...readAccountFile()!, approvers: [...approvers, { public_key: consoleKey, kind: "phone", name: "x" }, { public_key: peerKey, kind: "computer", name: "y" }] });
  const consoled = pairDevice({ deviceName: "iPhone (console)", tunnelPublicKey: consoleKey, origin: "account", approvalRule: "console" });
  const consoledHeaders = { authorization: `Bearer ${consoled.token}`, ...sealedFrom(consoleKey) };
  assert.deepEqual((await renew(consoledHeaders, accessFor(consoleKey))).json(), { error: "not_a_person_device" });
  assert.deepEqual((await pin(consoledHeaders, { device_access: accessFor(consoleKey) })).json(), { error: "anchor_not_allowed" });
  // A peer (a Desktop's embedded server, rule 1): no_anchor_yet.
  const peer = pairDevice({ deviceName: "MacBook Air", tunnelPublicKey: peerKey, role: "peer", origin: "account", requesterComputerId: MAC, approvalRule: "approver" });
  const peerHeaders = { authorization: `Bearer ${peer.token}`, ...sealedFrom(peerKey) };
  assert.deepEqual((await pin(peerHeaders, { device_access: accessFor(peerKey) })).json(), { error: "no_anchor_yet" });
  assert.equal((await renew(peerHeaders, accessFor(peerKey))).json().error, "peer_session_forbidden");
  writeAccountFile({ ...readAccountFile()!, approvers });

  // The iPhone's session itself, but: not through the tunnel from its key,
  // a statement for another key, another computer, or signed by another key.
  const stranger = crypto.createDeviceKeys();
  assert.equal((await pin({ authorization: `Bearer ${phoneSession.token}`, ...sealedFrom(randomBytes(32).toString("hex")) }, { device_access: accessFor(phoneKey) })).json().error, "anchor_not_allowed");
  assert.equal((await pin(phoneHeaders, { device_access: accessFor(randomBytes(32).toString("hex")) })).json().error, "anchor_not_allowed");
  assert.equal((await pin(phoneHeaders, { device_access: accessFor(phoneKey, { computer: MAC }) })).json().error, "anchor_not_allowed");
  assert.equal((await pin(phoneHeaders, { device_access: accessFor(phoneKey, { signer: stranger }) })).json().error, "anchor_not_allowed");
  assert.equal((await renew(phoneHeaders, accessFor(phoneKey, { signer: stranger }))).json().error, "not_a_person_device");

  // The approver no longer pinned: approver_not_pinned, and nothing taken.
  writeAccountFile({ ...readAccountFile()!, approvers: [] });
  assert.deepEqual((await renew(phoneHeaders, accessFor(phoneKey))).json(), { error: "approver_not_pinned" });
  assert.deepEqual((await pin(phoneHeaders, { device_access: accessFor(phoneKey) })).json(), { error: "approver_not_pinned" });
  writeAccountFile({ ...readAccountFile()!, approvers });

  assert.deepEqual(service.vaultAnchorsHeld(), []);
});

test("the iPhone renews its device-access, then anchors itself: the roster holds it", async () => {
  const renewed = await renew(phoneHeaders, accessFor(phoneKey));
  assert.equal(renewed.statusCode, 200, renewed.body);
  assert.equal(renewed.json().vault_device_id, phone.id);
  // As the app does it today: the anchor alone, after the renewal.
  const pinned = await pin(phoneHeaders);
  assert.equal(pinned.statusCode, 200, pinned.body);
  assert.deepEqual(pinned.json(), { anchors: 1, pinned: true });
  assert.deepEqual(service.vaultAnchorsHeld(), [{ id: phone.id, sign_public: crypto.toHex(phone.keys.signPublic) }]);
  const roster = await meshRoster().refresh();
  assert.ok(roster?.persons.has(phone.id));
  // Renewed against the roster from now on.
  assert.equal((await renew(phoneHeaders, accessFor(phoneKey))).statusCode, 200);
});

test("« Faire confiance » completes: approval v2, binding, envelopes; the Pi takes its keys", async () => {
  const identity = (await app.inject({ url: "/api/v1/peer/vault/identity", headers: phoneHeaders })).json();
  const device = { id: identity.vault_device_id, enc_public: identity.enc_public, sign_public: identity.sign_public };
  const bound = { vault_device_id: device.id, account_computer_id: identity.account_computer_id, tunnel_public_key: identity.tunnel_public_key, pairing_public_key: identity.pairing_public_key, can_approve: false };
  const binding = JSON.stringify({ ...bound, approver_id: phone.id, signature: signBinding({ userId: USER_ID, binding: bound, signPrivate: phone.keys.signPrivate }) });
  const signature = signApprovalV2({ userId: USER_ID, device, approverId: phone.id, kind: "computer", accountComputerId: identity.account_computer_id, signPrivate: phone.keys.signPrivate });
  await post(`vault/devices/${device.id}/approval`, { approver_id: phone.id, signature, binding });
  await post("vault/envelopes", { envelopes: [...phone.epochs].map(([epoch, epochKey]) => crypto.wrapEpochKey({ epochKey, epoch, userId: USER_ID, to: { deviceId: device.id, encPublic: crypto.fromHex(device.enc_public) }, from: { deviceId: phone.id, signPrivate: phone.keys.signPrivate } })) });
  assert.equal((await vaultService.tick()).status, "trusted");
  assert.equal(service.vaultEpochKeys().size, 1);
});

test("once an anchor exists, no second device founds anything", async () => {
  // A second phone, its key pinned as approver too, a member of the vault.
  const second = { keys: crypto.createDeviceKeys(), key: randomBytes(32).toString("hex"), id: "" };
  writeAccountFile({ ...readAccountFile()!, approvers: [...approvers, { public_key: second.key, kind: "phone", name: "iPad" }] });
  const registered = await post("vault/devices", { label: "iPad", enc_public: crypto.toHex(second.keys.encPublic), sign_public: crypto.toHex(second.keys.signPublic) });
  second.id = registered.device.id;
  const session = pairDevice({ deviceName: "iPad", tunnelPublicKey: second.key, origin: "account", approvalRule: "approver" });
  const headers = { authorization: `Bearer ${session.token}`, ...sealedFrom(second.key) };
  const access = accessFor(second.key, { signer: second.keys, id: () => second.id });
  assert.deepEqual((await renew(headers, access)).json(), { error: "not_a_person_device" });
  const refused = await app.inject({ method: "POST", url: "/api/v1/peer/vault/anchor", headers, payload: { vault_device_id: second.id, sign_public: crypto.toHex(second.keys.signPublic), device_access: access } });
  assert.equal(refused.statusCode, 403);
  assert.deepEqual(service.vaultAnchorsHeld()?.map((a) => a.id), [phone.id]);
});
