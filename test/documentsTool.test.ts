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
    if (body.tools && callTool && !answered && body.max_tokens !== 1) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "search_documents", arguments: "" } }] } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"query\":\"électricité\"}" } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    } else {
      send({ choices: [{ delta: { content: answered ? "Vous payez 84 euros [1]." : "Réponse." } }] });
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
  return { final: JSON.parse(block.slice(block.indexOf("data: ") + 6)), sent: bodies.slice(before).filter((body) => body.max_tokens !== 1) };
}
const lastUser = (body: Body) => body.messages.filter((message) => message.role === "user").at(-1)!.content;

test("a message that is not about the documents reads none: the model has the tool, searches, and cites what it found", async () => {
  const { final, sent } = await ask("Combien je paie pour l'électricité ?");
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0]!.tools?.map((tool) => tool.function.name), ["search_documents"]);
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
