import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A malicious account and a peer let in on the console (final review N1):
// the account makes up a person device F (self-approved, with a desktop-
// binding naming a computer it invents and a tunnel key it holds), and
// sends a peer request carrying F's device-access. The person, at the Pi's
// console, runs `twoody-server approve` on what the account names « MacBook
// Air ». Before: the session kept F's statement, pinned F as the Pi's
// anchor, and F then vouched for a made-up computer (rule 4). Now: a peer
// the console approved keeps no statement and never pins; a peer let in by
// rule 1 or 2 pins only a device the anchors already held reach; and the
// console shows the requester's security code with a warning.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-console-pin-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";

const { buildApp } = await import("../src/app.js");
const { setBackendFetch, backendCall } = await import("../src/account/backend.js");
const { writeAccountFile, linkedAccount } = await import("../src/account/store.js");
const { newPairingKey } = await import("../src/account/keys.js");
const { approveRequest, readPending, judgeMesh, requestSecurityCode } = await import("../src/account/approvals.js");
const { APPROVE_WARNING, describeRequest } = await import("../src/cli/account.js");
const crypto = await import("../src/vault/crypto.js");
const { securityCode, signApprovalV2, signBinding, signDesktopBinding, signDeviceAccessV2 } = await import("../src/vault/contracts.js");
const service = await import("../src/vault/service.js");
const { buildRoster } = await import("../src/vault/roster.js");
const { fakeVaultBackend } = await import("./helpers/fakeVault.js");
const { authSessions, db } = await import("../src/db.js");
const { pairDevice } = await import("../src/pairing.js");
const { eq } = await import("drizzle-orm");

const USER_ID = 42;
const PI = "9f3d5b72-4c6e-4a8f-8b2d-3e5f7a9b1c22";
const FAKE_MAC = "4b7e2d19-8c3a-4f6e-9d1b-5a2c8e0f7d33";
const FAKE_PC = "6d1f4a28-2b9c-4e7d-8a3f-1c5e9b0d2f44";
const BACKEND = "https://account.test";

const fake = fakeVaultBackend({ userId: USER_ID, computers: [PI] });
setBackendFetch((async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (/\/decide$/.test(url.pathname)) return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  return fake.fetch(input, init);
}) as typeof fetch);
writeAccountFile({
  backend_url: BACKEND, account_id: USER_ID, user_token: fake.serverSession(PI), device_token: "t",
  computer: { id: PI, credential: "c", name: "Pi" }, pairing_key: newPairingKey(),
  approvers: [{ public_key: randomBytes(32).toString("hex"), kind: "phone", name: "iPhone" }],
});
const app = await buildApp();
const vs = service.startVaultService({ firstTickMs: 3_600_000, intervalMs: 3_600_000 });
test.after(async () => {
  vs.stop();
  await app.close();
  setBackendFetch(null);
});
const post = (path: string, body: unknown) => backendCall({ backendUrl: BACKEND, userToken: fake.personSession() }, path, { body }).then((r: any) => r.body);

/// A person device the account made up: approved by itself, with a
/// desktop-binding naming FAKE_MAC and the tunnel key K the account holds.
function fabricated() {
  const keys = crypto.createDeviceKeys();
  const id = randomUUID();
  const K = randomBytes(32).toString("hex");
  const row: any = { id, label: "MacBook Air", enc_public: crypto.toHex(keys.encPublic), sign_public: crypto.toHex(keys.signPublic), status: "trusted", approved_at: "now", approved_by_id: id, approval: null, kind: "person", account_computer_id: null, binding: null, invite_proof: null };
  row.approval = { approver_id: id, signature: signApprovalV2({ userId: USER_ID, device: row, approverId: id, kind: "person", signPrivate: keys.signPrivate }) };
  const binding = { vault_device_id: id, account_computer_id: FAKE_MAC, tunnel_public_key: K, pairing_public_key: "ab".repeat(32) };
  row.desktop_binding = JSON.stringify({ ...binding, signature: signDesktopBinding({ userId: USER_ID, binding, signPrivate: keys.signPrivate }) });
  fake.devices.push(row);
  const stated = { vault_device_id: id, tunnel_public_key: K, account_computer_id: PI, exp: Math.floor(Date.now() / 1000) + 600 };
  const access = { ...stated, signature: signDeviceAccessV2({ userId: USER_ID, access: stated, signPrivate: keys.signPrivate }) };
  return { keys, id, K, row, access };
}

const pin = (token: string, K: string, anchor: { id: string; sign_public: string }) =>
  app.inject({ method: "POST", url: "/api/v1/peer/vault/anchor", headers: { authorization: `Bearer ${token}`, "x-twoody-via-tunnel": "relay", "x-twoody-tunnel-peer": K }, payload: { vault_device_id: anchor.id, sign_public: anchor.sign_public } });

test("a peer approved on the console keeps no device-access and never pins a device the account made up; no made-up computer gets rule 4", async () => {
  // The legit iPhone founds the vault; the Pi registers (pending, no anchor).
  const phone = crypto.createDeviceKeys();
  const founded = await post("vault/devices", { label: "iPhone", enc_public: crypto.toHex(phone.encPublic), sign_public: crypto.toHex(phone.signPublic) });
  await post(`vault/devices/${founded.device.id}/approval`, { approver_id: founded.device.id, signature: signApprovalV2({ userId: USER_ID, device: founded.device, approverId: founded.device.id, kind: "person", signPrivate: phone.signPrivate }) });
  assert.equal((await vs.tick()).status, "pending");

  const F = fabricated();
  const request = readPending({ requests: [{ id: 7, name: "x", public_key: F.K, expires_at: new Date(Date.now() + 60_000).toISOString(), role: "peer", requester_kind: "computer", requester_computer_id: FAKE_MAC, requester_name: "MacBook Air", device_access: F.access }] })[0]!;

  // `twoody-server approve` (rule 3): the session names no vault device.
  await approveRequest(linkedAccount()!, request);
  const [row] = db.select().from(authSessions).where(eq(authSessions.requesterComputerId, FAKE_MAC)).all();
  assert.ok(row, "the session was given");
  assert.equal(row!.approvalRule, "console");
  assert.equal(row!.vaultDeviceId, null, "no vault device for a console approval");
  assert.equal(row!.deviceAccessJson, null, "no statement kept");

  // Even a console session carrying the statement (as before) may not pin
  // (a peer, while the Pi trusts no device yet: told so, no_anchor_yet).
  const consoleSession = pairDevice({ deviceName: "MacBook Air", tunnelPublicKey: F.K, role: "peer", origin: "account", requesterComputerId: FAKE_MAC, approvalRule: "console", vaultDeviceId: F.id, deviceAccessJson: JSON.stringify(F.access) });
  const refused = await pin(consoleSession.token, F.K, { id: F.id, sign_public: F.row.sign_public });
  assert.equal(refused.statusCode, 403, refused.body);
  assert.deepEqual(refused.json(), { error: "no_anchor_yet" });

  // Nor a rule-2 or rule-4 one: F is reached from no anchor (there is none
  // yet, and F only approves itself).
  for (const rule of ["endorsed", "approver", "mesh_computer"]) {
    const session = pairDevice({ deviceName: "MacBook Air", tunnelPublicKey: F.K, role: "peer", origin: "account", requesterComputerId: FAKE_MAC, approvalRule: rule, vaultDeviceId: F.id, deviceAccessJson: JSON.stringify(F.access) });
    const res = await pin(session.token, F.K, { id: F.id, sign_public: F.row.sign_public });
    assert.equal(res.statusCode, 403, `${rule}: ${res.body}`);
  }
  assert.deepEqual((await service.vaultRosterInput())?.anchors, [], "nothing pinned");

  // F then « approves » a made-up computer with a tunnel key the account holds.
  const Z = crypto.createDeviceKeys();
  const zid = randomUUID();
  const Kz = randomBytes(32).toString("hex");
  const zRow: any = { id: zid, label: "PC", enc_public: crypto.toHex(Z.encPublic), sign_public: crypto.toHex(Z.signPublic), status: "trusted", approved_at: "now", approved_by_id: F.id, approval: null, kind: "computer", account_computer_id: FAKE_PC, binding: null, invite_proof: null };
  zRow.approval = { approver_id: F.id, signature: signApprovalV2({ userId: USER_ID, device: zRow, approverId: F.id, kind: "computer", accountComputerId: FAKE_PC, signPrivate: F.keys.signPrivate }) };
  const zb = { vault_device_id: zid, account_computer_id: FAKE_PC, tunnel_public_key: Kz, pairing_public_key: "cd".repeat(32), can_approve: false };
  zRow.binding = JSON.stringify({ ...zb, approver_id: F.id, signature: signBinding({ userId: USER_ID, binding: zb, signPrivate: F.keys.signPrivate }) });
  fake.devices.push(zRow);
  const input = await service.vaultRosterInput();
  const roster = buildRoster(input ?? { userId: String(USER_ID), devices: [], anchors: [] });
  assert.equal(roster.persons.has(F.id), false, "F is no person of the roster");
  assert.equal(roster.computers.has(FAKE_PC), false, "nor is the made-up computer");
  const asked = readPending({ requests: [{ id: 8, name: "PC", public_key: Kz, expires_at: new Date(Date.now() + 60_000).toISOString(), role: "peer", requester_computer_id: FAKE_PC }] })[0]!;
  assert.equal(judgeMesh(asked, roster, { selfComputerId: PI }), null, "no rule 4 for it");

  // The console shows the key's security code and a warning, not only
  // the account's name.
  assert.equal(requestSecurityCode(request), securityCode(F.K));
  assert.match(describeRequest({ ...request, security_code: requestSecurityCode(request) }), new RegExp(`MacBook Air .*security code ${securityCode(F.K)}`));
  assert.match(APPROVE_WARNING, /same security code/);
  assert.match(APPROVE_WARNING, /proves nothing/);
});
