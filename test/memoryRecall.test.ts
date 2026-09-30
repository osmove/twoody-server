import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// « Quel âge j'ai ? », ten minutes after importing what Claude knew of the
// person (30/09/2026): « Je n'ai pas d'information sur ton âge ». The
// system prompt held 13 of the 55 facts, the age not among them, and the
// question's words matched none. Through /queries, against a runtime that
// records what it is given: the imported age reaches the model in a new
// conversation and in one started before the import, and the prompt of
// that one still starts with the previous request (prefix cache).

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-memory-recall-"));
delete process.env.BRIDGE_LOCAL_LLM_ENDPOINT;

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
    const extraction = messages[0].content.startsWith("You extract lasting facts");
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
const app = await buildApp();
test.after(async () => {
  await app.close();
  await new Promise((resolve) => server.close(resolve));
});

const AGE = "Camille a 41 ans (septembre 2026).";
// Dozens of facts, as an import brings, the age in the middle.
const IMPORT = [
  "Voici ce que je sais de vous :",
  ...Array.from({ length: 30 }, (_, i) => `- Camille a suivi le cours de photographie numéro ${i} l'an dernier, avec plaisir.`),
  `- ${AGE}`,
  ...Array.from({ length: 30 }, (_, i) => `- Camille collectionne les cartes postales de la série ${i}, surtout anciennes.`),
].join("\n");

test("imported memories reach the model from the next message: in a new conversation, and in one started before the import", async () => {
  const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
  const headers = { authorization: `Bearer ${paired.json().token}` };
  assert.equal((await app.inject({ method: "POST", url: "/providers/local", headers, payload: { url, model: "qwen", name: "llama.cpp" } })).statusCode, 201);
  const ask = async (text: string, discussionId?: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/queries",
      headers,
      payload: { text, channel: "keyboard", context_window: 16_384, locale: "fr-FR", ...(discussionId ? { discussion_id: discussionId } : { force_new_discussion: true }) },
    });
    assert.equal(response.statusCode, 200, response.body);
    const final = response.body.split("\n\n").find((block) => block.startsWith("event: final"))!;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { discussionId: (JSON.parse(final.slice(final.indexOf("data: ") + 6)) as { discussion_id: string }).discussion_id, sent: chats.at(-1)! };
  };

  // A conversation from before the import.
  const before = await ask("Salut, comment ça va en cette journée pluvieuse ?");
  assert.doesNotMatch(JSON.stringify(before.sent), /41 ans/);

  const imported = await app.inject({ method: "POST", url: "/memories/import", headers, payload: { text: IMPORT, source: "claude" } });
  assert.equal(imported.statusCode, 201, imported.body);
  assert.equal(imported.json().imported, 61);

  // (a) A new conversation: the age is in the system prompt.
  const fresh = await ask("Quel âge j’ai ?");
  assert.equal(fresh.sent.length, 2);
  assert.match(fresh.sent[0].content, /What you know about the user, from their saved Memories[\s\S]*- Camille a 41 ans \(septembre 2026\)\./);

  // (b) The conversation from before: the system prompt and the history as
  // they were, the new memories on the new message.
  const again = await ask("Quel âge j’ai ?", before.discussionId);
  assert.deepEqual(again.sent.slice(0, before.sent.length), before.sent, "the previous request is the start of this one");
  assert.match(again.sent.at(-1)!.content, /^\[Saved in the user's Memories since this conversation started\]\n[\s\S]*- Camille a 41 ans \(septembre 2026\)\.[\s\S]*\[End of new memories\]\n\nQuel âge j’ai \?$/);

  // And the turn after: given once, the prefix only grows.
  const next = await ask("Et dans cinq ans ?", before.discussionId);
  assert.deepEqual(next.sent.slice(0, again.sent.length), again.sent);
  assert.equal(next.sent.at(-1)!.content, "Et dans cinq ans ?");
});
