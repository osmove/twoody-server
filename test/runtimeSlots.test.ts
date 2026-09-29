import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// llama.cpp's slots: the chat on slot 0 and the background work on slot 1,
// only on the runtime Twoody ships (started with a key) when it has two
// slots or more — never on another runtime, never with one slot.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-runtime-slots-"));
delete process.env.BRIDGE_LOCAL_LLM_ENDPOINT;

const { runtimeSlot, forgetRuntimeSlots } = await import("../src/runtimeSlots.js");
const { configureRuntimeKeys } = await import("../src/runtimeAuth.js");

const KEY = "runtime-key";
let slots: number | null = 2;
const bodies: Array<Record<string, unknown>> = [];
const propsAsked: string[] = [];

// llama-server in router mode, as far as this goes.
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (req.headers.authorization !== `Bearer ${KEY}`) {
    res.writeHead(401).end();
    return;
  }
  if (req.method === "GET" && url.pathname === "/props") {
    propsAsked.push(url.searchParams.get("model") ?? "");
    if (slots === null) return void res.writeHead(404).end();
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
    const extraction = body.messages[0]?.content.startsWith("You extract lasting facts");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: extraction ? "- Elle s'appelle Camille." : "Enchanté, Camille." } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
test.after(() => new Promise((resolve) => server.close(resolve)));

test("the runtime Twoody ships, with two slots: chat on 0, background on 1", async () => {
  configureRuntimeKeys({ [base]: KEY });
  forgetRuntimeSlots();
  slots = 2;
  assert.equal(await runtimeSlot(base, "qwen", "chat"), 0);
  assert.equal(await runtimeSlot(base, "qwen", "background"), 1);
  assert.deepEqual(propsAsked, ["qwen"], "asked once, then kept");
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

test("through /queries: the answer on slot 0, the memory extraction after it on slot 1", async () => {
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
    for (let i = 0; i < 100 && bodies.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(bodies.map((body) => body.id_slot), [0, 1]);
  } finally {
    await app.close();
  }
});
