import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The person's memories and synchronised history on a computer others use
// too (final review N2): a household member's phone let in by an endorsement
// (rule 2), a device paired by code, one the console approved or a
// firmware device read and wrote them — and a memory written here goes to
// every computer of the vault. Now only the owner or the person's own
// devices do; anyone else keeps this computer's own conversations.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-household-history-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { pairDevice } = await import("../src/pairing.js");
const { importVaultConversation } = await import("../src/routes/discussions.js");
const { sqlite } = await import("../src/db.js");

const app = await buildApp();
test.after(() => app.close());

const VAULT_ID = "6e4d3c2b-1a0f-4e9d-8c7b-a69584736251";

test("a household member's phone, a device paired by code or one the console approved: no memories, no synchronised history", async () => {
  const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Owner" } });
  const owner = { authorization: `Bearer ${paired.json().token}` };
  const userId = paired.json().user_id as string;
  const made = await app.inject({ method: "POST", url: "/api/v1/memories", headers: owner, payload: { memory: { content: "Owner secret: diagnosis X" } } });
  assert.equal(made.statusCode, 201);
  const id = made.json().id;
  const synced = importVaultConversation(userId, { vault_id: VAULT_ID, title: "Médecin", turns: [{ ref: "t1", text: "Mon diagnostic ?", reply: "X." }] });
  assert.ok(!("error" in synced));
  sqlite.prepare("INSERT INTO discussions (id, user_id, channel, title, created_at, last_activity_at) VALUES ('local-1', ?, 'desktop', 'Ici', 1, 1)").run(userId);

  const tunnel = { "x-twoody-via-tunnel": "relay", "x-twoody-tunnel-peer": "ab".repeat(32) };
  const others = [
    ["household (rule 2)", pairDevice({ deviceName: "iPhone de Claire", tunnelPublicKey: "ab".repeat(32), origin: "account", approvalRule: "endorsed" })],
    ["paired by code", pairDevice({ deviceName: "iPad de la cuisine", origin: "code" })],
    ["the console's", pairDevice({ deviceName: "Appareil", tunnelPublicKey: "ab".repeat(32), origin: "account", approvalRule: "console" })],
  ] as const;
  for (const [who, session] of others) {
    const h = { authorization: `Bearer ${session.token}`, ...tunnel };
    const denied = { error: "person_device_required" };
    for (const [method, url, payload] of [
      ["GET", "/api/v1/memories", undefined],
      ["GET", "/api/v1/memories/duplicates", undefined],
      ["GET", `/api/v1/memories/${id}`, undefined],
      ["POST", "/api/v1/memories", { memory: { content: "planted" } }],
      ["POST", "/api/v1/memories/import", { text: "- I like tea" }],
      ["PATCH", `/api/v1/memories/${id}`, { memory: { content: "overwritten" } }],
      ["DELETE", `/api/v1/memories/${id}`, undefined],
      ["POST", "/api/v1/discussions/import", { vault_id: VAULT_ID, turns: [{ ref: "t2", text: "planted", reply: "planted" }] }],
    ] as const) {
      const res = await app.inject({ method, url, headers: h, ...(payload ? { payload } : {}) });
      assert.equal(res.statusCode, 403, `${who}: ${method} ${url} ${res.body}`);
      assert.deepEqual(res.json(), denied, `${who}: ${method} ${url}`);
    }
    const listed = await app.inject({ method: "GET", url: "/api/v1/discussions", headers: h });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(listed.json().discussions.map((d: { id: string }) => d.id), ["local-1"], `${who}: this computer's own conversations only`);
    const found = await app.inject({ method: "GET", url: "/api/v1/discussions?q=diagnostic", headers: h });
    assert.deepEqual(found.json().discussions, [], `${who}: not found by search either`);
    assert.equal((await app.inject({ method: "GET", url: `/api/v1/discussions/${synced.id}`, headers: h })).statusCode, 404, who);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/v1/discussions/${synced.id}`, headers: h })).statusCode, 404, who);
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/discussions/local-1", headers: h })).statusCode, 200, `${who}: its own, as before`);
  }

  // The owner: everything, untouched.
  const mine = await app.inject({ method: "GET", url: "/api/v1/memories", headers: owner });
  assert.deepEqual(mine.json().map((m: { content: string }) => m.content), ["Owner secret: diagnosis X"]);
  const all = await app.inject({ method: "GET", url: "/api/v1/discussions", headers: owner });
  assert.deepEqual(all.json().discussions.map((d: { id: string }) => d.id).sort(), ["local-1", synced.id].sort());
  assert.equal((await app.inject({ method: "GET", url: `/api/v1/discussions/${synced.id}`, headers: owner })).statusCode, 200);
});
