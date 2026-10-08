import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The documents only when the message needs them (Jimmy, 01/10/2026): read
// with a message that plainly asks about them; otherwise the model has a
// search_documents tool, and its passages are cited like the others.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-doctool-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
delete process.env.BRIDGE_LOCAL_LLM_ENDPOINT;
delete process.env.TWOODY_EMBEDDING_BINARY;
delete process.env.TWOODY_EMBEDDING_MODEL;

type Message = { role: string; content: string; tool_calls?: unknown; tool_call_id?: string };
type Body = { messages: Message[]; tools?: Array<{ function: { name: string } }>; tool_choice?: string; max_tokens?: number };
const bodies: Body[] = [];
let callTool = true;
/// What the model says before its call (« I need to search your documents
/// for this. »): with the call in the same turn, or alone.
let narrate: "with_call" | "alone" | null = null;
const NARRATION = "I need to search your documents for this.";
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "qwen" }] }));
    return;
  }
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = JSON.parse(raw) as Body;
    bodies.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (event: object) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const answered = body.messages.some((message) => message.role === "tool");
    if (narrate === "alone" && body.tools && !answered && body.max_tokens !== 1 && body.tool_choice !== "required") {
      for (const piece of ["I need to search ", "your documents ", "for this."]) send({ choices: [{ delta: { content: piece } }] });
      send({ choices: [{ delta: {}, finish_reason: "stop" }] });
    } else if (body.tools && callTool && !answered && body.max_tokens !== 1) {
      if (narrate === "with_call") for (const piece of ["I need to search ", "your documents ", "for this.", "\n\n"]) send({ choices: [{ delta: { content: piece } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "search_documents", arguments: "" } }] } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"query\":\"électricité\"}" } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    } else {
      if (answered && narrate) for (const piece of ["You pay ", "84 euros [1]."]) send({ choices: [{ delta: { content: piece } }] });
      else send({ choices: [{ delta: { content: answered ? "Vous payez 84 euros [1]." : "Réponse." } }] });
    }
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { ensureLocalUser } = await import("../src/pairing.js");
const { sqlite } = await import("../src/db.js");
const app = await buildApp();
test.after(async () => {
  await app.close();
  await new Promise((resolve) => server.close(resolve));
});
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const headers = { authorization: `Bearer ${paired.json().token}` };
await app.inject({ method: "POST", url: "/providers/local", headers, payload: { url, model: "qwen", name: "llama.cpp" } });
await app.inject({ method: "PATCH", url: "/me", headers, payload: { user: { memory_enabled: false } } });
const user = ensureLocalUser();
const docs = mkdtempSync(join(tmpdir(), "twoody-doctool-docs-"));
const file = join(docs, "facture-electricite.txt");
writeFileSync(file, "Facture d'électricité de septembre : 84 euros.");
sqlite.prepare("INSERT INTO document_folders(id,user_id,path,created_at) VALUES(?,?,?,?)").run("folder", user.id, docs, Date.now());
sqlite.prepare("INSERT INTO documents(id,user_id,folder_id,path,name,ext,size,mtime_ms,status,chars) VALUES(?,?,?,?,?,?,?,?,?,?)")
  .run("facture", user.id, "folder", file, "facture-electricite.txt", ".txt", 50, 1_790_000_000_000, "indexed", 50);
sqlite.prepare("INSERT INTO document_chunks(document_id,user_id,page,position,text) VALUES(?,?,?,?,?)").run("facture", user.id, null, 0, "Facture d'électricité de septembre : la facture s'élève à 84 euros.");

async function ask(text: string, extra: Record<string, unknown> = {}) {
  const before = bodies.length;
  const response = await app.inject({ method: "POST", url: "/queries", headers, payload: { text, channel: "desktop", force_new_discussion: true, ...extra } });
  assert.equal(response.statusCode, 200, response.body);
  const block = response.body.split("\n\n").find((b) => b.startsWith("event: final"))!;
  return { final: JSON.parse(block.slice(block.indexOf("data: ") + 6)), sent: bodies.slice(before).filter((body) => body.max_tokens !== 1), body: response.body };
}
const lastUser = (body: Body) => body.messages.filter((message) => message.role === "user").at(-1)!.content;

test("a message that is not about the documents reads none: the model has the tool, searches, and cites what it found", async () => {
  const { final, sent, body } = await ask("Combien je paie pour l'électricité ?");
  assert.equal(sent.length, 2);
  assert.match(body, /event: status\ndata: \{"kind":"searching_documents","query":"électricité"\}/, "« Recherche dans vos documents… » while it looks");
  assert.deepEqual(sent[0]!.tools?.map((tool) => tool.function.name), ["search_documents", "list_files"]);
  assert.doesNotMatch(lastUser(sent[0]!), /Excerpts from the user's documents/);
  const result = sent[1]!.messages.find((message) => message.role === "tool")!;
  assert.match(result.content, /^\[Excerpts from the user's documents\]\n\[1\] facture-electricite\.txt/);
  assert.equal(result.tool_call_id, "call_1");
  assert.equal(sent[1]!.tool_choice, "auto");
  assert.equal(final.message, "Vous payez 84 euros [1].");
  assert.deepEqual(final.sources.map((source: { n: number; name: string }) => [source.n, source.name]), [[1, "facture-electricite.txt"]]);
});

test("a question the model answers without searching: one request, no excerpt, nothing cited", async () => {
  callTool = false;
  const { final, sent } = await ask("Une idée de dîner ?");
  callTool = true;
  assert.equal(sent.length, 1);
  assert.doesNotMatch(lastUser(sent[0]!), /Excerpts/);
  assert.deepEqual(final.sources, []);
});

test("a message plainly about the documents reads them with it, as before", async () => {
  callTool = false;
  const { final, sent } = await ask("Que dit ma facture d'électricité ?");
  callTool = true;
  assert.equal(sent.length, 1);
  assert.match(lastUser(sent[0]!), /\[1\] facture-electricite\.txt/);
  assert.equal(final.sources.length, 1);
});

test("documents switched off: no tool, nothing read", async () => {
  const { sent } = await ask("Combien je paie pour l'électricité ?", { document_access: { mode: "off" } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.tools, undefined);
  assert.doesNotMatch(lastUser(sent[0]!), /Excerpts/);
});

test("each answer leaves a trace: the documents decision, the tools offered and called, the prompt's parts, the tokens", async () => {
  const { final } = await ask("Combien je paie pour l'électricité ?");
  const listed = (await app.inject({ url: "/diagnostics/turns?kind=chat&limit=1", headers })).json().traces;
  const trace = listed[0];
  assert.equal(trace.outcome, "answered");
  assert.equal(trace.discussion_id, final.discussion_id);
  assert.equal(trace.detail.documents.decision, "tool");
  assert.deepEqual(trace.detail.tools_offered, ["search_documents", "list_files"]);
  assert.equal(trace.detail.tool_calls.length, 1);
  assert.equal(trace.detail.tool_calls[0].name, "search_documents");
  assert.match(trace.detail.tool_calls[0].arguments, /électricité/);
  assert.equal(trace.detail.tool_calls[0].passages, 1);
  assert.ok(trace.detail.prompt.system_chars > 0);
  assert.equal(typeof trace.detail.tokens.prompt, "number");
  assert.equal(typeof trace.total_ms, "number");
  const byMessage = (await app.inject({ url: `/diagnostics/turns?message_id=${trace.message_id}`, headers })).json().traces;
  assert.equal(byMessage[0].id, trace.id);
  assert.equal((await app.inject({ url: "/diagnostics/turns" })).statusCode, 401);

  const { telemetryOf } = await import("../src/diagnostics/traces.js");
  const flat = telemetryOf(trace);
  assert.ok(Object.values(flat).every((value) => ["string", "number", "boolean"].includes(typeof value)) && Object.keys(flat).length <= 40);
  assert.doesNotMatch(JSON.stringify(flat), /électricité|facture|Combien/, "nothing the person wrote");
  assert.equal(flat.tool_names, "search_documents");
  assert.equal(flat.documents_decision, "tool");
  const sent = (await app.inject({ url: "/diagnostics/telemetry?after=0", headers })).json();
  assert.ok(sent.events.length >= 1);
  assert.equal(sent.events[0].name, "assistant_turn");
  assert.doesNotMatch(JSON.stringify(sent), /électricité|facture|Combien|dîner/);
  assert.equal((await app.inject({ url: `/diagnostics/telemetry?after=${sent.next}`, headers })).json().events.length, 0, "sent once");
});

/// The answer's text as it was streamed (`event: message`).
const streamed = (body: string) => body.split("\n\n").filter((block) => block.startsWith("event: message\n")).map((block) => block.slice("event: message\ndata: ".length)).join("");

test("what the model says on its way to the tool (« I need to search your documents for this. ») is neither streamed nor kept", async () => {
  narrate = "with_call";
  const { final, sent, body } = await ask("How much do I pay for electricity?");
  narrate = null;
  assert.equal(sent.length, 2);
  assert.equal(final.message, "You pay 84 euros [1].");
  assert.equal(streamed(body), "You pay 84 euros [1].");
  const call = sent[1]!.messages.find((message) => message.role === "assistant" && message.tool_calls)!;
  assert.equal(call.content, "", "nor given back to the model with its call");
});

test("a search only announced, not called: not shown, the model made to call the documents' search alone", async () => {
  narrate = "alone";
  const { final, sent, body } = await ask("How much do I pay for electricity?");
  narrate = null;
  assert.equal(sent.length, 3);
  assert.equal(sent[1]!.tool_choice, "required");
  assert.deepEqual(sent[1]!.tools?.map((tool) => tool.function.name), ["search_documents", "list_files"], "no action may be called on the way");
  assert.equal(final.message, "You pay 84 euros [1].");
  assert.equal(streamed(body), "You pay 84 euros [1].");
});

test("an answer that announces nothing goes out as it comes, sentence by sentence", async () => {
  callTool = false;
  const { final, body } = await ask("Une idée de dîner ?");
  callTool = true;
  assert.equal(final.message, "Réponse.");
  assert.equal(streamed(body), "Réponse.");
});

test("what words announce a search, and what words do not", async () => {
  const { onlyNarration } = await import("../src/routes/queries.js");
  for (const said of [
    "I need to search your documents for this.", "Let me look that up.", "I'll check your files first:", "Searching your documents…",
    "Je vais chercher dans vos documents.", "Il faut que je consulte vos fichiers.", "Ich werde in Ihren Dokumenten nachsehen.",
    "Voy a buscar en tus documentos.", "Lasciami cercare nei tuoi documenti.", "Vou procurar nos seus documentos.", "ドキュメントを検索します。", "문서를 검색하겠습니다.",
  ]) assert.equal(onlyNarration(said), true, said);
  for (const said of [
    "Paris is the capital of France.", "Bonjour Jimmy ! Comment puis-je t'aider ?", "Let me know if you need anything else.",
    "I can't find that in your documents.", "I checked your contract: the notice is three months.", "The notice period is one month.",
    "I need to search your documents for this. The notice period is one month.",
  ]) assert.equal(onlyNarration(said), false, said);
});

test("a message naming a kind of document reads them with it, in English and other languages as in French", async () => {
  const { aboutDocuments } = await import("../src/routes/queries.js");
  for (const said of [
    "Mrs Dupont wants to end the services agreement before the end of the year. What notice period applies?",
    "Mme Dupont veut résilier le contrat de prestation. Quel préavis ?",
    "What does my lease say about pets?", "Find my last invoice from Orange", "my payslip for June", "my bank statement", "the amendment to the contract",
    "mon relevé de compte", "Was steht in meinem Mietvertrag?", "die Kündigungsfrist", "¿Qué dice mi contrato de alquiler?", "la mia busta paga",
    "a minha fatura da luz", "私の契約書の解約予告は？", "계약서를 확인해 주세요",
  ]) assert.equal(aboutDocuments(said), true, said);
  for (const said of [
    "Hello, how are you?", "Une idée de dîner ?", "Combien je paie pour l'électricité ?", "Give me a quote from Einstein", "What's the weather report?",
    "Write me a letter to thank my aunt", "Ich vertrage keine Milch", "Berechnung der Fläche", "una pasta al pomodoro", "プロファイルを見せて",
  ]) assert.equal(aboutDocuments(said), false, said);

  callTool = false;
  const { sent } = await ask("Mrs Dupont wants to end the services agreement. What notice period applies?");
  callTool = true;
  assert.equal(sent.length, 1);
  const trace = (await app.inject({ url: "/diagnostics/turns?kind=chat&limit=1", headers })).json().traces[0];
  assert.equal(trace.detail.documents.decision, "read", "read up front, like « contrat de prestation »");
  assert.equal(trace.detail.documents.reason, "named");
});
