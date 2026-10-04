import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A conversation's title, written by the model after its first answer
// (src/discussionTitles.ts): the first question's at once, then the
// model's, in the conversation's language, without reasoning; never over a
// title given on purpose; the first question's kept when the model fails;
// the clients told (discussion.updated).

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-titles-"));

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { sqlite } = await import("../src/db.js");
const { subscribe } = await import("../src/events.js");
const { beginGeneration } = await import("../src/account/inflight.js");
const { forgetRuntimeProbes } = await import("../src/localRuntime.js");
const titles = await import("../src/discussionTitles.js");

type Chat = { messages: Array<{ role: string; content: string }>; max_tokens?: number; chat_template_kwargs?: { enable_thinking?: boolean }; reasoning_effort?: string; id_slot?: number };
const titleRequests: Chat[] = [];
/// What the fake model answers a title request with (or a status code).
let titleAnswer: string | number = "Trip to Lisbon";
/// Held until released, when set.
let titleGate: Promise<void> | null = null;

const isTitleRequest = (body: Chat) => body.messages[0]?.content.startsWith("You name conversations");

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "qwen", object: "model" }] }));
    return;
  }
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", async () => {
    const body = JSON.parse(raw) as Chat;
    let text = "Lisbon is lovely in May: mild weather, fewer crowds.";
    if (isTitleRequest(body)) {
      titleRequests.push(body);
      if (titleGate) await titleGate;
      if (typeof titleAnswer === "number") {
        res.writeHead(titleAnswer, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "boom" }));
        return;
      }
      text = titleAnswer;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const app = await buildApp();
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const userId = paired.json().user_id as string;
const headers = { authorization: `Bearer ${paired.json().token}` };
assert.equal((await app.inject({ method: "POST", url: "/providers/local", headers, payload: { url: `${url}/v1`, model: "qwen", name: "llama.cpp" } })).statusCode, 201);

const events: Array<{ kind: string; discussionId: string; title?: string | null }> = [];
const unsubscribe = subscribe((event) => events.push(event as (typeof events)[number]));
const running = titles.startTitles();

test.after(async () => {
  running.stop();
  unsubscribe();
  await app.close();
  await new Promise((resolve) => server.close(resolve));
});

async function ask(text: string) {
  forgetRuntimeProbes();
  const response = await app.inject({ method: "POST", url: "/queries", headers, payload: { text, channel: "desktop", force_new_discussion: true } });
  assert.equal(response.statusCode, 200, response.body);
  const final = response.body.split("\n\n").find((block) => block.startsWith("event: final"))!;
  return (JSON.parse(final.slice(final.indexOf("data: ") + 6)) as { discussion_id: string }).discussion_id;
}

const listed = async (id: string) => ((await app.inject({ url: "/discussions", headers })).json().discussions as Array<{ id: string; title: string; title_source: string | null }>).find((row) => row.id === id)!;

test("the model's title replaces the first question's, in its language, without reasoning; the clients are told", async () => {
  titleAnswer = "<think></think>\nTitle: \"Trip to Lisbon.\"";
  const question = "Where should we stay in Lisbon in May? We would like a quiet place near the old town and the river.";
  const id = await ask(question);
  const created = events.find((event) => event.kind === "discussion.created" && event.discussionId === id)!;
  assert.equal(created.title, question.slice(0, 60), "the first question's title at once");

  await titles.titlesIdle();
  const row = await listed(id);
  assert.deepEqual([row.title, row.title_source], ["Trip to Lisbon", "model"]);
  assert.equal((await app.inject({ url: `/discussions/${id}`, headers })).json().title, "Trip to Lisbon");
  assert.ok(events.some((event) => event.kind === "discussion.updated" && event.discussionId === id && event.title === "Trip to Lisbon"));

  const asked = titleRequests.at(-1)!;
  assert.match(asked.messages.at(-1)!.content, /PERSON: Where should we stay in Lisbon/);
  assert.match(asked.messages.at(-1)!.content, /ASSISTANT: Lisbon is lovely in May/);
  assert.match(asked.messages.at(-1)!.content, /Title, in English:$/);
  assert.equal(asked.chat_template_kwargs?.enable_thinking, false);
  assert.equal(asked.reasoning_effort, "none");
  assert.ok(asked.max_tokens! <= 64);
});

test("a French conversation is titled in French; a later answer asks for no title", async () => {
  titleAnswer = "« Voyage à Lisbonne en mai »";
  const before = titleRequests.length;
  const id = await ask("Où loger à Lisbonne en mai ? Je voudrais un quartier calme pour la famille.");
  await titles.titlesIdle();
  assert.match(titleRequests.at(-1)!.messages.at(-1)!.content, /Title, in French:$/);
  assert.equal((await listed(id)).title, "Voyage à Lisbonne en mai");

  const next = await app.inject({ method: "POST", url: "/queries", headers, payload: { text: "Et pour manger ?", channel: "desktop", discussion_id: id } });
  assert.equal(next.statusCode, 200);
  await titles.titlesIdle();
  assert.equal(titleRequests.length, before + 1, "only after the first answer");
});

test("a title given meanwhile (another device's) is never replaced by the model", async () => {
  titleAnswer = "Generated title";
  let release!: () => void;
  titleGate = new Promise((resolve) => (release = resolve));
  try {
    const id = await ask("What's a good recipe for pancakes with buttermilk and blueberries?");
    while (!titleRequests.some((request) => request.messages.at(-1)!.content.includes("pancakes"))) await new Promise((resolve) => setTimeout(resolve, 10));
    const imported = await app.inject({ method: "POST", url: "/discussions/import", headers, payload: { vault_id: "7a1c2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", discussion_id: id, title: "Pancakes du dimanche", turns: [] } });
    assert.equal(imported.statusCode, 200, imported.body);
    release();
    await titles.titlesIdle();
    const row = await listed(id);
    assert.deepEqual([row.title, row.title_source], ["Pancakes du dimanche", "given"]);
    assert.ok(!events.some((event) => event.kind === "discussion.updated" && event.discussionId === id && event.title === "Generated title"));
    assert.ok(events.some((event) => event.kind === "discussion.updated" && event.discussionId === id && event.title === "Pancakes du dimanche"), "the given title is told too");
  } finally {
    titleGate = null;
    release?.();
  }
});

test("the model failing, or writing nothing worth showing, leaves the first question's title", async () => {
  for (const [i, answer] of ([500, "...", "\"\"", "🎉🎉"] as const).entries()) {
    titleAnswer = answer;
    const question = `Party ${i}: can you help me plan a birthday party for twelve children?`;
    const id = await ask(question);
    await titles.titlesIdle();
    const row = await listed(id);
    assert.deepEqual([row.title, row.title_source], [question.slice(0, 60), "question"], String(answer));
    assert.ok(!events.some((event) => event.kind === "discussion.updated" && event.discussionId === id));
  }
});

test("waits while the computer answers, and gives way to an answer that starts", async () => {
  sqlite.prepare("INSERT INTO discussions (id, user_id, channel, title, title_source, created_at, last_activity_at) VALUES ('wait-1', ?, 'desktop', 'Bonjour, comment', 'question', 1, 1)").run(userId);
  const calls: string[] = [];
  let firstCall = true;
  const answering = beginGeneration("chat");
  try {
    titles.titleAfterFirstAnswer({
      userId,
      discussionId: "wait-1",
      question: "Bonjour, comment faire une pâte à crêpes ?",
      answer: "Mélangez la farine, les œufs et le lait.",
      call: async (_messages, signal) => {
        calls.push("asked");
        if (firstCall) {
          firstCall = false;
          // An answer starts while the title is being written.
          await new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            setTimeout(() => {
              const other = beginGeneration("chat");
              setTimeout(other, 1_200);
            }, 20);
            setTimeout(resolve, 5_000);
          });
        }
        return "Pâte à crêpes";
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.deepEqual(calls, [], "not while an answer is being written");
  } finally {
    answering();
  }
  await titles.titlesIdle(8_000);
  assert.deepEqual(calls, ["asked", "asked"], "stopped for the answer, asked again after it");
  assert.deepEqual(sqlite.prepare("SELECT title, title_source FROM discussions WHERE id = 'wait-1'").get(), { title: "Pâte à crêpes", title_source: "model" });
});

test("a synchronised conversation's title from the vault: the model's kept over the first question's, another device's taken", async () => {
  const vaultId = "0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
  const turn = { ref: "q1", text: "Quel vin avec une raclette savoyarde, et combien de bouteilles pour huit ?", reply: "Un blanc de Savoie.", created_at: "2026-10-04T10:00:00Z" };
  const first = await app.inject({ method: "POST", url: "/discussions/import", headers, payload: { vault_id: vaultId, turns: [turn] } });
  const id = first.json().discussion_id as string;
  assert.equal((await listed(id)).title_source, "question");
  assert.ok(titles.applyGeneratedTitle(userId, id, "Vin pour une raclette"));
  assert.ok(!titles.applyGeneratedTitle(userId, id, "Autre titre"), "once");

  // The vault had no title event: it names the conversation by its first question.
  await app.inject({ method: "POST", url: "/discussions/import", headers, payload: { vault_id: vaultId, title: turn.text.slice(0, 60), turns: [turn, { ...turn, ref: "q2", text: "Et en rouge ?", created_at: "2026-10-04T10:05:00Z" }] } });
  assert.deepEqual([(await listed(id)).title, (await listed(id)).title_source], ["Vin pour une raclette", "model"]);

  await app.inject({ method: "POST", url: "/discussions/import", headers, payload: { vault_id: vaultId, title: "Raclette de samedi", turns: [] } });
  assert.deepEqual([(await listed(id)).title, (await listed(id)).title_source], ["Raclette de samedi", "given"]);
});

test("cleanTitle: quotes, prefixes, reasoning, emoji and length", () => {
  assert.equal(titles.cleanTitle("Title: \"Trip to Lisbon.\""), "Trip to Lisbon");
  assert.equal(titles.cleanTitle("<think>The person asks about crêpes…</think>\n\n« Recette de crêpes »"), "Recette de crêpes");
  assert.equal(titles.cleanTitle("Titre :\nVoyage à Lisbonne\nVoici un titre court."), "Voyage à Lisbonne");
  assert.equal(titles.cleanTitle("**Budget 2027** 📊"), "Budget 2027");
  assert.equal(titles.cleanTitle("「東京の旅行計画」"), "東京の旅行計画");
  const long = titles.cleanTitle("A very long title that goes on and on about many different things at once");
  assert.ok(long && long.length <= titles.TITLE_MAX_CHARS && !long.endsWith(" "), String(long));
  assert.equal(titles.cleanTitle(""), null);
  assert.equal(titles.cleanTitle("<think>unfinished reasoning"), null);
  assert.equal(titles.cleanTitle("..."), null);
  assert.equal(titles.cleanTitle("Sorry, I can't help with that"), null);
});
