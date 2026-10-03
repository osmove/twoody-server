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
  const at = Date.now() - (options.idleMs ?? LEARN_IDLE_MS + 60_000);
  sqlite.prepare("INSERT INTO discussions (id, user_id, channel, title, memory_mode, created_at, last_activity_at) VALUES (?, ?, 'desktop', NULL, ?, ?, ?)")
    .run(id, userId, options.mode ?? null, at, at);
  for (const line of lines) addLine(id, line);
  return id;
}
function addLine(discussionId: string, line: Line) {
  sqlite.prepare("INSERT INTO messages (id, discussion_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(`msg${++counter}`, discussionId, userId, line.role, line.content, Date.now());
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
  const [before, read] = prompts[1]!.split("CONVERSATION:\n");
  assert.doesNotMatch(read!, /adopté/);
  assert.match(before!, /EARLIER:\nPERSON: J'ai adopté un chat/, "what came before, as context only");
  assert.match(read!, /PERSON: Moka a deux ans\./);
  assert.match(prompts[1]!, /m\d: A un chat, Moka/, "what is known about it is shown");
});

test("a memory is written in the language the person spoke in that conversation, else in their usual one", async () => {
  // « Mme Dupont souhaite mettre fin à l'accord de services », learned from
  // an English conversation (03/10/2026).
  const english = conversation([
    { role: "user", content: "Mrs Dupont is my client and she wants to end the services agreement before the end of the year. What notice does she have to give?" },
    { role: "assistant", content: "Under the agreement, she must give one month's notice in writing." },
  ]);
  const prompts: Array<Array<{ role: string; content: string }>> = [];
  const ask = async (_user: string, messages: Array<{ role: "system" | "user"; content: string }>) => {
    prompts.push(messages);
    return answer();
  };
  await learnDiscussion(english, { ask });
  assert.match(prompts[0]![1]!.content, /\n\nWrite each text and title in English, the language the PERSON spoke in this conversation, keeping names and quoted terms as they were\.$/);
  assert.match(prompts[0]![0]!.content, /in the language the PERSON uses in CONVERSATION, never translated, even when KNOWN, PROJECTS or the examples here are in another language/);

  // Too short to tell: the locale the app gave with this conversation.
  const short = conversation([{ role: "user", content: "Moka, 2 ans." }]);
  sqlite.prepare("UPDATE discussions SET context = ? WHERE id = ?").run(JSON.stringify({ v: 1, locale: "de-DE" }), short);
  await learnDiscussion(short, { ask });
  assert.match(prompts[1]![1]!.content, /Write each text and title in German,/);
  assert.equal(prompts[1]![0]!.content, prompts[0]![0]!.content, "the system message is the same whatever the language (the runtime reuses it)");

  const { conversationLanguage } = learner;
  assert.equal(conversationLanguage(userId, english, ["Je voudrais résilier le contrat de prestation avant la fin de l'année."]), "fr");
  assert.equal(conversationLanguage(userId, english, ["¿Qué preaviso debe dar la señora Dupont para terminar el contrato?"]), "es");
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

test("what was learned is told: in its conversation, and once in the next one", async () => {
  const id = conversation([{ role: "user", content: "Je fais de l'escalade le jeudi." }]);
  await learnDiscussion(id, { ask: async () => answer(
    fact("Fait de l'escalade le jeudi", "Je fais de l'escalade le jeudi", { category: "habit", confidence: 0.9 }),
    fact("Fait peut-être un stage en mai", "Je fais de l'escalade le jeudi", { category: "date", confidence: 0.6 }),
  ) });
  const opened = (await app.inject({ url: `/discussions/${id}`, headers })).json();
  assert.equal(opened.memory_notices.length, 1);
  assert.deepEqual(opened.memory_notices[0].saved.map((m: { content: string }) => m.content), ["Fait de l'escalade le jeudi"]);
  assert.equal(opened.memory_notices[0].proposed, 1);

  const news = (await app.inject({ url: "/memories/news?except=another", headers })).json();
  const mine = news.notices.find((n: { discussion_id: string }) => n.discussion_id === id);
  assert.ok(mine, "told in the next conversation");
  assert.ok(news.candidates >= 1);
  const again = (await app.inject({ url: "/memories/news", headers })).json();
  assert.ok(!again.notices.some((n: { discussion_id: string }) => n.discussion_id === id), "once");
  assert.equal((await app.inject({ url: `/discussions/${id}`, headers })).json().memory_notices.length, 1, "the conversation keeps saying it");
});

test("« Doublons possibles »: the same fact said twice, by its words without vectors; a pair said to differ is not shown again", async () => {
  const put = (id: string, content: string, days: number) => db.insert(memories).values({ id, userId, kind: "user", title: null, content, tagsJson: "[]", source: "import", sourceRef: "claude", createdAt: new Date(Date.now() - days * 86_400_000), updatedAt: new Date() }).run();
  put("dup-a", "Jimmy préfère les e-mails professionnels sans icônes.", 40);
  put("dup-b", "Dans les e-mails professionnels, Jimmy préfère sans icônes.", 1);
  put("dup-c", "Jimmy joue au padel le dimanche.", 3);
  const pairs = (await app.inject({ url: "/memories/similar", headers })).json().pairs as Array<{ by: string; memories: Array<{ id: string }> }>;
  const pair = pairs.find((p) => p.memories.some((m) => m.id === "dup-a"))!;
  assert.deepEqual(pair.memories.map((m) => m.id), ["dup-a", "dup-b"], "the older first");
  assert.equal(pair.by, "words");
  assert.ok(!pairs.some((p) => p.memories.some((m) => m.id === "dup-c")));
  assert.equal((await app.inject({ method: "POST", url: "/memories/similar/dismiss", headers, payload: { ids: ["dup-b", "dup-a"] } })).statusCode, 204);
  assert.ok(!(await app.inject({ url: "/memories/similar", headers })).json().pairs.some((p: { memories: Array<{ id: string }> }) => p.memories.some((m) => m.id === "dup-a")));
  assert.equal((await app.inject({ method: "POST", url: "/memories/similar/dismiss", headers, payload: { ids: ["dup-a"] } })).statusCode, 422);
});

test("« retiens que… » is kept as said: the learner does not learn it again in other words", async () => {
  const id = conversation([{ role: "user", content: "Retiens que je réfléchis actuellement à acquérir un Mac Mini" }]);
  const result = await learnDiscussion(id, { ask: async () => answer(fact("Envisage l'achat d'un Mac Mini", "je réfléchis actuellement à acquérir un Mac Mini", { category: "project", confidence: 0.9 })) });
  assert.deepEqual([result!.saved, result!.proposed], [[], []]);
});

test("projects: a new one is proposed, never made on its own; a hypothesis or one already known is not", async () => {
  const { parseProjects, judgeProjects } = learner;
  const personLines = ["Je réfléchis à acheter un Mac mini pour faire tourner Twoody.", "Si un jour j'avais les moyens, j'achèterais une Tesla.", "On se marie en juin 2027 avec Claire-Sophie !"];
  const projects = parseProjects(JSON.stringify({ facts: [], projects: [
    { title: "Achat d'un Mac mini", name: "Mac mini", kind: "purchase", size: "small", status: "idea", due: null, evidence: "Je réfléchis à acheter un Mac mini", confidence: 0.8, ref: null },
    { title: "Achat d'une Tesla", name: "Tesla", kind: "purchase", size: "large", status: "idea", due: null, evidence: "j'achèterais une Tesla", confidence: 0.6, ref: null },
    { title: "Mariage", name: "mariage", kind: "event", size: "large", status: "active", due: "2027-06-15", evidence: "On se marie en juin 2027", confidence: 0.95, ref: "p1" },
    { title: "Déménagement", name: "déménagement", kind: "home", size: "large", status: "active", due: null, evidence: "nous déménageons", confidence: 0.9, ref: null },
  ] }));
  // Four sizes (Jimmy, 02/10/2026): what the model says is kept, anything else is small.
  assert.deepEqual(projects.map((project) => project.size), ["small", "large", "large", "large"]);
  assert.deepEqual(parseProjects(JSON.stringify({ projects: ["medium", "critical", "huge"].map((size) => ({ title: `Projet ${size}`, size, evidence: "x", confidence: 0.9 })) })).map((project) => project.size), ["medium", "critical", "small"]);
  const known = [{ ref: "p1", id: "proj-wedding", title: "Mariage", status: "active", name: "mariage" }];
  const judged = judgeProjects(projects, { personLines, known });
  assert.deepEqual(judged.propose.map((j) => [j.project.title, j.updates?.id ?? null]), [["Achat d'un Mac mini", null], ["Mariage", "proj-wedding"]]);
  assert.deepEqual(judged.dropped.map((d) => [d.project.title, d.reason]), [["Achat d'une Tesla", "hypothesis"], ["Déménagement", "no_evidence"]]);
  // Known, same status, no date: nothing to say.
  const same = judgeProjects(parseProjects(JSON.stringify({ projects: [{ title: "Mariage", name: "mariage", status: "active", evidence: "On se marie en juin 2027", confidence: 0.9, ref: "p1" }] })), { personLines, known });
  assert.deepEqual(same.dropped.map((d) => d.reason), ["known"]);
});

test("a project proposed by the learner, kept: it exists, knows its memories, and the conversation is about it", async () => {
  const id = conversation([{ role: "user", content: "Je réfléchis à acheter un Mac mini, le M5 Pro avec 64 Go." }]);
  await learnDiscussion(id, { ask: async () => JSON.stringify({
    facts: [fact("Envisage un Mac mini M5 Pro 64 Go", "Je réfléchis à acheter un Mac mini, le M5 Pro avec 64 Go", { category: "project", confidence: 0.95 })],
    projects: [{ title: "Achat d'un Mac mini", name: "Mac mini", kind: "purchase", size: "small", status: "idea", due: null, evidence: "Je réfléchis à acheter un Mac mini", confidence: 0.8, ref: null }],
  }) });
  const candidates = (await app.inject({ url: "/memories/candidates", headers })).json().candidates as Array<{ id: string; type: string; content: string; project: { kind: string } }>;
  const proposal = candidates.find((c) => c.type === "project")!;
  assert.equal(proposal.content, "Achat d'un Mac mini");
  assert.equal(proposal.project.kind, "purchase");
  assert.equal((await app.inject({ url: "/projects", headers })).json().length, 0, "not made before the person says so");

  const kept = await app.inject({ method: "POST", url: `/memories/candidates/${proposal.id}/accept`, headers, payload: {} });
  assert.equal(kept.statusCode, 200, kept.body);
  const projectId = kept.json().project_id as string;
  const { ensureLinked } = await import("../src/memory/entities.js");
  ensureLinked(userId);
  const detail = (await app.inject({ url: `/projects/${projectId}`, headers })).json().project;
  assert.deepEqual([detail.title, detail.name, detail.kind, detail.status, detail.source], ["Achat d'un Mac mini", "Mac mini", "purchase", "idea", "learned"]);
  assert.ok(detail.memories.some((m: { content: string }) => /M5 Pro/.test(m.content)), JSON.stringify(detail.memories));
  assert.deepEqual(detail.conversations.map((c: { id: string }) => c.id), [id]);

  // Said again: not proposed twice.
  const again = conversation([{ role: "user", content: "Toujours sur le Mac mini, j'hésite encore." }]);
  await learnDiscussion(again, { ask: async () => JSON.stringify({ facts: [], projects: [{ title: "Achat d'un Mac mini", name: "Mac mini", kind: "purchase", status: "idea", evidence: "Toujours sur le Mac mini", confidence: 0.8, ref: "p1" }] }) });
  assert.equal(listCandidates(userId).filter((c) => c.type !== "fact").length, 0);
});

test("/projects: made by hand, changed, tied to a task, removed (what hung off it stays)", async () => {
  const made = await app.inject({ method: "POST", url: "/projects", headers, payload: { project: { title: "Mariage", kind: "event", size: "large", due_at: "2027-06-15T12:00:00.000Z" } } });
  assert.equal(made.statusCode, 201, made.body);
  const id = made.json().project.id as string;
  assert.equal((await app.inject({ method: "POST", url: "/projects", headers, payload: { project: { title: "" } } })).statusCode, 422);
  assert.equal((await app.inject({ method: "PATCH", url: `/projects/${id}`, headers, payload: { project: { status: "nope" } } })).statusCode, 422);
  const changed = (await app.inject({ method: "PATCH", url: `/projects/${id}`, headers, payload: { project: { status: "done" } } })).json().project;
  assert.equal(changed.status, "done");
  assert.ok(changed.done_at);
  sqlite.prepare("INSERT INTO tasks (id, user_id, title, created_at, updated_at) VALUES ('t1', ?, 'Réserver la salle', ?, ?)").run(userId, 1, 1);
  const linked = (await app.inject({ method: "POST", url: `/projects/${id}/link`, headers, payload: { task_id: "t1" } })).json().project;
  assert.deepEqual(linked.tasks.map((t: { title: string }) => t.title), ["Réserver la salle"]);
  assert.equal(linked.counts.tasks_open, 1);
  assert.equal((await app.inject({ method: "POST", url: `/projects/${id}/link`, headers, payload: { task_id: "nope" } })).statusCode, 404);
  assert.equal((await app.inject({ method: "DELETE", url: `/projects/${id}`, headers })).statusCode, 204);
  assert.equal((sqlite.prepare("SELECT project_id FROM tasks WHERE id = 't1'").get() as { project_id: string | null }).project_id, null);
  assert.equal((await app.inject({ url: "/projects" })).statusCode, 401);
});

// « et ils se sont mariés en 2019 » answered « C'est noté » and nothing was
// kept (Jimmy, 01/10/2026): what was said is read right after each answer,
// with the messages before it to say who « ils » are, and stops for the next
// answer — which never waits for it.
test("after each answer: read at once, with what came before as context; the next answer stops it and it starts over", async () => {
  const { beginGeneration } = await import("../src/account/inflight.js");
  const id = conversation([
    { role: "user", content: "Mon ami David est marié à Dafna." },
    { role: "assistant", content: "D'accord." },
  ], { idleMs: 0 });
  sqlite.prepare("UPDATE discussions SET learned_through = (SELECT MAX(rowid) FROM messages WHERE discussion_id = ?) WHERE id = ?").run(id, id);
  addLine(id, { role: "user", content: "et ils se sont mariés en 2019" });
  addLine(id, { role: "assistant", content: "C'est noté." });

  const prompts: string[] = [];
  let stopped = 0;
  learner.setLearningModel((_user, messages, signal) => new Promise((resolve, reject) => {
    prompts.push(messages[1]!.content);
    if (prompts.length === 1) {
      // The first read is still running when the next message comes.
      signal?.addEventListener("abort", () => { stopped += 1; reject(new Error("aborted")); });
      return;
    }
    resolve(answer(fact("David et Dafna se sont mariés en 2019", "et ils se sont mariés en 2019", { confidence: 0.9 })));
  }));
  const running = learner.startLearning({ firstTickMs: 3_600_000 });
  try {
    learner.learnAfterAnswer(id);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(prompts.length, 1, "read at once");
    assert.equal(learner.isLearning(id), true);
    assert.match(prompts[0]!, /EARLIER:\nPERSON: Mon ami David est marié à Dafna\.[\s\S]*CONVERSATION:\nPERSON: et ils se sont mariés en 2019/);
    const answering = beginGeneration("chat");
    assert.equal(stopped, 1, "the next answer stops it");
    await new Promise((resolve) => setTimeout(resolve, 2_600));
    assert.equal(prompts.length, 1, "not while the answer is written");
    answering();
    await new Promise((resolve) => setTimeout(resolve, 2_600));
    assert.equal(prompts.length, 2, "started over once it is written");
    assert.ok(memoryTexts().includes("David et Dafna se sont mariés en 2019"), "« David », « Dafna »: the person's words, said before");
    assert.equal(learner.isLearning(id), false);
    const notices = (await app.inject({ method: "GET", url: `/discussions/${id}/memory_notices`, headers })).json();
    assert.equal(notices.learning, false);
    assert.deepEqual(notices.notices.at(-1).saved.map((m: { content: string }) => m.content), ["David et Dafna se sont mariés en 2019"]);
    assert.equal((await app.inject({ method: "GET", url: "/discussions/nope/memory_notices", headers })).statusCode, 404);
  } finally {
    running.stop();
    learner.setLearningModel(null);
  }
});

// The Pi read again, two minutes of its four cores each, the conversations
// the Mac had answered and learned, brought by the encrypted history — its
// fan (02/10/2026): an exchange another computer answered is not read here.
test("an exchange another computer answered (from the encrypted history) is not read again here", async () => {
  const id = conversation([], { idleMs: 0 });
  sqlite.prepare("INSERT INTO messages (id, discussion_id, user_id, role, content, created_at) VALUES (?, ?, ?, 'user', 'Ma sœur s''appelle Inès.', ?)").run(`v${++counter}`, id, userId, Date.now());
  sqlite.prepare("INSERT INTO messages (id, discussion_id, user_id, role, content, provider, created_at) VALUES (?, ?, ?, 'assistant', 'Noté.', 'vault', ?)").run(`v${++counter}`, id, userId, Date.now());
  let asked = 0;
  const result = await learnDiscussion(id, { ask: async () => { asked += 1; return answer(); } });
  assert.equal(asked, 0);
  assert.deepEqual(result!.saved, []);
  assert.ok(!pendingDiscussions({ userId, idleMs: 0 }).includes(id), "and not looked at again");
});

// Steeve imported what Claude knew of him (02/10/2026): the projects, people
// and dates in it are proposed, held to the facts, and made only once ticked.
test("after an import: projects, contacts and dates proposed from its memories, made only when ticked", async () => {
  const { discoverFromMemories, applyDiscovery } = await import("../src/memory/discover.js");
  const ids = ["Steeve a fondé The Posterity Project, une plateforme de mémoire numérique.", "Sa fille Lina est née le 3 mars 2019.", "Il se marie avec Sarah le 14 juin 2027."].map((content, index) => {
    const id = `import-${index}-${++counter}`;
    db.insert(memories).values({ id, userId, kind: "user", title: null, content, tagsJson: "[\"import\"]", source: "import", createdAt: new Date(), updatedAt: new Date() }).run();
    return id;
  });
  let prompt = "";
  const found = await discoverFromMemories(userId, ids, async (_user, messages) => {
    prompt = messages[1]!.content;
    return JSON.stringify({
      projects: [{ title: "The Posterity Project", name: null, kind: "work", status: "active", facts: ["F1"] }, { title: "Inventé", kind: "work", status: "active", facts: ["F9"] }],
      contacts: [{ name: "Lina", relation: "family", detail: "fille", birthday: "2019-03-03", facts: ["F2"] }, { name: "Sarah", relation: "partner", birthday: "2019-02-30", facts: ["F3"] }],
      events: [{ name: "Mariage avec Sarah", date: "2027-06-14", facts: ["F3"] }, { name: "Sans date", date: "bientôt", facts: ["F3"] }],
    });
  });
  assert.match(prompt, /F1: Steeve a fondé The Posterity Project/);
  assert.deepEqual(found.projects.map((project) => [project.title, project.memory_ids]), [["The Posterity Project", [ids[0]]]], "a fact not given is no evidence");
  assert.deepEqual(found.contacts.map((contact) => [contact.name, contact.birthday]), [["Lina", "2019-03-03"], ["Sarah", null]], "no date that does not exist");
  assert.deepEqual(found.events.map((event) => [event.name, event.date]), [["Mariage avec Sarah", "2027-06-14"]]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM contacts WHERE user_id = ?").get(userId)!.n, 0, "nothing made yet");

  const made = applyDiscovery(userId, { projects: found.projects, contacts: [found.contacts[0]!], events: found.events });
  assert.deepEqual([made.projects.length, made.contacts.length, made.events.length], [1, 1, 1]);
  assert.equal((sqlite.prepare("SELECT birthday, relation_type FROM contacts WHERE id = ?").get(made.contacts[0]) as { birthday: string }).birthday, "2019-03-03");
  // Ticked twice: nothing made twice.
  assert.deepEqual(Object.values(applyDiscovery(userId, { projects: found.projects, contacts: [found.contacts[0]!], events: found.events })).map((list) => list.length), [0, 0, 0]);
  const response = await app.inject({ method: "POST", url: "/memories/discover/apply", headers, payload: { contacts: [found.contacts[1]] } });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().contacts, 1);
  assert.equal((await app.inject({ method: "POST", url: "/memories/discover", headers, payload: {} })).statusCode, 422);
});
