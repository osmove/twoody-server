import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The first anchor in one call (routes/peerVault.ts): the approver device
// of a computer freshly linked with the one-time secret sends its
// device-access/v2 with the anchor, as the app does since 0.2.32; the
// anchor is pinned and the session becomes that device together.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-first-anchor-atomic-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
const { buildApp } = await import("../src/app.js");
const { setBackendFetch, backendCall } = await import("../src/account/backend.js");
const { writeAccountFile } = await import("../src/account/store.js");
const { newPairingKey } = await import("../src/account/keys.js");
const { pairDevice } = await import("../src/pairing.js");
const { sessionRow } = await import("../src/sessionTrust.js");
const crypto = await import("../src/vault/crypto.js");
const { signApprovalV2, signDeviceAccessV2 } = await import("../src/vault/contracts.js");
const service = await import("../src/vault/service.js");
const { meshRoster } = await import("../src/vault/roster.js");
const { fakeVaultBackend } = await import("./helpers/fakeVault.js");

const USER_ID = 42;
const PI = "9f3d5b72-4c6e-4a8f-8b2d-3e5f7a9b1c22";
const BACKEND = "https://account.test";
const fake = fakeVaultBackend({ userId: USER_ID, computers: [PI] });
setBackendFetch(fake.fetch as typeof fetch);

const phoneKey = randomBytes(32).toString("hex");
writeAccountFile({
  backend_url: BACKEND, account_id: USER_ID, user_token: fake.serverSession(PI), device_token: "pi-device-token",
  computer: { id: PI, credential: "pi-credential", name: "twoody-pi-trixie" }, pairing_key: newPairingKey(),
  approvers: [{ public_key: phoneKey, kind: "phone", name: "iPhone" }],
});

const app = await buildApp();
test.after(() => app.close());
const vaultService = service.startVaultService({ firstTickMs: 3_600_000, intervalMs: 3_600_000 });
test.after(() => vaultService.stop());

const post = (path: string, body: unknown) => backendCall({ backendUrl: BACKEND, userToken: fake.personSession() }, path, { body }).then((r) => r.body as Record<string, any>);
const phone = { keys: crypto.createDeviceKeys(), id: "" };
const session = pairDevice({ deviceName: "iPhone", tunnelPublicKey: phoneKey, origin: "account", approvalRule: "approver" });
const headers = { authorization: `Bearer ${session.token}`, "x-twoody-via-tunnel": "relay", "x-twoody-tunnel-peer": phoneKey };
const accessFor = (signer = phone.keys) => {
  const access = { vault_device_id: phone.id, tunnel_public_key: phoneKey, account_computer_id: PI, exp: Math.floor(Date.now() / 1000) + 600 };
  return { ...access, signature: signDeviceAccessV2({ userId: USER_ID, access, signPrivate: signer.signPrivate }) };
};
const pin = (extra: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/api/v1/peer/vault/anchor", headers, payload: { vault_device_id: phone.id, sign_public: crypto.toHex(phone.keys.signPublic), ...extra } });

test("the iPhone founds the history; the Pi registers, pending", async () => {
  const founded = await post("vault/devices", { label: "iPhone", enc_public: crypto.toHex(phone.keys.encPublic), sign_public: crypto.toHex(phone.keys.signPublic) });
  phone.id = founded.device.id;
  await post(`vault/devices/${phone.id}/approval`, { approver_id: phone.id, signature: signApprovalV2({ userId: USER_ID, device: founded.device, approverId: phone.id, kind: "person", signPrivate: phone.keys.signPrivate }) });
  assert.equal((await vaultService.tick()).status, "pending");
});

test("with its device-access in the call, the iPhone becomes the first anchor and its session that device", async () => {
  // Without it, or signed by another key: refused, nothing kept.
  assert.equal((await pin({})).statusCode, 403);
  assert.equal((await pin({ device_access: accessFor(crypto.createDeviceKeys()) })).statusCode, 403);
  assert.equal((await pin({ device_access: { nonsense: true } })).statusCode, 403);
  assert.equal(sessionRow(session.sessionId)?.vaultDeviceId, null);

  const pinned = await pin({ device_access: accessFor() });
  assert.equal(pinned.statusCode, 200, pinned.body);
  assert.deepEqual(pinned.json(), { anchors: 1, pinned: true });
  assert.equal(sessionRow(session.sessionId)?.vaultDeviceId, phone.id);
  assert.ok((await meshRoster().refresh())?.persons.has(phone.id));
  // Sent again (a retried switch): the same anchor, nothing new.
  assert.deepEqual((await pin({ device_access: accessFor() })).json(), { anchors: 1, pinned: false });
  // Renewed against the roster from now on.
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/session/device-access", headers, payload: accessFor() })).statusCode, 200);
});
