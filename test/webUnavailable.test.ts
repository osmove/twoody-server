import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// « Recherche Internet » on, and no web this time (Jimmy, 16/10/2026): no
// connection, the search engine silent. The message is answered without the
// web — no longer refused — and says so: a line the server writes first, in
// the person's language; the model told on the last message (never in the
// system prompt); a claim to have searched or a web citation taken out of
// what it writes. Here: the line in ten languages, what reads as a claim and
// what does not, the guard as the words stream, and the turn of this
// computer's app (its search failed in its window: `web_failed`). The
// iPhone's turn, searched by this computer: test/deviceTools.test.ts.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-web-unavailable-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
delete process.env.BRIDGE_LOCAL_LLM_ENDPOINT;
delete process.env.TWOODY_EMBEDDING_BINARY;
delete process.env.TWOODY_EMBEDDING_MODEL;
delete process.env.TWOODY_WEB_BRIDGE_URL;
delete process.env.TWOODY_WEB_BRIDGE_KEY;

const { claimsWebSearch, createWebClaimGuard, readWebFailure, webClaimsIn, webFailureOf, webUnavailableNote, webUnavailableNotice, webUnavailableNotices, WEB_FAILURES } = await import("../src/webUnavailable.js");

const LANGUAGES = ["fr", "en", "de", "es", "it", "pt", "nl", "ja", "zh", "ko"] as const;

/// What the guard lets out of `text`, streamed `size` characters at a time.
function guarded(text: string, sources = 0, size = 3): { out: string; removed: number } {
  const guard = createWebClaimGuard({ sources: () => sources });
  let out = "";
  for (let index = 0; index < text.length; index += size) out += guard.push(text.slice(index, index + size));
  out += guard.flush();
  return { out, removed: guard.removed.length };
}

test("the line the answer starts with: ten languages, one per reason, in the message's language — French when none is told", () => {
  for (const lang of LANGUAGES) {
    const said = WEB_FAILURES.map((reason) => webUnavailableNotice(reason, lang));
    assert.equal(new Set(said).size, 3, lang);
    for (const line of said) {
      assert.ok(line.length > 15 && /[.。]$/u.test(line), `${lang}: ${line}`);
      // Never a claim, to the guard nor once it is in the history.
      assert.deepEqual(webClaimsIn(line), [], `${lang}: ${line}`);
    }
  }
  assert.equal(webUnavailableNotice("offline", "fr"), "Pas de connexion à Internet : réponse sans recherche sur le web.");
  assert.equal(webUnavailableNotice("engine", "fr-FR"), "Le moteur de recherche n'a pas répondu : réponse sans recherche sur le web.");
  assert.equal(webUnavailableNotice("failed", "fr"), "La recherche n'a pas pu se faire : réponse sans recherche sur le web.");
  assert.equal(webUnavailableNotice("offline", "en-US"), "No Internet connection: answer without a web search.");
  assert.equal(webUnavailableNotice("offline", "de"), "Keine Internetverbindung: Antwort ohne Websuche.");
  assert.equal(webUnavailableNotice("engine", "es"), "El buscador no ha respondido: respuesta sin búsqueda en la web.");
  assert.equal(webUnavailableNotice("offline", "pt-BR"), "Sem conexão com a Internet: resposta sem pesquisa na web.");
  assert.equal(webUnavailableNotice("offline", "ja"), "インターネットに接続されていません。ウェブ検索なしで回答します。");
  assert.equal(webUnavailableNotice("engine", "zh"), "搜索引擎没有响应：以下回答未经网络搜索。");
  assert.equal(webUnavailableNotice("offline", "ko"), "인터넷에 연결되어 있지 않습니다. 웹 검색 없이 답변합니다.");
  assert.equal(webUnavailableNotice("offline", null), webUnavailableNotice("offline", "fr"));
  assert.equal(webUnavailableNotice("offline", "sv"), webUnavailableNotice("offline", "en"));
  assert.equal(webUnavailableNotices().length, 30);
});

test("why: the reason the Desktop gives, else what its words say", () => {
  assert.deepEqual(["offline", "engine", "failed", "nope", 3, null].map(readWebFailure), ["offline", "engine", "failed", null, null, null]);
  assert.equal(webFailureOf("getaddrinfo ENOTFOUND html.duckduckgo.com"), "offline");
  assert.equal(webFailureOf("getaddrinfo EAI_AGAIN api.search.brave.com"), "offline");
  assert.equal(webFailureOf("connect ENETUNREACH 52.142.124.215:443"), "offline");
  assert.equal(webFailureOf("DuckDuckGo turned the search away for now (too many in a row): try again in a minute"), "engine");
  assert.equal(webFailureOf("Brave Search answered 503"), "engine");
  assert.equal(webFailureOf("the site took too long to answer"), "engine");
  assert.equal(webFailureOf("connect ECONNREFUSED 127.0.0.1:8888"), "engine");
  assert.equal(webFailureOf("web search is not ready"), "failed");
  assert.equal(webFailureOf("the search could not be reached on this computer"), "failed");
});

test("what the model is told: no web results and why, from what it knows, never that it searched — in English, with the message", () => {
  const note = webUnavailableNote("offline");
  assert.match(note, /^\[No web search for this message: the user turned « Recherche Internet » on, but this computer has no Internet connection, so there are no web results\./);
  assert.match(note, /Answer from the conversation and what you already know/);
  assert.match(note, /Never say or suggest that you searched the web, looked anything up online or read web pages/);
  assert.match(webUnavailableNote("engine"), /the search engine did not answer/);
  assert.match(webUnavailableNote("failed"), /the search could not be done/);
});

test("an answer that says it searched the web, in the ten languages: the claim goes, the answer stays", () => {
  const claims: Array<[string, string, string]> = [
    ["fr", "D'après mes recherches sur le web, la capitale de l'Australie est Canberra.", "D'après mes connaissances, la capitale de l'Australie est Canberra."],
    ["fr", "La capitale est Canberra, selon mes recherches sur internet.", "La capitale est Canberra, d'après mes connaissances."],
    ["fr", "J'ai cherché sur le web : Canberra est la capitale. Bonne journée !", "Canberra est la capitale. Bonne journée !"],
    ["fr", "Les résultats de recherche montrent que Canberra est la capitale.", "Je sais que Canberra est la capitale."],
    ["fr", "Canberra est la capitale. J'ai effectué une recherche sur le web pour le vérifier.", "Canberra est la capitale."],
    ["en", "According to my search, Canberra is the capital of Australia.", "As far as I know, Canberra is the capital of Australia."],
    ["en", "I searched online and found that Canberra is the capital.", "I know that Canberra is the capital."],
    ["en", "I searched online and found no results, but Canberra is the capital.", "Canberra is the capital."],
    ["en", "Canberra is the capital and I checked it online.", "Canberra is the capital."],
    ["de", "Laut meiner Recherche im Internet ist Canberra die Hauptstadt.", "Meines Wissens ist Canberra die Hauptstadt."],
    ["de", "Ich habe im Internet nachgesehen: Canberra ist die Hauptstadt.", "Canberra ist die Hauptstadt."],
    ["de", "Die Suchergebnisse zeigen, dass Canberra die Hauptstadt ist.", "Ich weiß, dass Canberra die Hauptstadt ist."],
    ["es", "Según mi búsqueda en internet, la capital es Canberra.", "Según lo que sé, la capital es Canberra."],
    ["es", "He buscado en internet y la capital es Canberra.", "La capital es Canberra."],
    ["it", "Secondo la mia ricerca su internet, la capitale è Canberra.", "Per quanto ne so, la capitale è Canberra."],
    ["it", "Ho cercato su internet e la capitale è Canberra.", "La capitale è Canberra."],
    ["pt", "Segundo a minha pesquisa na internet, a capital é Canberra.", "Pelo que sei, a capital é Canberra."],
    ["pt", "Pesquisei na internet e a capital é Canberra.", "A capital é Canberra."],
    ["nl", "Volgens mijn zoekopdracht is Canberra de hoofdstad.", "Voor zover ik weet is Canberra de hoofdstad."],
    ["nl", "Ik heb op internet gezocht. Canberra is de hoofdstad.", "Canberra is de hoofdstad."],
    ["ja", "ウェブで検索したところ、オーストラリアの首都はキャンベラです。", "私の知る限り、オーストラリアの首都はキャンベラです。"],
    ["ja", "検索結果によると、首都はキャンベラです。", "私の知る限り、首都はキャンベラです。"],
    ["ja", "インターネットで調べました。首都はキャンベラです。", "首都はキャンベラです。"],
    ["zh", "根据搜索结果，澳大利亚的首都是堪培拉。", "据我所知，澳大利亚的首都是堪培拉。"],
    ["zh", "我在网上查了一下，澳大利亚的首都是堪培拉。", "据我所知，澳大利亚的首都是堪培拉。"],
    ["ko", "검색 결과에 따르면 호주의 수도는 캔버라입니다.", "제가 알기로는 호주의 수도는 캔버라입니다."],
    ["ko", "찾아보니 호주의 수도는 캔버라입니다.", "제가 알기로는 호주의 수도는 캔버라입니다."],
    ["ko", "인터넷에서 검색했습니다. 호주의 수도는 캔버라입니다.", "호주의 수도는 캔버라입니다."],
  ];
  assert.deepEqual([...new Set(claims.map(([lang]) => lang))].sort(), [...LANGUAGES].sort());
  for (const [lang, said, kept] of claims) {
    assert.ok(claimsWebSearch(said), `${lang}: ${said}`);
    assert.equal(guarded(said).out, kept, `${lang}: ${said}`);
    assert.ok(!claimsWebSearch(kept), `${lang}: what is left claims nothing: ${kept}`);
  }
});

test("a denial, an offer, a study, the person's documents, a calculation are no claims: left as they are", () => {
  for (const answer of [
    "Je n'ai pas pu chercher sur le web, mais la capitale est Canberra.",
    "Je ne peux pas faire de recherche sur le web pour le moment. Canberra est la capitale.",
    "Je n'ai pas accès à Internet en ce moment, mais d'après mes connaissances, la mission Artemis II est prévue pour 2026.",
    "Selon une recherche de l'Inserm publiée en 2020, le café est bon pour le cœur.",
    "Selon les dernières informations dont je dispose, la mission Artemis II doit partir en 2026.",
    "Vous pouvez vérifier sur le site officiel : https://www.service-public.fr.",
    "J'ai cherché dans vos documents : le contrat prévoit un préavis de trois mois.",
    "15 % de 240 € font 36 €. Le calcul : 240 × 0,15 = 36.",
    "I haven't searched online, but Canberra is the capital.",
    "I can't browse the web right now; as far as I know, Canberra is the capital.",
    "You could look it up online to be sure.",
    "Ich konnte nicht im Internet suchen, aber Canberra ist die Hauptstadt.",
    "No he podido buscar en internet, pero la capital es Canberra.",
    "Non ho potuto cercare su internet, ma la capitale è Canberra.",
    "Não consegui pesquisar na internet, mas a capital é Canberra.",
    "Ik kon niet op internet zoeken, maar Canberra is de hoofdstad.",
    "ウェブで検索できませんでしたが、首都はキャンベラです。",
    "文書を検索した結果、契約の解約予告は3か月です。",
    "我无法上网搜索，但澳大利亚的首都是堪培拉。",
    "검색 결과가 없습니다. 호주의 수도는 캔버라입니다.",
    "인터넷에서 검색할 수 없었지만 호주의 수도는 캔버라입니다.",
  ]) {
    assert.ok(!claimsWebSearch(answer), answer);
    assert.equal(guarded(answer).out, answer, answer);
  }
});

test("citations: a number of no source of this turn goes; the person's documents' stay; code is left alone", () => {
  assert.equal(guarded("La capitale de l'Australie est Canberra [1]. Elle compte 460 000 habitants [2].").out, "La capitale de l'Australie est Canberra. Elle compte 460 000 habitants.");
  assert.equal(guarded("Le préavis est de trois mois [1], le loyer de 900 € [2] et Canberra la capitale [3].", 2).out, "Le préavis est de trois mois [1], le loyer de 900 € [2] et Canberra la capitale.");
  assert.equal(guarded("Canberra【1】 est la capitale[^2], voir [1](https://fr.wikipedia.org/wiki/Canberra).").out, "Canberra est la capitale, voir.");
  const code = "Voici le code :\n```js\nconst a = list[1];\n```\nEt `x[2]` aussi.";
  assert.equal(guarded(code).out, code);
  assert.equal(guarded("1. Premier point.\n2. Deuxième point [3].").out, "1. Premier point.\n2. Deuxième point.");
});

test("a list of web « Sources » goes whole; one of the person's documents stays", () => {
  assert.equal(
    guarded("Canberra est la capitale.\n\nSources :\n- [1] Wikipédia – https://fr.wikipedia.org/wiki/Canberra\n- [2] https://www.australia.gov.au\n").out,
    "Canberra est la capitale.\n\n",
  );
  assert.equal(guarded("Canberra is the capital.\n\n**References**\n1. Wikipedia, https://en.wikipedia.org/wiki/Canberra\n2. https://www.australia.gov.au").out, "Canberra is the capital.\n\n");
  assert.equal(guarded("首都はキャンベラです。\n\n出典：\n[1] https://ja.wikipedia.org/wiki/キャンベラ").out, "首都はキャンベラです。\n\n");
  const documents = "Le préavis est de trois mois [1].\n\n**Sources**\n1. contrat.pdf, page 3\n";
  assert.equal(guarded(documents, 1).out, documents);
  // On one line: named as consulted, with no document behind it.
  assert.equal(guarded("Canberra est la capitale.\nSources : Wikipédia, site de la NASA.\n").out, "Canberra est la capitale.\n");
  assert.equal(guarded("首都はキャンベラです。\n出典：ウィキペディア").out, "首都はキャンベラです。\n");
  assert.equal(guarded("Le préavis est de trois mois [1].\nSource : contrat.pdf, page 3\n", 1).out, "Le préavis est de trois mois [1].\nSource : contrat.pdf, page 3\n");
  // A heading that only starts like one: kept.
  assert.equal(guarded("Sources d'énergie renouvelable : le solaire et l'éolien.\n").out, "Sources d'énergie renouvelable : le solaire et l'éolien.\n");
});

test("streamed: the same answer whatever the pieces, and each sentence goes out once it is whole", () => {
  const answer = "Selon mes recherches sur le web, Canberra est la capitale [1]. Elle a été choisie en 1908.\n\n- Population : 460 000 habitants.\n- Fondée en 1913 [2].\n\nSources :\n- https://fr.wikipedia.org/wiki/Canberra\n";
  const expected = "D'après mes connaissances, Canberra est la capitale. Elle a été choisie en 1908.\n\n- Population : 460 000 habitants.\n- Fondée en 1913.\n\n";
  for (const size of [1, 2, 5, 17, 1000]) assert.equal(guarded(answer, 0, size).out, expected, `pieces of ${size}`);
  const guard = createWebClaimGuard();
  assert.equal(guard.push("Canberra est la capitale. Elle a"), "Canberra est la capitale.", "the first sentence, at once");
  assert.equal(guard.push(" été choisie en 1908"), "");
  assert.equal(guard.flush(), " Elle a été choisie en 1908");
});

// ── The turn of this computer's app: its search failed (`web_failed`) ─────

type Body = { messages: Array<{ role: string; content: string }>; max_tokens?: number };
const bodies: Body[] = [];
let answer = "Canberra est la capitale de l'Australie.";
const runtime = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "qwen" }] })); return; }
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = JSON.parse(raw) as Body;
    bodies.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    // Streamed in small pieces, as a model does.
    const said = body.max_tokens === 1 ? "" : answer;
    for (let index = 0; index < said.length; index += 4) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: said.slice(index, index + 4) } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((resolve) => runtime.listen(0, "127.0.0.1", resolve));

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { sqlite } = await import("../src/db.js");
const app = await buildApp();
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const desktop = { authorization: `Bearer ${paired.json().token}` };
await app.inject({ method: "POST", url: "/providers/local", headers: desktop, payload: { url: `http://127.0.0.1:${(runtime.address() as AddressInfo).port}/v1`, model: "qwen", name: "llama.cpp" } });

test.after(async () => {
  await app.close();
  await new Promise((resolve) => runtime.close(resolve));
});

const events = (body: string, name: string) => body.split("\n\n").filter((block) => block.startsWith(`event: ${name}\n`)).map((block) => block.slice(block.indexOf("data: ") + 6).replace(/\ndata: /g, "\n"));
async function ask(payload: Record<string, unknown>) {
  const before = bodies.length;
  const response = await app.inject({ method: "POST", url: "/queries", headers: desktop, payload: { channel: "desktop", force_new_discussion: true, document_access: { mode: "off" }, time_zone: "Europe/Paris", ...payload } });
  const final = JSON.parse(events(response.body, "final")[0] ?? "null") as { message: string; message_id: string; discussion_id: string } | null;
  const sent = bodies.slice(before).filter((body) => body.max_tokens !== 1);
  return { response, final, streamed: events(response.body, "message").join(""), sent, system: sent[0]?.messages[0]?.content ?? "", last: sent[0]?.messages.at(-1)?.content ?? "" };
}
const traceOf = (messageId: string) => JSON.parse((sqlite.prepare("SELECT trace FROM message_traces WHERE message_id = ?").get(messageId) as { trace: string }).trace) as { web?: { failed: string; removed?: Array<{ kind: string; text: string }>; removed_count?: number } };

test("the app's search failed: answered without the web, the line first, the model told on the last message only", async () => {
  answer = "Canberra est la capitale de l'Australie.";
  const usual = await ask({ text: "Quelle est la capitale de l'Australie ?" });
  const offline = await ask({ text: "Quelle est la capitale de l'Australie ?", web_failed: "offline" });
  assert.equal(offline.response.statusCode, 200);
  assert.equal(events(offline.response.body, "error").length, 0, "never refused");
  const notice = "Pas de connexion à Internet : réponse sans recherche sur le web.";
  assert.equal(offline.final!.message, `${notice}\n\nCanberra est la capitale de l'Australie.`);
  assert.equal(offline.streamed, offline.final!.message, "the line streamed first, as the answer");
  // Kept with the answer: the Mac, the iPhone and the history show it.
  assert.equal((sqlite.prepare("SELECT content FROM messages WHERE id = ?").get(offline.final!.message_id) as { content: string }).content, offline.final!.message);
  // Told on the last message; the system prompt is the same as without it (the cache).
  assert.match(offline.last, /\[No web search for this message: .* this computer has no Internet connection/);
  assert.ok(offline.last.trimEnd().endsWith("Quelle est la capitale de l'Australie ?"), offline.last);
  assert.equal(offline.system, usual.system);
  assert.doesNotMatch(offline.system, /No web search for this message/);
  assert.deepEqual(traceOf(offline.final!.message_id).web, { failed: "offline" });
  // The question kept as typed.
  assert.equal((sqlite.prepare("SELECT content FROM messages WHERE discussion_id = ? AND role = 'user'").get(offline.final!.discussion_id) as { content: string }).content, "Quelle est la capitale de l'Australie ?");
});

test("a claim of the model taken out, said in the trace; the line in the message's language, for each reason", async () => {
  answer = "D'après mes recherches sur le web, Canberra est la capitale [1].\n\nSources :\n- https://fr.wikipedia.org/wiki/Canberra";
  const fr = await ask({ text: "Quelle est la capitale de l'Australie ?", web_failed: "engine" });
  assert.equal(fr.final!.message, "Le moteur de recherche n'a pas répondu : réponse sans recherche sur le web.\n\nD'après mes connaissances, Canberra est la capitale.");
  assert.equal(fr.streamed.trimEnd(), fr.final!.message, "never streamed before it was judged");
  assert.doesNotMatch(fr.response.body, /recherches sur le web|wikipedia/);
  const web = traceOf(fr.final!.message_id).web!;
  assert.equal(web.failed, "engine");
  assert.deepEqual(web.removed!.map((one) => one.kind).sort(), ["citation", "claim", "sources", "sources"]);
  assert.equal(web.removed!.find((one) => one.kind === "claim")!.text, "D'après mes recherches sur le web");
  assert.equal(web.removed_count, 4);

  answer = "Laut meiner Recherche im Internet ist Canberra die Hauptstadt.";
  const de = await ask({ text: "Was ist die Hauptstadt von Australien?", web_failed: "failed", locale: "fr-FR" });
  assert.equal(de.final!.message, "Die Suche war nicht möglich: Antwort ohne Websuche.\n\nMeines Wissens ist Canberra die Hauptstadt.");
  assert.match(de.last, /\[Reply in German, the language of this message\.\]$/);
  answer = "首都はキャンベラです。";
  const ja = await ask({ text: "オーストラリアの首都はどこですか？", web_failed: "offline" });
  assert.equal(ja.final!.message, "インターネットに接続されていません。ウェブ検索なしで回答します。\n\n首都はキャンベラです。");
  // Nothing written by the model: the line all the same.
  answer = "";
  const empty = await ask({ text: "Quelle est la capitale de l'Australie ?", web_failed: "offline" });
  assert.equal(empty.final!.message, "Pas de connexion à Internet : réponse sans recherche sur le web.");
  assert.equal(empty.streamed.trimEnd(), empty.final!.message);
  // « Oui »: too short to tell, the app's language.
  answer = "D'accord.";
  const short = await ask({ text: "ok", web_failed: "offline", locale: "es-ES" });
  assert.match(short.final!.message, /^Sin conexión a Internet: respuesta sin búsqueda en la web\./);
});

test("never where the web is not used: « Seulement mes documents », an unknown reason, a walled-off project's conversation that did not switch it on", async () => {
  answer = "Réponse.";
  const only = await ask({ text: "Quel est le préavis ?", web_failed: "offline", document_access: { mode: "only" } });
  assert.doesNotMatch(only.final!.message, /Pas de connexion/);
  assert.doesNotMatch(only.last, /No web search/);
  const unknown = await ask({ text: "Quelle heure est-il à Sydney ?", web_failed: "maybe" });
  assert.equal(unknown.final!.message, "Réponse.");
  // A walled-off project: what reaches outside it starts off for each message.
  const created = await app.inject({ method: "POST", url: "/api/v1/projects", headers: desktop, payload: { title: "Dossier Tessane", isolated: true } });
  assert.equal(created.statusCode, 201, created.body);
  const project = created.json().project as { id: string };
  const walled = await ask({ text: "Quel temps fait-il à Lisbonne ?", web_failed: "offline", project_id: project.id });
  assert.equal(walled.final!.message, "Réponse.", "the web is off there: nothing to say about it");
  assert.doesNotMatch(walled.last, /No web search/);
  // Switched on for the conversation from this computer's app: as anywhere else.
  const on = await ask({ text: "Quel temps fait-il à Lisbonne ?", web_failed: "offline", discussion_id: walled.final!.discussion_id, force_new_discussion: undefined, capabilities_on: ["web"] });
  assert.match(on.final!.message, /^Pas de connexion à Internet/);
  assert.match(on.last, /\[No web search for this message/);
});
