import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Mémoire v2, lot L3 (docs/memory-v2-design.md §2–3): the compact profile of
// the system prompt (tier a) and the memories a message bears on (tier b),
// ranked with the entities of the person's graph — through buildChatTurn,
// POST /memories/retrieve (the dry run the bench reads) and /queries.
// Without an embedding model here: the lexical fallback, with the entities.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-memory-retrieve-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
delete process.env.BRIDGE_LOCAL_LLM_ENDPOINT;
delete process.env.TWOODY_EMBEDDING_BINARY;
delete process.env.TWOODY_EMBEDDING_MODEL;

const { buildChatTurn } = await import("../src/chatContext.js");
const { rankMemories, firstPerson, ageFrom } = await import("../src/memory/rank.js");
type Input = Parameters<typeof buildChatTurn>[0];

const NOW = new Date(2026, 9, 1, 10, 0, 0);
const input = (overrides: Partial<Input> = {}): Input => ({ userName: "Camille", prefs: {}, history: [], memories: [], content: "Bonjour", local: true, now: NOW, ...overrides });
const tokens = (text: string | null) => Math.ceil((text ?? "").length / 3.5);

test("the profile is compact: about 600 tokens out of a hundred facts, how to answer and the birth date first, its age said", () => {
  const facts = Array.from({ length: 100 }, (_, i) => ({ id: `h${i}`, kind: "user", title: null, content: `Camille a suivi l'atelier de poterie numéro ${i} au centre culturel, le jeudi soir.` }));
  const memories = [
    ...facts.slice(0, 50),
    { id: "birth", kind: "user", title: null, content: "Camille est née le 14 mars 1984 à Angers." },
    { id: "style", kind: "user", title: null, content: "Camille préfère des réponses courtes.", sourceRef: "account" },
    ...facts.slice(50),
  ];
  const turn = buildChatTurn(input({ memories, contextWindow: 32_768 }));
  const profile = turn.state.profile!;
  assert.ok(tokens(profile) <= 800 && tokens(profile) >= 450, `${tokens(profile)} tokens`);
  assert.equal(turn.memory.profile_tokens, tokens(profile));
  assert.match(profile, /^- Camille préfère des réponses courtes\.\n- Camille est née le 14 mars 1984 à Angers\. \(42 years old today\)/);
  assert.ok(turn.profileIds.includes("birth") && turn.profileIds.length < 40);
  // A tenth of a small window at most.
  assert.ok(tokens(buildChatTurn(input({ memories, contextWindow: 4_096 })).state.profile) <= 410);
});

test("a birth date gives an age; a year, an approximate one", () => {
  assert.deepEqual(ageFrom("Mathieu Garnier est né le 14 mars 1984 à Angers.", NOW), { years: 42, approximate: false });
  assert.deepEqual(ageFrom("Léa est née le 9 octobre 2014.", NOW), { years: 11, approximate: false });
  assert.deepEqual(ageFrom("Sophie est née en 1987.", NOW), { years: 39, approximate: true });
  assert.equal(ageFrom("Élodie Garnier (née Roux) est orthophoniste.", NOW), null);
});

test("sensitive memories: never in the profile, on a message only for a model of the person's own", () => {
  const memories = [
    { id: "s", kind: "user", title: null, content: "Camille a un diabète de type 1 depuis 2009.", sensitive: true },
    { id: "a", kind: "user", title: null, content: "Camille habite à Nantes." },
  ];
  const local = buildChatTurn(input({ memories, content: "Mon diabète, ça fait combien de temps ?" }));
  assert.doesNotMatch(local.messages[0].content, /diabète/);
  assert.match(local.messages.at(-1)!.content, /\[Saved notes that may be relevant\]\n- Camille a un diabète/);
  const cloud = buildChatTurn(input({ memories, content: "Mon diabète, ça fait combien de temps ?", local: false }));
  assert.doesNotMatch(JSON.stringify(cloud.messages), /diabète de type/);
  // Pinned, it is in the profile of a local turn — and a cloud turn after it
  // refreshes the profile without it.
  const pinned = [{ ...memories[0], pinned: true }, memories[1]];
  const first = buildChatTurn(input({ memories: pinned, currentId: "u1" }));
  assert.match(first.messages[0].content, /diabète/);
  const history = [{ id: "u1", role: "user", content: "Bonjour", sent: first.sent }, { id: "a1", role: "assistant", content: "Bonjour !" }];
  const after = buildChatTurn(input({ memories: pinned, state: first.state, history, content: "Et alors ?", currentId: "u2", local: false }));
  assert.doesNotMatch(after.messages[0].content, /diabète/);
});

test("small talk and « Profil seulement » carry no memory on the message; the profile stays", () => {
  const memories = [{ id: "p", kind: "project", title: "Cuisine", content: "Les travaux de la cuisine commencent en novembre." }];
  assert.doesNotMatch(buildChatTurn(input({ memories, content: "Salut, ça va ?" })).messages.at(-1)!.content, /Saved notes/);
  assert.doesNotMatch(buildChatTurn(input({ memories, content: "Quand commencent les travaux de la cuisine ?", memoryMode: "profile" })).messages.at(-1)!.content, /Saved notes/);
  assert.match(buildChatTurn(input({ memories, content: "Quand commencent les travaux de la cuisine ?" })).messages.at(-1)!.content, /Saved notes[\s\S]*Cuisine/);
});

test("ranking: an entity the message reaches by kinship lifts its memories; one about someone else falls", () => {
  assert.equal(firstPerson("Comment s'appelle ma femme ?"), true);
  assert.equal(firstPerson("Donne-moi une recette de brioche."), false);
  const items = [
    { text: "Élodie est orthophoniste à Rezé.", entities: ["elodie"] },
    { text: "Antoine est orthophoniste à Bordeaux.", entities: ["antoine"] },
    { text: "La tour Bretagne mesure 144 mètres." },
  ];
  const ranked = rankMemories(items, "Ma femme est orthophoniste dans quelle ville ?", {
    queryEntities: new Map([["elodie", 0.15]]), resolvedWords: new Set(["femme"]), self: "me",
  });
  assert.equal(ranked[0]?.index, 0);
  assert.ok(ranked.every((entry) => entry.index !== 2));
  const other = ranked.find((entry) => entry.index === 1);
  assert.ok(!other || other.score < ranked[0]!.score - 0.39, "about someone else");
});

// ── through the routes ──────────────────────────────────────────────────

type Message = { role: string; content: string };
const chats: Message[][] = [];
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
    if (!extraction) chats.push(messages);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: extraction ? "NONE" : "Réponse." } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { sqlite } = await import("../src/db.js");
const app = await buildApp();
test.after(async () => {
  await app.close();
  await new Promise((resolve) => server.close(resolve));
});

const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const headers = { authorization: `Bearer ${paired.json().token}` };
await app.inject({ method: "POST", url: "/providers/local", headers, payload: { url, model: "qwen", name: "llama.cpp" } });
const FACTS = [
  "Mathieu Garnier est né le 14 mars 1984 à Angers.",
  "Mathieu est marié à Élodie Garnier depuis 2011.",
  "Élodie est orthophoniste ; elle a ouvert son cabinet à Rezé.",
  "Le frère d'Élodie, Antoine Roux, est orthophoniste à Bordeaux.",
  "Mathieu supporte le SCO d'Angers.",
  "Mathieu déteste la coriandre.",
  "Mathieu a un diabète de type 1 diagnostiqué en 2009.",
  "Mathieu conduisait une Peugeot 308.",
];
const imported = await app.inject({
  method: "POST", url: "/memories/import", headers,
  payload: { source: "account", memories: FACTS.map((content) => ({ content, kind: "user", tags: /diabète/.test(content) ? ["sensitive"] : [] })) },
});
const ids = Object.fromEntries((imported.json().memories as Array<{ id: string; content: string }>).map((m) => [m.content, m.id]));
await app.inject({ method: "POST", url: "/entities", headers, payload: { entity: { kind: "self", name: "Mathieu Garnier", aliases: ["Mathieu"], relations: [{ to: "Élodie Garnier", label: "épouse" }] } } });
await app.inject({ method: "POST", url: "/entities", headers, payload: { entity: { kind: "person", name: "Élodie Garnier", aliases: ["Élodie"] } } });
await app.inject({ method: "POST", url: "/entities", headers, payload: { entity: { kind: "person", name: "Antoine Roux", aliases: ["Antoine"] } } });
// The car was replaced: the old fact is superseded, never given.
const car = (await app.inject({ method: "POST", url: "/memories", headers, payload: { memory: { content: "Mathieu conduit une Renault Mégane électrique depuis avril 2026." } } })).json().id as string;
sqlite.prepare("UPDATE memories SET superseded_by_id = ? WHERE id = ?").run(car, ids["Mathieu conduisait une Peugeot 308."]);

const retrieve = async (query: string, extra: Record<string, unknown> = {}) =>
  (await app.inject({ method: "POST", url: "/memories/retrieve", headers, payload: { query, context_window: 32_768, ...extra } })).json();

test("POST /memories/retrieve: the profile and the memories a message would be given, with their scores", async () => {
  const wife = await retrieve("Ma femme est orthophoniste dans quelle ville ?", { explain: true });
  assert.equal(wife.retrieval, "lexical");
  const profile = wife.profile.items.map((item: { id: string }) => item.id);
  assert.ok(profile.includes(ids["Mathieu Garnier est né le 14 mars 1984 à Angers."]), "the birth date is in the profile");
  assert.match(wife.profile.text, /\(42 years old today\)|\(\d+ years old today\)/);
  assert.match(wife.profile.text, /The user's people, places and projects: Élodie Garnier \(épouse\)\./);
  assert.ok(!profile.includes(ids["Mathieu a un diabète de type 1 diagnostiqué en 2009."]), "nothing sensitive in the profile");
  const given = [...profile, ...wife.items.map((item: { id: string }) => item.id)];
  assert.ok(given.includes(ids["Élodie est orthophoniste ; elle a ouvert son cabinet à Rezé."]));
  assert.ok(!wife.items.some((item: { id: string }) => item.id === ids["Le frère d'Élodie, Antoine Roux, est orthophoniste à Bordeaux."]), "about her brother");
  assert.ok(wife.explained.length > 0 && typeof wife.ms === "number");

  const generic = await retrieve("Quelle est la capitale de l'Australie ?");
  assert.deepEqual(generic.items, [], "a message that is not about the person gets nothing");
  assert.equal(generic.relevant_tokens, 0);

  const all = JSON.stringify(await retrieve("Quelle voiture je conduis ?"));
  assert.doesNotMatch(all, new RegExp(ids["Mathieu conduisait une Peugeot 308."]!), "superseded: never given");
  assert.equal((await app.inject({ method: "POST", url: "/memories/retrieve", headers, payload: {} })).statusCode, 422);
  const none = await retrieve("Quel est le métier de ma femme ?", { mode: "none" });
  assert.deepEqual([none.items, none.profile.tokens], [[], 0]);
  const only = await retrieve("Quel est le métier de ma femme ?", { mode: "profile" });
  assert.deepEqual(only.items, []);
  assert.ok(only.profile.tokens > 0);
});

test("/queries: what rode on a message is counted (memory_usage), the profile is in the system prompt", async () => {
  const response = await app.inject({ method: "POST", url: "/queries", headers, payload: { text: "Je supporte quelle équipe de foot déjà, le SCO ?", channel: "keyboard", force_new_discussion: true, context_window: 32_768 } });
  assert.equal(response.statusCode, 200, response.body);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const sent = chats.at(-1)!;
  assert.match(sent[0].content, /What you know about the user, from their saved Memories[\s\S]*né le 14 mars 1984/);
  const final = JSON.parse(response.body.split("\n\n").find((b) => b.startsWith("event: final"))!.replace(/^event: final\ndata: /, ""));
  const given = (final.memory.items as Array<{ id: string }>).map((item) => item.id);
  const counted = sqlite.prepare("SELECT memory_id, uses FROM memory_usage").all() as Array<{ memory_id: string; uses: number }>;
  assert.deepEqual(counted.map((row) => row.memory_id).sort(), [...given].sort());
});

test("the memory closest by meaning, clearly ahead, is kept though it shares no word (« un projet d'achat » → « acquérir un Mac Mini »)", () => {
  // Unit vectors at chosen cosines with the query (first axis).
  const at = (cosine: number, axis: number) => {
    const v = new Float32Array(8);
    v[0] = cosine;
    v[axis] = Math.sqrt(1 - cosine * cosine);
    return v;
  };
  const query = at(1, 1);
  const items = [
    { text: "Jimmy fait des projets maker : Raspberry Pi, Arduino.", vector: at(0.461, 2) },
    { text: "Twoody est un projet important et récurrent.", vector: at(0.476, 3) },
    { text: "Le projet H-Way avance le vendredi.", vector: at(0.441, 4) },
    { text: "Je réfléchis actuellement à acquérir un Mac Mini", vector: at(0.585, 5) },
  ];
  const ranked = rankMemories(items, "Est-ce que tu sais si j'ai un projet d'achat en ce moment ?", { queryVector: query });
  assert.ok(ranked.some((entry) => entry.index === 3), JSON.stringify(ranked));
  // Not clearly ahead: no exception.
  const close = [...items.slice(0, 3), { ...items[3]!, vector: at(0.5, 5) }];
  assert.ok(!rankMemories(close, "Est-ce que tu sais si j'ai un projet d'achat en ce moment ?", { queryVector: query }).some((entry) => entry.index === 3));
});

test("what the person told Twoody this week is in the profile, whatever is asked; an older fact or a project is not", () => {
  const day = 86_400_000;
  const turn = buildChatTurn(input({
    content: "Bonjour",
    memories: [
      { id: "new", kind: "user", title: null, content: "Je réfléchis à acquérir un Mac Mini", source: "conversation", createdAt: NOW.getTime() - 2 * day },
      { id: "old", kind: "user", title: null, content: "Je joue au padel le dimanche", source: "conversation", createdAt: NOW.getTime() - 30 * day },
      { id: "proj", kind: "project", title: null, content: "La cuisine sera refaite en novembre", manual: true, source: "manual", createdAt: NOW.getTime() - day },
    ],
  }));
  assert.match(turn.messages[0]!.content, /Mac Mini/);
  assert.doesNotMatch(turn.messages[0]!.content, /cuisine/);
});
