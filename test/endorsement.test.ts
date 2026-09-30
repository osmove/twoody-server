import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { x25519 as nobleX25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { endorse, endorsementMessage, verifyEndorsement } from "../src/account/endorsement.js";
import { publicHexOf } from "../src/account/keys.js";
import { readStatus } from "../src/account/status.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/endorsement-v1.json", import.meta.url), "utf8"));
const schema = JSON.parse(readFileSync(new URL("./fixtures/computer-status.schema.json", import.meta.url), "utf8"));
const approvers = fixture.approvers as Record<string, { private_hex: string; private_pkcs8_base64: string; public: string }>;
const request = (v: { host_id: string; rid: string; requester_key: string; expires_at: string }) => ({
  hostId: v.host_id,
  rid: v.rid,
  requesterKey: v.requester_key,
  expiresAt: v.expires_at,
});

test("the fixture's keys are consistent", () => {
  assert.equal(publicHexOf(fixture.host.private_hex), fixture.host.public);
  assert.equal(publicHexOf(fixture.host.private_pkcs8_base64), fixture.host.public);
  for (const a of Object.values(approvers)) {
    assert.equal(publicHexOf(a.private_hex), a.public);
    assert.equal(publicHexOf(a.private_pkcs8_base64), a.public);
  }
});

test("endorsement v1 reproduces every vector, from raw or PKCS#8 keys", () => {
  for (const v of fixture.vectors) {
    const a = approvers[v.approver]!;
    assert.equal(endorsementMessage(request(v)), v.message, v.name);
    assert.equal(endorse(a.private_hex, fixture.host.public, request(v)), v.endorsement, v.name);
    assert.equal(endorse(a.private_pkcs8_base64, fixture.host.public, request(v)), v.endorsement, v.name);
  }
});

test("an independent implementation (noble, as the app uses) agrees", () => {
  const enc = new TextEncoder();
  for (const v of fixture.vectors) {
    const a = approvers[v.approver]!;
    const secret = nobleX25519.getSharedSecret(Buffer.from(a.private_hex, "hex"), Buffer.from(fixture.host.public, "hex"));
    const key = hkdf(sha256, secret, enc.encode(`twoody-endorse-v1:${v.rid}`), enc.encode("approval endorsement"), 32);
    const mac = hmac(sha256, key, enc.encode(v.message));
    assert.equal(Buffer.from(mac).toString("base64"), v.endorsement, v.name);
  }
});

test("the host verifies with its own private key and the approver's public key", () => {
  for (const v of fixture.vectors) {
    const a = approvers[v.approver]!;
    assert.equal(verifyEndorsement(fixture.host.private_hex, a.public, request(v), v.endorsement), true, v.name);
  }
});

test("a forged, reused or mismatched endorsement does not verify", () => {
  const v = fixture.vectors[0];
  const mac = approvers.mac!.public;
  const phone = approvers.phone!.public;
  const host = fixture.host.private_hex;
  assert.equal(verifyEndorsement(host, phone, request(v), v.endorsement), false, "wrong approver");
  assert.equal(verifyEndorsement(host, mac, { ...request(v), rid: "318" }, v.endorsement), false, "another request");
  assert.equal(verifyEndorsement(host, mac, { ...request(v), hostId: "43" }, v.endorsement), false, "another host");
  assert.equal(verifyEndorsement(host, mac, { ...request(v), requesterKey: phone }, v.endorsement), false, "another requester");
  assert.equal(verifyEndorsement(host, mac, { ...request(v), expiresAt: "2026-09-30T10:15:00.000Z" }, v.endorsement), false, "longer life");
  const flipped = Buffer.from(v.endorsement, "base64");
  flipped[0]! ^= 1;
  assert.equal(verifyEndorsement(host, mac, request(v), flipped.toString("base64")), false, "one bit");
  for (const junk of ["", "AAAA", 42, null, undefined, "x".repeat(200)]) {
    assert.equal(verifyEndorsement(host, mac, request(v), junk), false, String(junk));
  }
  assert.equal(verifyEndorsement(host, "not-a-key", request(v), v.endorsement), false);
});

test("the status schema's example is a status, and the reader keeps to the schema's fields", () => {
  const example = schema.examples[0];
  assert.deepEqual(readStatus(example), example);
  assert.deepEqual(Object.keys(example).sort(), [...schema.required].sort());
  assert.deepEqual(Object.keys(schema.properties.load.properties).sort(), [...schema.properties.load.required].sort());
  assert.equal(readStatus({ ...example, inflight: -1 }), null);
  assert.equal(readStatus({ ...example, accepts: ["chat", "chat"] }), null);
  assert.equal(readStatus({ ...example, load: { ...example.load, cpu_pct: 140 } }), null);
  assert.equal(readStatus({ ...example, models: [{ id: "", loaded: true }] }), null);
  assert.equal(readStatus({ ...example, models: Array.from({ length: 33 }, (_, i) => ({ id: `m${i}`, loaded: false })) }), null);
  assert.equal(readStatus("status"), null);
});

test("the engine is optional in a status: kept when it is one of ours, dropped otherwise", () => {
  const example = schema.examples[0];
  assert.equal(readStatus(example)!.engine, undefined);
  assert.equal(readStatus({ ...example, engine: "builtin" })!.engine, "builtin");
  assert.equal(readStatus({ ...example, engine: null })!.engine, null);
  const odd = readStatus({ ...example, engine: "vllm" })!;
  assert.ok(odd && !("engine" in odd));
  assert.deepEqual(schema.properties.engine.enum, ["builtin", "ollama", "lmstudio", "mlx", "custom", null]);
});
