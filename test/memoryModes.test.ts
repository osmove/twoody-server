import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Mémoire v2, lot L4a (docs/memory-v2-design.md §2): a conversation's memory
// mode — « Complète » (full), « Profil seulement » (profile), « Aucune »
// (none) — from /me, PATCH /discussions/:id or /queries; what a turn was
// given of the memories, in the final event and messages.memory_json; and
// a conversation's state that keeps the fields it does not know (G9).

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-memory-modes-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
delete process.env.BRIDGE_LOCAL_LLM_ENDPOINT;
delete process.env.TWOODY_EMBEDDING_BINARY;
delete process.env.TWOODY_EMBEDDING_MODEL;

const { buildChatTurn, readContextState, memoryModeFor } = await import("../src/chatContext.js");
type Input = Parameters<typeof buildChatTurn>[0];

const NOW = new Date(2026, 8, 21, 10, 0, 0);
const MEMORIES = [
  { id: "m-age", kind: "user", title: null, content: "Camille a 41 ans." },
  { id: "m-proj", kind: "project", title: "Cuisine", content: "Les travaux de la cuisine commencent en novembre." },
];
const input = (overrides: Partial<Input> = {}): Input => ({ userName: "Camille", prefs: {}, history: [], memories: MEMORIES, content: "Bonjour", local: true, now: NOW, ...overrides });

test("the mode of a turn: memory switched off is « none »; else asked, the conversation's, the person's, « full »", () => {
  assert.equal(memoryModeFor({}), "full");
  assert.equal(memoryModeFor({ memory_mode: "profile" }), "profile");
  assert.equal(memoryModeFor({ memory_mode: "profile" }, "none"), "none");
  assert.equal(memoryModeFor({ memory_mode: "profile" }, "none", "full"), "full");
  assert.equal(memoryModeFor({ memory_enabled: false }, "full", "full"), "none");
  assert.equal(memoryModeFor({ memory_mode: "bogus" }, "also bogus"), "full");
});

test("« full » gives the profile and the memories a message is about; « profile » the profile alone; « none » nothing", () => {
  const ask = "Quand commencent les travaux de la cuisine ?";
  const full = buildChatTurn(input({ content: ask }));
  assert.match(full.messages[0].content, /Camille a 41 ans/);
  assert.match(full.messages.at(-1)!.content, /\[Saved notes that may be relevant\]\n- Cuisine: Les travaux/);
  assert.equal(full.memory.mode, "full");
  assert.ok(full.memory.profile_tokens > 0);
  assert.ok(full.memory.relevant_tokens > 0);
  assert.deepEqual(full.memory.items.map((i) => [i.id, i.title, typeof i.score]), [["m-proj", "Cuisine", "number"]]);

  const profile = buildChatTurn(input({ content: ask, memoryMode: "profile" }));
  assert.equal(profile.messages[0].content, full.messages[0].content, "the same profile");
  assert.doesNotMatch(profile.messages.at(-1)!.content, /Saved notes/);
  assert.deepEqual({ ...profile.memory, profile_tokens: 0 }, { mode: "profile", profile_tokens: 0, relevant_tokens: 0, items: [] });

  const none = buildChatTurn(input({ content: ask, memoryMode: "none" }));
  assert.doesNotMatch(JSON.stringify(none.messages), /41 ans|novembre/);
  assert.deepEqual(none.memory, { mode: "none", profile_tokens: 0, relevant_tokens: 0, items: [] });
});

test("a change of mode is a refresh point; staying in a mode keeps the prefix (prompt cache)", () => {
  const first = buildChatTurn(input({ currentId: "u1" }));
  assert.equal(first.state.memoryMode, undefined, "a state in « full » is written as before");
  const history = [{ id: "u1", role: "user", content: "Bonjour", sent: first.sent }, { id: "a1", role: "assistant", content: "Bonjour !" }];
  const off = buildChatTurn(input({ state: first.state, history, content: "Et alors ?", currentId: "u2", memoryMode: "none" }));
  assert.doesNotMatch(off.messages[0].content, /41 ans/);
  assert.equal(off.state.memoryMode, "none");
  const history2 = [...history, { id: "u2", role: "user", content: "Et alors ?", sent: off.sent }, { id: "a2", role: "assistant", content: "Rien." }];
  const still = buildChatTurn(input({ state: off.state, history: history2, content: "Bon.", currentId: "u3", memoryMode: "none" }));
  assert.deepEqual(still.messages.slice(0, off.messages.length - 1), off.messages.slice(0, -1), "the prefix holds in « none »");
  assert.doesNotMatch(still.messages.at(-1)!.content, /Saved in the user's Memories/, "the memories are not announced as new");
  const back = buildChatTurn(input({ state: still.state, history: [...history2, { id: "u3", role: "user", content: "Bon.", sent: still.sent }, { id: "a3", role: "assistant", content: "Oui." }], content: "Mon âge ?", currentId: "u4" }));
  assert.match(back.messages[0].content, /Camille a 41 ans/, "back in « full »: the profile is frozen again");
  assert.doesNotMatch(back.messages.at(-1)!.content, /Saved in the user's Memories since/, "not announced as new either");
  assert.equal(back.state.memoryMode, undefined);
});

test("a state keeps the fields it does not know, read and written again (G9)", () => {
  const stored = JSON.stringify({ v: 1, basis: null, profile: "- Camille a 41 ans.", documents: false, web: false, compact: [], liveFrom: "u1", seen: [], told: [], tools: ["search_memory"], future: { x: 1 }, memoryMode: "profile" });
  const state = readContextState(stored)!;
  assert.deepEqual(state.tools, ["search_memory"]);
  assert.deepEqual(state.future, { x: 1 });
  assert.equal(state.memoryMode, "profile");
  assert.equal(readContextState(JSON.stringify({ v: 1, compact: "nope", memoryMode: "loud" }))!.memoryMode, undefined, "known fields are still checked");
  const history = [{ id: "u1", role: "user", content: "Bonjour" }, { id: "a1", role: "assistant", content: "Salut" }];
  const kept = buildChatTurn(input({ state, history, content: "Ça va ?", currentId: "u2", memoryMode: "profile" }));
  assert.deepEqual(kept.state.tools, ["search_memory"]);
  // At a refresh point too (a change of mode).
  const refreshed = buildChatTurn(input({ state, history, content: "Ça va ?", currentId: "u2", memoryMode: "full" }));
  assert.deepEqual(refreshed.state.future, { x: 1 });
});

// ── through the routes ──────────────────────────────────────────────────

type Message = { role: string; content: string };
const chats: Message[][] = [];
let extractions = 0;
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "qwen" }] }));
    return;
  }
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const { messages } = JSON.parse(raw) as { messages: Message[] };
    const extraction = messages[0].content.startsWith("You read a conversation between");
    if (extraction) extractions += 1;
    else chats.push(messages);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: extraction ? "NONE" : "Réponse." } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { pairDevice } = await import("../src/pairing.js");
const { sqlite } = await import("../src/db.js");
const app = await buildApp();
test.after(async () => {
  await app.close();
  await new Promise((resolve) => server.close(resolve));
});

const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const headers = { authorization: `Bearer ${paired.json().token}` };
await app.inject({ method: "POST", url: "/providers/local", headers, payload: { url, model: "qwen", name: "llama.cpp" } });
await app.inject({ method: "POST", url: "/memories", headers, payload: { memory: { content: "Camille a 41 ans." } } });
const project = (await app.inject({ method: "POST", url: "/memories", headers, payload: { memory: { kind: "project", title: "Cuisine", content: "Les travaux de la cuisine commencent en novembre." } } })).json().id as string;

async function ask(payload: Record<string, unknown>, h: Record<string, string> = headers) {
  const response = await app.inject({ method: "POST", url: "/queries", headers: h, payload: { channel: "keyboard", context_window: 16_384, ...payload } });
  if (response.statusCode !== 200) return { status: response.statusCode, body: response.json() } as const;
  const block = response.body.split("\n\n").find((b) => b.startsWith("event: final"))!;
  await new Promise((resolve) => setTimeout(resolve, 30));
  return { status: 200, final: JSON.parse(block.slice(block.indexOf("data: ") + 6)), sent: chats.at(-1)! } as const;
}

test("/me: memory_mode, the same switch as memory_enabled", async () => {
  assert.equal((await app.inject({ url: "/me", headers })).json().memory_mode, "full");
  const none = (await app.inject({ method: "PATCH", url: "/me", headers, payload: { user: { memory_mode: "none" } } })).json();
  assert.deepEqual([none.memory_mode, none.memory_enabled], ["none", false]);
  const profile = (await app.inject({ method: "PATCH", url: "/me", headers, payload: { user: { memory_mode: "profile" } } })).json();
  assert.deepEqual([profile.memory_mode, profile.memory_enabled], ["profile", true]);
  const off = (await app.inject({ method: "PATCH", url: "/me", headers, payload: { user: { memory_enabled: false } } })).json();
  assert.equal(off.memory_mode, "none", "memory_enabled: false is « none »");
  const on = (await app.inject({ method: "PATCH", url: "/me", headers, payload: { user: { memory_enabled: true, memory_mode: "full" } } })).json();
  assert.deepEqual([on.memory_mode, on.memory_enabled], ["full", true]);
});

test("/queries: final.memory says what the answer was given, kept with it; memory_mode becomes the conversation's", async () => {
  const full = await ask({ text: "Quand commencent les travaux de la cuisine ?", force_new_discussion: true });
  assert.equal(full.status, 200);
  const memory = full.final.memory;
  assert.equal(memory.mode, "full");
  assert.ok(memory.profile_tokens > 0 && memory.relevant_tokens > 0);
  assert.deepEqual(memory.items.map((i: { id: string; title: string }) => [i.id, i.title]), [[project, "Cuisine"]]);
  const stored = sqlite.prepare("SELECT memory_json FROM messages WHERE discussion_id = ? AND role = 'assistant'").get(full.final.discussion_id) as { memory_json: string };
  assert.deepEqual(JSON.parse(stored.memory_json), memory);
  const opened = (await app.inject({ url: `/discussions/${full.final.discussion_id}`, headers })).json();
  assert.deepEqual(opened.messages.at(-1).memory, memory);
  assert.equal(opened.memory_mode, null, "follows the person's");

  // « Aucune » for this conversation: nothing given, nothing learned, nothing remembered.
  const learnedBefore = extractions;
  const memoriesBefore = (sqlite.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n;
  const none = await ask({ text: "Retiens que j'adore le cassoulet. Et ma cuisine ?", discussion_id: full.final.discussion_id, memory_mode: "none" });
  assert.equal(none.status, 200);
  assert.deepEqual(none.final.memory, { mode: "none", profile_tokens: 0, relevant_tokens: 0, items: [] });
  // The system prompt is frozen again without them; what the conversation
  // already said stays as it was (the history is given byte for byte).
  assert.doesNotMatch(none.sent[0].content, /41 ans/);
  assert.doesNotMatch(none.sent.at(-1)!.content, /Saved notes|novembre/);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n, memoriesBefore);
  // Not read afterwards either, even asked to.
  assert.equal((await app.inject({ method: "POST", url: "/memories/learn", headers, payload: { discussion_id: full.final.discussion_id } })).statusCode, 200);
  assert.equal(extractions, learnedBefore);
  assert.equal((await app.inject({ url: `/discussions/${full.final.discussion_id}`, headers })).json().memory_mode, "none");

  // The next turn, naming no mode, stays in the conversation's.
  const next = await ask({ text: "Et la salle de bain ?", discussion_id: full.final.discussion_id });
  assert.equal(next.final.memory.mode, "none");
  assert.equal((await ask({ text: "x", memory_mode: "loud" })).status, 422);
});

test("PATCH /discussions/:id {memory_mode}: « Profil seulement », then back to the person's", async () => {
  const first = await ask({ text: "Bonjour !", force_new_discussion: true });
  const id = first.final.discussion_id;
  const patched = await app.inject({ method: "PATCH", url: `/discussions/${id}`, headers, payload: { memory_mode: "profile" } });
  assert.deepEqual(patched.json(), { id, memory_mode: "profile" });
  const turn = await ask({ text: "Quand commencent les travaux de la cuisine ?", discussion_id: id });
  assert.equal(turn.final.memory.mode, "profile");
  assert.match(turn.sent[0].content, /41 ans/);
  assert.doesNotMatch(turn.sent.at(-1)!.content, /novembre/);
  assert.equal((await app.inject({ method: "PATCH", url: `/discussions/${id}`, headers, payload: { memory_mode: "loud" } })).statusCode, 422);
  assert.equal((await app.inject({ method: "PATCH", url: `/discussions/${id}`, headers, payload: { memory_mode: null } })).json().memory_mode, null);
  assert.equal((await app.inject({ method: "PATCH", url: "/discussions/nope", headers, payload: { memory_mode: "none" } })).statusCode, 404);
  // Memory switched off for the person: « none » whatever the conversation says.
  await app.inject({ method: "PATCH", url: "/me", headers, payload: { user: { memory_enabled: false } } });
  await app.inject({ method: "PATCH", url: `/discussions/${id}`, headers, payload: { memory_mode: "full" } });
  assert.equal((await ask({ text: "Mon âge ?", discussion_id: id })).final.memory.mode, "none");
  await app.inject({ method: "PATCH", url: "/me", headers, payload: { user: { memory_enabled: true } } });
});

test("someone who may not read the memories is told how much was given, not which", async () => {
  const session = pairDevice({ deviceName: "iPad de la cuisine", origin: "code" });
  const ipad = { authorization: `Bearer ${session.token}`, "x-twoody-via-tunnel": "relay", "x-twoody-tunnel-peer": "ab".repeat(32) };
  const turn = await ask({ text: "Quand commencent les travaux de la cuisine ?", force_new_discussion: true }, ipad);
  assert.equal(turn.status, 200);
  assert.equal(turn.final.memory.mode, "full");
  assert.deepEqual(turn.final.memory.items, []);
  const opened = (await app.inject({ url: `/discussions/${turn.final.discussion_id}`, headers: ipad })).json();
  assert.deepEqual(opened.messages.at(-1).memory.items, []);
  const owner = (await app.inject({ url: `/discussions/${turn.final.discussion_id}`, headers })).json();
  assert.equal(owner.messages.at(-1).memory.items.length, 1, "the owner reads them");
});

test("« Retiens que… »: the answer says it was kept, or already known (« Mémoire enregistrée »)", async () => {
  const first = await ask({ text: "Retiens que je joue du violoncelle.", force_new_discussion: true });
  assert.deepEqual(first.final.remembered, { content: "Je joue du violoncelle", added: true });
  const again = await ask({ text: "Retiens que je joue du violoncelle", force_new_discussion: true });
  assert.deepEqual(again.final.remembered, { content: "Je joue du violoncelle", added: false });
  assert.equal((await ask({ text: "Bonjour", force_new_discussion: true })).final.remembered, undefined);
});

test("« Mémoire enregistrée » stays with the answer: a conversation opened again still says it", async () => {
  const kept = await ask({ text: "Retiens que je pars à Lisbonne en mai.", force_new_discussion: true });
  const opened = (await app.inject({ url: `/discussions/${kept.final.discussion_id}`, headers })).json();
  assert.deepEqual(opened.messages.at(-1).memory.remembered, { content: "Je pars à Lisbonne en mai", added: true });
});
