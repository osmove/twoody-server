import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// An encrypted conversation started on another device is brought here with
// its decrypted exchanges, to go on on this computer (vaultSync).

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-discussion-import-"));
const { buildApp } = await import("../src/app.js");
const { ensureSetupToken, createAuthSession } = await import("../src/auth.js");
const { sqlite } = await import("../src/db.js");
const { loadHistory } = await import("../src/routes/queries.js");

const app = await buildApp();
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const owner = paired.json().user_id as string;
const headers = { authorization: `Bearer ${paired.json().token}` };
const vaultId = "5f0c2a4e-8b1d-4c3e-9a7f-2d6e1b0c9a8f";
const turn = (ref: string, text: string, reply: string, at: string) => ({ ref, text, reply, model: "apple-intelligence", created_at: at });

test("creates the conversation once and adds only new exchanges, in order", async () => {
  const first = await app.inject({ method: "POST", url: "/discussions/import", headers, payload: { vault_id: vaultId, title: "Mon CV", turns: [turn("r1", "Résume mon CV", "Product Owner", "2026-09-28T10:00:00Z")] } });
  assert.equal(first.statusCode, 200);
  assert.deepEqual([first.json().created, first.json().added], [true, 1]);
  const id = first.json().discussion_id;

  const again = await app.inject({ method: "POST", url: "/discussions/import", headers, payload: { vault_id: vaultId.toUpperCase(), turns: [turn("r1", "Résume mon CV", "Product Owner", "2026-09-28T10:00:00Z"), turn("r2", "Et en anglais ?", "In English", "2026-09-28T10:05:00Z")] } });
  assert.deepEqual([again.json().discussion_id, again.json().created, again.json().added], [id, false, 1]);

  const shown = (await app.inject({ url: `/discussions/${id}`, headers })).json();
  assert.equal(shown.vault_id, vaultId);
  assert.equal(shown.title, "Mon CV");
  assert.deepEqual(shown.messages.map((m: { content: string }) => m.content), ["Résume mon CV", "Product Owner", "Et en anglais ?", "In English"]);
  const listed = (await app.inject({ url: "/discussions", headers })).json().discussions.find((d: { id: string }) => d.id === id);
  assert.equal(listed.vault_id, vaultId);
});

test("the next question here is given the imported history", async () => {
  const id = (sqlite.prepare("SELECT id FROM discussions WHERE vault_id = ?").get(vaultId) as { id: string }).id;
  const history = loadHistory(id);
  assert.deepEqual(history.map((row) => row.role), ["user", "assistant", "user", "assistant"]);
  assert.match(JSON.stringify(history), /Résume mon CV[\s\S]*In English/);
  assert.ok(owner);
});

test("needs a session, a well-formed id, and stays with its owner", async () => {
  assert.equal((await app.inject({ method: "POST", url: "/discussions/import", payload: { vault_id: vaultId, turns: [] } })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/discussions/import", headers, payload: { vault_id: "not-a-uuid", turns: [] } })).statusCode, 422);
  sqlite.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").run("other", "other@self-hosted.twoody", Date.now());
  const other = { authorization: `Bearer ${createAuthSession("other").token}` };
  const theirs = await app.inject({ method: "POST", url: "/discussions/import", headers: other, payload: { vault_id: vaultId, turns: [turn("x", "à moi", "ok", "2026-09-28T11:00:00Z")] } });
  assert.equal(theirs.json().created, true, "the same vault id under another person is another conversation");
  const mine = (await app.inject({ url: "/discussions", headers })).json().discussions;
  assert.ok(!mine.some((d: { id: string }) => d.id === theirs.json().discussion_id));
});

test("an exchange answered here and synced back is not added twice", async () => {
  const id = (sqlite.prepare("SELECT id FROM discussions WHERE vault_id = ? AND user_id = ?").get(vaultId, owner) as { id: string }).id;
  // What /queries stores for a question sent with vault_ref "r3".
  const insert = sqlite.prepare("INSERT INTO messages (id, discussion_id, user_id, role, content, vault_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  insert.run("m-r3", id, owner, "user", "Et en espagnol ?", "r3", Math.floor(Date.now() / 1000));
  insert.run("m-r3b", id, owner, "assistant", "En español", "r3#reply", Math.floor(Date.now() / 1000));
  const back = await app.inject({ method: "POST", url: "/discussions/import", headers, payload: { vault_id: vaultId, turns: [turn("r3", "Et en espagnol ?", "En español", "2026-09-28T10:10:00Z")] } });
  assert.equal(back.json().added, 0);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM messages WHERE discussion_id = ?").get(id) as { n: number }).n, 6);
});

test("a conversation already here takes a vault id once, and later imports extend it", async () => {
  const local = sqlite.prepare("INSERT INTO discussions (id, user_id, channel, title, created_at, last_activity_at) VALUES ('local-1', ?, 'desktop', 'Ici', 1, 1)");
  local.run(owner);
  const otherVault = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const attach = await app.inject({ method: "POST", url: "/discussions/import", headers, payload: { vault_id: otherVault, discussion_id: "local-1", turns: [] } });
  assert.deepEqual([attach.statusCode, attach.json().discussion_id, attach.json().created], [200, "local-1", false]);
  const extend = await app.inject({ method: "POST", url: "/discussions/import", headers, payload: { vault_id: otherVault, turns: [turn("p1", "Depuis l'iPhone", "ok", "2026-09-28T12:00:00Z")] } });
  assert.equal(extend.json().discussion_id, "local-1");
  const again = await app.inject({ method: "POST", url: "/discussions/import", headers, payload: { vault_id: vaultId, discussion_id: "local-1", turns: [] } });
  assert.equal(again.statusCode, 409, "a conversation mirrors one encrypted conversation only");
  assert.equal((await app.inject({ method: "POST", url: "/discussions/import", headers, payload: { vault_id: "8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", discussion_id: "nope", turns: [] } })).statusCode, 404);
});

test("an exchange already here, synchronised later, takes its ref instead of a copy", async () => {
  sqlite.prepare("INSERT INTO discussions (id, user_id, channel, title, created_at, last_activity_at) VALUES ('old-1', ?, 'desktop', 'Ancienne', 1, 1)").run(owner);
  const insert = sqlite.prepare("INSERT INTO messages (id, discussion_id, user_id, role, content, created_at) VALUES (?, 'old-1', ?, ?, ?, 1)");
  insert.run("q-1", owner, "user", "Vieille question"); insert.run("a-1", owner, "assistant", "Vieille réponse");
  const migrated = "9b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
  const first = await app.inject({ method: "POST", url: "/discussions/import", headers, payload: { vault_id: migrated, discussion_id: "old-1", turns: [turn("q-1", "Vieille question", "Vieille réponse", "2026-01-01T00:00:00Z")] } });
  assert.deepEqual([first.json().discussion_id, first.json().added], ["old-1", 0]);
  const again = await app.inject({ method: "POST", url: "/discussions/import", headers, payload: { vault_id: migrated, turns: [turn("q-1", "Vieille question", "Vieille réponse", "2026-01-01T00:00:00Z")] } });
  assert.equal(again.json().added, 0);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM messages WHERE discussion_id = 'old-1'").get() as { n: number }).n, 2);
  assert.deepEqual((sqlite.prepare("SELECT vault_ref FROM messages WHERE discussion_id = 'old-1' ORDER BY rowid").all() as Array<{ vault_ref: string }>).map((r) => r.vault_ref), ["q-1", "q-1#reply"]);
});

test("a question said here without its ref, its copy from the vault moments later: one exchange, not two", async () => {
  // Jimmy, 03/10/2026: « Salut, comment ça va ? » said aloud on the phone,
  // then shown twice once the phone's copy came back through the vault.
  const at = Math.floor(Date.parse("2026-10-03T06:06:06Z") / 1000);
  sqlite.prepare("INSERT INTO discussions (id, user_id, channel, title, created_at, last_activity_at) VALUES ('voice-1', ?, 'iPhone', 'Salut', ?, ?)").run(owner, at, at);
  const insert = sqlite.prepare("INSERT INTO messages (id, discussion_id, user_id, role, content, channel, created_at) VALUES (?, 'voice-1', ?, ?, ?, ?, ?)");
  insert.run("vq-1", owner, "user", "Salut, comment ça va ?", "recording", at);
  insert.run("va-1", owner, "assistant", "Salut Jimmy, ça va !", null, at + 9);
  const spoken = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
  const synced = await app.inject({ method: "POST", url: "/discussions/import", headers, payload: { vault_id: spoken, discussion_id: "voice-1", turns: [{ ...turn("1791007566186", "Salut, comment ça va ?", "Salut Jimmy, ça va !", "2026-10-03T06:06:08Z"), channel: "recording" }] } });
  assert.equal(synced.json().added, 0);
  const rows = sqlite.prepare("SELECT role, vault_ref, channel FROM messages WHERE discussion_id = 'voice-1' ORDER BY rowid").all() as Array<{ role: string; vault_ref: string; channel: string | null }>;
  assert.deepEqual(rows.map((r) => [r.role, r.vault_ref, r.channel]), [["user", "1791007566186", "recording"], ["assistant", "1791007566186#reply", null]]);
  // The same words asked again later are another exchange.
  const later = await app.inject({ method: "POST", url: "/discussions/import", headers, payload: { vault_id: spoken, turns: [turn("1791009000000", "Salut, comment ça va ?", "Toujours bien.", "2026-10-03T07:00:00Z")] } });
  assert.equal(later.json().added, 1);
});
