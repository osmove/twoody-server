import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// « Connecteurs » (Capacités, Jimmy, 03/10/2026): an MCP server the person
// adds on this computer, whose tools the chat uses, each call allowed first
// in the chat.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-connectors-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
delete process.env.BRIDGE_LOCAL_LLM_ENDPOINT;
delete process.env.TWOODY_EMBEDDING_BINARY;
delete process.env.TWOODY_EMBEDDING_MODEL;

type Body = { messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }>; max_tokens?: number; tool_choice?: string };
const bodies: Body[] = [];
let call: { name: string; arguments: object } | null = null;
/// The model announces the search instead of calling the tool, unless made to.
let announce = false;
const llm = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "qwen" }] })); return; }
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = JSON.parse(raw) as Body;
    bodies.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (event: object) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const answered = body.messages.find((message) => message.role === "tool");
    if (call && body.tools && !answered && body.max_tokens !== 1 && announce && body.tool_choice !== "required") {
      send({ choices: [{ delta: { content: "Voici vos 5 dernières offres créées :" } }] });
      send({ choices: [{ delta: {}, finish_reason: "stop" }] });
    } else if (call && body.tools && !answered && body.max_tokens !== 1) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    } else {
      send({ choices: [{ delta: { content: answered ? `OK: ${answered.content.slice(0, 120)}` : "Réponse." } }] });
    }
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((resolve) => llm.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken, createAuthSession } = await import("../src/auth.js");
const { waitingApprovals, chatToolName, stopConnector } = await import("../src/connectors/connectors.js");
const { answerFromEventStream } = await import("../src/connectors/mcpClient.js");
const app = await buildApp();
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const headers = { authorization: `Bearer ${paired.json().token}` };
const userId = paired.json().user_id as string;
await app.inject({ method: "POST", url: "/providers/local", headers, payload: { url, model: "qwen", name: "llama.cpp" } });
const fixture = join(import.meta.dirname, "fixtures", "fake-mcp.mjs");
let connectorId = "";
test.after(async () => {
  if (connectorId) stopConnector(userId, connectorId);
  await app.close();
  await new Promise((resolve) => llm.close(resolve));
});

const ask = (text: string) => app.inject({ method: "POST", url: "/queries", headers, payload: { text, channel: "desktop", force_new_discussion: true, document_access: { mode: "off" } } });
const finalOf = (body: string) => {
  const block = body.split("\n\n").find((b) => b.startsWith("event: final"))!;
  return JSON.parse(block.slice(block.indexOf("data: ") + 6)) as { message: string };
};
async function answerWhenAsked(allow: boolean, always = false) {
  for (let i = 0; i < 200; i += 1) {
    const [id] = waitingApprovals(userId);
    if (id) return app.inject({ method: "POST", url: "/queries/approval", headers, payload: { id, allow, always } });
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("no approval asked");
}

test("a connector is added from this computer's app, started, its tools read; its environment's values never shown", async () => {
  const added = await app.inject({ method: "POST", url: "/connectors", headers, payload: { connector: { name: "Carnet", command: process.execPath, args: [fixture], env: { GREETING: "Bonjour", SECRET_TOKEN: "s3cr3t" } } } });
  assert.equal(added.statusCode, 201, added.body);
  const connector = added.json().connector;
  connectorId = connector.id;
  assert.deepEqual(connector.tools.map((tool: { name: string }) => tool.name), ["lookup", "erase_all"]);
  assert.deepEqual(connector.env_keys, ["GREETING", "SECRET_TOKEN"]);
  assert.doesNotMatch(added.body, /s3cr3t/);
  assert.doesNotMatch((await app.inject({ url: "/connectors", headers })).body, /s3cr3t/);
  // Kept apart, readable by this account only.
  const file = join(process.env.TWOODY_DATA_DIR!, "connectors.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.match(readFileSync(file, "utf8"), /s3cr3t/);
});

test("added, changed, removed only from this computer's app", async () => {
  const phone = { authorization: `Bearer ${createAuthSession(userId, "iphone").token}` };
  const refused = await app.inject({ method: "POST", url: "/connectors", headers: phone, payload: { connector: { name: "X", command: "/bin/echo" } } });
  assert.equal(refused.statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/connectors", headers, payload: { connector: { name: "Web", url: "http://example.com/mcp" } } })).json().error, "https_required");
});

test("in the chat: off until Capacités → Connecteurs is on; then the call is asked, and done once allowed", async () => {
  const name = chatToolName({ name: "Carnet" }, "lookup");
  call = { name, arguments: { word: "Zanzibar" } };
  await ask("Cherche Zanzibar dans mon carnet");
  assert.ok(!bodies.at(-1)!.tools?.some((tool) => tool.function.name === name), "not offered while the capability is off");

  await app.inject({ method: "PATCH", url: "/local_capabilities/connectors", headers, payload: { enabled: true } });
  const [response] = await Promise.all([ask("Cherche Zanzibar dans mon carnet"), answerWhenAsked(true)]);
  assert.match(response.body, /event: approval\ndata: .*"connector":"Carnet","tool":"lookup","arguments":\{"word":"Zanzibar"\}/);
  assert.match(response.body, /event: approval_done\ndata: .*"allowed":true/);
  assert.match(finalOf(response.body).message, /Bonjour: Zanzibar found on page 12/);
});

test("refused: nothing is called, the model is told", async () => {
  call = { name: chatToolName({ name: "Carnet" }, "erase_all"), arguments: {} };
  const [response] = await Promise.all([ask("Efface tout le carnet"), answerWhenAsked(false)]);
  assert.match(finalOf(response.body).message, /did not allow this call/);
});

test("a tool turned off is not offered; a connector switched off neither", async () => {
  call = null;
  await app.inject({ method: "PATCH", url: `/connectors/${connectorId}`, headers, payload: { disabled_tools: ["erase_all"] } });
  await ask("Bonjour");
  const offered = bodies.at(-1)!.tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(offered.includes(chatToolName({ name: "Carnet" }, "lookup")));
  assert.ok(!offered.includes(chatToolName({ name: "Carnet" }, "erase_all")));
  await app.inject({ method: "PATCH", url: `/connectors/${connectorId}`, headers, payload: { enabled: false } });
  await ask("Bonjour");
  assert.ok(!(bodies.at(-1)!.tools ?? []).some((tool) => tool.function.name.startsWith("mcp__")));
});

test("« Détails » under an answer: its trace, the prompt the model was given, the tools offered, each call's result", async () => {
  await app.inject({ method: "PATCH", url: `/connectors/${connectorId}`, headers, payload: { enabled: true, disabled_tools: [] } });
  call = { name: chatToolName({ name: "Carnet" }, "lookup"), arguments: { word: "Zanzibar" } };
  const [response] = await Promise.all([ask("Cherche Zanzibar dans mon carnet"), answerWhenAsked(true)]);
  call = null;
  const final = finalOf(response.body) as { message: string; message_id?: string };
  assert.ok(final.message_id, "the final event names the answer");
  const details = await app.inject({ url: `/diagnostics/messages/${final.message_id}`, headers });
  assert.equal(details.statusCode, 200, details.body);
  const body = details.json() as { trace: { detail: { tool_calls: Array<{ name: string; result_preview?: string }>; tools_offered: string[] } }; prompt: { messages: Array<{ role: string; content: string }>; tools: Array<{ name: string }> } };
  assert.equal(body.prompt.messages[0]!.role, "system");
  assert.match(body.prompt.messages.at(-1)!.content, /Cherche Zanzibar/);
  assert.ok(body.prompt.tools.some((tool) => tool.name === chatToolName({ name: "Carnet" }, "lookup")));
  assert.match(body.trace.detail.tool_calls[0]!.result_preview ?? "", /found on page 12/);
  // Nothing of it in what « Partager des diagnostics » could send.
  const telemetry = (await app.inject({ url: "/diagnostics/telemetry?after=0", headers })).body;
  assert.doesNotMatch(telemetry, /Zanzibar|page 12/);
});

test("a connector with many tools: none offered until the person picks; what the chat gets is counted, 40 at most", async () => {
  const added = await app.inject({ method: "POST", url: "/connectors", headers, payload: { connector: { name: "Gros", command: process.execPath, args: [fixture], env: { EXTRA_TOOLS: "56" } } } });
  const big = added.json().connector as { id: string; tools: Array<{ name: string; enabled: boolean; offered: boolean; tokens: number }>; offered_tools: number; offered_tokens: number; max_chat_tools: number };
  assert.equal(big.tools.length, 58);
  assert.equal(big.offered_tools, 0, "none offered at first");
  assert.ok(big.tools.every((tool) => !tool.enabled && tool.tokens > 0));
  const all = await app.inject({ method: "PATCH", url: `/connectors/${big.id}`, headers, payload: { disabled_tools: [] } });
  const picked = all.json().connector as typeof big;
  assert.equal(picked.max_chat_tools, 40);
  assert.ok(picked.offered_tools <= 40 && picked.offered_tools > 0);
  assert.ok(picked.tools.some((tool) => tool.enabled && !tool.offered), "beyond the limit: on, but not offered");
  assert.ok(picked.offered_tokens > 0);
  await app.inject({ method: "DELETE", url: `/connectors/${big.id}`, headers });
});

test("a search announced instead of called (« Voici vos offres : »): held back, the model made to call the tool", async () => {
  await app.inject({ method: "PATCH", url: `/connectors/${connectorId}`, headers, payload: { enabled: true, disabled_tools: [] } });
  call = { name: chatToolName({ name: "Carnet" }, "lookup"), arguments: { word: "Zanzibar" } };
  announce = true;
  const [response] = await Promise.all([ask("Cherche Zanzibar dans mon carnet"), answerWhenAsked(true)]);
  announce = false;
  call = null;
  const final = finalOf(response.body).message;
  assert.match(final, /found on page 12/);
  assert.doesNotMatch(final, /Voici vos 5 dernières offres/);
  assert.equal(bodies.filter((body) => body.tool_choice === "required").length >= 1, true);
  // The instruction rides on the system prompt while a connector is on.
  assert.match(bodies.at(-1)!.messages[0]!.content, /connected as tools \(their names start with mcp__\): Carnet/);
});

test("« Toujours autoriser »: that tool is called without asking; the others still ask", async () => {
  await app.inject({ method: "PATCH", url: `/connectors/${connectorId}`, headers, payload: { enabled: true, disabled_tools: [], auto_tools: ["lookup"] } });
  const listed = (await app.inject({ url: "/connectors", headers })).json().connectors.find((one: { id: string }) => one.id === connectorId);
  assert.deepEqual(listed.tools.filter((tool: { always: boolean }) => tool.always).map((tool: { name: string }) => tool.name), ["lookup"]);
  call = { name: chatToolName({ name: "Carnet" }, "lookup"), arguments: { word: "Zanzibar" } };
  const response = await ask("Cherche Zanzibar dans mon carnet");
  call = null;
  assert.doesNotMatch(response.body, /event: approval/);
  assert.match(finalOf(response.body).message, /found on page 12/);
  await app.inject({ method: "PATCH", url: `/connectors/${connectorId}`, headers, payload: { auto_tools: [] } });
});

test("« Toujours autoriser » from the chat: this call goes on, the next ones are not asked", async () => {
  await app.inject({ method: "PATCH", url: `/connectors/${connectorId}`, headers, payload: { enabled: true, disabled_tools: [], auto_tools: [] } });
  call = { name: chatToolName({ name: "Carnet" }, "lookup"), arguments: { word: "Zanzibar" } };
  const [first] = await Promise.all([ask("Cherche Zanzibar dans mon carnet"), answerWhenAsked(true, true)]);
  assert.match(first.body, /event: approval\n/);
  assert.match(finalOf(first.body).message, /found on page 12/);
  const listed = (await app.inject({ url: "/connectors", headers })).json().connectors.find((one: { id: string }) => one.id === connectorId);
  assert.equal(listed.running, true, "choosing the tools leaves the server running");
  assert.deepEqual(listed.tools.filter((tool: { always: boolean }) => tool.always).map((tool: { name: string }) => tool.name), ["lookup"]);
  const second = await ask("Cherche Zanzibar dans mon carnet");
  call = null;
  assert.doesNotMatch(second.body, /event: approval/);
  await app.inject({ method: "PATCH", url: `/connectors/${connectorId}`, headers, payload: { auto_tools: [] } });
});

test("the traces whole, for audits: each with its prompt, after a point", async () => {
  const full = (await app.inject({ url: "/diagnostics/full?after=0&limit=50", headers })).json() as { traces: Array<{ kind: string; prompt: { messages: unknown[] } | null; trace: { tool_calls?: unknown[] } }>; next: number };
  const answered = full.traces.filter((trace) => trace.kind === "chat" && trace.prompt);
  assert.ok(answered.length > 0);
  assert.ok(answered[0]!.prompt!.messages.length > 0);
  const later = (await app.inject({ url: `/diagnostics/full?after=${full.next}`, headers })).json() as { traces: unknown[] };
  assert.equal(later.traces.length, 0);
});

test("what an announcement looks like, and what it does not", async () => {
  const { looksLikeAnnouncement } = await import("../src/routes/queries.js");
  for (const said of ["Voici vos 5 dernières offres créées :", "Je peux récupérer vos 5 dernières offres. Voulez-vous que je les affiche ?", "Je vais rechercher vos 5 dernières offres dans le système.", "Let me look that up."]) {
    assert.equal(looksLikeAnnouncement(said), true, said);
  }
  for (const said of ["Bonjour Jimmy ! Comment puis-je t'aider ?", "La capitale de la France est Paris.", `Voici la liste :${" offre".repeat(80)}`]) {
    assert.equal(looksLikeAnnouncement(said), false, said);
  }
});

test("an answer over HTTP may come as an event stream", () => {
  assert.deepEqual(answerFromEventStream('event: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"tools":[]}}\n\n', 3), { jsonrpc: "2.0", id: 3, result: { tools: [] } });
  assert.equal(answerFromEventStream("data: not json\n\n", 3), null);
});
