import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A phone paired with this computer offers, in its picker, every model
// the computer's runtimes hold — mlx-lm on Jimmy's Mac holds six — and
// the question goes to the model picked. Until now it was offered only
// the one model a provider names: /providers said nothing else, and
// /local_llm/status read an environment variable the desktop never sets.
//
// The data directory is set before anything imports the database, since
// that is when it is read.
process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-computer-models-"));

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { forgetRuntimeProbes } = await import("../src/localRuntime.js");

type Runtime = {
  url: string;
  asked: string[];
  close: () => Promise<void>;
};

/// An OpenAI-compatible runtime holding `models`. It answers each chat
/// with the name of the model asked for, after `firstWordAfterMs`.
async function runtime(models: string[], firstWordAfterMs = 0): Promise<Runtime> {
  const asked: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: models.map((id) => ({ id, object: "model" })) }));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const { model } = JSON.parse(raw) as { model: string };
      asked.push(model);
      res.writeHead(200, { "content-type": "text/event-stream" });
      setTimeout(() => {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `answered by ${model}` } }] })}\n\n`);
        res.end("data: [DONE]\n\n");
      }, firstWordAfterMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    asked,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const app = await buildApp();
const paired = await app.inject({
  method: "POST",
  url: "/auth/pair",
  payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" },
});
assert.equal(paired.statusCode, 201);
const headers = { authorization: `Bearer ${paired.json().token}` };

// The Mac: mlx-lm with its default model and others, an embedding model
// among them; and LM Studio, with one model the provider does not name.
const mlx = await runtime(["Qwen/Qwen3-14B-MLX-4bit", "mlx-community/GLM-4-9B-0414-4bit", "mlx-community/bge-small-en-v1.5"]);
const lmStudio = await runtime(["google/gemma-3-12b"]);

async function addProvider(url: string, model: string, name: string) {
  const response = await app.inject({ method: "POST", url: "/providers/local", headers, payload: { url: `${url}/v1`, model, name } });
  assert.equal(response.statusCode, 201, response.body);
}
await addProvider(mlx.url, "Qwen/Qwen3-14B-MLX-4bit", "mlx-lm");
await addProvider(lmStudio.url, "qwen/qwen3-8b", "LM Studio");

async function ask(model: string | undefined) {
  forgetRuntimeProbes();
  const response = await app.inject({ method: "POST", url: "/queries", headers, payload: { content: "Bonjour", model } });
  assert.equal(response.statusCode, 200, response.body);
  const final = response.body.split("\n\n").find((block) => block.startsWith("event: final"));
  return JSON.parse(final!.slice(final!.indexOf("data: ") + 6)) as { model: string; text: string };
}

test.after(async () => {
  await app.close();
  await mlx.close();
  await lmStudio.close();
});

test("/providers offers every chat model a runtime holds, the provider's own first", async () => {
  const response = await app.inject({ method: "GET", url: "/providers", headers });
  const byName = Object.fromEntries(response.json().providers.map((row: { name: string; models: string[] }) => [row.name, row.models]));
  assert.deepEqual(byName["mlx-lm"], ["Qwen/Qwen3-14B-MLX-4bit", "mlx-community/GLM-4-9B-0414-4bit"]);
  assert.deepEqual(byName["LM Studio"], ["qwen/qwen3-8b", "google/gemma-3-12b"]);
});

test("a model picked on the phone goes to the runtime that holds it", async () => {
  assert.equal((await ask("mlx-community/GLM-4-9B-0414-4bit")).text, "answered by mlx-community/GLM-4-9B-0414-4bit");
  assert.equal(mlx.asked.at(-1), "mlx-community/GLM-4-9B-0414-4bit");

  // Held by LM Studio, which is not the default provider.
  const final = await ask("google/gemma-3-12b");
  assert.equal(lmStudio.asked.at(-1), "google/gemma-3-12b");
  assert.equal(final.model, "google/gemma-3-12b");

  // Named by a provider, even one whose runtime does not list it.
  await ask("qwen/qwen3-8b");
  assert.equal(lmStudio.asked.at(-1), "qwen/qwen3-8b");
});

test("a model no runtime here holds gets the computer's default, never sent on", async () => {
  // A name from the account's catalogue, left selected on the phone:
  // sent on, a runtime could go and fetch it from the internet.
  const final = await ask("gpt-5.4-mini");
  assert.equal(final.model, "Qwen/Qwen3-14B-MLX-4bit");
  assert.equal(mlx.asked.at(-1), "Qwen/Qwen3-14B-MLX-4bit");
  assert.ok(!mlx.asked.includes("gpt-5.4-mini") && !lmStudio.asked.includes("gpt-5.4-mini"));

  // "local" is what a phone sends when it knows no model by name.
  await ask("local");
  assert.equal(mlx.asked.at(-1), "Qwen/Qwen3-14B-MLX-4bit");
  await ask(undefined);
  assert.equal(mlx.asked.at(-1), "Qwen/Qwen3-14B-MLX-4bit");
});

test("/local_llm/status says what the Mac holds, from its own provider", async () => {
  const response = await app.inject({ method: "GET", url: "/local_llm/status.json", headers });
  const [device] = response.json().devices;
  assert.equal(device.online, true);
  assert.equal(device.heartbeat.loaded_model, "Qwen/Qwen3-14B-MLX-4bit");
  assert.deepEqual(device.heartbeat.downloaded_models, ["Qwen/Qwen3-14B-MLX-4bit", "mlx-community/GLM-4-9B-0414-4bit"]);
});

// A phone takes a reply that has not opened within 3 s for a computer
// out of reach, and asks again through the relay: a model that took
// longer to load sent the question to the computer twice.
test("the reply opens before the model's first word", async () => {
  const slow = await runtime(["slow-model"], 1500);
  const port = await app.listen({ port: 0, host: "127.0.0.1" }).then((address) => new URL(address).port);
  try {
    await addProvider(slow.url, "slow-model", "slow");
    forgetRuntimeProbes();
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/queries`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ content: "Bonjour", model: "slow-model" }),
    });
    const reader = response.body!.getReader();
    const first = await reader.read();
    const opened = Date.now() - started;
    assert.equal(response.status, 200);
    assert.ok(opened < 1000, `opened after ${opened} ms`);
    assert.equal(new TextDecoder().decode(first.value).trimStart()[0], ":", "the padding comes first");

    let rest = "";
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) rest += new TextDecoder().decode(chunk.value);
    assert.match(rest, /event: final/);
    assert.ok(Date.now() - started >= 1500);
  } finally {
    await slow.close();
  }
});

test("a runtime that is not there is still said with a 503, before anything opens", async () => {
  const gone = await runtime(["gone-model"]);
  await gone.close();
  await addProvider(gone.url, "gone-model", "gone");
  forgetRuntimeProbes();
  const response = await app.inject({ method: "POST", url: "/queries", headers, payload: { content: "Bonjour", model: "gone-model" } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error, "local_llm_unavailable");
});
