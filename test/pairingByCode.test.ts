import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Pairing a phone with a computer that already has its account — which,
// on Twoody Desktop, is every computer. Its own file, because pairing is
// rate-limited per route and per address, and a file is a fresh process.
//
// The data directory is set before anything imports the database, since
// that is when it is read.
process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-pairing-by-code-"));

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { db, authSessions, tunnelPeers, users } = await import("../src/db.js");
const { tunnelIdentity, tunnelPeersFor } = await import("../src/tunnel/identity.js");

const app = await buildApp();

function virginServer(): string {
  db.delete(tunnelPeers).run();
  db.delete(authSessions).run();
  db.delete(users).run();
  return ensureSetupToken()!.token;
}

// Twoody Desktop spends the setup token on its own account the first
// time it starts its server, so from then on a phone pairs into that
// account with the code the server was started with — new at every
// start, shown on the computer's screen. Until this was fixed the
// desktop's QR code carried the spent setup token, and every scan was
// refused with "ce code d'appairage n'est plus valable".
test("once the computer has its account, a phone pairs into it with the code of this start", async () => {
  const setupToken = virginServer();
  // The desktop's own first launch.
  const desktop = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: setupToken, device_name: "Twoody Desktop" } });
  assert.equal(desktop.statusCode, 201);
  const account = desktop.json().user_id;

  process.env.TWOODY_PAIRING_CODE = "K7M2Q9XR";
  try {
    // The spent setup token is refused, as before…
    const stale = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: setupToken, device_name: "iPhone" } });
    assert.equal(stale.statusCode, 403);

    // …and the code of this start pairs, into the same account, with the
    // key exchange the tunnel rests on. Typed in lower case, it still is.
    const phoneKey = "e5".repeat(32);
    const phone = await app.inject({
      method: "POST",
      url: "/auth/pair",
      payload: { setup_token: " k7m2q9xr ", device_name: "iPhone de Jimmy", tunnel_public_key: phoneKey },
    });
    assert.equal(phone.statusCode, 201);
    assert.equal(phone.json().user_id, account, "the computer's account, not a second one");
    assert.equal(db.select().from(users).all().length, 1);
    assert.equal(phone.json().tunnel_public_key, tunnelIdentity().publicKey.toString("hex"));
    assert.deepEqual(
      tunnelPeersFor(account).map((peer) => peer.publicKey.toString("hex")),
      [phoneKey],
    );

    // A code of another start is nothing.
    const wrong = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: "K7M2Q9XA", device_name: "iPhone" } });
    assert.equal(wrong.statusCode, 403);
  } finally {
    delete process.env.TWOODY_PAIRING_CODE;
  }
});

test("before any account exists, the code of a start opens nothing: the setup token comes first", async () => {
  virginServer();
  process.env.TWOODY_PAIRING_CODE = "K7M2Q9XR";
  try {
    const early = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: "K7M2Q9XR", device_name: "iPhone" } });
    assert.equal(early.statusCode, 403);
    assert.equal(db.select().from(users).all().length, 0);
  } finally {
    delete process.env.TWOODY_PAIRING_CODE;
  }
});

test.after(async () => {
  await app.close();
});
