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
