import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The chat acts on the person's say (docs/projects-design.md P4): a
// reminder, a task, a project's status — said under the answer.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-actions-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
delete process.env.BRIDGE_LOCAL_LLM_ENDPOINT;
delete process.env.TWOODY_EMBEDDING_BINARY;
delete process.env.TWOODY_EMBEDDING_MODEL;

type Body = { messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }>; max_tokens?: number };
const bodies: Body[] = [];
let call: { name: string; arguments: object } | null = null;
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "qwen" }] })); return; }
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = JSON.parse(raw) as Body;
    bodies.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (event: object) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const answered = body.messages.find((message) => message.role === "tool");
    if (call && body.tools && !answered && body.max_tokens !== 1) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    } else {
      send({ choices: [{ delta: { content: answered ? `OK: ${answered.content.slice(0, 40)}` : "Réponse." } }] });
    }
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { sqlite } = await import("../src/db.js");
const { zonedInstant, resolveProject, namedDay } = await import("../src/projects/actions.js");
const app = await buildApp();
test.after(async () => { await app.close(); await new Promise((resolve) => server.close(resolve)); });
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const headers = { authorization: `Bearer ${paired.json().token}` };
const userId = paired.json().user_id as string;
await app.inject({ method: "POST", url: "/providers/local", headers, payload: { url, model: "qwen", name: "llama.cpp" } });
const project = (await app.inject({ method: "POST", url: "/projects", headers, payload: { project: { title: "Achat d'un Mac mini", name: "Mac mini", kind: "purchase" } } })).json().project;

async function ask(text: string, extra: Record<string, unknown> = {}) {
  const response = await app.inject({ method: "POST", url: "/queries", headers, payload: { text, channel: "desktop", force_new_discussion: true, time_zone: "Europe/Paris", document_access: { mode: "off" }, ...extra } });
  assert.equal(response.statusCode, 200, response.body);
  const block = response.body.split("\n\n").find((b) => b.startsWith("event: final"))!;
  return JSON.parse(block.slice(block.indexOf("data: ") + 6));
}

test("a time in the person's zone: 18:00 in Paris in October is 16:00 UTC; a day alone rings at 09:00", () => {
  assert.equal(zonedInstant("2026-10-02T18:00", "Europe/Paris").toISOString(), "2026-10-02T16:00:00.000Z");
  assert.equal(zonedInstant("2026-12-24", "Europe/Paris").toISOString(), "2026-12-24T08:00:00.000Z");
  assert.equal(resolveProject(userId, "le mac mini")?.id, project.id);
  assert.equal(resolveProject(userId, "mariage"), null);
});

test("« Rappelle-moi… »: a reminder, tied to the project, said under the answer; the model is told", async () => {
  call = { name: "create_reminder", arguments: { text: "Comparer les prix du Mac mini", when: "2026-10-02T18:00", project: "Mac mini" } };
  const final = await ask("Rappelle-moi de comparer les prix du Mac mini vendredi à 18h");
  call = null;
  assert.equal(final.actions.length, 1);
  const action = final.actions[0];
  // The next Friday, whatever day the test runs (it failed on a Friday).
  const friday = zonedInstant(`${namedDay("vendredi", "Europe/Paris")}T18:00`, "Europe/Paris").toISOString();
  assert.deepEqual([action.type, action.title, action.at, action.project.title], ["reminder", "Comparer les prix du Mac mini", friday, "Achat d'un Mac mini"]);
  const row = sqlite.prepare("SELECT project_id, status, notify_at FROM reminders WHERE id = ?").get(action.id) as { project_id: string; status: string; notify_at: number };
  assert.deepEqual([row.project_id, row.status, row.notify_at], [project.id, "active", Date.parse(friday) / 1000]);
  assert.match(final.message, /^OK: Done \(reminder/);
  assert.match(bodies.find((body) => body.tools)!.messages[0]!.content, /You can act for the user: create_reminder/);
  const opened = (await app.inject({ url: `/discussions/${final.discussion_id}`, headers })).json();
  assert.equal(opened.messages.at(-1).memory.actions[0].id, action.id, "said again when the conversation is opened");
});

test("a project bought: its status changes; a project that does not exist is said, not invented", async () => {
  call = { name: "update_project", arguments: { project: "Mac mini", status: "done" } };
  const final = await ask("C'est bon, j'ai acheté le Mac mini !");
  assert.equal(final.actions[0].change.status, "done");
  assert.equal((sqlite.prepare("SELECT status FROM projects WHERE id = ?").get(project.id) as { status: string }).status, "done");
  call = { name: "update_project", arguments: { project: "Mariage", status: "done" } };
  const missing = await ask("Le mariage est passé.");
  call = null;
  assert.equal(missing.actions, undefined);
  assert.match(missing.message, /Not done: no_such_project/);
});

test("memory switched off: no action tools, nothing said about them", async () => {
  await app.inject({ method: "PATCH", url: "/me", headers, payload: { user: { memory_enabled: false } } });
  const before = bodies.length;
  await ask("Rappelle-moi d'appeler maman");
  const sent = bodies.slice(before).filter((body) => body.max_tokens !== 1);
  assert.equal(sent[0]!.tools, undefined);
  assert.doesNotMatch(sent[0]!.messages[0]!.content, /You can act for the user/);
});

test("the day the person named wins: « vendredi » is the next Friday, « demain » tomorrow; an outright ask must call the tool", async () => {
  const { namedDay, askedAction } = await import("../src/projects/actions.js");
  const thursday = new Date("2026-10-01T10:00:00Z");
  assert.equal(namedDay("Rappelle-moi vendredi à 18h", "Europe/Paris", thursday), "2026-10-02");
  assert.equal(namedDay("rappelle-moi lundi", "Europe/Paris", thursday), "2026-10-05");
  assert.equal(namedDay("rappelle-moi jeudi", "Europe/Paris", thursday), "2026-10-08", "today's weekday: next week");
  assert.equal(namedDay("rappelle-moi demain à 8h", "Europe/Paris", thursday), "2026-10-02");
  assert.equal(namedDay("rappelle-moi après-demain", "Europe/Paris", thursday), "2026-10-03");
  assert.equal(namedDay("rappelle-moi le 12 octobre", "Europe/Paris", thursday), null, "a date of their own: the model reads it");
  assert.equal(askedAction("Rappelle-moi d’appeler maman"), "create_reminder");
  assert.equal(askedAction("Note que je dois appeler le notaire"), "create_task");
  assert.equal(askedAction("Tu te rappelles de mon anniversaire ?"), null);

  await app.inject({ method: "PATCH", url: "/me", headers, payload: { user: { memory_enabled: true } } });
  call = { name: "create_reminder", arguments: { text: "Comparer les prix", when: "2026-10-09T18:00" } };
  const before = bodies.length;
  const final = await ask("Rappelle-moi vendredi à 18h de comparer les prix");
  call = null;
  const first = bodies.slice(before).find((body) => body.max_tokens !== 1) as Body & { tool_choice?: string };
  assert.equal(first.tool_choice, "required");
  assert.equal(first.max_tokens, 300, "a short round");
  const when = new Date(final.actions[0].at);
  assert.equal(when.getUTCHours(), 16, "18:00 in Paris");
  assert.equal(new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Paris", weekday: "long" }).format(when), "Friday");
  // On a Friday, « vendredi » is next week's: never further.
  assert.ok(when.getTime() - Date.now() <= 8 * 86_400_000, "this Friday, not the one after");
});

test("a model that does not call the tool when it must: its words are not shown, the usual round answers", async () => {
  call = null;
  const before = bodies.length;
  const final = await ask("Rappelle-moi d'appeler maman demain");
  const sent = bodies.slice(before).filter((body) => body.max_tokens !== 1) as Array<Body & { tool_choice?: string }>;
  assert.deepEqual(sent.map((body) => body.tool_choice), ["required", "auto"]);
  assert.equal(final.message, "Réponse.");
  assert.equal(final.actions, undefined);
});
