import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Mémoire v2, lot L6 (docs/memory-v2-design.md §4): what was said in passing
// is learned once the conversation is over, from the whole of it — sure
// facts kept, doubtful, changed and sensitive ones « À confirmer », nothing
// from the assistant's words, nothing from a conversation in « Aucune ».

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-learner-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
delete process.env.BRIDGE_LOCAL_LLM_ENDPOINT;
delete process.env.TWOODY_EMBEDDING_BINARY;
delete process.env.TWOODY_EMBEDDING_MODEL;

const { db, memories, sqlite } = await import("../src/db.js");
const learner = await import("../src/memory/learner.js");
const { judgeFacts, parseLearning, learnDiscussion, acceptCandidate, rejectCandidate, listCandidates, pendingDiscussions, LEARN_IDLE_MS } = learner;
const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");

const app = await buildApp();
test.after(() => app.close());
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const headers = { authorization: `Bearer ${paired.json().token}` };
const userId = (sqlite.prepare("SELECT id FROM users LIMIT 1").get() as { id: string }).id;

type Line = { role: "user" | "assistant"; content: string };
let counter = 0;
function conversation(lines: Line[], options: { mode?: string | null; idleMs?: number } = {}): string {
  const id = `d${++counter}`;
  const at = Math.floor((Date.now() - (options.idleMs ?? LEARN_IDLE_MS + 60_000)) / 1000);
  sqlite.prepare("INSERT INTO discussions (id, user_id, channel, title, memory_mode, created_at, last_activity_at) VALUES (?, ?, 'desktop', NULL, ?, ?, ?)")
    .run(id, userId, options.mode ?? null, at, at);
  for (const line of lines) addLine(id, line);
  return id;
}
function addLine(discussionId: string, line: Line) {
  sqlite.prepare("INSERT INTO messages (id, discussion_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(`msg${++counter}`, discussionId, userId, line.role, line.content, Math.floor(Date.now() / 1000));
}
const fact = (text: string, evidence: string, extra: Record<string, unknown> = {}) => ({ text, evidence, kind: "user", category: "family", confidence: 0.8, supersedes: null, ...extra });
const answer = (...facts: unknown[]) => `<think>hmm</think>\n\`\`\`json\n${JSON.stringify({ facts })}\n\`\`\``;
const memoryTexts = () => db.select().from(memories).all().map((row) => row.content);

test("the model's answer: JSON, even after reasoning or in a code fence; anything else is nothing", () => {
  const facts = parseLearning(answer(fact("a une fille, Léa", "ma fille Léa"), { text: "x" }, fact("Habite à Antony", "j'habite à Antony", { kind: "bogus", category: "nowhere", confidence: 7 })));
  assert.deepEqual(facts.map((f) => [f.text, f.kind, f.category, f.confidence]), [["A une fille, Léa", "user", "family", 0.8], ["Habite à Antony", "user", "other", 1]]);
  assert.deepEqual(parseLearning("NONE"), []);
  assert.deepEqual(parseLearning("{not json"), []);
  assert.deepEqual(parseLearning('{"facts": "none"}'), []);
});

test("a fact must quote what the person said: never one from the assistant's words, nor one already known", () => {
  const personLines = ["Au fait, j’ai adopté un lapin nain, il s’appelle Biscotte.", "Oui, on l'a mis dans la buanderie."];
  const known = [{ ref: "m1", id: "mem-dog", text: "A un chien, Pixel." }, { ref: "m2", id: "mem-city", text: "Habite à Antony." }];
  const judged = judgeFacts(parseLearning(answer(
    fact("A un lapin nain, Biscotte", "j'ai adopté un lapin nain, il s'appelle Biscotte", { category: "pet", confidence: 0.75 }),
    fact("A un chien, Pixel", "Pense à l'abri de Pixel", { category: "pet", confidence: 0.95 }),
    fact("Habite à Antony", "on l'a mis dans la buanderie", { confidence: 0.95 }),
    fact("A un chien nommé Pixel", "Oui, on l'a mis dans la buanderie", { confidence: 0.95 }),
  )), { personLines, known });
  assert.deepEqual(judged.save.map((j) => j.fact.text), ["A un lapin nain, Biscotte"], "said in the first person: 0.75 + 0.15, over the bar");
  assert.deepEqual(judged.dropped.map((d) => d.reason), ["no_evidence", "known", "known"]);
});

test("a name or number only the assistant wrote is not the person's: « le 29 novembre », restated from a memory", () => {
  const personLines = ["Rappelle-moi la date de mon marathon ?", "Top. D'ailleurs mon numéro de dossard, c'est le 1843."];
  const assistantLines = ["Ton marathon de La Rochelle a lieu le 29 novembre 2026.", "Noté, dossard 1843."];
  const judged = judgeFacts(parseLearning(answer(
    fact("Court le marathon de La Rochelle le 29 novembre 2026", "mon marathon", { category: "date", confidence: 0.9 }),
    fact("A le dossard 1843", "mon numéro de dossard, c'est le 1843", { category: "date", confidence: 0.9 }),
  )), { personLines, assistantLines, known: [] });
  assert.deepEqual(judged.save.map((j) => j.fact.text), ["A le dossard 1843"]);
  assert.deepEqual(judged.dropped.map((d) => d.reason), ["from_assistant"]);
});

test("doubtful facts are proposed or dropped, sensitive ones always proposed, a change of a known fact proposed with it", () => {
  const personLines = ["Je crois que mon rendez-vous chez le dentiste est mardi.", "J'ai 41 ans maintenant.", "On m'a diagnostiqué un diabète l'an dernier.", "Il est peut-être possible que je déménage."];
  const known = [{ ref: "m1", id: "mem-age", text: "A 40 ans." }];
  const judged = judgeFacts(parseLearning(answer(
    fact("Rendez-vous chez le dentiste mardi", "mon rendez-vous chez le dentiste est mardi", { category: "date", confidence: 0.7 }),
    fact("A 41 ans", "J'ai 41 ans", { category: "identity", confidence: 0.9, supersedes: "m1" }),
    fact("Est diabétique", "On m'a diagnostiqué un diabète", { category: "identity", confidence: 0.95 }),
    fact("Va déménager", "que je déménage", { category: "home", confidence: 0.6 }),
  )), { personLines, known });
  assert.deepEqual(judged.save, []);
  assert.deepEqual(judged.propose.map((j) => [j.fact.text, j.sensitive, j.supersedesId]), [
    ["Rendez-vous chez le dentiste mardi", false, null],
    ["A 41 ans", false, "mem-age"],
    ["Est diabétique", true, null],
  ]);
  assert.deepEqual(judged.dropped.map((d) => [d.fact.text, d.reason]), [["Va déménager", "unsure"]]);
});

test("a conversation is read once, as a whole, and only what the person said goes to the model", async () => {
  const id = conversation([
    { role: "user", content: "J'ai adopté un chat, il s'appelle Moka. \n<<document name=\"bail.pdf\">>\nLoyer 1200 euros\n<</document>>" },
    { role: "assistant", content: "Bienvenue à Moka ! " + "Un chat demande… ".repeat(60) },
    { role: "user", content: "Et je préfère des réponses courtes." },
  ]);
  const prompts: string[] = [];
  const ask = async (_user: string, messages: Array<{ content: string }>) => {
    prompts.push(messages[1]!.content);
    return answer(
      fact("A un chat, Moka", "J'ai adopté un chat, il s'appelle Moka", { category: "pet", confidence: 0.85 }),
      fact("Préfère des réponses courtes", "je préfère des réponses courtes", { kind: "feedback", category: "preference", confidence: 0.6 }),
      fact("Paie 1200 euros de loyer", "Loyer 1200 euros", { category: "finances", confidence: 0.9 }),
    );
  };
  const result = await learnDiscussion(id, { ask });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /PERSON: J'ai adopté un chat, il s'appelle Moka\.\nASSISTANT: Bienvenue à Moka/);
  assert.doesNotMatch(prompts[0]!, /Loyer|bail\.pdf/, "documents are left out");
  assert.ok(prompts[0]!.split("\n").find((line) => line.startsWith("ASSISTANT"))!.length <= 312, "the assistant's turn is cut");
  assert.equal(result!.saved.length, 1);
  assert.equal(result!.proposed.length, 1, "« réponses courtes »: 0.6 + 0.15, proposed");
  const kept = db.select().from(memories).all().find((row) => row.content === "A un chat, Moka")!;
  assert.deepEqual([kept.source, kept.sourceRef, JSON.parse(kept.tagsJson)], ["conversation", id, ["learned"]]);
  assert.ok(!memoryTexts().some((text) => /loyer/i.test(text)), "the document's words are no evidence");

  // Read already: nothing new, the model is not asked again.
  assert.equal((await learnDiscussion(id, { ask }))!.read, 0);
  assert.equal(prompts.length, 1);
  // Something new: only the new part.
  addLine(id, { role: "user", content: "Moka a deux ans." });
  await learnDiscussion(id, { ask: async (_u, messages) => { prompts.push(messages[1]!.content); return answer(); } });
  assert.doesNotMatch(prompts[1]!, /adopté/);
  assert.match(prompts[1]!, /PERSON: Moka a deux ans\./);
  assert.match(prompts[1]!, /m\d: A un chat, Moka/, "what is known about it is shown");
});

test("« Aucune », its own or the person's: never read, not even later", async () => {
  const id = conversation([{ role: "user", content: "Je m'appelle Camille et j'habite à Lyon." }], { mode: "none" });
  let asked = 0;
  const ask = async () => { asked += 1; return answer(fact("Habite à Lyon", "j'habite à Lyon", { confidence: 0.95 })); };
  await learnDiscussion(id, { ask });
  sqlite.prepare("UPDATE discussions SET memory_mode = 'full' WHERE id = ?").run(id);
  await learnDiscussion(id, { ask });
  assert.equal(asked, 0);
  assert.ok(!memoryTexts().includes("Habite à Lyon"));
});

test("the model failing: nothing read is lost, tried again later", async () => {
  const id = conversation([{ role: "user", content: "Mon fils s'appelle Noé." }]);
  await assert.rejects(learnDiscussion(id, { ask: async () => { throw new Error("busy"); } }));
  assert.ok(!pendingDiscussions({ userId, idleMs: 0 }).includes(id), "not tried again at once");
  assert.ok(pendingDiscussions({ userId, idleMs: 0, now: Date.now() + 31 * 60_000 }).includes(id));
  const result = await learnDiscussion(id, { ask: async () => answer(fact("A un fils, Noé", "Mon fils s'appelle Noé", { confidence: 0.8 })) });
  assert.equal(result!.saved.length, 1);
});

test("only conversations quiet for ten minutes are read on their own", () => {
  const quiet = conversation([{ role: "user", content: "J'ai un vélo." }]);
  const busy = conversation([{ role: "user", content: "J'ai une trottinette." }], { idleMs: 60_000 });
  const pending = pendingDiscussions({ idleMs: LEARN_IDLE_MS });
  assert.ok(pending.includes(quiet));
  assert.ok(!pending.includes(busy));
  assert.ok(pendingDiscussions({ userId, idleMs: 0, except: quiet }).includes(busy), "a new conversation: the others at once");
  assert.ok(!pendingDiscussions({ userId, idleMs: 0, except: quiet }).includes(quiet));
});

test("« À confirmer »: kept as proposed or corrected, a change replaces the known fact, a refusal is final", async () => {
  const [age] = db.insert(memories).values({ id: "mem-age-2", userId, kind: "user", title: "A 40 ans.", content: "A 40 ans.", tagsJson: "[]", source: "manual", createdAt: new Date(), updatedAt: new Date() }).returning().all();
  const id = conversation([
    { role: "user", content: "J'ai 41 ans depuis hier." },
    { role: "user", content: "Je suis sous traitement pour l'asthme." },
    { role: "user", content: "Je crois que ma sœur vient en mai." },
  ]);
  await learnDiscussion(id, { ask: async (_u, messages) => {
    const ref = /(m\d+): A 40 ans\./.exec(messages[1]!.content)![1];
    return answer(
      fact("A 41 ans", "J'ai 41 ans", { category: "identity", confidence: 0.95, supersedes: ref }),
      fact("Est asthmatique", "sous traitement pour l'asthme", { category: "health", confidence: 0.95 }),
      fact("Sa sœur vient en mai", "ma sœur vient en mai", { confidence: 0.85 }),
    );
  } });
  const listed = (await app.inject({ url: "/memories/candidates", headers })).json().candidates as Array<{ id: string; content: string; sensitive: boolean; supersedes: { id: string; content: string } | null }>;
  const byText = new Map(listed.map((c) => [c.content, c]));
  assert.deepEqual(byText.get("A 41 ans")!.supersedes, { id: age!.id, content: "A 40 ans." });
  assert.equal(byText.get("Est asthmatique")!.sensitive, true);

  const changed = await app.inject({ method: "POST", url: `/memories/candidates/${byText.get("A 41 ans")!.id}/accept`, headers, payload: {} });
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.json().memory.id, age!.id);
  assert.equal(changed.json().memory.content, "A 41 ans");

  const health = await app.inject({ method: "POST", url: `/memories/candidates/${byText.get("Est asthmatique")!.id}/accept`, headers, payload: { content: "Asthmatique, traité depuis 2020" } });
  assert.equal(health.json().memory.content, "Asthmatique, traité depuis 2020");
  assert.deepEqual(health.json().memory.tags, ["learned", "sensitive"]);

  const sister = byText.get("Sa sœur vient en mai")!;
  assert.equal((await app.inject({ method: "POST", url: `/memories/candidates/${sister.id}/reject`, headers })).statusCode, 204);
  assert.equal((await app.inject({ method: "POST", url: `/memories/candidates/${sister.id}/reject`, headers })).statusCode, 404);
  assert.deepEqual(listCandidates(userId).map((c) => c.content).filter((t) => /41|asthm|sœur/.test(t)), []);

  // Said again in another conversation: not proposed again.
  const again = conversation([{ role: "user", content: "Je crois que ma sœur vient en mai." }]);
  const result = await learnDiscussion(again, { ask: async () => answer(fact("Sa sœur vient en mai", "ma sœur vient en mai", { confidence: 0.85 })) });
  assert.deepEqual([result!.saved, result!.proposed], [[], []]);
  assert.throws(() => acceptCandidate(userId, sister.id), /not_found/);
  assert.throws(() => rejectCandidate(userId, "nope"), /not_found/);
});

test("POST /memories/learn: one conversation now, or a 404 for someone else's", async () => {
  learner.setLearningModel(async () => answer(fact("Joue du piano", "je joue du piano", { category: "habit", confidence: 0.9 })));
  try {
    const id = conversation([{ role: "user", content: "Le soir, je joue du piano." }], { idleMs: 0 });
    const learned = await app.inject({ method: "POST", url: "/memories/learn", headers, payload: { discussion_id: id } });
    assert.equal(learned.statusCode, 200, learned.body);
    assert.equal(learned.json().results[0].saved.length, 1);
    assert.ok(memoryTexts().includes("Joue du piano"));
    assert.equal((await app.inject({ method: "POST", url: "/memories/learn", headers, payload: { discussion_id: "nope" } })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: "/memories/learn", payload: {} })).statusCode, 401);
  } finally {
    learner.setLearningModel(null);
  }
});

test("a new conversation: the one before is read once the computer answers nothing", async () => {
  const { beginGeneration } = await import("../src/account/inflight.js");
  let asked = 0;
  learner.setLearningModel(async () => { asked += 1; return answer(fact("Fait du kayak", "je fais du kayak", { category: "habit", confidence: 0.9 })); });
  const running = learner.startLearning({ firstTickMs: 3_600_000 });
  const answering = beginGeneration("chat");
  try {
    const before = conversation([{ role: "user", content: "Le dimanche, je fais du kayak." }], { idleMs: 0 });
    learner.learnSoon(userId, "the-new-one");
    await new Promise((resolve) => setTimeout(resolve, 2_600));
    assert.equal(asked, 0, "the new conversation's answer goes first");
    answering();
    await new Promise((resolve) => setTimeout(resolve, 5_600));
    assert.ok(asked >= 1, "this one, and the others left unread above");
    assert.ok(memoryTexts().includes("Fait du kayak"));
    assert.ok(!pendingDiscussions({ userId, idleMs: 0 }).includes(before));
  } finally {
    answering();
    running.stop();
    learner.setLearningModel(null);
  }
});
