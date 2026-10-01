import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A new conversation starts at once (Jimmy, 01/10/2026: 14 s before the
// first word): its system prompt is the one the runtime last read, and when
// it changes — a memory saved — it is read ahead in the background.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-warm-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
delete process.env.BRIDGE_LOCAL_LLM_ENDPOINT;
delete process.env.TWOODY_EMBEDDING_BINARY;
delete process.env.TWOODY_EMBEDDING_MODEL;

type Body = { messages: Array<{ role: string; content: string }>; max_tokens?: number };
const bodies: Body[] = [];
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "qwen" }] }));
    return;
  }
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
const { warmNewConversation } = await import("../src/routes/queries.js");
const app = await buildApp();
test.after(async () => {
  await app.close();
  await new Promise((resolve) => server.close(resolve));
});
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const headers = { authorization: `Bearer ${paired.json().token}` };
const userId = paired.json().user_id as string;
await app.inject({ method: "POST", url: "/providers/local", headers, payload: { url, model: "qwen", name: "llama.cpp" } });
const ask = (text: string) => app.inject({ method: "POST", url: "/queries", headers, payload: { text, channel: "desktop", force_new_discussion: true, context_window: 16_384, locale: "fr" } });
const chats = () => bodies.filter((body) => body.max_tokens !== 1);
const warms = () => bodies.filter((body) => body.max_tokens === 1);

test("two new conversations in a row start with the same system prompt: nothing to read ahead", async () => {
  await ask("Bonjour");
  await ask("Une idée de dîner ?");
  const [a, b] = chats().slice(-2);
  assert.equal(a!.messages[0]!.content, b!.messages[0]!.content);
  assert.equal(await warmNewConversation(userId), "unchanged");
  assert.equal(warms().length, 0);
});

test("a memory saved: the next new conversation's start is read ahead, and is the one it then sends", async () => {
  await app.inject({ method: "POST", url: "/memories", headers, payload: { memory: { content: "Je réfléchis à acquérir un Mac Mini" } } });
  assert.equal(await warmNewConversation(userId), "warmed");
  const warm = warms().at(-1)!;
  assert.deepEqual(warm.messages.map((m) => m.role), ["system", "user"]);
  assert.match(warm.messages[0]!.content, /Mac Mini/);
  assert.equal(await warmNewConversation(userId), "unchanged", "once");
  await ask("Est-ce que j'ai un projet d'achat ?");
  assert.equal(chats().at(-1)!.messages[0]!.content, warm.messages[0]!.content, "the same start: the runtime reuses it");
});
