import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Twoody Desktop's sidebar lists conversations as ChatGPT and Claude do,
// and deletes them the same way.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-discussions-"));

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { db, discussions, messages, users } = await import("../src/db.js");

const app = await buildApp();
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
assert.equal(paired.statusCode, 201);
const owner = paired.json().user_id as string;
const headers = { authorization: `Bearer ${paired.json().token}` };

function conversation(userId: string, title: string): string {
  const id = `d-${Math.random().toString(36).slice(2)}`;
  const now = new Date();
  db.insert(discussions).values({ id, userId, channel: "desktop", title, createdAt: now, lastActivityAt: now }).run();
  for (const [role, content] of [["user", "Bonjour"], ["assistant", "Bonjour !"]]) {
    db.insert(messages).values({ id: `m-${Math.random().toString(36).slice(2)}`, discussionId: id, userId, role, content, createdAt: now }).run();
  }
  return id;
}

test("a conversation is deleted with its messages, and only by its owner", async () => {
  const mine = conversation(owner, "À supprimer");
  const kept = conversation(owner, "À garder");
  db.insert(users).values({ id: "someone-else", email: "autre@self-hosted.twoody", name: "Autre", createdAt: new Date() } as typeof users.$inferInsert).run();
  const theirs = conversation("someone-else", "Pas à moi");

  assert.equal((await app.inject({ method: "DELETE", url: `/discussions/${theirs}`, headers })).statusCode, 404);
  assert.equal(db.select().from(discussions).all().some((row) => row.id === theirs), true);

  assert.equal((await app.inject({ method: "DELETE", url: `/api/v1/discussions/${mine}`, headers })).statusCode, 204);
  assert.equal((await app.inject({ method: "GET", url: `/discussions/${mine}`, headers })).statusCode, 404);
  assert.equal(db.select().from(messages).all().filter((row) => row.discussionId === mine).length, 0);
  assert.equal((await app.inject({ method: "GET", url: `/discussions/${kept}`, headers })).json().messages.length, 2);
  assert.equal((await app.inject({ method: "DELETE", url: `/discussions/${mine}`, headers })).statusCode, 404, "twice");
});
