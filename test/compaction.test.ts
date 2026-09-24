import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The context gauge under the desktop's composer, and « Compacter la
// conversation »: the tokens a turn took, and a summary the model writes
// that it is given from then on instead of the messages it covers.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-compaction-"));

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { forgetRuntimeProbes } = await import("../src/localRuntime.js");

type Chat = { messages: Array<{ role: string; content: string }>; stream_options?: { include_usage?: boolean } };
const asked: Chat[] = [];

// mlx-lm, as far as this goes: it counts the tokens when asked to.
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "qwen", object: "model" }] }));
    return;
  }
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = JSON.parse(raw) as Chat;
    asked.push(body);
    const last = body.messages.at(-1)?.content ?? "";
    const text = last.includes("about to be replaced by a summary") ? "Jimmy prépare un bail de trois ans à Paris." : `Réponse ${asked.length}`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
    if (body.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1_000 + asked.length, completion_tokens: 7 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const app = await buildApp();
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const headers = { authorization: `Bearer ${paired.json().token}` };
assert.equal((await app.inject({ method: "POST", url: "/providers/local", headers, payload: { url: `${url}/v1`, model: "qwen", name: "mlx-lm" } })).statusCode, 201);

test.after(async () => {
  await app.close();
  await new Promise((resolve) => server.close(resolve));
});

async function ask(text: string, discussionId?: string) {
  forgetRuntimeProbes();
  const response = await app.inject({
    method: "POST",
    url: "/queries",
    headers,
    payload: { text, channel: "desktop", discussion_id: discussionId, force_new_discussion: discussionId ? undefined : true },
  });
  assert.equal(response.statusCode, 200, response.body);
  const final = response.body.split("\n\n").find((block) => block.startsWith("event: final"))!;
  return JSON.parse(final.slice(final.indexOf("data: ") + 6)) as { discussion_id: string; usage: { prompt_tokens: number; completion_tokens: number; estimated: boolean } };
}

test("a turn says the tokens it took; a conversation opened again, what it would give the model", async () => {
  const first = await ask("Bonjour, je prépare un bail.");
  assert.deepEqual(first.usage, { prompt_tokens: 1_001, completion_tokens: 7, estimated: false });
  assert.deepEqual(asked[0].stream_options, { include_usage: true });
  const opened = (await app.inject({ method: "GET", url: `/discussions/${first.discussion_id}`, headers })).json();
  assert.equal(opened.summary, null);
  assert.ok(opened.context_tokens_estimate > 0);
});

test("compacting: the model writes a summary, given to it from then on instead of the messages it covers", async () => {
  const { discussion_id: id } = await ask("Je veux un bail de trois ans.");
  await ask("À Paris.", id);
  const before = asked.length;

  const compacted = await app.inject({ method: "POST", url: `/discussions/${id}/compact`, headers, payload: {} });
  assert.equal(compacted.statusCode, 200, compacted.body);
  const result = compacted.json();
  assert.equal(result.summary, "Jimmy prépare un bail de trois ans à Paris.");
  assert.equal(result.tokens_before, 1_000 + before + 1);
  // Asked with the conversation, then the demand.
  const demand = asked[before];
  assert.deepEqual(demand.messages.slice(1, -1).map((message) => message.content), ["Je veux un bail de trois ans.", `Réponse ${before - 1}`, "À Paris.", `Réponse ${before}`]);
  assert.match(demand.messages.at(-1)!.content, /about to be replaced by a summary/);

  const opened = (await app.inject({ method: "GET", url: `/discussions/${id}`, headers })).json();
  assert.equal(opened.summary, result.summary);
  assert.equal(opened.summary_through, opened.messages.at(-1).id, "through the last message");
  assert.equal(opened.messages.length, 4, "the screen keeps every message");
  assert.ok(opened.context_tokens_estimate < result.tokens_before);

  await ask("Et le dépôt de garantie ?", id);
  const next = asked.at(-1)!;
  assert.match(next.messages[0].content, /Summary of the earlier part of this conversation[^\n]*\nJimmy prépare un bail de trois ans à Paris\./);
  assert.deepEqual(next.messages.slice(1).map((message) => message.content), ["Et le dépôt de garantie ?"]);

  assert.equal((await app.inject({ method: "POST", url: `/discussions/${id}/compact`, headers, payload: {} })).statusCode, 200, "the summary and what came after");
  assert.match(asked.at(-1)!.messages[0].content, /Jimmy prépare un bail/, "the earlier summary goes into the next");
  const again = await app.inject({ method: "POST", url: `/discussions/${id}/compact`, headers, payload: {} });
  assert.deepEqual([again.statusCode, again.json().error], [409, "nothing_to_compact"]);
  assert.equal((await app.inject({ method: "POST", url: "/discussions/nope/compact", headers, payload: {} })).statusCode, 404);
});
