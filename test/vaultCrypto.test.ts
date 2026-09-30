import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  approvalValid, canonicalHeader, createDeviceKeys, createEpochKey, envelopeSigned, fromHex, openEvent, recoveryCode, recoveryDevice,
  recoverySecret, sealEvent, signApproval, toHex, unwrapEpochKey, wrapEpochKey,
} from "../src/vault/crypto.js";
import { eventIdFor } from "../src/vault/sync.js";
import * as contracts from "../src/vault/contracts.js";

// The server's vault must read the phone's and the Desktop's history byte
// for byte: the vectors are those twoody-app writes and twoody-desktop
// checks (test/fixtures/vault-vectors.json, copied with its origin).

const fixtureUrl = new URL("./fixtures/vault-vectors.json", import.meta.url);
const { _origin: origin, ...vectors } = JSON.parse(readFileSync(fixtureUrl, "utf8"));

function seeded(seed: number) {
  let n = seed;
  return (length: number) => Uint8Array.from({ length }, () => {
    n = (n * 1103515245 + 12345) % 2147483648;
    return n & 255;
  });
}

test("produces exactly the vectors the phone produces", () => {
  const random = seeded(7);
  const a = { deviceId: "iphone", ...createDeviceKeys(random) };
  const b = { deviceId: "mac", ...createDeviceKeys(random) };
  const key = createEpochKey(random);
  const envelope = wrapEpochKey({ epochKey: key, epoch: 1, userId: 42, to: b, from: a, random });
  const event = sealEvent({ epochKey: key, epoch: 1, userId: 42, conversationId: "c-1", eventId: "e-1", kind: "turn", createdAt: "2026-09-28T14:00Z", payload: { q: "Bonjour", r: "Salut !" }, random });
  assert.deepEqual({ aSignPublic: toHex(a.signPublic), bEncPublic: toHex(b.encPublic), epochKey: toHex(key), envelope, event, recovery: recoveryCode(key) }, vectors);
  assert.equal(toHex(unwrapEpochKey(envelope, { userId: 42, device: b, signers: new Map([["iphone", a.signPublic]]) })), vectors.epochKey);
});

test("opens what the phone sealed, and refuses it altered", () => {
  const keys = new Map([[1, fromHex(vectors.epochKey)]]);
  assert.deepEqual(openEvent(vectors.event, keys), { q: "Bonjour", r: "Salut !" });
  assert.throws(() => openEvent({ ...vectors.event, conversation_id: "c-2" }, keys), /bad_event/);
  assert.throws(() => openEvent({ ...vectors.event, epoch: 2 }, keys), /missing_epoch_key/);
  assert.deepEqual(recoverySecret(vectors.recovery), fromHex(vectors.epochKey));
});

test("a key given with fresh randomness opens only with the right device and signer", () => {
  const pi = { deviceId: "pi", ...createDeviceKeys() };
  const phone = { deviceId: "iphone", ...createDeviceKeys() };
  const key = createEpochKey();
  const envelope = wrapEpochKey({ epochKey: key, epoch: 2, userId: 7, to: pi, from: phone });
  assert.deepEqual(unwrapEpochKey(envelope, { userId: 7, device: pi, signers: new Map([["iphone", phone.signPublic]]) }), key);
  assert.throws(() => unwrapEpochKey(envelope, { userId: 7, device: pi, signers: new Map() }), /untrusted_signer/);
  assert.throws(() => unwrapEpochKey(envelope, { userId: 8, device: pi, signers: new Map([["iphone", phone.signPublic]]) }), /not_for_this_device/);
  // Signed by another key under the phone's id: refused.
  const other = createDeviceKeys();
  assert.throws(() => unwrapEpochKey(envelope, { userId: 7, device: pi, signers: new Map([["iphone", other.signPublic]]) }), /bad_signature/);
  const secret = createEpochKey();
  const toRecovery = wrapEpochKey({ epochKey: key, epoch: 2, userId: 7, to: recoveryDevice(secret), from: phone });
  assert.deepEqual(unwrapEpochKey(toRecovery, { userId: 7, device: recoveryDevice(recoverySecret(recoveryCode(secret))), signers: new Map([["iphone", phone.signPublic]]) }), key);
});

test("an envelope's signature checks without the key that opens it", () => {
  const pi = { deviceId: "pi", ...createDeviceKeys() };
  const phone = { deviceId: "iphone", ...createDeviceKeys() };
  const envelope = wrapEpochKey({ epochKey: createEpochKey(), epoch: 3, userId: 7, to: pi, from: phone });
  assert.equal(envelopeSigned(envelope, { userId: 7, signerSignPublic: phone.signPublic }), true);
  assert.equal(envelopeSigned(envelope, { userId: 7, signerSignPublic: createDeviceKeys().signPublic }), false);
  assert.equal(envelopeSigned(envelope, { userId: 8, signerSignPublic: phone.signPublic }), false);
  // Another number, recipient or version than the one signed: refused.
  assert.equal(envelopeSigned({ ...envelope, epoch: 4 }, { userId: 7, signerSignPublic: phone.signPublic }), false);
  assert.equal(envelopeSigned({ ...envelope, to_device: "mac" }, { userId: 7, signerSignPublic: phone.signPublic }), false);
  assert.equal(envelopeSigned({ ...envelope, v: 2 }, { userId: 7, signerSignPublic: phone.signPublic }), false);
  assert.equal(envelopeSigned({ ...envelope, epoch: 2 ** 53 }, { userId: 7, signerSignPublic: phone.signPublic }), false);
  // Malformed: false, never a throw.
  assert.equal(envelopeSigned({ ...envelope, signature: "zz" }, { userId: 7, signerSignPublic: phone.signPublic }), false);
  assert.equal(envelopeSigned(null as never, { userId: 7, signerSignPublic: phone.signPublic }), false);
});

test("the canonical header, the approval and the event ids match the other devices'", () => {
  assert.equal(toHex(canonicalHeader("L", ["ab", 1])), "4c" + "0002" + "6162" + "0001" + "31");
  // The approval the P0 fixture cross-checked with twoody-desktop and twoody-app.
  const binding = JSON.parse(readFileSync(new URL("./fixtures/computer-binding-v1.json", import.meta.url), "utf8"));
  const ap = binding.approval_v1_same_key;
  const iphone = binding.devices.iphone;
  assert.equal(signApproval({ userId: ap.user_id, device: ap.device, approverId: ap.approver_id, signPrivate: fromHex(iphone.sign_private) }), ap.signature);
  assert.ok(approvalValid({ userId: 42, device: ap.device, approverId: ap.approver_id, approverSignPublic: fromHex(iphone.sign_public), signature: ap.signature }));
  assert.ok(!approvalValid({ userId: 43, device: ap.device, approverId: ap.approver_id, approverSignPublic: fromHex(iphone.sign_public), signature: ap.signature }));
  // The sync's event ids are the contracts' (and twoody-desktop's).
  const conversation = "5f0c2a4e-8b1d-4c3e-9a7f-2d6e1b0c9a8f";
  assert.equal(eventIdFor(conversation, "turn", "r1"), contracts.eventIdFor(conversation, "turn", "r1"));
});

test("memory events seal and open like the others (the memories stream, S5)", () => {
  const key = createEpochKey();
  const event = sealEvent({ epochKey: key, epoch: 1, userId: 42, conversationId: "5f0c2a4e-8b1d-4c3e-9a7f-2d6e1b0c9a8f", eventId: "e", kind: "memory", createdAt: "2026-09-30T10:00:00Z", payload: { type: "tombstone" } });
  assert.deepEqual(openEvent(event, new Map([[1, key]])), { type: "tombstone" });
  assert.throws(() => sealEvent({ epochKey: key, epoch: 1, userId: 42, conversationId: "c", eventId: "e", kind: "other", createdAt: "x", payload: null }), /bad_kind/);
});

test("the copied vectors have not drifted from twoody-app and twoody-desktop", (t) => {
  assert.match(origin, /twoody-app test\/fixtures\/vault-vectors\.json/);
  let compared = 0;
  for (const sibling of ["../../twoody-app/test/fixtures/vault-vectors.json", "../../twoody-desktop/test/fixtures/vault-vectors.json"]) {
    const url = new URL(sibling, import.meta.url);
    if (!existsSync(url)) continue;
    assert.deepEqual(JSON.parse(readFileSync(url, "utf8")), vectors, sibling);
    compared += 1;
  }
  if (compared === 0) t.skip("no sibling checkout of twoody-app or twoody-desktop here");
});
