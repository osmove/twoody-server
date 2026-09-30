import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A phone stays the person on a computer past the day its device-access
// holds (sessionTrust.ts renewDeviceAccess, POST /session/device-access):
// it signs a fresh one and sends it over the sealed tunnel, no account in
// between. And Jimmy's setup (final review N2): his iPhone, paired with
// his Mac by QR code (the code on the Mac's screen), is a member of the
// history — once it sends a device-access, it reads the memories, the
// synchronised history and the other computers' documents there; a phone
// paired by code that is no member stays limited to this computer's own.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-device-access-renewal-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
delete process.env.TWOODY_USER_TOKEN;
delete process.env.TWOODY_BACKEND_URL;

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { authSessions, db, sqlite } = await import("../src/db.js");
const { pairDevice } = await import("../src/pairing.js");
const { setDesktopAccount } = await import("../src/account/service.js");
const { importVaultConversation } = await import("../src/routes/discussions.js");
const { setRosterSource } = await import("../src/vault/roster.js");
const { meshVault } = await import("./helpers/meshVault.js");
const { eq } = await import("drizzle-orm");

const MAC = "0b8c7d6e-5f4a-4b3c-9d2e-1f0a9b8c7d6e";
const PI = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const OTHER = "3c2b1a0f-9e8d-4c7b-8a69-584736251403";
const VAULT_ID = "6e4d3c2b-1a0f-4e9d-8c7b-a69584736251";

setDesktopAccount({ backendUrl: "http://127.0.0.1:9", userToken: "unused", computerId: MAC, computerName: "Mac de Jimmy" });
const app = await buildApp();
test.after(async () => {
  setRosterSource(null);
  delete process.env.TWOODY_PAIRING_CODE;
  await app.close();
});

// The Mac's Desktop: this server's owner.
const desktop = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const owner = { authorization: `Bearer ${desktop.json().token}` };
const userId = desktop.json().user_id as string;

// The history: the iPhone founded it (the Mac's anchor), the Mac is a
// Desktop it approved, the Pi a computer it bound.
const vault = meshVault(userId);
const iphone = vault.person("iPhone de Jimmy");
const mac = vault.desktop("Mac de Jimmy", MAC, iphone);
vault.computer("Raspberry Pi", PI, iphone);
const stranger = meshVault(userId).person("Pas de l'historique");
await setRosterSource(async () => vault.input([iphone])).refresh();

// The person's memory and synchronised conversation, and one of this Mac's own.
const made = await app.inject({ method: "POST", url: "/api/v1/memories", headers: owner, payload: { memory: { content: "Mon garagiste s'appelle Martin" } } });
assert.equal(made.statusCode, 201);
const synced = importVaultConversation(userId, { vault_id: VAULT_ID, title: "Garage", turns: [{ ref: "t1", text: "Mon garagiste ?", reply: "Martin." }] });
assert.ok(!("error" in synced));
sqlite.prepare("INSERT INTO discussions (id, user_id, channel, title, created_at, last_activity_at) VALUES ('local-1', ?, 'desktop', 'Ici', 1, 1)").run(userId);

/// What the tunnel stamps on a request it serves from `key`.
const sealedFrom = (key: string) => ({ "x-twoody-via-tunnel": "relay", "x-twoody-tunnel-peer": key });
const nowS = () => Math.floor(Date.now() / 1000);

/// Pairs a phone by the code the Mac shows (its QR code carries it), with its tunnel key.
async function pairByCode(name: string, tunnelKey: string) {
  process.env.TWOODY_PAIRING_CODE = "K7M2Q9XR";
  const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: "k7m2q9xr", device_name: name, tunnel_public_key: tunnelKey } });
  assert.equal(paired.statusCode, 201, paired.body);
  return { authorization: `Bearer ${paired.json().token}`, ...sealedFrom(tunnelKey), sessionId: paired.json().session_id as string };
}

const renew = (headers: Record<string, string>, body: unknown, url = "/api/v1/session/device-access") =>
  app.inject({ method: "POST", url, headers, payload: body as Record<string, unknown> });

/// What only the person reaches here: the memories, the synchronised
/// history, the other computers' documents (the Pi, not linked: offline).
async function reaches(headers: Record<string, string>) {
  const memories = await app.inject({ method: "GET", url: "/api/v1/memories", headers });
  const listed = await app.inject({ method: "GET", url: "/api/v1/discussions", headers });
  const opened = await app.inject({ method: "GET", url: `/api/v1/discussions/${synced.id}`, headers });
  const documents = await app.inject({ method: "GET", url: "/local_documents/computers", headers });
  return {
    memories: memories.statusCode === 200 ? memories.json().map((m: { content: string }) => m.content).sort() : memories.json(),
    history: listed.json().discussions.map((d: { id: string }) => d.id).sort(),
    opened: opened.statusCode,
    documents: documents.json().computers.map((c: { computer_id: string }) => c.computer_id),
  };
}

const person = { memories: ["Mon garagiste s'appelle Martin"], history: ["local-1", synced.id].sort(), opened: 200, documents: [PI] };
const limited = { memories: { error: "person_device_required" }, history: ["local-1"], opened: 404, documents: [] };

test("Jimmy's iPhone, paired with his Mac by QR code and a member of the history: memories, synced history and documents once it sends its device-access", async () => {
  const phoneKey = randomBytes(32).toString("hex");
  const { sessionId, ...phone } = await pairByCode("iPhone de Jimmy", phoneKey);
  // Paired by code: nobody yet, as before.
  assert.deepEqual(await reaches(phone), limited);

  const sent = await renew(phone, vault.deviceAccess(iphone, phoneKey, MAC, nowS() + 24 * 3600));
  assert.equal(sent.statusCode, 200, sent.body);
  assert.equal(sent.json().vault_device_id, iphone.id);
  assert.deepEqual(await reaches(phone), person);
  // It writes one too, which goes to every computer of the history.
  const wrote = await app.inject({ method: "POST", url: "/api/v1/memories", headers: phone, payload: { memory: { content: "Pneus changés en septembre" } } });
  assert.equal(wrote.statusCode, 201, wrote.body);
  // Its session stays the code's: nothing about how it was let in changed.
  const row = db.select().from(authSessions).where(eq(authSessions.id, sessionId)).all()[0]!;
  assert.deepEqual([row.origin, row.approvalRule, row.vaultDeviceId], ["code", null, iphone.id]);

  // The token through the tunnel from another key is not the iPhone.
  const bare = { authorization: phone.authorization };
  assert.deepEqual((await reaches({ ...bare, ...sealedFrom(randomBytes(32).toString("hex")) })).memories, { error: "person_device_required" }, "through the tunnel from another key");

  // The iPhone leaves the history: limited again, its pairing kept.
  await setRosterSource(async () => ({ ...vault.input([mac]), devices: vault.input([mac]).devices.filter((d) => d.id !== iphone.id) })).refresh();
  assert.deepEqual(await reaches(phone), limited);
  await setRosterSource(async () => vault.input([iphone])).refresh();
  assert.deepEqual(await reaches(phone), { ...person, memories: [...person.memories, "Pneus changés en septembre"].sort() });
});

test("a phone paired by code that is no member of the history stays limited, whatever it signs", async () => {
  const key = randomBytes(32).toString("hex");
  const { sessionId: _id, ...ipad } = await pairByCode("iPad de la cuisine", key);
  const refused = await renew(ipad, meshVault(userId).deviceAccess(stranger, key, MAC));
  assert.equal(refused.statusCode, 403);
  assert.deepEqual(refused.json(), { error: "not_a_person_device" });
  // The iPhone's statement, for another key: not this iPad's.
  const iphoneKey = randomBytes(32).toString("hex");
  const borrowed = await renew(ipad, vault.deviceAccess(iphone, iphoneKey, MAC));
  assert.equal(borrowed.statusCode, 403);
  assert.deepEqual(borrowed.json(), { error: "wrong_tunnel_key" });
  // Claiming the iPhone's id with a signature of another key.
  const forged = { ...vault.deviceAccess(stranger, key, MAC), vault_device_id: iphone.id };
  assert.equal((await renew(ipad, forged)).statusCode, 403);
  assert.deepEqual(await reaches(ipad), limited);
});

test("renewal: before expiry the phone signs again and stays the person; past its exp it no longer is", async () => {
  const phoneKey = randomBytes(32).toString("hex");
  const { sessionId, ...phone } = await pairByCode("iPhone de Jimmy", phoneKey);
  // A day's statement, about to end.
  const first = vault.deviceAccess(iphone, phoneKey, MAC, nowS() + 2);
  assert.equal((await renew(phone, first)).statusCode, 200);
  assert.deepEqual((await reaches(phone)).memories.length > 0, true);
  // Renewed before it ends: the new one is kept.
  const second = vault.deviceAccess(iphone, phoneKey, MAC, nowS() + 24 * 3600);
  const renewed = await renew(phone, second);
  assert.equal(renewed.statusCode, 200);
  assert.equal(renewed.json().exp, second.exp);
  // An older one sent again never shortens it.
  const replay = await renew(phone, vault.deviceAccess(iphone, phoneKey, MAC, nowS() + 60));
  assert.equal(replay.json().exp, second.exp);
  assert.equal(JSON.parse(db.select().from(authSessions).where(eq(authSessions.id, sessionId)).all()[0]!.deviceAccessJson!).exp, second.exp);

  // Without renewal, a statement past its exp is nobody: the refresh path is the way back.
  const lateKey = randomBytes(32).toString("hex");
  const late = await pairByCode("iPhone de Jimmy", lateKey);
  assert.equal((await renew(late, vault.deviceAccess(iphone, lateKey, MAC, nowS() + 1))).statusCode, 200);
  await new Promise((resolve) => setTimeout(resolve, 2100));
  assert.deepEqual((await reaches(late)).memories, { error: "person_device_required" }, "expired");
  assert.equal((await renew(late, vault.deviceAccess(iphone, lateKey, MAC, nowS() + 3600))).statusCode, 200);
  assert.deepEqual((await reaches(late)).memories.length > 0, true, "back once renewed");
});

test("a rule-5 session renews the same way, and only as the device it is", async () => {
  const phoneKey = randomBytes(32).toString("hex");
  const access = vault.deviceAccess(iphone, phoneKey, MAC, nowS() + 60);
  const session = pairDevice({ deviceName: "iPhone de Jimmy", tunnelPublicKey: phoneKey, origin: "mesh", vaultDeviceId: iphone.id, approvalRule: "device_access", deviceAccessJson: JSON.stringify(access) });
  const headers = { authorization: `Bearer ${session.token}`, ...sealedFrom(phoneKey) };
  assert.equal((await renew(headers, vault.deviceAccess(iphone, phoneKey, MAC, nowS() + 24 * 3600))).statusCode, 200);
  // The Mac (a person device too) cannot make this session its own.
  const other = await renew(headers, vault.deviceAccess(mac, phoneKey, MAC));
  assert.equal(other.statusCode, 409);
  assert.deepEqual(other.json(), { error: "other_vault_device" });
});

test("what the refresh endpoint refuses: not sealed, another computer, too long, expired, a peer, the owner", async () => {
  const phoneKey = randomBytes(32).toString("hex");
  const { sessionId: _id, ...phone } = await pairByCode("iPhone de Jimmy", phoneKey);
  const cases: Array<[string, Record<string, string>, unknown, number, string]> = [
    ["not through the tunnel", { authorization: phone.authorization }, vault.deviceAccess(iphone, phoneKey, MAC), 403, "pinned_channel_required"],
    ["for another computer", phone, vault.deviceAccess(iphone, phoneKey, OTHER), 422, "device_access_not_usable"],
    ["more than a day ahead", phone, vault.deviceAccess(iphone, phoneKey, MAC, nowS() + 25 * 3600), 422, "device_access_not_usable"],
    ["expired", phone, vault.deviceAccess(iphone, phoneKey, MAC, nowS() - 1), 422, "device_access_not_usable"],
    ["not a device-access/v2", phone, vault.deviceAccessV1(iphone, phoneKey), 422, "invalid_device_access"],
    ["the owner", { ...owner, ...sealedFrom(phoneKey) }, vault.deviceAccess(iphone, phoneKey, MAC), 409, "owner_session"],
  ];
  for (const [why, headers, body, status, error] of cases) {
    const res = await renew(headers, body);
    assert.equal(res.statusCode, status, `${why}: ${res.body}`);
    assert.deepEqual(res.json(), { error }, why);
  }
  // A computer's peer session: never through this route, never a person.
  const piKey = randomBytes(32).toString("hex");
  const pi = pairDevice({ deviceName: "Raspberry Pi", tunnelPublicKey: piKey, role: "peer", origin: "mesh", requesterComputerId: PI, approvalRule: "mesh_computer" });
  const peer = await renew({ authorization: `Bearer ${pi.token}`, ...sealedFrom(piKey) }, vault.deviceAccess(iphone, piKey, MAC));
  assert.equal(peer.statusCode, 403);
  // Nor through the Desktop's route, naming no vault device of its own.
  const asDesktop = await renew({ authorization: `Bearer ${pi.token}`, ...sealedFrom(piKey) }, vault.deviceAccess(iphone, piKey, MAC), "/api/v1/peer/session/device-access");
  assert.equal(asDesktop.statusCode, 403);
  assert.deepEqual(asDesktop.json(), { error: "not_a_desktop_session" });
});
