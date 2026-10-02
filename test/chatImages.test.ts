import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Images with a message (Jimmy, 01/10/2026: « il faut ajouter les images,
// c'est important »): given to the model of this computer with the last
// message, the conversation keeping that there were some; a model without
// its vision file says so (vision_unavailable), never a vague failure.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-images-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
delete process.env.BRIDGE_LOCAL_LLM_ENDPOINT;
delete process.env.TWOODY_EMBEDDING_BINARY;
delete process.env.TWOODY_EMBEDDING_MODEL;

type Part = { type: string; text?: string; image_url?: { url: string } };
const bodies: Array<{ messages: Array<{ role: string; content: string | Part[] }> }> = [];
let blind = false;
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "gemma" }] })); return; }
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = JSON.parse(raw);
    bodies.push(body);
    const hasImage = body.messages.some((message: { content: unknown }) => Array.isArray(message.content));
    if (blind && hasImage) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "image input is not supported - hint: if this is unexpected, you may need to provide the mmproj" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Il est écrit TWOODY 42." } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { readImages, withImages } = await import("../src/routes/queries.js");
const app = await buildApp();
test.after(async () => { await app.close(); await new Promise((resolve) => server.close(resolve)); });
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const headers = { authorization: `Bearer ${paired.json().token}` };
await app.inject({ method: "POST", url: "/providers/local", headers, payload: { url, model: "gemma", name: "llama.cpp" } });

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const ask = (payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/queries", headers, payload: { channel: "desktop", force_new_discussion: true, document_access: { mode: "off" }, ...payload } });

test("the images of a request: up to four data URLs of an image, nothing else", () => {
  assert.deepEqual(readImages(undefined), []);
  assert.deepEqual(readImages([PNG]), [PNG]);
  assert.equal(readImages([PNG, PNG, PNG, PNG, PNG]), "invalid");
  assert.equal(readImages(["https://example.com/a.png"]), "invalid");
  assert.equal(readImages(["data:text/html;base64,PGgxPg=="]), "invalid");
  const sent = withImages([{ role: "system", content: "S" }, { role: "user", content: "Q" }], [PNG]);
  assert.deepEqual(sent[1], { role: "user", content: [{ type: "text", text: "Q" }, { type: "image_url", image_url: { url: PNG } }] });
  // The mark the conversation keeps is no text for the model (« je ne vois
  // qu'un code image », 02/10/2026): out with the image, explained after it.
  const withMark = withImages([{ role: "user", content: "Vois-tu cette image ?\n\n[image]" }], [PNG]);
  assert.deepEqual((withMark[0]!.content as Array<{ text?: string }>)[0], { type: "text", text: "Vois-tu cette image ?" });
  const later = withImages([{ role: "user", content: "Vois-tu cette image ?\n\n[image]" }, { role: "assistant", content: "Un carré." }, { role: "user", content: "Décris-la" }], []);
  assert.match(later[0]!.content as string, /you saw it then; it is no longer shown to you/);
  assert.doesNotMatch(later[0]!.content as string, /\[image\]/);
  // Kept in memory: the image goes again with its own message.
  const again = withImages([{ role: "user", content: "Vois-tu cette image ?\n\n[image]" }, { role: "assistant", content: "Un carré." }, { role: "user", content: "Décris-la" }], [], [PNG]);
  assert.deepEqual((again[0]!.content as Array<{ type: string }>).map((part) => part.type), ["text", "image_url"]);
  assert.equal(again[2]!.content, "Décris-la");
});

test("an image goes to the model with the last message; the conversation keeps « [image] »", async () => {
  const response = await ask({ text: "Qu'est-ce qui est écrit ?", images: [PNG] });
  assert.equal(response.statusCode, 200, response.body);
  const last = bodies.at(-1)!.messages.at(-1)!;
  assert.ok(Array.isArray(last.content));
  assert.deepEqual((last.content as Part[]).map((part) => part.type), ["text", "image_url"]);
  assert.match((last.content as Part[])[0]!.text!, /Qu'est-ce qui est écrit \?/);
  const final = response.body.split("\n\n").find((block) => block.startsWith("event: final"))!;
  const id = JSON.parse(final.slice(final.indexOf("data: ") + 6)).discussion_id;
  const opened = (await app.inject({ url: `/discussions/${id}`, headers })).json();
  assert.equal(opened.messages[0].content, "Qu'est-ce qui est écrit ?\n\n[image]");

  // An image alone is a question about it.
  assert.equal((await ask({ images: [PNG] })).statusCode, 200);
  assert.equal((await ask({ text: "x", images: ["nope"] })).statusCode, 422);
});

test("a model without its vision file: « vision_unavailable », with the model", async () => {
  blind = true;
  const response = await ask({ text: "Et celle-ci ?", images: [PNG] });
  blind = false;
  const error = response.body.split("\n\n").find((block) => block.startsWith("event: error"));
  const said = error ? JSON.parse(error.slice(error.indexOf("data: ") + 6)) : response.json();
  assert.equal(said.error, "vision_unavailable");
  assert.equal(said.model, "gemma");
});
