import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Pairing on the LAN is where the tunnel's trust is created and the
// only place it could be: the person read a token printed in their own
// terminal and typed it into their own phone, on their own network.
// After that the two devices recognise each other by key, and no server
// is asked to vouch for either.
//
// The data directory is set before anything imports the database, since
// that is when it is read.
process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-tunnel-pairing-"));

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { db, authSessions, tunnelPeers, users } = await import("../src/db.js");
const { KEY_BYTES } = await import("../src/tunnel/channel.js");
const { tunnelIdentity, tunnelPeersFor, forgetTunnelPeer } = await import("../src/tunnel/identity.js");

const app = await buildApp();

/// The setup token is the first account's, by design: once one exists
/// it stops working, and a second device pairs with a pairing code
/// instead. Each test here wants that first moment, so the temporary
/// database it owns is emptied between them.
function virginServer(): string {
  db.delete(tunnelPeers).run();
  db.delete(authSessions).run();
  db.delete(users).run();
  return ensureSetupToken()!.token;
}

test("a phone that brings a key gets this computer's, and is remembered", async () => {
  const setupToken = virginServer();
  const phoneKey = "a".repeat(64);
  const response = await app.inject({
    method: "POST",
    url: "/auth/pair",
    payload: { setup_token: setupToken, device_name: "iPhone de Jimmy", tunnel_public_key: phoneKey },
  });

  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.equal(body.tunnel_public_key, tunnelIdentity().publicKey.toString("hex"));
  assert.equal(Buffer.from(body.tunnel_public_key, "hex").length, KEY_BYTES);

  const peers = tunnelPeersFor(body.user_id);
  assert.deepEqual(peers.map((peer) => peer.publicKey.toString("hex")), [phoneKey]);
  assert.equal(peers[0].name, "iPhone de Jimmy");

  forgetTunnelPeer({ userId: body.user_id, publicKey: Buffer.from(phoneKey, "hex") });
  assert.deepEqual(tunnelPeersFor(body.user_id), []);
});

test("a device that brings no key pairs as before, and has no tunnel", async () => {
  const setupToken = virginServer();
  const response = await app.inject({
    method: "POST",
    url: "/auth/pair",
    payload: { setup_token: setupToken, device_name: "Apple Watch" },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.json().tunnel_public_key, undefined);
  assert.deepEqual(tunnelPeersFor(response.json().user_id), []);
});

test("what is not a key is refused, and no account is created", async () => {
  const setupToken = virginServer();
  for (const key of ["pas une clé", "ab", "z".repeat(64), "A".repeat(63)]) {
    const response = await app.inject({
      method: "POST",
      url: "/auth/pair",
      payload: { setup_token: setupToken, device_name: "bizarre", tunnel_public_key: key },
    });
    assert.equal(response.statusCode, 422, `accepted ${key.slice(0, 12)}`);
  }
  // Refused before anything was written: the account that a successful
  // pairing would have created is not there.
  assert.deepEqual(db.select().from(users).all(), []);
});

test("a wrong setup token learns nothing about this computer", async () => {
  virginServer();
  const response = await app.inject({
    method: "POST",
    url: "/auth/pair",
    payload: { setup_token: "ce-n-est-pas-le-bon", tunnel_public_key: "b".repeat(64) },
  });

  assert.equal(response.statusCode, 403);
  assert.equal(response.json().tunnel_public_key, undefined);
  assert.equal(response.body.includes(tunnelIdentity().publicKey.toString("hex")), false);
});

test("the computer's key is kept to itself, and does not change", () => {
  const path = join(process.env.TWOODY_DATA_DIR!, "tunnel-identity");
  // Readable by this account and nobody else: it is the one secret that
  // makes every paired device's session its own.
  assert.equal(statSync(path).mode & 0o077, 0);
  assert.match(readFileSync(path, "utf8").trim(), /^[0-9a-f]{64}$/);

  // Asked for twice, the same key: a computer that changed it would ask
  // every paired device to pair again.
  assert.equal(tunnelIdentity().publicKey.toString("hex"), tunnelIdentity().publicKey.toString("hex"));
});

test.after(async () => {
  await app.close();
});
