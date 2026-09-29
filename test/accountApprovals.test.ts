import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { x25519 } from "@noble/curves/ed25519.js";
import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { startFakeBackend } from "./helpers/fakeBackend.js";

// Who a headless computer lets in (docs/multi-computer-design.md §2): rule
// 1, the device that added it; rule 2, a request a pinned approver vouched
// for (endorsement v1, the shared vectors); anything else — forged,
// expired, vouched for by a key it never pinned — stays pending for rule 3,
// the console. And what an approval sends back: sealed like the Desktop's
// sealPairing, opened like the app's openAccountPairing.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-account-approvals-"));
delete process.env.TWOODY_USER_TOKEN;
process.env.TWOODY_PUBLIC_URL = "http://192.168.1.42:3000";

const vectors = JSON.parse(readFileSync(new URL("./fixtures/endorsement-v1.json", import.meta.url), "utf8"));
const sealedByDesktop = JSON.parse(readFileSync(new URL("./fixtures/account-pairing-v1.json", import.meta.url), "utf8"));

const backend = await startFakeBackend();
process.env.TWOODY_BACKEND_URL = backend.url;

const { judge, readPending, startApprovalLoop } = await import("../src/account/approvals.js");
const { openPairing, sealPairing } = await import("../src/account/pairingSeal.js");
const { writeAccountFile } = await import("../src/account/store.js");
const { buildApp } = await import("../src/app.js");
const { authSessions, db } = await import("../src/db.js");
const { allTunnelPeers } = await import("../src/tunnel/identity.js");
const { eq } = await import("drizzle-orm");

test.after(() => backend.close());

const host = vectors.host;
const mac = vectors.approvers.mac;
const phone = vectors.approvers.phone;
const account = {
  pairing_key: { priv: host.private_hex, pub: host.public },
  approvers: [{ public_key: mac.public, kind: "computer" as const, name: "Mac de Jimmy" }],
  computer: { id: "42", credential: "c" },
};
const BEFORE = Date.parse("2026-09-29T10:00:00.000Z");

function request(v: (typeof vectors.vectors)[number], endorsements: Array<{ approver_key: string; endorsement: string }>) {
  return readPending({ requests: [{ id: Number(v.rid), name: "iPhone de Claire", public_key: v.requester_key, expires_at: v.expires_at, role: "device", endorsements }] })[0]!;
}

test("rule 2: a request vouched for by the pinned approver is approved, with the shared vectors", () => {
  const v = vectors.vectors[0];
  assert.deepEqual(judge(request(v, [{ approver_key: mac.public, endorsement: v.endorsement }]), account, BEFORE), { approve: true, rule: "endorsed" });
});

test("a forged, misplaced, unpinned or expired endorsement leaves the request pending", () => {
  const v = vectors.vectors[0];
  const forged = Buffer.from(v.endorsement, "base64");
  forged[5]! ^= 0x10;
  const cases: Array<[string, Array<{ approver_key: string; endorsement: string }>]> = [
    ["none", []],
    ["forged", [{ approver_key: mac.public, endorsement: forged.toString("base64") }]],
    ["for another request", [{ approver_key: mac.public, endorsement: vectors.vectors[3].endorsement }]],
    // The phone's endorsement is genuine, but this computer never pinned the phone.
    ["unpinned approver", [{ approver_key: phone.public, endorsement: vectors.vectors[1].endorsement }]],
    ["garbage", [{ approver_key: mac.public, endorsement: "not base64 at all" }]],
  ];
  for (const [name, endorsements] of cases) {
    assert.deepEqual(judge(request(v, endorsements), account, BEFORE), { approve: false, reason: "needs_console" }, name);
  }
  const genuine = [{ approver_key: mac.public, endorsement: v.endorsement }];
  assert.deepEqual(judge(request(v, genuine), account, Date.parse(v.expires_at) + 1), { approve: false, reason: "expired" });
  // Another host id: the same endorsement does not open it.
  assert.deepEqual(judge(request(v, genuine), { ...account, computer: { id: "43", credential: "c" } }, BEFORE), { approve: false, reason: "needs_console" });
});

test("rule 1: the device whose key was pinned when it added this computer is approved", () => {
  const v = vectors.vectors[0];
  const own = readPending({ requests: [{ id: 5, name: "iPhone de Jimmy", public_key: mac.public, expires_at: v.expires_at, role: "device" }] })[0]!;
  assert.deepEqual(judge(own, account, BEFORE), { approve: true, rule: "approver" });
  const stranger = readPending({ requests: [{ id: 6, name: "Inconnu", public_key: phone.public, expires_at: v.expires_at }] })[0]!;
  assert.deepEqual(judge(stranger, account, BEFORE), { approve: false, reason: "needs_console" });
});

test("an envelope sealed by Twoody Desktop opens with this port; this port's opens like the app's", () => {
  const opened = openPairing(sealedByDesktop.requester_private_hex, sealedByDesktop.host_public, sealedByDesktop.request_id, sealedByDesktop.sealed);
  assert.deepEqual(opened, sealedByDesktop.payload);

  const payload = { localServerUrl: "http://192.168.1.42:3000", localServerToken: "t", computerTunnelKey: host.public, computerName: "Pi", computerId: "42", kind: "server" };
  const sealed = sealPairing(host.private_hex, phone.public, "317", payload);
  // The app (utils/accountPairing.js), with noble.
  const frame = Buffer.from(sealed, "base64");
  assert.equal(frame[0], 1);
  const aad = new TextEncoder().encode("twoody-account-pairing-v1:317");
  const key = hkdf(sha256, x25519.getSharedSecret(Buffer.from(phone.private_hex, "hex"), Buffer.from(host.public, "hex")), aad, new TextEncoder().encode("credential envelope"), 32);
  const plain = gcm(key, frame.subarray(1, 13), aad).decrypt(frame.subarray(13));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(plain)), payload);
  assert.throws(() => openPairing(phone.private_hex, host.public, "318", sealed), "another request id does not open it");
});

test("the loop approves by rule 2 against the backend, sealed for the requester, and leaves the rest pending", async () => {
  await buildApp();
  const pi = backend.addComputer({ name: "Raspberry Pi", public_key: host.public, kind: "server", approver_keys: [mac.public] });
  writeAccountFile({
    backend_url: backend.url,
    user_token: backend.userToken,
    device_token: "dev",
    computer: { id: String(pi.id), credential: pi.credential, name: "Raspberry Pi" },
    pairing_key: { priv: host.private_hex, pub: host.public },
    approvers: [{ public_key: mac.public, kind: "computer", name: "Mac" }],
  });
  const expires = new Date(Date.now() + 60_000).toISOString();
  const { endorse } = await import("../src/account/endorsement.js");
  const endorsed = { id: 900, computer_id: pi.id, name: "iPhone de Claire", public_key: phone.public, role: "device" as const, state: "pending" as const, sealed_response: null, expires_at: expires, endorsements: [] as Array<{ approver_key: string; endorsement: string }> };
  endorsed.endorsements.push({ approver_key: mac.public, endorsement: endorse(mac.private_hex, host.public, { hostId: String(pi.id), rid: "900", requesterKey: phone.public, expiresAt: expires }) });
  const peer = { ...endorsed, id: 901, name: "Mac mini", role: "peer" as const, public_key: vectors.vectors[2].requester_key, endorsements: [] };
  peer.endorsements = [{ approver_key: mac.public, endorsement: endorse(mac.private_pkcs8_base64, host.public, { hostId: String(pi.id), rid: "901", requesterKey: peer.public_key, expiresAt: expires }) }] as never;
  const unvouched = { ...endorsed, id: 902, name: "Inconnu", public_key: "cd".repeat(32), endorsements: [] };
  backend.authorizations.push(endorsed, peer, unvouched);

  const logs: string[] = [];
  const loop = startApprovalLoop({ everyMs: 60_000, log: (m) => logs.push(m) });
  const done = await loop.tick();
  loop.stop();
  const decided = new Map(done.map((d) => [d.request.id, d.verdict]));
  assert.deepEqual(decided.get("900"), { approve: true, rule: "endorsed" });
  assert.deepEqual(decided.get("901"), { approve: true, rule: "endorsed" });
  assert.deepEqual(decided.get("902"), { approve: false, reason: "needs_console" });
  assert.equal(endorsed.state, "approved");
  assert.equal(peer.state, "approved");
  assert.equal(unvouched.state, "pending");
  assert.ok(logs.some((l) => l.includes("twoody-server approve")));

  const opened = openPairing(phone.private_hex, host.public, "900", endorsed.sealed_response!) as Record<string, string>;
  assert.equal(opened.localServerUrl, "http://192.168.1.42:3000");
  assert.equal(opened.computerId, String(pi.id));
  assert.equal(opened.kind, "server");
  assert.match(opened.computerTunnelKey, /^[0-9a-f]{64}$/);
  assert.ok(allTunnelPeers().some((p) => p.publicKey.toString("hex") === phone.public), "the phone's key is paired for the tunnel");

  // vectors[2]'s requester is the raw scalar sha256("twoody-endorse-v1 test requester (Mac peer)").
  const peerPrivate = createHash("sha256").update("twoody-endorse-v1 test requester (Mac peer)").digest("hex");
  const peerOpened = openPairing(peerPrivate, host.public, "901", peer.sealed_response!) as Record<string, string>;
  const kinds = db.select().from(authSessions).all().map((s) => s.clientKind);
  assert.ok(kinds.includes("pair:iPhone de Claire"));
  assert.ok(kinds.includes("peer:Mac mini"), "a peer gets a peer-limited session");
  const [peerSession] = db.select().from(authSessions).where(eq(authSessions.clientKind, "peer:Mac mini")).all();
  assert.ok(peerSession);
  assert.ok(peerOpened.localServerToken);
});
