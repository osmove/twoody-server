import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The Devices screens show what this computer's models spent answering, by
// day, model and device (28/09/2026), and each answer its tokens.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-usage-"));

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { db, discussions, messages } = await import("../src/db.js");
const { clientOf } = await import("../src/routes/usage.js");

const app = await buildApp();
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "iPhone" } });
assert.equal(paired.statusCode, 201);
const owner = paired.json().user_id as string;
const headers = { authorization: `Bearer ${paired.json().token}` };

function answer(discussionId: string, at: Date, model: string, client: string, prompt: number, completion: number) {
  db.insert(messages).values({ id: `m-${Math.random().toString(36).slice(2)}`, discussionId, userId: owner, role: "assistant", content: "…", model, client, promptTokens: prompt, completionTokens: completion, tokensEstimated: false, createdAt: at }).run();
}

test("usage adds up the answers of the last days, by day, model and device", async () => {
  const id = "d-usage";
  const now = new Date();
  db.insert(discussions).values({ id, userId: owner, channel: "desktop", title: "t", createdAt: now, lastActivityAt: now }).run();
  answer(id, now, "Qwen3.5-9B", "iPhone", 1000, 50);
  answer(id, now, "Qwen3.5-9B", "this-computer", 500, 20);
  answer(id, new Date(now.getTime() - 40 * 24 * 3600 * 1000), "Qwen3.5-9B", "iPhone", 9999, 9999);
  db.insert(messages).values({ id: "m-question", discussionId: id, userId: owner, role: "user", content: "?", createdAt: now }).run();

  const usage = (await app.inject({ method: "GET", url: "/api/v1/usage?days=30", headers })).json();
  assert.deepEqual(usage.totals, { prompt_tokens: 1500, completion_tokens: 70, messages: 2 });
  assert.equal(usage.by_day.length, 1);
  assert.deepEqual(usage.by_model.map((row: { model: string }) => row.model), ["Qwen3.5-9B"]);
  assert.deepEqual(usage.by_device.map((row: { device: string }) => row.device), ["iPhone", "this-computer"]);

  const shown = (await app.inject({ method: "GET", url: `/api/v1/discussions/${id}`, headers })).json();
  const counted = shown.messages.find((row: { role: string; prompt_tokens: number | null }) => row.role === "assistant" && row.prompt_tokens === 1000);
  assert.equal(counted.completion_tokens, 50);
});

test("who asked: the phone by the name it paired with, nobody without a session", async () => {
  const me = await app.inject({ method: "GET", url: "/api/v1/usage", headers });
  assert.equal(me.statusCode, 200);
  const { authSessions } = await import("../src/db.js");
  const [session] = db.select().from(authSessions).all().filter((row) => row.clientKind === "pair:iPhone");
  assert.equal(clientOf({ sessionId: session.id }), "iPhone");
  assert.equal(clientOf({}), null);
});
