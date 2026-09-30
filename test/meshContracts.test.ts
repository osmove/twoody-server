import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Fastify from "fastify";
import { ed25519 } from "@noble/curves/ed25519.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalHeader, fromHex, toHex } from "../src/compute/sealBase.js";
import * as c from "../src/vault/contracts.js";
import { estimate, priorTps, rank } from "../src/router/score.js";

// The mesh contracts (docs/mesh-design.md lot P0): every fixture is read
// back through the reference (src/vault/contracts.ts), the schemas through
// Fastify's own Ajv, the rank table through today's router. The same
// fixtures were checked against twoody-desktop's and twoody-app's vault.js
// (approval, canonical header, openEvent, eventIdFor) and the backend's
// Ruby encoding when they were written.

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const binding = fixture("computer-binding-v1.json");
const access = fixture("device-access-v1.json");
const memories = fixture("memory-lww-vectors.json");
const EPOCH_ONE = fromHex(memories.epoch_one_key);

test("computer-binding/v1: the vectors, signed like the v1 approval", () => {
  for (const [name, device] of Object.entries<{ sign_private: string; sign_public: string }>(binding.devices)) {
    assert.equal(toHex(ed25519.getPublicKey(fromHex(device.sign_private))), device.sign_public, name);
  }
  // The same iPhone key signs the ordinary approval and the binding.
  const ap = binding.approval_v1_same_key;
  const approval = canonicalHeader("twoody/vault/approval/v1", [1, ap.user_id, ap.device.id, ap.device.enc_public, ap.device.sign_public, ap.approver_id]);
  assert.equal(toHex(approval), ap.statement_hex);
  assert.ok(ed25519.verify(fromHex(ap.signature), approval, fromHex(binding.devices.iphone.sign_public)));

  for (const v of binding.vectors) {
    const { approver_id, signature, ...bound } = v.wire;
    assert.equal(approver_id, binding.devices[v.verified_with].id, v.name);
    assert.equal(toHex(c.bindingStatement(v.user_id, bound)), v.statement_hex, v.name);
    assert.equal(c.bindingValid({ userId: v.user_id, binding: bound, signerSignPublic: fromHex(binding.devices[v.verified_with].sign_public), signature }), v.expected.valid, v.name);
    if (v.expected.valid) assert.equal(c.signBinding({ userId: Number(v.user_id), binding: bound, signPrivate: fromHex(binding.devices[v.signed_by].sign_private) }), signature, v.name);
  }
  const pi = binding.vectors[1].wire;
  assert.equal(pi.can_approve, false);
  // Another account, a malformed key or signature: refused, never thrown.
  const { approver_id: _a, signature, ...bound } = pi;
  const key = fromHex(binding.devices.iphone.sign_public);
  assert.equal(c.bindingValid({ userId: "43", binding: bound, signerSignPublic: key, signature }), false);
  assert.equal(c.bindingValid({ userId: "42", binding: { ...bound, tunnel_public_key: bound.tunnel_public_key.toUpperCase() }, signerSignPublic: key, signature }), false);
  assert.equal(c.bindingValid({ userId: "42", binding: bound, signerSignPublic: key, signature: "zz" }), false);
  assert.equal(c.bindingValid({ userId: "42", binding: { ...bound, can_approve: "false" as unknown as boolean }, signerSignPublic: key, signature }), false);
  assert.throws(() => c.bindingStatement("42", { ...bound, pairing_public_key: "" }), /bad_binding/);
});

test("device-access/v1: the vectors", () => {
  for (const v of access.vectors) {
    const { signature, ...stated } = v.wire;
    assert.equal(toHex(c.deviceAccessStatement(v.user_id, stated)), v.statement_hex, v.name);
    assert.equal(c.deviceAccessValid({ userId: v.user_id, access: stated, signerSignPublic: fromHex(access.devices[v.verified_with].sign_public), signature }), v.expected.valid, v.name);
    if (v.expected.valid) assert.equal(c.signDeviceAccess({ userId: v.user_id, access: stated, signPrivate: fromHex(access.devices[v.signed_by].sign_private) }), signature, v.name);
  }
  // A binding's signature is not a device-access signature (different labels).
  const b = binding.vectors[0];
  assert.equal(c.deviceAccessValid({ userId: "42", access: { vault_device_id: b.wire.vault_device_id, tunnel_public_key: b.wire.tunnel_public_key }, signerSignPublic: fromHex(binding.devices.iphone.sign_public), signature: b.wire.signature }), false);
});

test("memories: stream id, learned ids, content hash, event ids", () => {
  assert.equal(c.memoriesStreamId(EPOCH_ONE), memories.memories_stream_id);
  assert.equal(toHex(c.learnedIdKey(EPOCH_ONE)), memories.learned_id_key);
  for (const n of memories.normalise) {
    assert.equal(c.normaliseMemoryContent(n.input), n.normalised, n.input);
    assert.equal(c.memoryContentHash(n.input), n.content_hash, n.input);
  }
  for (const l of memories.learned_ids) {
    assert.equal(c.memoryContentHash(l.content), l.content_hash);
    assert.equal(c.learnedMemoryId(EPOCH_ONE, l.content_hash), l.memory_id);
  }
  for (const e of memories.event_ids) assert.equal(c.memoryEventId(memories.memories_stream_id, e.payload), e.event_id);
  assert.throws(() => c.memoriesStreamId(new Uint8Array(16)), /bad_epoch_key/);
});

test("memories: the HLC", () => {
  for (const h of memories.hlc) {
    const got = h.op === "tick" ? c.hlcTick(h.last, h.now) : c.hlcReceive(h.last, h.remote, h.now);
    assert.equal(got, h.expected, JSON.stringify(h));
  }
  assert.throws(() => c.parseHlc("2026-09-30T10:00:00Z"), /bad_hlc/);
  assert.ok(c.formatHlc({ wall: 999, counter: 3 }) < c.formatHlc({ wall: 1000, counter: 0 }));
});

test("memories: the sealed event opens as a vault event of the stream", () => {
  const { payload, ...sealed } = memories.sealed_memory_event;
  assert.equal(sealed.conversation_id, memories.memories_stream_id);
  assert.equal(sealed.event_id, c.memoryEventId(memories.memories_stream_id, payload));
  const key = hkdf(sha256, EPOCH_ONE, new TextEncoder().encode("twoody/vault/conversation/v1"), new TextEncoder().encode(sealed.conversation_id), 32);
  const aad = canonicalHeader("twoody/vault/event/v1", [sealed.v, sealed.user_id, sealed.conversation_id, sealed.event_id, sealed.epoch, sealed.kind, sealed.created_at]);
  const plain = xchacha20poly1305(key, fromHex(sealed.nonce), aad).decrypt(fromHex(sealed.ciphertext));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(plain)), payload);
  assert.deepEqual(c.readMemoryEvent(payload), payload);
});

test("memories: last writer wins, in any order", () => {
  for (const s of memories.scenarios) {
    const orders = [s.events, [...s.events].reverse(), [...s.events.slice(1), ...s.events.slice(0, 1)], [...s.events, ...s.events]];
    for (const events of orders) assert.deepEqual(c.mergeMemories(events, { epochOne: EPOCH_ONE }), s.expected, s.name);
  }
});

async function schemaApp() {
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false, allErrors: true } } });
  app.addSchema(fixture("memory-event.schema.json"));
  app.addSchema(fixture("peer-documents-search.schema.json"));
  const check = (path: string, ref: string) => app.post(path, { schema: { body: { $ref: ref } } }, async () => ({ ok: true }));
  check("/memory", "memory-event.schema.json#");
  check("/request", "peer-documents-search.schema.json#/definitions/request");
  check("/response", "peer-documents-search.schema.json#/definitions/response");
  check("/error", "peer-documents-search.schema.json#/definitions/error");
  await app.ready();
  return async (path: string, body: unknown) => (await app.inject({ method: "POST", url: path, payload: body as object })).statusCode === 200;
}

test("memory-event schema: compiles in Fastify and agrees with the reference", async () => {
  const valid = await schemaApp();
  const schema = fixture("memory-event.schema.json");
  for (const example of [...schema.definitions.memory.examples, ...schema.definitions.tombstone.examples]) assert.ok(await valid("/memory", example));
  for (const s of memories.scenarios) {
    for (const e of s.events) assert.equal(await valid("/memory", e.payload), c.readMemoryEvent(e.payload) !== null, `${s.name}: ${JSON.stringify(e.payload)}`);
  }
});

test("peer documents search schema: requests and responses, and never a path", async () => {
  const valid = await schemaApp();
  const schema = fixture("peer-documents-search.schema.json");
  const [request, followUp] = schema.definitions.request.examples;
  const response = schema.definitions.response.examples[0];
  assert.ok(await valid("/request", request));
  assert.ok(await valid("/request", followUp));
  assert.ok(await valid("/response", response));
  assert.ok(await valid("/error", schema.definitions.error.examples[0]));
  for (const p of [...response.passages, ...response.files]) {
    assert.deepEqual(c.parseSourceId(p.source_id), { computerId: response.computer_id, documentId: p.document_id });
  }
  assert.equal(c.citationUrl(response.computer_id, response.passages[0].document_id), `twoody://doc/${response.computer_id}/${response.passages[0].document_id}`);

  const refused: Array<[string, unknown]> = [
    ["limit over 8", { ...request, limit: 9 }],
    ["deadline over 3 s", { ...request, deadline_ms: 5000 }],
    ["budget over 10 000", { ...request, budget_chars: 10001 }],
    ["selected without folders", { ...request, scope: { mode: "selected" } }],
    ["all with folders", { ...request, scope: { mode: "all", folder_ids: ["a"] } }],
    ["the caller naming itself", { ...request, requester_computer_id: "x" }],
    ["empty question", { ...request, q: "" }],
  ];
  for (const [name, body] of refused) assert.equal(await valid("/request", body), false, name);

  const passage = response.passages[0];
  const withPassage = (over: Record<string, unknown>) => ({ ...response, passages: [{ ...passage, ...over }] });
  const leaks: Array<[string, unknown]> = [
    ["an absolute path field", withPassage({ path: "/Users/jimmy/Documents/Contrats/contrat-dupont.pdf" })],
    ["rel_path absolute", withPassage({ rel_path: "/Users/jimmy/Documents/Contrats/contrat-dupont.pdf" })],
    ["rel_path Windows", withPassage({ rel_path: "C:\\Users\\jimmy\\contrat.pdf" })],
    ["rel_path drive with slashes", withPassage({ rel_path: "C:/Users/jimmy/contrat.pdf" })],
    ["rel_path home", withPassage({ rel_path: "~/Documents/contrat.pdf" })],
    ["rel_path climbing", withPassage({ rel_path: "2026/../../secret.pdf" })],
    ["rel_path dot segment", withPassage({ rel_path: "./contrat.pdf" })],
    ["rel_path empty segment", withPassage({ rel_path: "2026//contrat.pdf" })],
    ["rel_path trailing slash", withPassage({ rel_path: "2026/" })],
    ["folder as a path", withPassage({ folder: "/Users/jimmy/Documents/Contrats" })],
    ["name with a slash", withPassage({ name: "Contrats/contrat.pdf" })],
    ["source_id without computer", withPassage({ source_id: passage.document_id })],
    ["page 0", withPassage({ page: 0 })],
    ["nine passages", { ...response, passages: Array.from({ length: 9 }, () => passage) }],
    ["a file with a path", { ...response, files: [{ ...response.files[0], path: "/Users/jimmy/x.pdf" }] }],
  ];
  for (const [name, body] of leaks) assert.equal(await valid("/response", body), false, name);
  assert.ok(await valid("/response", withPassage({ rel_path: "contrat-dupont.pdf" })));
  assert.ok(await valid("/response", withPassage({ rel_path: "Été 2026/..résumé.pdf" })));
  assert.equal(c.parseSourceId("/Users/jimmy:x"), null);
  assert.throws(() => c.sourceId("mac", "abc"), /bad_source_id/);
});

test("rank table: today's router, row by row", () => {
  const table = fixture("rank-table.json");
  for (const row of table.rank) assert.deepEqual(rank(row.computers, row.ask), row.expected, row.name);
  for (const row of table.estimate) assert.equal(estimate(row.computer, row.model, row.tokens), row.expected, row.name);
  for (const row of table.prior_tps) assert.equal(priorTps(row.input), row.expected, JSON.stringify(row.input));
});
