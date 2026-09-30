import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A computer linked before the one-time secret (account/link.ts
// approverProved) pinned no approver key: with no anchor yet, no phone's
// session can name its first one, nor renew a device-access. Both routes
// say so (approver_not_pinned), for the phone and the Desktop to tell the
// person to link it again, instead of a bare refusal.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-approver-not-pinned-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
const { buildApp } = await import("../src/app.js");
const { setBackendFetch, backendCall } = await import("../src/account/backend.js");
const { writeAccountFile, readAccountFile } = await import("../src/account/store.js");
const { newPairingKey } = await import("../src/account/keys.js");
const { pairDevice } = await import("../src/pairing.js");
const crypto = await import("../src/vault/crypto.js");
const { signApprovalV2, signDeviceAccessV2 } = await import("../src/vault/contracts.js");
const service = await import("../src/vault/service.js");
const { fakeVaultBackend } = await import("./helpers/fakeVault.js");

const USER_ID = 42;
const PI = "9f3d5b72-4c6e-4a8f-8b2d-3e5f7a9b1c22";
const MAC = "4b7e2d19-8c3a-4f6e-9d1b-5a2c8e0f7d33";
const BACKEND = "https://account.test";
const fake = fakeVaultBackend({ userId: USER_ID, computers: [PI] });
setBackendFetch(fake.fetch as typeof fetch);

// Linked before the one-time secret: no approver pinned.
writeAccountFile({
  backend_url: BACKEND, account_id: USER_ID, user_token: fake.serverSession(PI), device_token: "pi-device-token",
  computer: { id: PI, credential: "pi-credential", name: "twoody-pi-trixie" }, pairing_key: newPairingKey(),
  approvers: [],
});

const app = await buildApp();
test.after(() => app.close());
const vaultService = service.startVaultService({ firstTickMs: 3_600_000, intervalMs: 3_600_000 });
test.after(() => vaultService.stop());

const post = (path: string, body: unknown) => backendCall({ backendUrl: BACKEND, userToken: fake.personSession() }, path, { body }).then((r) => r.body as Record<string, any>);
const phone = { keys: crypto.createDeviceKeys(), id: "" };
const sealedFrom = (key: string) => ({ "x-twoody-via-tunnel": "relay", "x-twoody-tunnel-peer": key });
const accessFor = (tunnelKey: string) => {
  const access = { vault_device_id: phone.id, tunnel_public_key: tunnelKey, account_computer_id: PI, exp: Math.floor(Date.now() / 1000) + 600 };
  return { ...access, signature: signDeviceAccessV2({ userId: USER_ID, access, signPrivate: phone.keys.signPrivate }) };
};
const pin = (headers: Record<string, string>) =>
  app.inject({ method: "POST", url: "/api/v1/peer/vault/anchor", headers, payload: { vault_device_id: phone.id, sign_public: crypto.toHex(phone.keys.signPublic) } });

test("the iPhone founds the history; the Pi registers, pending, with no anchor", async () => {
  const founded = await post("vault/devices", { label: "iPhone", enc_public: crypto.toHex(phone.keys.encPublic), sign_public: crypto.toHex(phone.keys.signPublic) });
  phone.id = founded.device.id;
  await post(`vault/devices/${phone.id}/approval`, { approver_id: phone.id, signature: signApprovalV2({ userId: USER_ID, device: founded.device, approverId: phone.id, kind: "person", signPrivate: phone.keys.signPrivate }) });
  assert.equal((await vaultService.tick()).status, "pending");
});

test("linked before the one-time secret: the phone and the Desktop are told approver_not_pinned, on both routes", async () => {
  const key = randomBytes(32).toString("hex");
  const byCode = pairDevice({ deviceName: "iPhone", tunnelPublicKey: key, origin: "code" });
  const headers = { authorization: `Bearer ${byCode.token}`, ...sealedFrom(key) };
  const anchor = await pin(headers);
  assert.equal(anchor.statusCode, 403);
  assert.deepEqual(anchor.json(), { error: "approver_not_pinned" });
  const renewed = await app.inject({ method: "POST", url: "/api/v1/session/device-access", headers, payload: accessFor(key) });
  assert.equal(renewed.statusCode, 403);
  assert.deepEqual(renewed.json(), { error: "approver_not_pinned" });
  // A Desktop's embedded server, as its computer: the same words.
  const desktopKey = randomBytes(32).toString("hex");
  const desktop = pairDevice({ deviceName: "MacBook Air", tunnelPublicKey: desktopKey, role: "peer", origin: "account", requesterComputerId: MAC, approvalRule: "endorsed" });
  assert.deepEqual((await pin({ authorization: `Bearer ${desktop.token}`, ...sealedFrom(desktopKey) })).json(), { error: "approver_not_pinned" });

  // Linked again with the secret, an approver is pinned: the refusals read as before.
  writeAccountFile({ ...readAccountFile()!, approvers: [{ public_key: randomBytes(32).toString("hex"), kind: "phone", name: "iPhone" }] });
  assert.deepEqual((await pin(headers)).json(), { error: "anchor_not_allowed" });
  assert.deepEqual((await app.inject({ method: "POST", url: "/api/v1/session/device-access", headers, payload: accessFor(key) })).json(), { error: "not_a_person_device" });
  assert.deepEqual((await pin({ authorization: `Bearer ${desktop.token}`, ...sealedFrom(desktopKey) })).json(), { error: "no_anchor_yet" });
});
