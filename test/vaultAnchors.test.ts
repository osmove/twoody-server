import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Where a headless computer's trust in the encrypted history starts (its
// vault anchors, docs/mesh-design.md §1) and who may name one: this
// server's owner, or the person device being pinned itself — let in by
// rule 1 or 5 (account/approvals.ts) with a device-access/v2 signed by the
// very key being pinned, asking through the tunnel from the key its session
// holds. Never replaced, never pushed out, only before the computer is
// approved; gone once the vault revokes that device. And the walk from them
// takes what a device is only from a verified signer.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-vault-anchors-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { authSessions, db } = await import("../src/db.js");
const { setBackendFetch, backendCall } = await import("../src/account/backend.js");
const { writeAccountFile, linkedAccount } = await import("../src/account/store.js");
const { newPairingKey } = await import("../src/account/keys.js");
const { approveRequest, readPending, judge } = await import("../src/account/approvals.js");
const { pairDevice } = await import("../src/pairing.js");
const crypto = await import("../src/vault/crypto.js");
const { signApprovalV2, signBinding, signDeviceAccessV2 } = await import("../src/vault/contracts.js");
const client = await import("../src/vault/client.js");
const service = await import("../src/vault/service.js");
const { buildRoster } = await import("../src/vault/roster.js");
const { fakeVaultBackend } = await import("./helpers/fakeVault.js");
const { meshVault } = await import("./helpers/meshVault.js");
const { eq } = await import("drizzle-orm");

const USER_ID = 42;
const PI = "9f3d5b72-4c6e-4a8f-8b2d-3e5f7a9b1c22";
const BACKEND = "https://account.test";
const fake = fakeVaultBackend({ userId: USER_ID, computers: [PI] });
/// The account, plus what the approval loop's decide call needs.
const decided: string[] = [];
setBackendFetch((async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (/\/authorizations\/[^/]+\/decide$/.test(url.pathname)) {
    decided.push(url.pathname);
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return fake.fetch(input, init);
}) as typeof fetch);

// The iPhone added the Pi (typed its code): its tunnel key is pinned.
const phoneTunnel = randomBytes(32).toString("hex");
const pairing = newPairingKey();
writeAccountFile({
  backend_url: BACKEND, account_id: USER_ID, user_token: fake.serverSession(PI), device_token: "pi-device-token",
  computer: { id: PI, credential: "pi-credential", name: "Pi du salon" }, pairing_key: pairing,
  approvers: [{ public_key: phoneTunnel, kind: "phone", name: "iPhone" }],
});

const app = await buildApp();
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Console" } });
const owner = { authorization: `Bearer ${paired.json().token}` };
const vaultService = service.startVaultService({ firstTickMs: 3_600_000, intervalMs: 3_600_000 });
test.after(() => vaultService.stop());

const phoneCreds = { backendUrl: BACKEND, userToken: fake.personSession() };
const post = (path: string, body: unknown) => backendCall(phoneCreds, path, { body }).then((r) => r.body as Record<string, any>);
const device = () => ({ keys: crypto.createDeviceKeys(), id: "" });
const phone = device();
const ipad = device();
const epochKey = crypto.createEpochKey();

/// What the tunnel puts on a request it serves: its marker and the key at the other end.
const sealedFrom = (key: string) => ({ "x-twoody-via-tunnel": "relay", "x-twoody-tunnel-peer": key });
const pin = (headers: Record<string, string>, who: { id: string; keys: { signPublic: Uint8Array } }, extra: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", url: "/api/v1/peer/vault/anchor", headers, payload: { vault_device_id: who.id, sign_public: crypto.toHex(who.keys.signPublic), ...extra } });
const anchorsOnDisk = () => (JSON.parse(readFileSync(service.vaultKeysPath(), "utf8")).anchors as Array<{ id: string; sign_public: string }>).map((a) => a.id);
/// A device-access/v2 by `signer` for `tunnelKey`, for the Pi.
const accessFor = (signer: typeof phone, tunnelKey: string, exp = Math.floor(Date.now() / 1000) + 600) => {
  const access = { vault_device_id: signer.id, tunnel_public_key: tunnelKey, account_computer_id: PI, exp };
  return { ...access, signature: signDeviceAccessV2({ userId: USER_ID, access, signPrivate: signer.keys.signPrivate }) };
};

test("the iPhone founds the history and approves the iPad; the Pi registers, pending", async () => {
  const founded = await post("vault/devices", { label: "iPhone", enc_public: crypto.toHex(phone.keys.encPublic), sign_public: crypto.toHex(phone.keys.signPublic) });
  phone.id = founded.device.id;
  await post(`vault/devices/${phone.id}/approval`, { approver_id: phone.id, signature: signApprovalV2({ userId: USER_ID, device: founded.device, approverId: phone.id, kind: "person", signPrivate: phone.keys.signPrivate }) });
  await post("vault/envelopes", { envelopes: [crypto.wrapEpochKey({ epochKey, epoch: 1, userId: USER_ID, to: { deviceId: phone.id, encPublic: phone.keys.encPublic }, from: { deviceId: phone.id, signPrivate: phone.keys.signPrivate } })] });
  const second = await post("vault/devices", { label: "iPad", enc_public: crypto.toHex(ipad.keys.encPublic), sign_public: crypto.toHex(ipad.keys.signPublic) });
  ipad.id = second.device.id;
  await post(`vault/devices/${ipad.id}/approval`, { approver_id: phone.id, signature: signApprovalV2({ userId: USER_ID, device: second.device, approverId: phone.id, kind: "person", signPrivate: phone.keys.signPrivate }) });
  await post("vault/envelopes", { envelopes: [crypto.wrapEpochKey({ epochKey, epoch: 1, userId: USER_ID, to: { deviceId: ipad.id, encPublic: ipad.keys.encPublic }, from: { deviceId: phone.id, signPrivate: phone.keys.signPrivate } })] });
  assert.equal((await vaultService.tick()).status, "pending");
});

test("rule 1 keeps the device-access the iPhone brought: which vault device the session is", async () => {
  const request = readPending({ requests: [{ id: 91, name: "iPhone de Jimmy", public_key: phoneTunnel, expires_at: new Date(Date.now() + 60_000).toISOString(), role: "device", device_access: accessFor(phone, phoneTunnel) }] })[0]!;
  const verdict = judge(request, linkedAccount()!);
  assert.deepEqual(verdict, { approve: true, rule: "approver" });
  await approveRequest(linkedAccount()!, request, verdict);
  assert.equal(decided.length, 1);
  const row = db.select().from(authSessions).where(eq(authSessions.vaultDeviceId, phone.id)).all()[0]!;
  assert.deepEqual([row.origin, row.approvalRule, row.clientKind], ["account", "approver", "pair:iPhone de Jimmy"]);
  assert.equal(JSON.parse(row.deviceAccessJson!).tunnel_public_key, phoneTunnel);
  const { tunnelPeers } = await import("../src/db.js");
  assert.equal(db.select().from(tunnelPeers).where(eq(tunnelPeers.publicKey, phoneTunnel)).all()[0]?.sessionId, row.id);

  // Statements that name another computer, have expired, or another key are not kept.
  for (const [why, access] of [
    ["another computer", { ...accessFor(phone, phoneTunnel), account_computer_id: "8e2c4a61-3b5d-4f7e-9a1c-2d4e6f8a0b11" }],
    ["expired", accessFor(phone, phoneTunnel, Math.floor(Date.now() / 1000) - 5)],
    ["another key", accessFor(phone, randomBytes(32).toString("hex"))],
  ] as const) {
    const other = readPending({ requests: [{ id: 92, name: "x", public_key: phoneTunnel, expires_at: new Date(Date.now() + 60_000).toISOString(), device_access: access }] })[0]!;
    await approveRequest(linkedAccount()!, other, judge(other, linkedAccount()!));
    const made = db.select().from(authSessions).all().at(-1)!;
    assert.deepEqual([made.vaultDeviceId, made.deviceAccessJson], [null, null], why);
    db.delete(authSessions).where(eq(authSessions.id, made.id)).run();
  }
});

test("who may name an anchor: the owner, or the device itself through the tunnel from its own key", async () => {
  // Every session, with a token, and the key it was given.
  const make = (name: string, extra: Parameters<typeof pairDevice>[0] = { deviceName: name }) => {
    const key = randomBytes(32).toString("hex");
    const made = pairDevice({ ...extra, deviceName: name, tunnelPublicKey: key });
    return { headers: { authorization: `Bearer ${made.token}`, ...sealedFrom(key) }, key, sessionId: made.sessionId };
  };
  const byCode = make("iPad de la cuisine", { deviceName: "", origin: "code" });
  const household = make("iPhone de Claire", { deviceName: "", origin: "account", approvalRule: "endorsed" });
  // The iPhone itself, by rule 1, holding its statement for its key.
  const itself = (() => {
    const key = randomBytes(32).toString("hex");
    const made = pairDevice({ deviceName: "iPhone", tunnelPublicKey: key, origin: "account", approvalRule: "approver", vaultDeviceId: phone.id, deviceAccessJson: JSON.stringify(accessFor(phone, key)) });
    return { headers: { authorization: `Bearer ${made.token}`, ...sealedFrom(key) }, key };
  })();
  // Rule 2 carrying the iPhone's statement: still not a person session.
  const endorsedWithAccess = (() => {
    const key = randomBytes(32).toString("hex");
    const made = pairDevice({ deviceName: "iPhone", tunnelPublicKey: key, origin: "account", approvalRule: "endorsed", vaultDeviceId: phone.id, deviceAccessJson: JSON.stringify(accessFor(phone, key)) });
    return { authorization: `Bearer ${made.token}`, ...sealedFrom(key) };
  })();
  // Another computer's peer session: not a person device.
  const peer = make("Mac", { deviceName: "", role: "peer", origin: "mesh", requesterComputerId: "8e2c4a61-3b5d-4f7e-9a1c-2d4e6f8a0b11", approvalRule: "mesh_computer" });

  for (const [why, headers, who] of [
    ["paired by code", byCode.headers, phone],
    ["household (rule 2)", household.headers, phone],
    ["rule 2 carrying the iPhone's statement", endorsedWithAccess, phone],
    ["another computer's peer session", peer.headers, phone],
    ["the iPhone naming the iPad", itself.headers, ipad],
  ] as const) {
    const refused = await pin(headers, who);
    assert.equal(refused.statusCode, 403, why);
    assert.equal(refused.json().error, "anchor_not_allowed", why);
  }
  // The iPhone, under a key it does not hold: its statement is for its own.
  assert.equal((await pin(itself.headers, phone, { sign_public: crypto.toHex(ipad.keys.signPublic) })).statusCode, 403, "another signing key");
  // Its token through the tunnel of another key, or over plain HTTP.
  assert.equal((await pin({ ...itself.headers, ...sealedFrom(randomBytes(32).toString("hex")) }, phone)).statusCode, 403, "another tunnel key");
  const lan = await app.inject({ method: "POST", url: "/api/v1/peer/vault/anchor", headers: itself.headers, remoteAddress: "192.168.1.30", payload: { vault_device_id: phone.id, sign_public: crypto.toHex(phone.keys.signPublic) } });
  assert.equal(lan.statusCode, 403, "the tunnel's stamp typed on the network");
  assert.deepEqual(anchorsOnDisk(), [], "nothing pinned so far");

  const pinned = await pin(itself.headers, phone);
  assert.equal(pinned.statusCode, 200, pinned.body);
  assert.deepEqual(pinned.json(), { anchors: 1, pinned: true });
  assert.deepEqual((await pin(itself.headers, phone)).json(), { anchors: 1, pinned: false }, "again: nothing changes");
  // The owner names the iPad.
  assert.deepEqual((await pin({ ...owner, ...sealedFrom(randomBytes(32).toString("hex")) }, ipad)).json(), { anchors: 2, pinned: true });
  assert.deepEqual(anchorsOnDisk(), [phone.id, ipad.id]);
});

test("a pinned anchor is never replaced nor pushed out", async () => {
  const tunnel = { ...owner, ...sealedFrom(randomBytes(32).toString("hex")) };
  const other = crypto.createDeviceKeys();
  const conflict = await pin(tunnel, { id: phone.id, keys: other });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error, "anchor_conflict");
  // Junk up to the limit (8): the ninth is refused, the iPhone stays first.
  for (let i = 0; i < 6; i++) assert.equal((await pin(tunnel, { id: randomUUID(), keys: crypto.createDeviceKeys() })).statusCode, 200);
  const full = await pin(tunnel, { id: randomUUID(), keys: crypto.createDeviceKeys() });
  assert.equal(full.statusCode, 409);
  assert.equal(full.json().error, "too_many_anchors");
  assert.deepEqual(anchorsOnDisk().slice(0, 2), [phone.id, ipad.id]);
  const saved = JSON.parse(readFileSync(service.vaultKeysPath(), "utf8")).anchors[0];
  assert.equal(saved.sign_public, crypto.toHex(phone.keys.signPublic));
});

test("approved, the Pi takes no new anchor; one the vault revokes goes, one merely missing stays", async () => {
  const identity = (await app.inject({ url: "/api/v1/peer/vault/identity", headers: { ...owner, "x-twoody-via-tunnel": "relay" } })).json();
  const pi = { id: identity.vault_device_id, enc_public: identity.enc_public, sign_public: identity.sign_public };
  const bound = { vault_device_id: pi.id, account_computer_id: PI, tunnel_public_key: identity.tunnel_public_key, pairing_public_key: identity.pairing_public_key, can_approve: false };
  const binding = JSON.stringify({ ...bound, approver_id: phone.id, signature: signBinding({ userId: USER_ID, binding: bound, signPrivate: phone.keys.signPrivate }) });
  await post(`vault/devices/${pi.id}/approval`, { approver_id: phone.id, signature: signApprovalV2({ userId: USER_ID, device: pi, approverId: phone.id, kind: "computer", accountComputerId: PI, signPrivate: phone.keys.signPrivate }), binding });
  await post("vault/envelopes", { envelopes: [crypto.wrapEpochKey({ epochKey, epoch: 1, userId: USER_ID, to: { deviceId: pi.id, encPublic: crypto.fromHex(pi.enc_public) }, from: { deviceId: phone.id, signPrivate: phone.keys.signPrivate } })] });
  assert.equal((await vaultService.tick()).status, "trusted");

  const late = await pin({ ...owner, ...sealedFrom(randomBytes(32).toString("hex")) }, { id: randomUUID(), keys: crypto.createDeviceKeys() });
  assert.equal(late.statusCode, 409);
  assert.equal(late.json().error, "already_approved");
  assert.deepEqual((await pin({ ...owner, ...sealedFrom(randomBytes(32).toString("hex")) }, phone)).json(), { anchors: 8, pinned: false }, "the same anchor again is no change");

  // The iPhone revokes the iPad: its anchor goes; the junk ones (never in
  // the vault) and the iPhone's stay.
  await post(`vault/devices/${ipad.id}/revoke`, {});
  const before = anchorsOnDisk();
  await vaultService.tick();
  const after = anchorsOnDisk();
  assert.ok(!after.includes(ipad.id), "revoked in the vault: pruned");
  assert.equal(after.length, before.length - 1);
  assert.equal(after[0], phone.id);
  assert.equal(service.vaultEpochKeys().size, 1, "the Pi still holds its keys");
});

// ── the walk (pure) ──────────────────────────────────────────────────────

test("what a device is comes only from a verified signer's approval", () => {
  const v = meshVault("42");
  const iphone = v.person("iPhone");
  const mac = v.person("MacBook", iphone);
  // The account makes a device up and has it « approved » by another it
  // made up (its own keys, its own signatures).
  const madeUpApprover = v.person("Inventé");
  const injected = v.person("Injecté", madeUpApprover);
  const input = v.input([iphone]);
  const byId = new Map(input.devices.map((d) => [d.id, d]));
  const verified = client.verifiedIds("42", input.devices, input.anchors);
  assert.deepEqual([...verified].sort(), [iphone.id, mac.id].sort());
  assert.equal(client.deviceKind("42", byId.get(injected.id), byId)?.kind, "person", "its signature checks…");
  assert.equal(client.deviceKind("42", byId.get(injected.id), byId, verified), null, "…but its approver is nobody verified");
  assert.equal(client.mayApprove("42", byId.get(injected.id), byId, verified), false);
  assert.equal(client.deviceKind("42", byId.get(mac.id), byId, verified)?.kind, "person");
  assert.equal(client.trustedSigners("42", input.devices, input.anchors).has(injected.id), false);
  assert.deepEqual([...buildRoster(input).persons.keys()].sort(), [iphone.id, mac.id].sort());
});

test("an anchor counts only with its own approval checking as a person's", () => {
  const v = meshVault("42");
  const iphone = v.person("iPhone");
  const mac = v.person("MacBook", iphone);
  const good = v.input([mac]);
  assert.equal(client.verifiedIds("42", good.devices, good.anchors).has(mac.id), true, "approved by the iPhone, whose key the roster has");
  for (const [why, change] of [
    ["no approval", (d: any) => (d.approval = null)],
    ["an approver the roster does not have", (d: any) => (d.approval = { ...d.approval, approver_id: randomUUID() })],
    ["a signature that is none", (d: any) => (d.approval = { ...d.approval, signature: "00".repeat(64) })],
    ["approved as a computer", (d: any) => (d.approval = { approver_id: iphone.id, signature: signApprovalV2({ userId: "42", device: d, approverId: iphone.id, kind: "computer", accountComputerId: PI, signPrivate: iphone.keys.signPrivate }) })],
  ] as const) {
    const input = v.input([mac]);
    change(input.devices.find((d) => d.id === mac.id));
    const byId = new Map(input.devices.map((d) => [d.id, d]));
    assert.equal(client.anchorHolds("42", input.anchors[0]!, byId), false, why);
    assert.equal(client.verifiedIds("42", input.devices, input.anchors).size, 0, why);
    assert.equal(buildRoster(input).persons.size, 0, why);
  }
});

test("the local keys' anchors: pinned once, refused past 8 or once approved, pruned when revoked", () => {
  const store = client.memoryKeyStore();
  const vaultClient = client.createComputerVaultClient({ api: { state: async () => ({}), createDevice: async () => ({ device: {} as any }), envelopes: async () => ({}) }, store, userId: 42, accountComputerId: PI });
  store.write({ userId: "42", accountComputerId: PI, deviceId: randomUUID(), keys: crypto.createDeviceKeys(), epochs: new Map(), anchors: [] });
  const a = { id: randomUUID(), sign_public: crypto.toHex(crypto.createDeviceKeys().signPublic) };
  assert.deepEqual(vaultClient.pinAnchor(a), { anchors: 1, pinned: true });
  assert.throws(() => vaultClient.pinAnchor({ ...a, sign_public: crypto.toHex(crypto.createDeviceKeys().signPublic) }), /anchor_conflict/);
  for (let i = 1; i < client.MAX_ANCHORS; i++) vaultClient.pinAnchor({ id: randomUUID(), sign_public: crypto.toHex(crypto.createDeviceKeys().signPublic) });
  assert.throws(() => vaultClient.pinAnchor({ id: randomUUID(), sign_public: a.sign_public }), /too_many_anchors/);
  assert.equal(store.read()!.anchors[0]!.id, a.id);
  // Listed revoked under another key: not that anchor, kept.
  const listed = (sign_public: string, status: "revoked" | "trusted") => ({ id: a.id, label: "x", enc_public: "00".repeat(32), sign_public, status });
  assert.deepEqual(vaultClient.pruneAnchors([listed("11".repeat(32), "revoked")]), []);
  assert.deepEqual(vaultClient.pruneAnchors([listed(a.sign_public, "trusted")]), []);
  assert.deepEqual(vaultClient.pruneAnchors([]), [], "missing from the listing: kept");
  assert.deepEqual(vaultClient.pruneAnchors([listed(a.sign_public, "revoked")]), [a.id]);
  assert.equal(store.read()!.anchors.length, client.MAX_ANCHORS - 1);
  // Approved (an epoch key held): no new anchor.
  const local = store.read()!;
  store.write({ ...local, epochs: new Map([[1, new Uint8Array(32)]]) });
  assert.throws(() => vaultClient.pinAnchor({ id: randomUUID(), sign_public: a.sign_public }), /already_approved/);
});
