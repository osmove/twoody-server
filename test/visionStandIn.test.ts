import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// An image asked of a model that reads none — Twoody's MLX engine (mlx-lm's
// server reads text only; twoody-desktop docs/mlx-engine.md) answers
// « vision_unavailable » —: the turn goes to a model of this computer's
// llama.cpp that reads images, the same model's GGUF first, and the answer
// says so (`vision_stand_in`). Text turns stay on MLX.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-vision-standin-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
delete process.env.BRIDGE_LOCAL_LLM_ENDPOINT;
delete process.env.TWOODY_EMBEDDING_BINARY;
delete process.env.TWOODY_EMBEDDING_MODEL;

type Body = { model: string; messages: Array<{ content: unknown }> };

function fakeRuntime(models: string[], readsImages: boolean, said: string) {
  const bodies: Body[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: models.map((id) => ({ id, status: { value: "unloaded" } })) }));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as Body;
      bodies.push(body);
      const hasImage = body.messages.some((message) => Array.isArray(message.content));
      if (hasImage && !readsImages) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "vision_unavailable", message: `${body.model} does not read images on MLX (vision unavailable)` } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: said } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  return { server, bodies };
}

const mlx = fakeRuntime(["Qwen3.5-9B-MLX"], false, "Réponse de MLX.");
const llama = fakeRuntime(["Qwen3.5-4B-Q4_K_M", "Qwen3.5-9B-Q4_K_M"], true, "Il est écrit TWOODY 42.");
await new Promise<void>((resolve) => mlx.server.listen(0, "127.0.0.1", resolve));
await new Promise<void>((resolve) => llama.server.listen(0, "127.0.0.1", resolve));
const mlxUrl = `http://127.0.0.1:${(mlx.server.address() as AddressInfo).port}/v1`;
const llamaUrl = `http://127.0.0.1:${(llama.server.address() as AddressInfo).port}/v1`;
// The Desktop hands the keys of both of its engines, whichever is chosen.
process.env.TWOODY_RUNTIME_KEYS = JSON.stringify({ [mlxUrl]: "k".repeat(64), [llamaUrl]: "l".repeat(64) });

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const app = await buildApp();
test.after(async () => {
  await app.close();
  await new Promise((resolve) => mlx.server.close(resolve));
  await new Promise((resolve) => llama.server.close(resolve));
});
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const headers = { authorization: `Bearer ${paired.json().token}` };
// The person chose the MLX model: the only provider stored.
await app.inject({ method: "POST", url: "/providers/local", headers, payload: { url: mlxUrl, model: "Qwen3.5-9B-MLX", name: "Twoody (MLX)" } });

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const ask = (payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/queries", headers, payload: { channel: "desktop", force_new_discussion: true, document_access: { mode: "off" }, ...payload } });
const finalOf = (body: string) => {
  const block = body.split("\n\n").find((part) => part.startsWith("event: final"));
  return block ? JSON.parse(block.slice(block.indexOf("data: ") + 6)) : null;
};

test("a text turn stays on the MLX model", async () => {
  const response = await ask({ text: "Bonjour" });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(finalOf(response.body).model, "Qwen3.5-9B-MLX");
  assert.equal(finalOf(response.body).vision_stand_in, undefined);
});

test("an image goes to the same model's GGUF on llama.cpp, and the answer says so", async () => {
  const before = llama.bodies.length;
  const response = await ask({ text: "Qu'est-ce qui est écrit ?", images: [PNG] });
  assert.equal(response.statusCode, 200, response.body);
  const final = finalOf(response.body);
  assert.equal(final.model, "Qwen3.5-9B-Q4_K_M");
  assert.deepEqual(final.vision_stand_in, { from: "Qwen3.5-9B-MLX", to: "Qwen3.5-9B-Q4_K_M" });
  assert.match(final.text, /TWOODY 42/);
  const sent = llama.bodies.slice(before);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.model, "Qwen3.5-9B-Q4_K_M");
  assert.ok(sent[0]!.messages.some((message) => Array.isArray(message.content)), "the image went to llama.cpp");
});

test("without a model that reads images, the refusal stays « vision_unavailable »", async () => {
  const { forgetRuntimeProbes } = await import("../src/localRuntime.js");
  const { configureRuntimeKeys } = await import("../src/runtimeAuth.js");
  configureRuntimeKeys({ [mlxUrl]: "k".repeat(64) });
  forgetRuntimeProbes();
  const response = await ask({ text: "Et celle-ci ?", images: [PNG] });
  const error = response.body.split("\n\n").find((block) => block.startsWith("event: error"));
  const said = error ? JSON.parse(error.slice(error.indexOf("data: ") + 6)) : response.json();
  assert.equal(said.error, "vision_unavailable");
  assert.equal(said.model, "Qwen3.5-9B-MLX");
});
