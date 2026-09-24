import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The devices paired with a computer, listed in Twoody Desktop's settings
// and removable there: the session goes, and the key the device would
// reach the computer with from outside. There was no way to undo a
// pairing before, and a phone that signed out was still waited for at the
// relay. Its own file: pairing is rate-limited per process.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-paired-devices-"));
process.env.TWOODY_PAIRING_CODE = "K7M2Q9XR";

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { db, tunnelPeers } = await import("../src/db.js");
const { rememberTunnelPeer } = await import("../src/tunnel/identity.js");

const app = await buildApp();
const desktop = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
assert.equal(desktop.statusCode, 201);
const asDesktop = { authorization: `Bearer ${desktop.json().token}` };
const account = desktop.json().user_id as string;

async function pairPhone(name: string, key: string) {
  const phone = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: "K7M2Q9XR", device_name: name, tunnel_public_key: key } });
  assert.equal(phone.statusCode, 201, phone.body);
  return { sessionId: phone.json().session_id as string, headers: { authorization: `Bearer ${phone.json().token}` } };
}

const list = async (headers: Record<string, string>) =>
  (await app.inject({ method: "GET", url: "/api/v1/paired_devices", headers })).json().devices as Array<Record<string, unknown>>;

test("a paired phone is listed, and removing it takes its session and its key", async () => {
  const phone = await pairPhone("iPhone de Jimmy", "a1".repeat(32));
  const devices = await list(asDesktop);
  assert.deepEqual(
    devices.map((device) => [device.name, device.this_device, device.reachable_from_outside]),
    [
      ["Twoody Desktop", true, false],
      ["iPhone de Jimmy", false, true],
    ],
  );

  assert.equal((await app.inject({ method: "DELETE", url: `/paired_devices/${devices[0]!.id}`, headers: asDesktop })).statusCode, 409, "not itself");
  assert.equal((await app.inject({ method: "DELETE", url: `/paired_devices/${phone.sessionId}`, headers: asDesktop })).statusCode, 204);
  assert.equal((await app.inject({ method: "GET", url: "/auth/me", headers: phone.headers })).statusCode, 401, "its session is gone");
  assert.equal(db.select().from(tunnelPeers).all().some((peer) => peer.publicKey === "a1".repeat(32)), false, "and its key");
  assert.deepEqual((await list(asDesktop)).map((device) => device.name), ["Twoody Desktop"]);
  assert.equal((await app.inject({ method: "DELETE", url: `/paired_devices/${phone.sessionId}`, headers: asDesktop })).statusCode, 404);
});

test("a phone that signs out forgets its key: the computer stops waiting for it", async () => {
  const phone = await pairPhone("iPad", "b2".repeat(32));
  assert.equal(db.select().from(tunnelPeers).all().some((peer) => peer.publicKey === "b2".repeat(32)), true);
  assert.equal((await app.inject({ method: "DELETE", url: "/session", headers: phone.headers })).statusCode, 200);
  assert.equal(db.select().from(tunnelPeers).all().some((peer) => peer.publicKey === "b2".repeat(32)), false);
});

test("a key paired before sessions and keys were linked is listed, and removable", async () => {
  rememberTunnelPeer({ userId: account, publicKey: Buffer.from("c3".repeat(32), "hex"), name: "Ancien iPhone" });
  const legacy = (await list(asDesktop)).find((device) => device.name === "Ancien iPhone");
  assert.equal(legacy?.id, `key:${"c3".repeat(32)}`);
  assert.equal((await app.inject({ method: "DELETE", url: `/paired_devices/${legacy!.id}`, headers: asDesktop })).statusCode, 204);
  assert.equal((await list(asDesktop)).some((device) => device.name === "Ancien iPhone"), false);
  assert.equal((await app.inject({ method: "DELETE", url: `/paired_devices/key:${"d4".repeat(32)}`, headers: asDesktop })).statusCode, 404);
});
