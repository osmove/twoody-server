import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// llama.cpp's slots on a shared computer (19/10/2026, builtin/slots.ts): the
// owner's chat and the work in the background on slot 0, the guests' turns
// and warms on slot 1 — only on the runtime Twoody ships (started with a
// key) when it has two slots or more; never on another runtime, never with
// one slot.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-runtime-slots-"));
delete process.env.BRIDGE_LOCAL_LLM_ENDPOINT;

const { runtimeSlot, forgetRuntimeSlots } = await import("../src/runtimeSlots.js");
const { configureRuntimeKeys } = await import("../src/runtimeAuth.js");

const KEY = "runtime-key";
let slots: number | null = 2;
let held = true;
const bodies: Array<Record<string, unknown>> = [];
const propsAsked: string[] = [];
const autoloads: Array<string | null> = [];

// llama-server in router mode, as far as this goes.
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (req.headers.authorization !== `Bearer ${KEY}`) {
    res.writeHead(401).end();
    return;
  }
  if (req.method === "GET" && url.pathname === "/props") {
    propsAsked.push(url.searchParams.get("model") ?? "");
    autoloads.push(url.searchParams.get("autoload"));
    if (slots === null) return void res.writeHead(404).end();
    // llama.cpp's router asked not to load a model it does not hold.
    if (url.searchParams.get("autoload") === "false" && !held) return void res.writeHead(400, { "content-type": "application/json" }).end('{"error":{"message":"model is not loaded"}}');
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ total_slots: slots, build_info: "b11146-7fe450e19", model_alias: "qwen" }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "qwen" }] }));
    return;
  }
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = JSON.parse(raw) as Record<string, unknown> & { messages: Array<{ content: string }> };
    bodies.push(body);
    const extraction = body.messages[0]?.content.startsWith("You read a conversation between");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: extraction ? '{"facts":[]}' : "Enchanté, Camille." } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
test.after(() => new Promise((resolve) => server.close(resolve)));

test("the runtime Twoody ships, with two slots: the owner and the background on 0, a guest on 1", async () => {
  configureRuntimeKeys({ [base]: KEY });
  forgetRuntimeSlots();
  propsAsked.length = 0;
  slots = 2;
  assert.equal(await runtimeSlot(base, "qwen", "chat"), 0);
  // Measured: a guest waits 13.9 s for a learner on slot 1, 2.5 s with it on 0.
  assert.equal(await runtimeSlot(base, "qwen", "background"), 0);
  assert.equal(await runtimeSlot(base, "qwen", "guest"), 1);
  assert.deepEqual(propsAsked, ["qwen"], "asked once, then kept");
  // Switched by the Desktop: asked again.
  forgetRuntimeSlots();
  slots = 1;
  assert.equal(await runtimeSlot(base, "qwen", "guest"), null);
  assert.deepEqual(propsAsked, ["qwen", "qwen"]);
});

test("a guest's warm asks without loading the model, and a model not held is asked again next time", async () => {
  configureRuntimeKeys({ [base]: KEY });
  forgetRuntimeSlots();
  slots = 2;
  held = false;
  autoloads.length = 0;
  assert.equal(await runtimeSlot(base, "qwen", "guest", { autoload: false }), null, "not loaded: no slot named");
  held = true;
  assert.equal(await runtimeSlot(base, "qwen", "guest", { autoload: false }), 1, "not kept: asked again");
  assert.deepEqual(autoloads, ["false", "false"]);
  assert.equal(await runtimeSlot(base, "qwen", "guest"), 1, "then kept");
  assert.equal(autoloads.length, 2);
});

test("one slot (--parallel 1, as today), or not llama.cpp: no slot named", async () => {
  configureRuntimeKeys({ [base]: KEY });
  forgetRuntimeSlots();
  slots = 1;
  assert.equal(await runtimeSlot(base, "qwen", "background"), null);
  forgetRuntimeSlots();
  slots = null;
  assert.equal(await runtimeSlot(base, "qwen", "chat"), null);
});

test("a runtime without Twoody's key (Ollama, LM Studio, one the person started) is never asked", async () => {
  configureRuntimeKeys({});
  forgetRuntimeSlots();
  slots = 2;
  const before = propsAsked.length;
  assert.equal(await runtimeSlot("http://127.0.0.1:11434/v1", "qwen3:8b", "chat"), null);
  assert.equal(await runtimeSlot(base, "qwen", "chat"), null);
  assert.equal(propsAsked.length, before);
});

test("through /queries: the answer and the learning from the conversation, both on the owner's slot 0", async () => {
  configureRuntimeKeys({ [base]: KEY });
  forgetRuntimeSlots();
  slots = 2;
  const { buildApp } = await import("../src/app.js");
  const { ensureSetupToken } = await import("../src/auth.js");
  const app = await buildApp();
  try {
    const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
    const headers = { authorization: `Bearer ${paired.json().token}` };
    assert.equal((await app.inject({ method: "POST", url: "/providers/local", headers, payload: { url: base, model: "qwen", name: "Twoody" } })).statusCode, 201);
    bodies.length = 0;
    const response = await app.inject({ method: "POST", url: "/queries", headers, payload: { text: "Bonjour, je m'appelle Camille.", channel: "desktop", force_new_discussion: true } });
    assert.equal(response.statusCode, 200, response.body);
    const learned = await app.inject({ method: "POST", url: "/memories/learn", headers, payload: { discussion_id: response.body.match(/"discussion_id":"([^"]+)"/)![1] } });
    assert.equal(learned.statusCode, 200, learned.body);
    assert.deepEqual(bodies.map((body) => body.id_slot), [0, 0]);
  } finally {
    await app.close();
  }
});

test("a guest's turn through llm_infer on slot 1; its body never names a slot", async () => {
  configureRuntimeKeys({ [base]: KEY });
  forgetRuntimeSlots();
  slots = 2;
  held = true;
  const { configureLocalModels } = await import("../src/executors/localModels.js");
  const { runLlmInfer } = await import("../src/executors/llmInfer.js");
  configureLocalModels({ endpoints: [base], defaultModel: "qwen" });
  bodies.length = 0;
  const asked = { model: "qwen", messages: [{ role: "user", content: "Bonjour" }], max_tokens: 20, id_slot: 0 };
  await runLlmInfer({ openai_body_json: JSON.stringify(asked) }, { guest: true });
  await runLlmInfer({ openai_body_json: JSON.stringify(asked) }, { guest: true, onlyIfLoaded: true });
  // Not a guest (none today; a plain llm_infer is refused by the bridge
  // client): no slot, and the body's own is dropped.
  await runLlmInfer({ openai_body_json: JSON.stringify(asked) });
  assert.deepEqual(bodies.map((body) => body.id_slot), [1, 1, undefined]);
  // One slot: nothing named.
  forgetRuntimeSlots();
  slots = 1;
  bodies.length = 0;
  await runLlmInfer({ openai_body_json: JSON.stringify(asked) }, { guest: true });
  assert.deepEqual(bodies.map((body) => body.id_slot), [undefined]);
});
