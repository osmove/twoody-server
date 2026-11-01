// The built-in engine inside the server (docs/builtin-runtime-design.md,
// lot B): /runtime and who may use it, the « Moteur » preference, the
// engine as a provider that is not stored, a chat that starts the runtime
// (a fake llama-server, fixtures/fake-llama-server.mjs), a model installed
// from a local mirror of the catalogue, and the refusals — 409 when the
// Desktop runs the runtime, 507 when a model would not fit in memory.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "twoody-runtime-routes-"));
process.env.TWOODY_DATA_DIR = join(root, "data");
process.env.TWOODY_RUNTIME_DIR = join(root, "runtime");
delete process.env.TWOODY_BACKEND_URL;
delete process.env.TWOODY_USER_TOKEN;
delete process.env.BRIDGE_LOCAL_LLM_ENDPOINT;
delete process.env.TWOODY_RUNTIME;
delete process.env.TWOODY_RUNTIME_OWNER;
delete process.env.TWOODY_ADMIN_TOKEN;

// A tiny « model » served by a local mirror, as TWOODY_MODEL_CATALOG allows.
const tiny = Buffer.from("GGUF tiny model for the tests");
const mirror = createServer((req, res) => {
  if (req.url !== "/Tiny-Q8_0.gguf") {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { "content-length": tiny.length });
  res.end(tiny);
});
await new Promise<void>((resolve) => mirror.listen(0, "127.0.0.1", resolve));
const catalogFile = join(root, "catalog.json");
writeFileSync(
  catalogFile,
  JSON.stringify([
    {
      id: "Tiny-Q8_0",
      name: "Tiny",
      file: "Tiny-Q8_0.gguf",
      url: `http://127.0.0.1:${(mirror.address() as AddressInfo).port}/Tiny-Q8_0.gguf`,
      bytes: tiny.length,
      sha256: createHash("sha256").update(tiny).digest("hex"),
      minRamGb: 1,
    },
  ]),
);
process.env.TWOODY_MODEL_CATALOG = catalogFile;

const { RUNTIME_STAMP, runtimeDir } = await import("../src/builtin/index.js");
const { initEngine, resetEngine, engine } = await import("../src/engine.js");
const { jobSettled } = await import("../src/engineJobs.js");

// The runtime folder of a « Pi », with the fake server as llama-server.
const binaryDir = runtimeDir(process.env.TWOODY_RUNTIME_DIR!, "linux", "arm64");
mkdirSync(binaryDir, { recursive: true });
const fake = fileURLToPath(new URL("./fixtures/fake-llama-server.mjs", import.meta.url));
copyFileSync(fake, join(binaryDir, "fake-llama-server.mjs"));
writeFileSync(join(binaryDir, "llama-server"), `#!/bin/sh\nexec "${process.execPath}" "${join(binaryDir, "fake-llama-server.mjs")}" "$@"\n`);
chmodSync(join(binaryDir, "llama-server"), 0o755);
writeFileSync(join(binaryDir, "VERSION"), `${RUNTIME_STAMP}\n`);

const GIB = 1024 ** 3;
let firstPort = 49_100 + Math.floor(Math.random() * 300) * 10;
function start(options: { desktop?: boolean; available?: number } = {}) {
  return initEngine({
    desktop: options.desktop,
    manager: {
      platform: "linux",
      arch: "arm64",
      cpuCount: () => 4,
      totalMemory: () => 16 * GIB,
      availableMemory: async () => options.available ?? 12 * GIB,
      firstPort: (firstPort += 10),
    },
  });
}
start();

const { buildApp } = await import("../src/app.js");
const { createAuthSession, ensureSetupToken } = await import("../src/auth.js");

const app = await buildApp();
test.after(async () => {
  await resetEngine();
  await app.close();
  mirror.close();
});

const lan = { remoteAddress: "192.168.1.30" };
const desktop = (await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } })).json();
const owner = { "x-user-token": desktop.token };
const phone = { "x-user-token": createAuthSession(desktop.user_id, "iphone", "code").token };
const peer = { "x-user-token": createAuthSession(desktop.user_id, "peer:Mac", "account").token };
const askedByComputer = { "x-user-token": createAuthSession(desktop.user_id, "Mac", "account", "77").token };

test("the person reaches /runtime; another computer of the account never does", async () => {
  assert.equal((await app.inject({ method: "GET", url: "/runtime", ...lan })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/runtime", headers: owner, ...lan })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/runtime", headers: phone, ...lan })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/runtime", headers: peer, ...lan })).statusCode, 403);
  assert.equal((await app.inject({ method: "PUT", url: "/api/v1/runtime", headers: peer, payload: { engine: "ollama" }, ...lan })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/runtime/models", headers: askedByComputer, payload: { id: "Tiny-Q8_0" }, ...lan })).statusCode, 403);
  // Its console: this machine, on loopback, without a session (twoody-server runtime status).
  assert.equal((await app.inject({ method: "GET", url: "/runtime" })).statusCode, 200);
});

test("GET /runtime: auto finds nothing yet; the built-in runtime is installed without models", async () => {
  const view = (await app.inject({ method: "GET", url: "/runtime", headers: owner })).json();
  assert.equal(view.preference.engine, "auto");
  assert.equal(view.builtin.installed, true);
  assert.equal(view.builtin.platform, "linux-arm64");
  assert.deepEqual(view.builtin.models, []);
  assert.equal(view.builtin.running, false);
  assert.equal(view.builtin.managed_by, "server");
  assert.equal(view.builtin.threads, 3);
  assert.equal(view.builtin.threads_batch, 4);
  assert.ok(view.engines.some((e: { id: string }) => e.id === "builtin"));
  // Nothing to chat with: no provider, and no engine with a model.
  const reply = await app.inject({ method: "POST", url: "/queries", headers: owner, payload: { content: "Bonjour", provider: "engine" } });
  assert.equal(reply.statusCode, 503);
});

test("POST /runtime/models installs a model of the catalogue; it becomes the default", async () => {
  assert.equal((await app.inject({ method: "POST", url: "/runtime/models", headers: owner, payload: { id: "Nope" } })).statusCode, 404);
  const started = await app.inject({ method: "POST", url: "/runtime/models", headers: phone, payload: { id: "Tiny-Q8_0" }, ...lan });
  assert.equal(started.statusCode, 202);
  assert.equal(started.json().job.model, "Tiny-Q8_0");
  const job = await jobSettled();
  assert.equal(job?.state, "done", job?.message ?? "");
  assert.ok(existsSync(join(process.env.TWOODY_DATA_DIR!, "models", "Tiny-Q8_0.gguf")));
  const current = (await app.inject({ method: "GET", url: "/runtime/jobs/current", headers: owner })).json();
  assert.equal(current.job.state, "done");
  const catalog = (await app.inject({ method: "GET", url: "/runtime/catalog", headers: owner })).json();
  assert.equal(catalog.overridden, true);
  assert.equal(catalog.models[0].installed, true);
  const view = (await app.inject({ method: "GET", url: "/runtime", headers: owner })).json();
  assert.equal(view.builtin.default_model, "Tiny-Q8_0");
  assert.equal(view.active.id, "builtin");
  assert.equal(view.active.reason, "auto");
  assert.equal(view.builtin.running, false, "installing a model does not start the runtime");
});

test("the engine is a provider that is not stored, and the chat starts the runtime", async () => {
  const providers = (await app.inject({ method: "GET", url: "/providers", headers: owner })).json().providers;
  const entry = providers.find((p: { id: string }) => p.id === "engine");
  assert.ok(entry, JSON.stringify(providers));
  assert.equal(entry.kind, "local_openai");
  assert.equal(entry.name, "Twoody (llama.cpp)");
  assert.equal(entry.engine, "builtin");
  assert.equal(entry.base_url, null, "the loopback port and its key stay here");
  assert.equal(entry.is_default, true);
  assert.deepEqual(entry.models, ["Tiny-Q8_0"]);

  const status = (await app.inject({ method: "GET", url: "/local_llm/status", headers: owner })).json();
  assert.deepEqual(status.devices[0].heartbeat.downloaded_models, ["Tiny-Q8_0"]);

  const reply = await app.inject({ method: "POST", url: "/queries", headers: owner, payload: { content: "Bonjour" } });
  assert.equal(reply.statusCode, 200, reply.body);
  assert.match(reply.body, /depuis le moteur intégré/);
  const requests = readdirSync(binaryDir)
    .filter((name) => name.startsWith("request-"))
    .map((name) => JSON.parse(readFileSync(join(binaryDir, name), "utf8")) as { body: Record<string, unknown> });
  const chat = requests.find((r) => r.body.stream === true);
  assert.equal(chat?.body.model, "Tiny-Q8_0");
  assert.deepEqual(chat?.body.chat_template_kwargs, { enable_thinking: false }, "thinking stays off by default");

  const view = (await app.inject({ method: "GET", url: "/runtime", headers: owner })).json();
  assert.equal(view.builtin.running, true);
  assert.equal(view.builtin.loaded_model, "Tiny-Q8_0");

  // Named explicitly, and in this computer's status for the account.
  const named = await app.inject({ method: "POST", url: "/queries", headers: owner, payload: { content: "Encore", provider: "engine", model: "Tiny-Q8_0" } });
  assert.equal(named.statusCode, 200, named.body);
  const { buildStatus } = await import("../src/account/statusSource.js");
  const self = await buildStatus(desktop.user_id);
  assert.equal(self.engine, "builtin");
  assert.deepEqual(self.models, [{ id: "Tiny-Q8_0", loaded: true }]);
});

test("PUT /runtime checks what it is given and keeps it in runtime.json", async () => {
  assert.equal((await app.inject({ method: "PUT", url: "/runtime", headers: owner, payload: { engine: "vllm" } })).statusCode, 422);
  assert.equal((await app.inject({ method: "PUT", url: "/runtime", headers: owner, payload: { engine: "custom" } })).statusCode, 422);
  assert.equal((await app.inject({ method: "PUT", url: "/runtime", headers: owner, payload: { builtin: { default_model: "Other" } } })).statusCode, 422);
  assert.equal((await app.inject({ method: "PUT", url: "/runtime", headers: owner, payload: { builtin: { ctx: 12 } } })).statusCode, 422);
  const set = await app.inject({ method: "PUT", url: "/runtime", headers: owner, payload: { engine: "builtin", builtin: { idle_minutes: 10, ctx: 4096 } } });
  assert.equal(set.statusCode, 200, set.body);
  assert.equal(set.json().preference.engine, "builtin");
  assert.equal(set.json().builtin.ctx, 4096);
  const stored = JSON.parse(readFileSync(join(process.env.TWOODY_DATA_DIR!, "runtime.json"), "utf8"));
  assert.equal(stored.engine, "builtin");
  assert.equal(stored.builtin.idle_minutes, 10);
  assert.equal(stored.builtin.default_model, "Tiny-Q8_0");
});

test("a model that would not fit in memory is refused with 507", async () => {
  await resetEngine();
  start({ available: 64 * 1024 ** 2 });
  const reply = await app.inject({ method: "POST", url: "/queries", headers: owner, payload: { content: "Bonjour", provider: "engine" } });
  assert.equal(reply.statusCode, 507, reply.body);
  assert.equal(reply.json().error, "insufficient_memory");
  assert.equal(engine().manager.status().running, false);
});

test("DELETE /runtime/models/:id removes it; the engine has nothing left to offer", async () => {
  assert.equal((await app.inject({ method: "DELETE", url: "/runtime/models/Nope", headers: owner })).statusCode, 404);
  assert.equal((await app.inject({ method: "DELETE", url: "/runtime/models/Tiny-Q8_0", headers: owner })).statusCode, 204);
  assert.ok(!existsSync(join(process.env.TWOODY_DATA_DIR!, "models", "Tiny-Q8_0.gguf")));
  const view = (await app.inject({ method: "GET", url: "/runtime", headers: owner })).json();
  assert.equal(view.active.reason, "no_models");
  assert.equal(view.builtin.default_model, null);
});

test("when the Desktop runs the runtime: 409 managed_by_desktop, and no engine provider", async () => {
  await resetEngine();
  start({ desktop: true });
  const install = await app.inject({ method: "POST", url: "/runtime/models", headers: owner, payload: { id: "Tiny-Q8_0" } });
  assert.equal(install.statusCode, 409);
  assert.equal(install.json().error, "managed_by_desktop");
  assert.equal((await app.inject({ method: "POST", url: "/runtime/install", headers: owner })).json().error, "managed_by_desktop");
  const view = (await app.inject({ method: "GET", url: "/runtime", headers: owner })).json();
  assert.equal(view.builtin.managed_by, "desktop");
  const providers = (await app.inject({ method: "GET", url: "/providers", headers: owner })).json().providers;
  assert.ok(!providers.some((p: { id: string }) => p.id === "engine"));
});

// 01/11/2026: `twoody pull` / `twoody rm` next to the Desktop — the Desktop
// does it (desktopModels.ts), over its port, as share-call does.
test("when the Desktop runs the runtime and listens: it installs and removes, its progress is the job's", async () => {
  await resetEngine();
  start({ desktop: true });
  const { relayModelsThroughDesktop } = await import("../src/desktopModels.js");
  const handlers: Array<(event: { data: unknown }) => void> = [];
  const asked: Array<{ op: string; model: string }> = [];
  let answerInstall: (() => void) | null = null;
  const port = {
    on: (_event: "message", handler: (event: { data: unknown }) => void) => void handlers.push(handler),
    postMessage(message: unknown) {
      const call = message as { type: string; id: string; op: string; model: string };
      asked.push({ op: call.op, model: call.model });
      const say = (data: unknown) => setImmediate(() => handlers.forEach((handler) => handler({ data })));
      if (call.op === "install") {
        // Another model's progress first: not this job's.
        say({ type: "model-progress", id: "Other-Q4", state: "downloading", received: 9, total: 99, bytesPerSecond: 1 });
        say({ type: "model-progress", id: call.model, state: "downloading", received: 40, total: 100, bytesPerSecond: 20 });
        answerInstall = () => say({ type: "model-call-result", id: call.id, ok: true });
      } else if (call.op === "remove") {
        say({ type: "model-call-result", id: call.id, ok: call.model === "Tiny-Q8_0", code: "Not A Code!", message: "x".repeat(900) });
      }
    },
  };
  const undo = relayModelsThroughDesktop(port as never);
  try {
    // Never another computer of the account.
    assert.equal((await app.inject({ method: "POST", url: "/runtime/models", headers: askedByComputer, payload: { id: "Tiny-Q8_0" }, ...lan })).statusCode, 403);
    assert.equal(asked.length, 0);
    const install = await app.inject({ method: "POST", url: "/runtime/models", headers: owner, payload: { id: "Tiny-Q8_0" } });
    assert.equal(install.statusCode, 202);
    assert.equal(install.json().job.model, "Tiny-Q8_0");
    assert.deepEqual(asked, [{ op: "install", model: "Tiny-Q8_0" }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const during = (await app.inject({ method: "GET", url: "/runtime/jobs/current", headers: owner })).json().job;
    assert.equal(during.state, "downloading");
    assert.equal(during.received, 40);
    assert.equal(during.total, 100);
    answerInstall!();
    assert.equal((await jobSettled())?.state, "done");
    // Not in the catalogue: never asked of the Desktop.
    assert.equal((await app.inject({ method: "DELETE", url: "/runtime/models/Not-There", headers: owner })).statusCode, 404);
    assert.equal(asked.length, 1);
    assert.equal((await app.inject({ method: "DELETE", url: "/runtime/models/Tiny-Q8_0", headers: owner })).statusCode, 204);
    assert.deepEqual(asked.at(-1), { op: "remove", model: "Tiny-Q8_0" });
  } finally {
    undo();
  }
  // The Desktop gone: as before.
  assert.equal((await app.inject({ method: "POST", url: "/runtime/models", headers: owner, payload: { id: "Tiny-Q8_0" } })).json().error, "managed_by_desktop");
});
