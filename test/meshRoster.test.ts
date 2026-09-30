import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { startFakeBackend } from "./helpers/fakeBackend.js";
import { meshVault } from "./helpers/meshVault.js";

// The verified mesh roster (docs/mesh-design.md §1, §4, lot S2): which
// computers this one trusts comes from the vault's own signatures — v2
// approvals, bindings, walked forward from the pinned iPhone — never from
// the backend's listing or account_peers.trusted. What it drives: rules 4
// and 5 of the approvals, the peer document trust, the links asked for,
// what goes within 60 s when a computer leaves, and the router's trust.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-mesh-roster-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
delete process.env.TWOODY_USER_TOKEN;
process.env.TWOODY_PUBLIC_URL = "http://192.168.1.42:3000";

const backend = await startFakeBackend();
test.after(() => backend.close());

const { buildRoster, createRosterCache, setRosterSource, startRosterRefresh } = await import("../src/vault/roster.js");
const { judgeMesh, readPending, startApprovalLoop } = await import("../src/account/approvals.js");
const { BackendError } = await import("../src/account/backend.js");
const { writeAccountFile } = await import("../src/account/store.js");
const { newPairingKey } = await import("../src/account/keys.js");
const { buildApp } = await import("../src/app.js");
const { accountPeers, authSessions, db, users } = await import("../src/db.js");
const { ensureLocalUser, pairDevice } = await import("../src/pairing.js");
const { isTrustedComputer } = await import("../src/peerDocuments/trust.js");
const { followRoster, peerById, setPeerStatus, startMeshLinks } = await import("../src/peers/index.js");
const { listComputers, peerTrusted, pickBackground, routablePeers } = await import("../src/router/index.js");
const { readStatus } = await import("../src/account/status.js");
const { eq } = await import("drizzle-orm");
const c = await import("../src/vault/contracts.js");

const USER = "7";
const hex = () => randomBytes(32).toString("hex");

// The account: this Pi, the Mac, and a computer the backend lists that no
// person device ever enrolled (acceptance 6).
const pi = backend.addComputer({ name: "Raspberry Pi", public_key: hex(), kind: "server" });
const mac = backend.addComputer({ name: "Mac de Jimmy", public_key: hex(), kind: "desktop" });
const listedOnly = backend.addComputer({ name: "Ordinateur inséré", public_key: hex(), kind: "server" });
const PI = String(pi.id);
const MAC = String(mac.id);
const LISTED = String(listedOnly.id);
writeAccountFile({
  backend_url: backend.url, account_id: Number(USER), user_token: backend.userToken, device_token: "dev",
  computer: { id: PI, credential: pi.credential, name: "Raspberry Pi" }, pairing_key: newPairingKey(), approvers: [],
});

// The vault: the iPhone founds it and is the Pi's anchor; it enrols and
// binds the Mac (a Desktop, can_approve) and the Pi; the iPad is a person
// device it approved.
const vault = meshVault(USER);
const iphone = vault.person("iPhone");
const ipad = vault.person("iPad", iphone);
const macDevice = vault.computer("Mac de Jimmy", MAC, iphone, { canApprove: true });
const piDevice = vault.computer("Raspberry Pi", PI, iphone);
let input = () => vault.input([iphone]);
setRosterSource(async () => input());

await buildApp();
const user = ensureLocalUser();

// ── the roster, pure ────────────────────────────────────────────────────────

test("the roster: computers bound by a person device, and the devices that may vouch for a phone", () => {
  const roster = buildRoster(vault.input([iphone]));
  assert.deepEqual([...roster.computers.keys()].sort(), [MAC, PI].sort());
  assert.equal(roster.computers.get(MAC)!.tunnelPublicKey, macDevice.tunnelKey);
  assert.equal(roster.computers.get(PI)!.vaultDeviceId, piDevice.id);
  assert.equal(roster.computers.get(PI)!.canApprove, false);
  // The Mac's binding says can_approve: a person device too; the Pi never.
  assert.deepEqual([...roster.persons.keys()].sort(), [iphone.id, ipad.id, macDevice.id].sort());
  // Without its anchor, this computer vouches for nobody.
  const none = buildRoster(vault.input([]));
  assert.equal(none.computers.size + none.persons.size, 0);
});

test("refused: a forged or self-made binding, one by a computer, a stripped kind, a v1 computer, unverified, revoked, pending, two for one computer", () => {
  const v = meshVault(USER);
  const phone = v.person("iPhone");
  const good = v.computer("NAS", "nas", phone);
  const forged = v.computer("Forged", "forged", phone);
  const binding = JSON.parse(forged.binding as string);
  forged.binding = JSON.stringify({ ...binding, tunnel_public_key: hex() });
  const selfBound = v.computer("Self-bound", "self-bound", phone);
  const selfBinding = JSON.parse(selfBound.binding as string);
  selfBound.binding = JSON.stringify({ ...selfBinding, approver_id: selfBound.id });
  const boundByPi = v.computer("Bound by the Pi", "bound-by-pi", phone, { bindingSigner: good });
  const stripped = v.computer("Stripped", "stripped", phone);
  const v1 = v.computer("v1", "v1", phone, { v1: true });
  const intruder = v.person("Intruder");
  const byIntruder = v.computer("By the intruder", "by-intruder", intruder);
  const revoked = v.computer("Revoked", "revoked", phone);
  revoked.status = "revoked";
  const pending = v.computer("Pending", "pending", phone);
  pending.status = "pending";
  v.computer("Twin A", "twin", phone);
  v.computer("Twin B", "twin", phone);
  const read = v.input([phone]);
  // The account strips the computer of what says it is one.
  Object.assign(read.devices.find((d) => d.id === stripped.id)!, { kind: "person", account_computer_id: null, binding: null });

  const roster = buildRoster(read);
  assert.deepEqual([...roster.computers.keys()], ["nas"]);
  assert.deepEqual([...roster.persons.keys()], [phone.id], "no computer, stripped or not, vouches for a phone");
  for (const d of [forged, selfBound, boundByPi, stripped, v1, byIntruder, revoked, pending, intruder]) {
    assert.ok(![...roster.computers.values()].some((c) => c.vaultDeviceId === d.id) && !roster.persons.has(d.id), d.label);
  }
  // An anchor pinned with another key than the account now gives it.
  assert.equal(buildRoster({ ...read, anchors: [{ id: phone.id, sign_public: hex() }] }).computers.size, 0);
});

test("a Desktop is a mesh computer by its own desktop-binding and stays a person device; forged, moved, a Pi's, unverified or twinned ones do not count", () => {
  const v = meshVault(USER);
  const phone = v.person("iPhone");
  const air = v.desktop("MacBook Air", "air", phone);
  // A Desktop approved by the other Desktop: both person devices.
  const mini = v.desktop("Mac mini", "mini", air);
  const pi = v.computer("Raspberry Pi", "pi", phone);
  const forged = v.desktop("Signed by the phone", "forged", phone, { signer: phone });
  const tampered = v.desktop("Tampered", "tampered", phone);
  tampered.desktop_binding = JSON.stringify({ ...JSON.parse(tampered.desktop_binding as string), tunnel_public_key: hex() });
  // The Pi names itself a Desktop: its signature checks, it is a computer by its approval.
  const piSelf = v.computer("Pi 2", "pi2", phone);
  const piBinding = { vault_device_id: piSelf.id, account_computer_id: "pi2-desktop", tunnel_public_key: hex(), pairing_public_key: hex() };
  piSelf.desktop_binding = JSON.stringify({ ...piBinding, signature: c.signDesktopBinding({ userId: USER, binding: piBinding, signPrivate: piSelf.keys.signPrivate }) });
  const intruder = v.person("Intruder");
  const intruderDesk = v.desktop("Intruder's Desktop", "intruder-desk", intruder);
  // The Air's binding carried by another device.
  const ipad = v.person("iPad", phone);
  ipad.desktop_binding = air.desktop_binding;
  // One account computer, a Desktop's and a computer's binding: neither.
  v.desktop("Twin Desktop", "twin", phone);
  v.computer("Twin computer", "twin", phone);
  const revoked = v.desktop("Revoked", "revoked", phone);
  revoked.status = "revoked";
  // The account moves a Desktop's binding into `binding`: it now reads as a
  // computer, which may not approve — and is no computer either.
  const moved = v.desktop("Moved", "moved", phone);
  const read = v.input([phone]);
  Object.assign(read.devices.find((d) => d.id === moved.id)!, { binding: moved.desktop_binding, desktop_binding: null });

  const roster = buildRoster(read);
  assert.deepEqual([...roster.computers.keys()].sort(), ["air", "mini", "pi", "pi2"], "never pi2-desktop");
  assert.equal(roster.computers.get("pi2")!.via, "computer");
  const a = roster.computers.get("air")!;
  assert.deepEqual([a.vaultDeviceId, a.tunnelPublicKey, a.canApprove, a.via], [air.id, air.tunnelKey, true, "desktop"]);
  assert.equal(roster.computers.get("mini")!.tunnelPublicKey, mini.tunnelKey);
  assert.equal(roster.computers.get("pi")!.via, "computer");
  assert.ok(roster.persons.has(air.id) && roster.persons.has(mini.id) && roster.persons.has(ipad.id), "Desktops stay person devices");
  assert.ok(!roster.persons.has(pi.id) && !roster.persons.has(piSelf.id) && !roster.persons.has(moved.id));
  for (const d of [forged, tampered, intruderDesk, revoked, moved]) {
    assert.ok(![...roster.computers.values()].some((x) => x.vaultDeviceId === d.id), d.label);
  }
  assert.ok(![...roster.computers.values()].some((x) => x.vaultDeviceId === ipad.id));
  // Rule 4 for a Desktop: its bound tunnel key only.
  const request = (key: string) => ({ id: 1, name: "Mac mini", public_key: key, expires_at: new Date(Date.now() + 60_000).toISOString(), role: "peer", requester_computer_id: "mini" });
  assert.deepEqual(judgeMesh(request(mini.tunnelKey) as never, roster, { selfComputerId: "air" }), { approve: true, rule: "mesh_computer" });
  assert.equal(judgeMesh(request(hex()) as never, roster, { selfComputerId: "air" }), null);
  // Without the phone as anchor, the Desktops are nobody.
  assert.equal(buildRoster(v.input([])).computers.size, 0);
});

test("cached 60 s, asked again at most every 10 s for a computer it lacks; 401 empties it, an unreachable account keeps it", async () => {
  let now = 1_000_000;
  let calls = 0;
  let fail: Error | null = null;
  const cache = createRosterCache({
    source: async () => {
      calls += 1;
      if (fail) throw fail;
      return vault.input([iphone]);
    },
    now: () => now,
  });
  const changes: Array<{ left: string[]; joined: string[] }> = [];
  cache.onChange((c) => void changes.push({ left: c.left, joined: c.joined }));
  assert.equal(await cache.isTrustedComputer(MAC), true);
  assert.equal(await cache.tunnelKeyOf(MAC), macDevice.tunnelKey);
  assert.equal(calls, 1);
  assert.equal(changes.length, 1);
  assert.deepEqual([changes[0]!.left, changes[0]!.joined.sort()], [[], [MAC, PI].sort()]);

  now += 5_000;
  assert.equal(await cache.isTrustedComputer(LISTED), false);
  assert.equal(calls, 1, "a miss 5 s after the last look asks nothing");
  now += 6_000;
  assert.equal(await cache.isTrustedComputer(LISTED), false);
  assert.equal(calls, 2, "11 s after: asked once more");
  now += 30_000;
  await cache.get();
  assert.equal(calls, 2, "within the minute: the cache");
  now += 60_000;
  fail = new TypeError("fetch failed");
  assert.equal(await cache.isTrustedComputer(MAC), true, "unreachable: the last verified roster stays");
  fail = new BackendError(401, "session_revoked", "no");
  now += 60_000;
  assert.equal(await cache.isTrustedComputer(MAC), false, "the account says no vault here: nobody");
  assert.deepEqual(changes.at(-1)!.left.sort(), [MAC, PI].sort());
});

// ── rules 4 and 5 ───────────────────────────────────────────────────────────

const phoneKey = hex();
function pending(extra: Record<string, unknown>) {
  return readPending({ requests: [{ id: 1, name: "x", public_key: hex(), expires_at: new Date(Date.now() + 60_000).toISOString(), role: "device", endorsements: [], ...extra }] })[0]!;
}

test("rule 4: a roster computer asking as a peer with its bound tunnel key; nothing else", () => {
  const roster = buildRoster(vault.input([iphone]));
  const ok = pending({ role: "peer", requester_kind: "computer", requester_computer_id: Number(MAC), public_key: macDevice.tunnelKey });
  assert.deepEqual(judgeMesh(ok, roster, { selfComputerId: PI }), { approve: true, rule: "mesh_computer" });
  for (const [why, request] of [
    ["another key", pending({ role: "peer", requester_computer_id: Number(MAC), public_key: hex() })],
    ["a computer the backend lists, never enrolled", pending({ role: "peer", requester_computer_id: Number(LISTED), public_key: hex() })],
    ["itself", pending({ role: "peer", requester_computer_id: Number(PI), public_key: piDevice.tunnelKey })],
    ["the Mac's key, no computer named (the account token alone)", pending({ role: "peer", public_key: macDevice.tunnelKey })],
    ["expired", pending({ role: "peer", requester_computer_id: Number(MAC), public_key: macDevice.tunnelKey, expires_at: new Date(Date.now() - 1).toISOString() })],
  ] as const) {
    assert.equal(judgeMesh(request, roster, { selfComputerId: PI }), null, why);
  }
  assert.equal(judgeMesh(ok, null), null, "no vault here: no rule 4");
});

test("rule 5: a phone carrying a device-access/v2 signed by a person device of the roster, for the key it asks with, this computer, not expired", () => {
  const roster = buildRoster(vault.input([iphone]));
  const here = { selfComputerId: PI };
  const signed = vault.deviceAccess(ipad, phoneKey, PI);
  assert.deepEqual(judgeMesh(pending({ public_key: phoneKey, device_access: signed }), roster, here), { approve: true, rule: "device_access", vaultDeviceId: ipad.id });
  // The Desktop's binding says can_approve: it may vouch too.
  assert.equal(judgeMesh(pending({ public_key: phoneKey, device_access: vault.deviceAccess(macDevice, phoneKey, PI) }), roster, here)?.approve, true);
  const outsider = meshVault(USER).person("Someone else's phone");
  const now = Math.floor(Date.now() / 1000);
  for (const [why, request] of [
    ["signed by the Pi (can_approve=false)", pending({ public_key: phoneKey, device_access: vault.deviceAccess(piDevice, phoneKey, PI) })],
    ["for another key", pending({ public_key: hex(), device_access: signed })],
    ["tampered", pending({ public_key: phoneKey, device_access: { ...signed, signature: signed.signature.replace(/^./, (c) => (c === "0" ? "1" : "0")) } })],
    ["a device not in the vault", pending({ public_key: phoneKey, device_access: { ...vault.deviceAccess(outsider, phoneKey, PI) } })],
    ["from a computer (role peer)", pending({ role: "peer", requester_computer_id: Number(LISTED), public_key: phoneKey, device_access: signed })],
    ["none", pending({ public_key: phoneKey })],
    ["garbage", pending({ public_key: phoneKey, device_access: "{not json" })],
    ["for another computer (replayed from the Mac)", pending({ public_key: phoneKey, device_access: vault.deviceAccess(ipad, phoneKey, MAC) })],
    ["another computer, said as this one", pending({ public_key: phoneKey, device_access: { ...vault.deviceAccess(ipad, phoneKey, MAC), account_computer_id: PI } })],
    ["expired", pending({ public_key: phoneKey, device_access: vault.deviceAccess(ipad, phoneKey, PI, now - 1) })],
    ["expiring too far ahead (kept, not made for one request)", pending({ public_key: phoneKey, device_access: vault.deviceAccess(ipad, phoneKey, PI, now + 2 * 86_400) })],
    ["a later expiry than signed", pending({ public_key: phoneKey, device_access: { ...signed, exp: signed.exp + 60 } })],
    ["v1 (no computer, no expiry)", pending({ public_key: phoneKey, device_access: vault.deviceAccessV1(ipad, phoneKey) })],
  ] as const) {
    assert.equal(judgeMesh(request, roster, here), null, why);
  }
  assert.equal(judgeMesh(pending({ public_key: phoneKey, device_access: signed }), roster), null, "not knowing which computer it is: no rule 5");
  const revoked = vault.input([iphone]);
  revoked.devices.find((d) => d.id === ipad.id)!.status = "revoked";
  assert.equal(judgeMesh(pending({ public_key: phoneKey, device_access: signed }), buildRoster(revoked), here), null, "a revoked person device");
});

let macSessionId = "";
let phoneSessionId = "";
test("the approval loop applies rules 4 and 5 against the account; a computer it only lists stays pending", async () => {
  const expires = new Date(Date.now() + 60_000).toISOString();
  const base = { computer_id: pi.id, state: "pending" as const, sealed_response: null, expires_at: expires, endorsements: [] };
  const fromMac = { ...base, id: 700, name: "Mac de Jimmy", public_key: macDevice.tunnelKey, role: "peer" as const, requester_kind: "computer" as const, requester_computer_id: mac.id, requester_name: "Mac de Jimmy" };
  const fromListed = { ...base, id: 701, name: "Ordinateur inséré", public_key: hex(), role: "peer" as const, requester_kind: "computer" as const, requester_computer_id: listedOnly.id };
  backend.authorizations.push(fromMac, fromListed);
  // The phone asks the way twoody-app A1 does: device_access in request_access.
  const asked = await fetch(`${backend.url}/api/v1/account_computers/${pi.id}/request_access`, {
    method: "POST", headers: { "content-type": "application/json", "x-user-token": backend.userToken },
    body: JSON.stringify({ name: "iPhone de Claire", public_key: phoneKey, role: "device", device_access: vault.deviceAccess(ipad, phoneKey, PI) }),
  }).then((r) => r.json());

  const loop = startApprovalLoop({ everyMs: 60_000 });
  const done = await loop.tick();
  loop.stop();
  const verdicts = new Map(done.map((d) => [d.request.id, d.verdict]));
  assert.deepEqual(verdicts.get("700"), { approve: true, rule: "mesh_computer" });
  assert.deepEqual(verdicts.get("701"), { approve: false, reason: "needs_console" });
  assert.deepEqual(verdicts.get(String(asked.id)), { approve: true, rule: "device_access", vaultDeviceId: ipad.id });
  assert.equal(fromMac.state, "approved");
  assert.equal(fromListed.state, "pending");

  const sessions = db.select().from(authSessions).all();
  const macSession = sessions.find((s) => s.requesterComputerId === MAC)!;
  assert.equal(macSession.origin, "mesh");
  assert.equal(macSession.clientKind, "peer:Mac de Jimmy", "a computer gets a peer-limited session");
  const phoneSession = sessions.find((s) => s.vaultDeviceId === ipad.id)!;
  assert.equal(phoneSession.origin, "mesh");
  assert.equal(phoneSession.clientKind, "pair:iPhone de Claire");
  macSessionId = macSession.id;
  phoneSessionId = phoneSession.id;
});

test("peer documents: the roster decides, and only for the session holding the bound key", async () => {
  assert.equal(await isTrustedComputer(MAC, { sessionId: macSessionId }), true);
  assert.equal(await isTrustedComputer(MAC), true);
  // The account labels another key's session with the Mac's id: not the Mac.
  const other = pairDevice({ deviceName: "Not the Mac", tunnelPublicKey: hex(), role: "peer", origin: "account", requesterComputerId: MAC });
  assert.equal(await isTrustedComputer(MAC, { sessionId: other.sessionId }), false);
  // account_peers.trusted no longer counts.
  const now = new Date();
  db.insert(accountPeers).values({ computerId: LISTED, userId: user.id, name: "Ordinateur inséré", state: "linked", trusted: true, enabled: true, token: "t", tunnelKey: hex(), url: "http://192.168.1.9:3000", createdAt: now, updatedAt: now }).run();
  assert.equal(await isTrustedComputer(LISTED), false);
  db.delete(authSessions).where(eq(authSessions.id, other.sessionId)).run();
});

// ── links follow the roster ─────────────────────────────────────────────────

test("a roster change asks each roster computer not linked yet for a link — never itself, never one only the account lists", async () => {
  const before = backend.authorizations.length;
  const roster = buildRoster(vault.input([iphone]));
  const { asked } = await followRoster([user.id], roster);
  assert.deepEqual(asked, [MAC]);
  const request = backend.authorizations.slice(before);
  assert.deepEqual(request.map((a) => [a.computer_id, a.role]), [[mac.id, "peer"]]);
  const row = peerById(user.id, MAC)!;
  assert.deepEqual([row.state, row.origin], ["requested", "mesh"]);
  assert.deepEqual((await followRoster([user.id], roster)).asked, [], "a request under way is left alone");
  // The link comes (as checkPeerRequest would write it): with the bound key.
  db.update(accountPeers).set({ state: "linked", token: "mac-peer-token", tunnelKey: macDevice.tunnelKey, url: "http://192.168.1.10:3000", requestId: null }).where(eq(accountPeers.computerId, MAC)).run();
  assert.deepEqual((await followRoster([user.id], roster)).asked, []);
});

// ── the router ──────────────────────────────────────────────────────────────

test("router: trusted from the roster over the bound key, a mesh link outside it not routed, /providers says mesh, preferred, documents", async () => {
  await setRosterSource(async () => input()).refresh();
  const now = new Date();
  // Linked from « Appareils », the column says trusted: the roster does not have it.
  // (LISTED, inserted above, is that.) A mesh link the roster no longer has:
  db.insert(accountPeers).values({ computerId: "999", userId: user.id, name: "Ancien", state: "linked", trusted: true, origin: "mesh", enabled: true, token: "t", tunnelKey: hex(), url: "http://192.168.1.11:3000", createdAt: now, updatedAt: now }).run();

  assert.equal(peerTrusted(peerById(user.id, MAC)!), true);
  assert.equal(peerTrusted(peerById(user.id, LISTED)!), false, "account_peers.trusted is not the roster");
  assert.equal(peerTrusted({ computerId: MAC, tunnelKey: hex() }), false, "the Mac's id under another key");
  assert.deepEqual(routablePeers(user.id).map((p) => p.computerId), [MAC], "one only the account vouches for lends nothing");
  // Added from « Appareils » with its code de sécurité checked: it lends its models.
  db.update(accountPeers).set({ checkedTunnelKey: peerById(user.id, LISTED)!.tunnelKey }).where(eq(accountPeers.computerId, LISTED)).run();
  assert.deepEqual(routablePeers(user.id).map((p) => p.computerId).sort(), [MAC, LISTED].sort(), "the checked one still lends its models");

  const computers = (await listComputers(user.id))!;
  const byId = new Map(computers.map((c) => [c.id, c]));
  assert.deepEqual(
    { trusted: byId.get(PI)!.trusted, mesh: byId.get(PI)!.mesh, preferred: byId.get(PI)!.preferred, documents: byId.get(PI)!.documents },
    { trusted: true, mesh: true, preferred: true, documents: { indexed: 0 } },
  );
  assert.deepEqual({ trusted: byId.get(MAC)!.trusted, mesh: byId.get(MAC)!.mesh, peer: byId.get(MAC)!.peer, preferred: byId.get(MAC)!.preferred }, { trusted: true, mesh: true, peer: true, preferred: false });
  assert.deepEqual({ trusted: byId.get(LISTED)!.trusted, mesh: byId.get(LISTED)!.mesh, documents: byId.get(LISTED)!.documents }, { trusted: false, mesh: false, documents: null });
  assert.equal(byId.has("999"), false);

  db.update(users).set({ prefsJson: JSON.stringify({ preferred_computer: `computer:${MAC}` }) }).where(eq(users.id, user.id)).run();
  const preferred = (await listComputers(user.id))!.filter((c) => c.preferred).map((c) => c.id);
  assert.deepEqual(preferred, [MAC]);
  db.update(users).set({ prefsJson: JSON.stringify({ preferred_computer: `computer:${LISTED}` }) }).where(eq(users.id, user.id)).run();
  assert.deepEqual((await listComputers(user.id))!.filter((c) => c.preferred).map((c) => c.id), [PI], "not in the mesh: this computer");
  db.update(users).set({ prefsJson: "{}" }).where(eq(users.id, user.id)).run();

  // « Tâches de fond » only on a roster computer.
  const idle = readStatus({ app_version: "0.3.0", models: [{ id: "qwen3:8b", loaded: true }], load: { cpu_pct: 5, gpu_pct: null, ram_used_pct: 30, at: null }, tps: { "qwen3:8b": 5 }, inflight: 0, accepts: ["chat", "background"], tools: true })!;
  setPeerStatus(MAC, idle);
  setPeerStatus(LISTED, idle);
  assert.equal((await pickBackground({ userId: user.id, preference: `computer:${MAC}`, model: "qwen3:8b" }))?.computerId, MAC);
  assert.equal(await pickBackground({ userId: user.id, preference: `computer:${LISTED}`, model: "qwen3:8b" }), null);
  setPeerStatus(MAC, null);
  setPeerStatus(LISTED, null);
  db.delete(accountPeers).where(eq(accountPeers.computerId, "999")).run();
});

// ── leaving ─────────────────────────────────────────────────────────────────

test("a computer or person device that leaves the roster loses its links and « mesh » sessions within 60 s; what was given otherwise stays", async () => {
  // Given by the console / an endorsement: the Mac only lends its models then.
  const household = pairDevice({ deviceName: "Mac (household)", tunnelPublicKey: hex(), role: "peer", origin: "account", requesterComputerId: MAC });
  mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
  try {
    setRosterSource(async () => input());
    const stopRoster = startRosterRefresh(60_000);
    const stopLinks = startMeshLinks(() => [user.id]);
    const settle = async () => {
      for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
    };
    await settle();
    const session = (id: string) => db.select().from(authSessions).where(eq(authSessions.id, id)).all()[0] ?? null;
    assert.ok(session(macSessionId) && session(phoneSessionId));

    // A person device revokes the Mac and the iPad (a new epoch follows).
    const revoke = new Set([macDevice.id, ipad.id]);
    input = () => {
      const read = vault.input([iphone]);
      for (const d of read.devices) if (revoke.has(d.id)) d.status = "revoked";
      return read;
    };
    mock.timers.tick(59_000);
    await settle();
    assert.ok(session(macSessionId), "not yet looked at");
    mock.timers.tick(1_000);
    await settle();
    assert.equal(session(macSessionId), null, "the Mac's mesh session went");
    assert.equal(session(phoneSessionId), null, "the phone vouched for by the iPad went");
    assert.ok(session(household.sessionId), "the household session stays (conversation only)");
    const link = peerById(user.id, MAC)!;
    assert.deepEqual([link.state, link.error, link.token, link.tunnelKey], ["revoked", "left_mesh", null, null]);
    assert.equal(peerById(user.id, LISTED)!.state, "linked", "a link asked for from « Appareils » stays");
    assert.equal(await isTrustedComputer(MAC), false, "403 on peer documents");
    stopLinks();
    stopRoster();
  } finally {
    mock.timers.reset();
  }
});
