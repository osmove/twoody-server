import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// « Proches » (docs/people-design.md): the person's people — one entity
// each, linked to their contact cards (sure → linked, else proposed), with
// a fixed kind of relation in the app's ten languages; the relations the
// learner finds always proposed, on the person's own words only; the person
// card on the last message of a turn that names them; « Doublons possibles »
// merged only on the person's yes.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-people-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
delete process.env.BRIDGE_LOCAL_LLM_ENDPOINT;
delete process.env.TWOODY_EMBEDDING_BINARY;
delete process.env.TWOODY_EMBEDDING_MODEL;

type Body = { messages: Array<{ role: string; content: string }> };
const bodies: Body[] = [];
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "qwen" }] })); return; }
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    bodies.push(JSON.parse(raw) as Body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Réponse." } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { sqlite } = await import("../src/db.js");
const { kinshipMentions, kindsOfWord, hypothetical, KIND_WORDS, RELATION_KINDS, LANGUAGES } = await import("../src/people/kinship.js");
const { judgePeople, parsePeople } = await import("../src/people/learn.js");
const { personCards } = await import("../src/people/cards.js");
const { entitiesInText, relinkMemories } = await import("../src/memory/entities.js");
const { learnDiscussion, acceptCandidate, rejectCandidate, listCandidates, LEARN_IDLE_MS } = await import("../src/memory/learner.js");
const { replaceContacts, readContacts } = await import("../src/personalSync.js");
const { recipientFor } = await import("../src/email/recipient.js");

const app = await buildApp();
test.after(async () => { await app.close(); await new Promise((resolve) => server.close(resolve)); });
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const headers = { authorization: `Bearer ${paired.json().token}` };
const userId = paired.json().user_id as string;
sqlite.prepare("UPDATE users SET name = 'Jimmy Douieb' WHERE id = ?").run(userId);
await app.inject({ method: "POST", url: "/providers/local", headers, payload: { url, model: "qwen", name: "llama.cpp" } });

const api = async (method: string, path: string, payload?: unknown) => {
  const response = await app.inject({ method: method as "GET", url: `/api/v1${path}`, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { status: response.statusCode, body: response.body ? response.json() : null };
};
const people = async () => (await api("GET", "/people")).body as { self: { id: string; name: string } | null; people: Array<{ id: string; name: string; relation: { kind: string; label: string } | null; group: string | null; links: Array<{ name: string; kind: string; side: string }>; contacts: Array<{ id: string; name: string; how: string }>; next_birthday: { date: string; age: number | null } | null }>; candidates: Array<{ id: string; type: string; content: string; project: Record<string, unknown> }> };
const named = async (name: string) => (await people()).people.find((person) => person.name === name);

test("the lexicon: one's own relatives in the ten languages, never someone else's, never another relative", () => {
  const own = (text: string) => kinshipMentions(text).filter((mention) => mention.own && !mention.owner).flatMap((mention) => mention.kinds);
  const cases: Array<[string, string]> = [
    ["Ma mère s'appelle Nadine", "mother"], ["My mum is called Nadine", "mother"], ["Meine Mutter heißt Nadine", "mother"],
    ["Mi madre se llama Nadine", "mother"], ["Mia mamma si chiama Nadine", "mother"], ["Minha mãe se chama Nadine", "mother"],
    ["Mijn moeder heet Nadine", "mother"], ["母の名前はナディーンです", "mother"], ["我妈妈叫娜丁", "mother"], ["우리 엄마 이름은 나딘이야", "mother"],
    ["Ma belle-sœur Claire", "sister_in_law"], ["Meine Schwiegermutter Ute", "mother_in_law"], ["Mi suegra Carmen", "mother_in_law"],
    ["Mon chef Bruno", "manager"], ["我老婆叫小美", "wife"], ["제 아내는 지영이에요", "wife"], ["妻は直子です", "wife"],
  ];
  for (const [text, kind] of cases) assert.ok(own(text).includes(kind as never), `${text} → ${kind} (${JSON.stringify(kinshipMentions(text))})`);
  for (const text of ["La mère de Paul", "Pauls Mutter", "Paul's mother", "la maman de Paul", "友達の母", "我朋友的妈妈", "친구의 엄마", "ma grand-mère", "Schwiegermutter", "祖母の家", "딸기를 먹었다", "丈夫です", "王先生来了"]) {
    assert.ok(!own(text).includes("mother") && !own(text).includes("husband") && !own(text).includes("daughter"), `${text}: ${JSON.stringify(kinshipMentions(text))}`);
  }
  assert.ok(kinshipMentions("la mère de mon ami Paul").some((mention) => mention.kinds.includes("friend") && mention.owner), "« mon ami » is the owner of « la mère »");
  assert.deepEqual(kindsOfWord("Mutter"), ["mother"]);
  assert.deepEqual(kindsOfWord("엄마"), ["mother"]);
  assert.deepEqual(kindsOfWord("belle-sœur"), ["sister_in_law"]);
  for (const text of ["si j'avais une sœur", "If I had a brother", "Wenn ich eine Schwester hätte", "Si tuviera un hermano", "Se avessi una sorella", "Se eu tivesse um irmão", "Als ik een zus had", "もし妹がいたら", "如果我有姐姐", "만약 언니가 있다면"]) assert.ok(hypothetical(text), text);
  assert.equal(hypothetical("Ma sœur Léa"), false);
  // Every kind has its word in every language (the apps' lists show them).
  for (const kind of RELATION_KINDS) for (const language of LANGUAGES) assert.ok(KIND_WORDS[kind][language], `${kind} ${language}`);
});

test("a person with their relation; a memory in German about « meine Mutter » is hers", async () => {
  const made = await api("POST", "/people", { person: { name: "Nadine", relation: { kind: "mother" } }, locale: "fr" });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual([made.body.person.relation.kind, made.body.person.relation.label, made.body.person.group], ["mother", "mère", "family"]);
  const list = await people();
  assert.equal(list.self?.name, "Jimmy Douieb", "the person's own entity, made with their name");
  await api("POST", "/memories", { memory: { content: "Meine Mutter liebt Jazz." } });
  relinkMemories(userId);
  const nadine = (await api("GET", `/people/${made.body.person.id}`)).body.person;
  assert.ok(nadine.memories.some((memory: { content: string }) => memory.content === "Meine Mutter liebt Jazz."), JSON.stringify(nadine.memories));
  assert.ok(entitiesInText(userId, "우리 엄마 생일이 언제야?").some((link) => link.entity_id === nadine.id), "« 우리 엄마 » reaches her");
  assert.ok(!entitiesInText(userId, "La mère de Paul arrive").some((link) => link.entity_id === nadine.id), "someone else's mother is not her");
});

test("cards: a full name is linked on its own, a first name proposed, a refused one never again", async () => {
  replaceContacts(userId, "macos", readContacts([
    { id: "c-nadine", given_name: "Nadine", family_name: "Douieb", emails: ["nadine@example.com"], birthday: "1958-03-12", phones: ["+33 6 00 00 00 01"] },
    { id: "c-claire", given_name: "Claire", family_name: "Douieb", emails: ["claire@example.com"] },
    { id: "c-paul1", given_name: "Paul", family_name: "Martin", emails: ["paul.martin@example.com"] },
    { id: "c-paul2", given_name: "Paul", family_name: "Durand", emails: ["paul.durand@example.com"] },
  ]));
  const list = await people();
  const proposal = list.candidates.find((candidate) => candidate.type === "person_link");
  assert.ok(proposal, "« Nadine » is the first name of one card only: proposed, not linked");
  assert.equal((await named("Nadine"))!.contacts.length, 0, "never linked on its own by a first name");
  assert.equal((await api("POST", `/memories/candidates/${proposal!.id}/accept`, {})).status, 200);
  const nadine = await named("Nadine");
  assert.deepEqual(nadine!.contacts.map((contact) => [contact.name, contact.how]), [["Nadine Douieb", "confirmed"]]);
  assert.equal(nadine!.next_birthday?.date.slice(5), "03-12");
  // A copy of the Mac's contacts again: the same ids, the link holds.
  replaceContacts(userId, "macos", readContacts([
    { id: "c-nadine", given_name: "Nadine", family_name: "Douieb", emails: ["nadine@example.com"], birthday: "1958-03-12" },
    { id: "c-claire", given_name: "Claire", family_name: "Douieb", emails: ["claire@example.com"] },
    { id: "c-paul1", given_name: "Paul", family_name: "Martin" }, { id: "c-paul2", given_name: "Paul", family_name: "Durand" },
  ]));
  assert.equal((await named("Nadine"))!.contacts.length, 1);
  const contacts = (await api("GET", "/contacts")).body as Array<{ name: string; person: { name: string } | null }>;
  assert.equal(contacts.find((contact) => contact.name === "Nadine Douieb")?.person?.name, "Nadine", "Contacts says whose card it is");

  // « Claire Douieb » by her full name: linked on its own.
  const claire = (await api("POST", "/people", { person: { name: "Claire Douieb", relation: { kind: "sister", label: "sœur" } } })).body.person;
  await people();
  assert.deepEqual((await named("Claire Douieb"))!.contacts.map((contact) => contact.how), ["auto"]);
  // Unlinked by hand: never again on its own.
  const cardId = (await named("Claire Douieb"))!.contacts[0]!.id;
  await api("DELETE", `/people/${claire.id}/contacts/${cardId}`);
  await people();
  assert.equal((await named("Claire Douieb"))!.contacts.length, 0);
  // « Paul »: two cards with that first name, nothing proposed.
  await api("POST", "/people", { person: { name: "Paul", relation: { kind: "friend" } } });
  assert.ok(!(await people()).candidates.some((candidate) => candidate.type === "person_link" && String(candidate.content).startsWith("Paul")));
  // Linked by hand after all.
  await api("POST", `/people/${claire.id}/contacts`, { contact_id: cardId });
  assert.deepEqual((await named("Claire Douieb"))!.contacts.map((contact) => contact.how), ["manual"]);
});

test("links between people: « la sœur de Nadine »; merge on yes only; split back", async () => {
  const nadine = (await named("Nadine"))!;
  const claire = (await named("Claire Douieb"))!;
  const linked = await api("PUT", `/people/${claire.id}/links`, { links: [{ person: nadine.id, kind: "daughter", side: "of" }], locale: "fr" });
  assert.equal(linked.status, 200, JSON.stringify(linked.body));
  assert.deepEqual(linked.body.person.links.map((link: { name: string; kind: string; side: string }) => [link.name, link.kind, link.side]), [["Nadine", "daughter", "of"]]);
  assert.deepEqual((await named("Nadine"))!.links.map((link) => [link.name, link.kind, link.side]), [["Claire Douieb", "daughter", "has"]]);
  // « Claire » alone, made by a relation: a possible duplicate, merged only on yes.
  await api("POST", "/people", { person: { name: "Claire", relation: { kind: "sister" } } });
  const duplicate = (await people()).candidates.find((candidate) => candidate.type === "person_duplicate");
  assert.ok(duplicate, "« Claire » is the first name of « Claire Douieb »");
  assert.ok(await named("Claire"), "not merged before the person says so");
  assert.equal((await api("POST", `/memories/candidates/${duplicate!.id}/accept`, {})).status, 200);
  assert.equal(await named("Claire"), undefined);
  const merged = (await api("GET", `/people/${claire.id}`)).body.person;
  assert.ok(merged.aliases.includes("Claire"));
  assert.deepEqual(merged.merged.map((one: { name: string }) => one.name), ["Claire"]);
  // « Séparer »: the merge undone.
  const split = await api("POST", `/people/${claire.id}/split`, { merged_id: merged.merged[0].id });
  assert.equal(split.status, 201);
  assert.ok(await named("Claire"));
  assert.ok(!(await api("GET", `/people/${claire.id}`)).body.person.aliases.includes("Claire"));
  // Merged by hand again, for what follows.
  await api("POST", `/people/${split.body.person.id}/merge`, { into: claire.id });
});

test("the learner proposes relations on the person's own words only, in any language; traps are dropped", () => {
  const p = (name: string, relation: string, of: string | null, evidence: string, confidence = 0.9) => ({ name, relation, of, label: null, evidence, confidence });
  const parse = (items: unknown[]) => parsePeople(JSON.stringify({ facts: [], people: items }));
  const lines = [
    "Ma mère s'appelle Nadine et la mère de mon ami Paul s'appelle Sophie.",
    "Meine Schwester heißt Lena.", "母の名前は直子です。", "Si j'avais un frère, je l'appellerais Hugo.",
    "Claire, la sœur de Nadine, vient dîner.", "我妈妈叫李华", "우리 아내는 지영이야", "Mon collègue Marc est marié à Julie.",
  ];
  const all = [
    p("Nadine", "mother", null, "Ma mère s'appelle Nadine"),
    p("Sophie", "mother", null, "la mère de mon ami Paul s'appelle Sophie"),
    p("Sophie", "friend", null, "la mère de mon ami Paul s'appelle Sophie"),
    p("Paul", "friend", null, "la mère de mon ami Paul s'appelle Sophie"),
    p("Sophie", "mother", "Paul", "la mère de mon ami Paul s'appelle Sophie"),
    p("Lena", "sibling", null, "Meine Schwester heißt Lena."),
    p("直子", "mother", null, "母の名前は直子です。"),
    p("Hugo", "brother", null, "Si j'avais un frère, je l'appellerais Hugo."),
    p("Claire", "sister", "Nadine", "Claire, la sœur de Nadine, vient dîner."),
    p("李华", "mother", null, "我妈妈叫李华"),
    p("Julie", "wife", null, "Mon collègue Marc est marié à Julie."),
    p("Marc", "colleague", null, "Mon collègue Marc est marié à Julie."),
    p("Zoé", "daughter", null, "Ma fille s'appelle Zoé"),
  ];
  // Of someone named by their relation only: whom is not known.
  const unnamed = judgePeople(parse([p("Lily", "daughter", "colleague", "My colleague's daughter, Lily, just started school."), p("Carmen", "mother", "mi novia", "La madre de mi novia se llama Carmen."), p("恵子さん", "mother", "友達", "友達のお母さんは恵子さんです。")]),
    { personLines: ["My colleague's daughter, Lily, just started school.", "La madre de mi novia se llama Carmen.", "友達のお母さんは恵子さんです。"] });
  assert.deepEqual(unnamed.dropped.map((one) => one.reason), ["of_unnamed", "of_unnamed", "of_unnamed"]);
  assert.equal(parse(all).length, 8, "eight people at most from one conversation");
  const judged = judgePeople([...parse(all.slice(0, 7)), ...parse(all.slice(7))], { personLines: lines, language: "fr", selfNames: ["Jimmy Douieb"] });
  const kept = judged.propose.map((one) => `${one.person.name}:${one.kind}:${one.person.of ?? "me"}`);
  assert.deepEqual(kept, ["Nadine:mother:me", "Paul:friend:me", "Sophie:mother:Paul", "Lena:sister:me", "直子:mother:me", "Claire:sister:Nadine", "李华:mother:me", "Marc:colleague:me"]);
  assert.deepEqual(judged.dropped.map((one) => `${one.person.name}:${one.reason}`), ["Sophie:not_theirs", "Sophie:not_theirs", "Hugo:hypothesis", "Julie:relation_not_said", "Zoé:no_evidence"]);
});

let counter = 0;
function conversation(lines: Array<{ role: "user" | "assistant"; content: string }>, projectId: string | null = null): string {
  const id = `people-d${++counter}`;
  const at = Date.now() - LEARN_IDLE_MS - 60_000;
  sqlite.prepare("INSERT INTO discussions (id, user_id, channel, title, project_id, created_at, last_activity_at) VALUES (?, ?, 'desktop', NULL, ?, ?, ?)").run(id, userId, projectId, at, at);
  for (const line of lines) sqlite.prepare("INSERT INTO messages (id, discussion_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(`people-m${++counter}`, id, userId, line.role, line.content, Date.now());
  return id;
}

test("a relation learned is « À confirmer », sensitive, kept only on yes; refused, never proposed again; never from a walled-off project", async () => {
  const said = "Mon beau-père s'appelle Gérard.";
  const ask = async () => JSON.stringify({ facts: [], projects: [], people: [{ name: "Gérard", relation: "father_in_law", of: "me", label: "beau-père", evidence: said, confidence: 0.95 }] });
  const first = conversation([{ role: "user", content: said }, { role: "assistant", content: "Noté." }]);
  const result = await learnDiscussion(first, { ask });
  assert.equal(result?.proposed.length, 1);
  assert.equal(await named("Gérard"), undefined, "nothing in the graph before the person's yes");
  const candidate = listCandidates(userId).find((one) => one.type === "relation")!;
  assert.deepEqual([candidate.sensitive, candidate.project?.kind, candidate.project?.to_name], [true, "father_in_law", "Gérard"]);
  rejectCandidate(userId, candidate.id);
  const again = await learnDiscussion(conversation([{ role: "user", content: said }]), { ask });
  assert.equal(again?.proposed.length, 0, "refused: never proposed again");

  const second = conversation([{ role: "user", content: "Ma tante s'appelle Odile." }]);
  await learnDiscussion(second, { ask: async () => JSON.stringify({ facts: [], people: [{ name: "Odile", relation: "aunt", of: "me", label: "tante", evidence: "Ma tante s'appelle Odile.", confidence: 0.9 }] }) });
  const aunt = listCandidates(userId).find((one) => one.type === "relation" && one.project?.to_name === "Odile")!;
  acceptCandidate(userId, aunt.id);
  assert.deepEqual((await named("Odile"))!.relation, { kind: "aunt", label: "tante", source: "learned" });

  // A walled-off project's conversation is never read.
  const walled = (await app.inject({ method: "POST", url: "/api/v1/projects", headers, payload: { title: "Dossier Varlin", isolated: true } })).json().project as { id: string };
  const inside = conversation([{ role: "user", content: "Ma cousine s'appelle Inès." }], walled.id);
  assert.equal(await learnDiscussion(inside, { ask: async () => JSON.stringify({ people: [{ name: "Inès", relation: "cousin", of: "me", evidence: "Ma cousine s'appelle Inès.", confidence: 0.9 }] }) }), null);
  assert.ok(!listCandidates(userId).some((one) => one.project?.to_name === "Inès"));
});

test("the person card: on the last message, one hop for « la sœur de ma femme », details only with Contacts", async () => {
  const wife = (await api("POST", "/people", { person: { name: "Élodie", relation: { kind: "wife", label: "femme" } } })).body.person;
  await api("POST", "/people", { person: { name: "Léonie", relation: null } });
  await api("PUT", `/people/${wife.id}/links`, { links: [{ person: "Léonie", kind: "sister", side: "has" }] });
  const hop = personCards(userId, "Qui est la sœur de ma femme ?", { contacts: false });
  assert.deepEqual(hop.map((card) => card.name), ["Élodie", "Léonie"]);
  assert.match(hop[0]!.card, /Élodie — the user's wife/);
  assert.match(hop[0]!.card, /Léonie is Élodie's sister/);
  const nadine = personCards(userId, "C'est quand l'anniversaire de ma mère ?", { contacts: true });
  assert.equal(nadine[0]?.name, "Nadine");
  assert.match(nadine[0]!.card, /Birthday: 12 March 1958/);
  assert.match(nadine[0]!.card, /nadine@example\.com/);
  assert.doesNotMatch(personCards(userId, "C'est quand l'anniversaire de ma mère ?", { contacts: false })[0]!.card, /example\.com|Birthday/);
  assert.deepEqual(personCards(userId, "Wie heißt meine Mutter?", { contacts: false }).map((card) => card.name), ["Nadine"]);
  assert.deepEqual(personCards(userId, "우리 엄마 이름이 뭐야?", { contacts: false }).map((card) => card.name), ["Nadine"]);
  assert.deepEqual(personCards(userId, "Hoe heet de zus van mijn vrouw?", { contacts: false }).map((card) => card.name), ["Élodie", "Léonie"]);
  assert.deepEqual(personCards(userId, "妻の姉妹の名前は何ですか？", { contacts: false }).map((card) => card.name), ["Élodie", "Léonie"]);
  assert.deepEqual(personCards(userId, "La mère de Paul est malade", { contacts: false }).map((card) => card.name), ["Paul"], "someone else's mother is not hers");
  for (const card of [...hop, ...nadine]) assert.ok(card.card.length <= 600);

  // In a turn: on the last message, never in the system prompt.
  bodies.length = 0;
  const response = await app.inject({ method: "POST", url: "/queries", headers, payload: { text: "Qui est la sœur de ma femme ?", channel: "desktop", force_new_discussion: true, document_access: { mode: "off" } } });
  assert.equal(response.statusCode, 200);
  const body = bodies.find((one) => one.messages.at(-1)?.content.includes("[The user's people this message is about"));
  assert.ok(body, "the card rides on the last message");
  assert.doesNotMatch(body!.messages[0]!.content, /people this message is about/);
  // Memory « Aucune »: no card.
  bodies.length = 0;
  await app.inject({ method: "POST", url: "/queries", headers, payload: { text: "Qui est la sœur de ma femme ?", channel: "desktop", force_new_discussion: true, memory_mode: "none", document_access: { mode: "off" } } });
  assert.ok(!bodies.some((one) => one.messages.at(-1)?.content.includes("people this message is about")));
});

test("« dis à maman »: the address of the card linked to her counts", async () => {
  sqlite.prepare("UPDATE memories SET content = content WHERE 1 = 0").run();
  const resolution = recipientFor(userId, "maman", { memories: [], contacts: [{ name: "Quelqu'un", firstName: null, lastName: null, organization: null, phones: [], emails: ["x@example.com"], birthday: null }] });
  assert.deepEqual(resolution.candidates.map((one) => one.address), ["nadine@example.com"]);
  const none = recipientFor(userId, "maman", { memories: [], contacts: [] });
  assert.deepEqual(none.candidates, [], "Contacts off for the turn: not the card's address");
});

test("« Retirer de vos proches » keeps the person: hidden from Proches, cards, « dis à maman » and the learner; « Rétablir » brings them back", async () => {
  const nadine = (await named("Nadine"))!;
  const gone = await api("DELETE", `/people/${nadine.id}`);
  assert.equal(gone.status, 204);
  const list = (await api("GET", "/people")).body as { people: Array<{ id: string }>; removed: Array<{ id: string; name: string; relation: { kind: string } | null }> };
  assert.ok(!list.people.some((person) => person.id === nadine.id), "not among the people");
  assert.deepEqual(list.removed.map((one) => [one.id, one.name, one.relation?.kind]), [[nadine.id, "Nadine", "mother"]], "« Proches retirés », with her relation kept");
  const page = (await api("GET", `/people/${nadine.id}`)).body.person;
  assert.ok(page.archived_at, "her page still opens, saying she was removed");
  assert.equal(page.removed_at, page.archived_at, "the name of before, for one release");
  assert.ok(sqlite.prepare("SELECT archived_at FROM entities WHERE id = ?").get(nadine.id)!.archived_at, "archived (hidden, restorable), not deleted");
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM entity_contacts WHERE entity_id = ? AND how != 'refused'").get(nadine.id)!.n, 1, "her card is still linked to her");
  assert.deepEqual(personCards(userId, "C'est quand l'anniversaire de ma mère ?", { contacts: true }), [], "no card in the chat");
  assert.deepEqual(entitiesInText(userId, "Nadine vient dimanche").map((link) => link.entity_id), [], "the graph the memory follows leaves her out");
  const resolution = recipientFor(userId, "maman", { memories: [], contacts: [{ name: "Quelqu'un", firstName: null, lastName: null, organization: null, phones: [], emails: ["x@example.com"], birthday: null }] });
  assert.ok(!resolution.candidates.some((one) => one.address === "nadine@example.com"), "« dis à maman » does not reach her");
  // The learner proposes nothing about her any more.
  const said = "Ma mère s'appelle Nadine.";
  const learned = await learnDiscussion(conversation([{ role: "user", content: said }]), { ask: async () => JSON.stringify({ facts: [], people: [{ name: "Nadine", relation: "mother", of: "me", label: "mère", evidence: said, confidence: 0.95 }] }) });
  assert.equal(learned?.proposed.length, 0);
  assert.ok(!listCandidates(userId).some((one) => one.type === "relation" && one.project?.to_name === "Nadine"));
  // « Rétablir »: back as she was.
  const back = await api("POST", `/people/${nadine.id}/restore`, {});
  assert.equal(back.status, 200);
  assert.equal(back.body.person.archived_at, null);
  assert.equal(back.body.person.removed_at, null);
  assert.equal((await named("Nadine"))!.relation?.kind, "mother");
  assert.deepEqual((await api("GET", "/people")).body.removed, []);
  assert.deepEqual(personCards(userId, "C'est quand l'anniversaire de ma mère ?", { contacts: true }).map((card) => card.name), ["Nadine"]);
  assert.deepEqual(recipientFor(userId, "maman", { memories: [], contacts: [{ name: "Quelqu'un", firstName: null, lastName: null, organization: null, phones: [], emails: ["x@example.com"], birthday: null }] }).candidates.map((one) => one.address), ["nadine@example.com"]);
  // Removed, then added again under the same name: the same person comes back.
  await api("DELETE", `/people/${nadine.id}`);
  const again = await api("POST", "/people", { person: { name: "Nadine" } });
  assert.equal(again.status, 201);
  assert.equal(again.body.person.id, nadine.id);
  assert.equal(again.body.person.relation?.kind, "mother");
  // The person's own entity is never removed.
  const self = (await people()).self!;
  assert.equal((await api("DELETE", `/people/${self.id}`)).status, 422);
});

test("only the person's own devices: /people is refused to a session that is not theirs", async () => {
  const anonymous = await app.inject({ method: "GET", url: "/api/v1/people" });
  assert.equal(anonymous.statusCode, 401);
});
