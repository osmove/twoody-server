// A model picked on a paired phone is loaded on this computer before the
// first question (POST /providers/load, src/modelLoads.ts), and /providers
// says which runtime answers and what it holds in memory. On 05/10/2026
// Jimmy picked « Qwen3 14B via mlx-lm » on his iPhone: mlx-lm was not
// running on the Mac, nothing said so, and the picker went back to
// « Automatique ».
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-providers-load-"));
delete process.env.TWOODY_BACKEND_URL;
delete process.env.TWOODY_USER_TOKEN;
delete process.env.BRIDGE_LOCAL_LLM_ENDPOINT;

// llama.cpp's router, as Twoody Desktop runs it: every model of its folder
// listed with a status, one in memory at a time, loaded on a request.
let inMemory = "Qwen3.5-9B-Q4_K_M";
let loadMs = 150;
const warmed: string[] = [];
/// Every request the runtime got, streamed or not.
const asked: Array<{ model: string; stream: boolean; max_tokens?: number; messages: Array<{ role: string; content: string }> }> = [];
const readBody = async (req: IncomingMessage) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || "{}");
};
const router = createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  if (req.method === "GET" && path === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: ["Qwen3.5-9B-Q4_K_M", "Qwen3.5-4B-Q4_K_M"].map((id) => ({ id, status: { value: id === inMemory ? "loaded" : "unloaded" } })) }));
    return;
  }
  if (req.method === "POST" && path === "/v1/chat/completions") {
    const body = await readBody(req);
    asked.push({ model: body.model, stream: body.stream === true, max_tokens: body.max_tokens, messages: body.messages });
    if (body.stream) {
      // A turn, or the start of a new conversation read ahead.
      await new Promise((resolve) => setTimeout(resolve, body.model === inMemory ? 5 : loadMs));
      inMemory = body.model;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Réponse." } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    warmed.push(body.model);
    await new Promise((resolve) => setTimeout(resolve, loadMs));
    inMemory = body.model;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "o" } }] }));
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((resolve) => router.listen(0, "127.0.0.1", resolve));
const routerUrl = `http://127.0.0.1:${(router.address() as AddressInfo).port}/v1`;

// mlx-lm, configured but not started: nothing listens at its address.
const closed = createServer();
await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
const mlxUrl = `http://127.0.0.1:${(closed.address() as AddressInfo).port}/v1`;
await new Promise<void>((resolve) => closed.close(() => resolve()));

const { buildApp } = await import("../src/app.js");
const { createAuthSession, ensureSetupToken } = await import("../src/auth.js");
const { forgetModelLoads, modelLoadSettled } = await import("../src/modelLoads.js");

const app = await buildApp();
test.after(async () => {
  await app.close();
  await new Promise<void>((resolve) => router.close(() => resolve()));
});

const desktop = (await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } })).json();
const owner = { "x-user-token": desktop.token };
const phone = { "x-user-token": createAuthSession(desktop.user_id, "iphone", "code").token };
const peer = { "x-user-token": createAuthSession(desktop.user_id, "peer:Mac", "account").token };
const askedByComputer = { "x-user-token": createAuthSession(desktop.user_id, "Mac", "account", "77").token };

assert.equal((await app.inject({ method: "POST", url: "/providers/local", headers: owner, payload: { url: routerUrl, model: "Qwen3.5-9B-Q4_K_M", name: "Twoody" } })).statusCode, 201);
assert.equal((await app.inject({ method: "POST", url: "/providers/local", headers: owner, payload: { url: mlxUrl, model: "Qwen/Qwen3-14B-MLX-4bit", name: "mlx-lm" } })).statusCode, 201);

test("/providers says which runtime answers and which models it holds in memory", async () => {
  const body = (await app.inject({ method: "GET", url: "/api/v1/providers", headers: phone })).json() as {
    providers: Array<{ name: string; models: string[]; loaded_models: string[] | null; status: { available: boolean; reachable: boolean } }>;
  };
  const twoody = body.providers.find((p) => p.name === "Twoody")!;
  assert.deepEqual(twoody.models, ["Qwen3.5-9B-Q4_K_M", "Qwen3.5-4B-Q4_K_M"]);
  assert.deepEqual(twoody.loaded_models, ["Qwen3.5-9B-Q4_K_M"]);
  assert.equal(twoody.status.reachable, true);
  const mlx = body.providers.find((p) => p.name === "mlx-lm")!;
  assert.equal(mlx.status.available, false);
  assert.equal(mlx.status.reachable, false);
  assert.equal(mlx.loaded_models, null);
});

test("a model in memory already is ready at once; nothing is sent to the runtime", async () => {
  forgetModelLoads();
  const reply = await app.inject({ method: "POST", url: "/api/v1/providers/load", headers: phone, payload: { model: "Qwen3.5-9B-Q4_K_M" } });
  assert.equal(reply.statusCode, 200);
  assert.equal(reply.json().load.state, "ready");
  assert.equal(reply.json().load.runtime, "Twoody");
  assert.deepEqual(warmed, []);
});

test("an installed model not in memory is loaded, and its progress can be followed", async () => {
  forgetModelLoads();
  const reply = await app.inject({ method: "POST", url: "/api/v1/providers/load", headers: phone, payload: { model: "Qwen3.5-4B-Q4_K_M" } });
  assert.equal(reply.statusCode, 202);
  assert.equal(reply.json().load.state, "loading");
  assert.ok(reply.json().load.expected_ms > 0);
  const during = (await app.inject({ method: "GET", url: "/api/v1/providers/load?model=Qwen3.5-4B-Q4_K_M", headers: phone })).json().load;
  assert.equal(during.state, "loading");
  assert.ok(during.progress >= 0 && during.progress < 1);
  // Asked twice while it loads: one load.
  await app.inject({ method: "POST", url: "/api/v1/providers/load", headers: phone, payload: { model: "Qwen3.5-4B-Q4_K_M" } });
  await modelLoadSettled("Qwen3.5-4B-Q4_K_M");
  assert.deepEqual(warmed, ["Qwen3.5-4B-Q4_K_M"]);
  const after = (await app.inject({ method: "GET", url: "/api/v1/providers/load?model=Qwen3.5-4B-Q4_K_M", headers: phone })).json().load;
  assert.equal(after.state, "ready");
  assert.equal(after.progress, 1);
  assert.ok(after.elapsed_ms >= loadMs - 20);
});

test("a runtime that is not running is said, by name: nothing is loaded", async () => {
  const reply = await app.inject({ method: "POST", url: "/api/v1/providers/load", headers: phone, payload: { model: "Qwen/Qwen3-14B-MLX-4bit" } });
  assert.equal(reply.statusCode, 503);
  assert.equal(reply.json().error, "runtime_unreachable");
  assert.equal(reply.json().runtime, "mlx-lm");
});

test("only a model one of this computer's runtimes lists; never an address", async () => {
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/providers/load", headers: phone, payload: { model: "../../etc/passwd" } })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/providers/load", headers: phone, payload: {} })).statusCode, 422);
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/providers/load", headers: phone, payload: { model: "auto" } })).statusCode, 422);
});

test("the person's devices only: never another computer of the account, never without a session", async () => {
  const lan = { remoteAddress: "192.168.1.30" };
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/providers/load", payload: { model: "Qwen3.5-4B-Q4_K_M" }, ...lan })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/providers/load", headers: peer, payload: { model: "Qwen3.5-4B-Q4_K_M" }, ...lan })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/providers/load", headers: askedByComputer, payload: { model: "Qwen3.5-4B-Q4_K_M" }, ...lan })).statusCode, 403);
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/providers/load?model=Qwen3.5-4B-Q4_K_M", headers: peer, ...lan })).statusCode, 403);
});

// « Prêt » (Jimmy, 11/10/2026): once a model chosen on a device is in
// memory, the start of that device's new conversation is read with it, so
// that the first question reads only itself; a background read for the
// model chosen before never loads it back in its place.
test("a model chosen after a conversation: loaded, the start of the device's new conversation read with it, then ready", async () => {
  const { forgetWarmStateForTests, warmNewConversation } = await import("../src/routes/queries.js");
  forgetWarmStateForTests();
  forgetModelLoads();
  inMemory = "Qwen3.5-9B-Q4_K_M";
  const ask = (headers: Record<string, string>, text: string) => app.inject({ method: "POST", url: "/queries", headers, payload: { text, channel: "device", force_new_discussion: true, context_window: 16_384, locale: "fr" } });
  assert.equal((await ask(owner, "Bonjour")).statusCode, 200);
  assert.equal((await ask(phone, "Salut")).statusCode, 200);
  const phoneTurn = asked.filter((call) => call.stream && call.max_tokens !== 1).at(-1)!;
  assert.equal(phoneTurn.model, "Qwen3.5-9B-Q4_K_M");

  const before = asked.length;
  const reply = await app.inject({ method: "POST", url: "/api/v1/providers/load", headers: phone, payload: { model: "Qwen3.5-4B-Q4_K_M" } });
  assert.equal(reply.statusCode, 202);
  const seen = new Set<string>([reply.json().load.state]);
  for (let i = 0; i < 200; i += 1) {
    const load = (await app.inject({ method: "GET", url: "/api/v1/providers/load?model=Qwen3.5-4B-Q4_K_M", headers: phone })).json().load;
    seen.add(load.state);
    if (load.state === "preparing") assert.equal(load.progress, 1, "in memory: the load is done");
    if (load.state === "ready") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual([...seen], ["loading", "preparing", "ready"]);
  const calls = asked.slice(before);
  assert.deepEqual(calls.map((call) => [call.model, call.stream, call.max_tokens]), [["Qwen3.5-4B-Q4_K_M", false, 1], ["Qwen3.5-4B-Q4_K_M", true, 1]]);
  assert.equal(calls[1]!.messages[0]!.role, "system");
  assert.equal(calls[1]!.messages[0]!.content, phoneTurn.messages[0]!.content, "the very start the phone's next new conversation sends");

  // Chosen again while it holds that start: ready at once, nothing read.
  const again = await app.inject({ method: "POST", url: "/api/v1/providers/load", headers: phone, payload: { model: "Qwen3.5-4B-Q4_K_M" } });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().load.state, "ready");
  assert.equal(asked.length, before + 2);

  // A memory saved: the app's start changed, but it was made for the 9B,
  // which the runtime let go of — read in the background, it would load
  // the 9B back in place of the model just chosen.
  await app.inject({ method: "POST", url: "/memories", headers: owner, payload: { memory: { content: "Je joue du piano le mardi" } } });
  assert.equal(await warmNewConversation(desktop.user_id), "none");
  assert.equal(asked.length, before + 2);
  assert.equal(inMemory, "Qwen3.5-4B-Q4_K_M");

  // The person is about to ask on the phone: its start is read with the 4B.
  assert.equal(await warmNewConversation(`${desktop.user_id}|remote`, { wake: true }), "warmed");
  assert.equal(asked.at(-1)!.model, "Qwen3.5-4B-Q4_K_M");
});

test("this computer's app asks for a model just loaded: the start read, answered once done", async () => {
  const { forgetWarmStateForTests } = await import("../src/routes/queries.js");
  forgetWarmStateForTests();
  inMemory = "Qwen3.5-9B-Q4_K_M";
  await app.inject({ method: "POST", url: "/queries", headers: owner, payload: { text: "Bonsoir", channel: "desktop", force_new_discussion: true, context_window: 16_384, locale: "fr" } });
  const before = asked.length;
  const first = await app.inject({ method: "POST", url: "/queries/warm", headers: owner, payload: { model: "Qwen3.5-4B-Q4_K_M", fresh: true } });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().status, "warmed");
  assert.equal(asked.at(-1)!.model, "Qwen3.5-4B-Q4_K_M");
  assert.equal(asked.at(-1)!.max_tokens, 1);
  assert.equal((await app.inject({ method: "POST", url: "/queries/warm", headers: owner, payload: { model: "Qwen3.5-4B-Q4_K_M" } })).json().status, "unchanged");
  // Loaded again (it slept, or another took its place): read again.
  assert.equal((await app.inject({ method: "POST", url: "/queries/warm", headers: owner, payload: { model: "Qwen3.5-4B-Q4_K_M", fresh: true } })).json().status, "warmed");
  // A model no runtime here holds: nothing is sent anywhere.
  const count = asked.length;
  assert.equal((await app.inject({ method: "POST", url: "/queries/warm", headers: owner, payload: { model: "gpt-5" } })).json().status, "none");
  assert.equal(asked.length, count);
  assert.ok(count > before);
  assert.equal((await app.inject({ method: "POST", url: "/queries/warm", payload: { model: "Qwen3.5-4B-Q4_K_M" } })).statusCode, 401);
  // Another computer of the account: never.
  const lan = { remoteAddress: "192.168.1.30" };
  assert.equal((await app.inject({ method: "POST", url: "/queries/warm", headers: peer, payload: { model: "Qwen3.5-4B-Q4_K_M" }, ...lan })).statusCode, 403);
  assert.equal(asked.length, count);
});
