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
