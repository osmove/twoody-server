import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A guest's warm (18/10/2026, compute/guestWarm.ts): someone the computer is
// shared with opens their conversation or starts typing, and their phone
// sends a sealed warm through the account. Attack tests (AGENTS.md rule 12,
// the account and the guest taken as possibly malicious): a guest cannot
// make the host load another model, cannot exhaust it, cannot learn
// anything from it — end to end, through the real bridge client, the real
// sealing on both sides, a fake account and a fake runtime that answers
// like llama.cpp's router.

const dataDir = mkdtempSync(join(tmpdir(), "twoody-guest-warm-"));
process.env.TWOODY_DATA_DIR = dataDir;
const { startBridgeClient } = await import("../src/bridgeClient.js");
const { createGuestWarmer, WARM_EVERY_MS } = await import("../src/compute/guestWarm.js");
const { configureLocalModels } = await import("../src/executors/localModels.js");
const { createComputeIdentity, openComputeResponse, publicIdentity, sealComputeRequest } = await import("../src/compute/computeSeal.js");

type Handler = (req: IncomingMessage, res: ServerResponse, path: string, body: string) => void;

async function server(handler: Handler) {
  const calls: Array<{ method: string; path: string; body: string }> = [];
  const http = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      calls.push({ method: req.method ?? "", path, body });
      handler(req, res, path, body);
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    calls,
    close: () => {
      const closed = new Promise<void>((resolve) => http.close(() => resolve()));
      http.closeAllConnections();
      return closed;
    },
  };
}

const json = (res: ServerResponse, status: number, body?: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
};

async function until(check: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function quiet() {
  const original = { warn: console.warn, log: console.log };
  console.warn = () => undefined;
  console.log = () => undefined;
  return () => Object.assign(console, original);
}

type Status = Record<string, string | null>;

/// A runtime as llama.cpp's router answers: each model with its status
/// (`null`: listed without one, as Ollama or LM Studio do), completions
/// recorded.
async function fakeRuntime(statuses: Status) {
  const state = { statuses, questionMs: 0, goneAtRead: null as string | null };
  const completions: Array<Record<string, unknown>> = [];
  const urls: string[] = [];
  const runtime = await server((req, res, path, body) => {
    if (path === "/v1/models") {
      return json(res, 200, { data: Object.entries(state.statuses).map(([id, status]) => (status === null ? { id } : { id, status: { value: status } })) });
    }
    if (path === "/v1/chat/completions") {
      const asked = JSON.parse(body) as Record<string, unknown>;
      // The router's own guard: not loaded, and asked not to load it.
      const status = state.goneAtRead === asked.model ? "unloaded" : state.statuses[String(asked.model)];
      if (req.url?.includes("autoload=false") && status !== "loaded" && status !== "sleeping") {
        return json(res, 400, { error: { code: 400, message: "model is not loaded", type: "invalid_request_error" } });
      }
      urls.push(req.url ?? "");
      completions.push(asked);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Bonjour" } }] })}\n\n`);
      // A question written slowly, when asked: a warm meanwhile is skipped.
      setTimeout(() => {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.end("data: [DONE]\n\n");
      }, asked.max_tokens === 1 ? 0 : state.questionMs);
      return;
    }
    json(res, 404);
  });
  return { ...runtime, state, completions, urls };
}

/// A fake account handing sealed tasks to the bridge client, as the real
/// one relays them, and the guest's device that seals them and reads the
/// answers.
async function setup(t: test.TestContext, statuses: Status) {
  const runtime = await fakeRuntime(statuses);
  configureLocalModels({ endpoints: [`${runtime.url}/v1`], defaultModel: Object.keys(statuses)[0] });
  const queue: Array<Record<string, unknown>> = [];
  const lines = new Map<string, string[]>();
  const done = new Set<string>();
  let hostKeys: { identity: { enc_public: string; sign_public: string }; prekeys: Array<{ created_at: number }> } | null = null;
  const account = await server((_req, res, path, body) => {
    if (path === "/bridge/tasks/next") {
      const task = queue.shift();
      return task ? json(res, 200, task) : setTimeout(() => json(res, 204), 20);
    }
    if (path === "/bridge/compute_key") {
      hostKeys = JSON.parse(body);
      return json(res, 201, {});
    }
    const match = /^\/bridge\/tasks\/([\w-]+)$/.exec(path);
    if (match) {
      const patch = JSON.parse(body) as { status: string; delta?: string };
      if (patch.status === "streaming" && patch.delta) lines.set(match[1]!, [...(lines.get(match[1]!) ?? []), ...patch.delta.split("\n").filter(Boolean)]);
      if (patch.status === "done" || patch.status === "error") done.add(match[1]!);
      return json(res, 204);
    }
    json(res, 404);
  });
  const restore = quiet();
  const client = startBridgeClient({
    backendUrl: account.url,
    userToken: "host-session",
    deviceIdPath: join(dataDir, `bridge-device-id-${Math.random()}`),
    computeKeysPath: join(dataDir, `compute-keys-${Math.random()}.json`),
    capabilities: ["local-llm-provider"],
  });
  t.after(async () => {
    client.stop();
    restore();
    await Promise.all([account.close(), runtime.close()]);
  });
  await until(() => hostKeys !== null);
  const guest = createComputeIdentity();
  const guestKey = { enc_public: publicIdentity(guest).encPublic, sign_public: publicIdentity(guest).signPublic };
  let count = 0;
  /// Sends a sealed body for `grant`; resolves with the guest's opened answer.
  async function send(body: unknown, grant = 7) {
    return (await sendAsync(body, grant))();
  }
  /// Sends it; resolves once the account handed it, with a function that
  /// waits for the answer.
  async function sendAsync(body: unknown, grant = 7) {
    const keys = hostKeys!;
    const prekey = [...keys.prekeys].sort((a, b) => b.created_at - a.created_at)[0] as never;
    const { request, turn } = sealComputeRequest({ guest, host: { encPublic: keys.identity.enc_public, signPublic: keys.identity.sign_public }, prekey, grantId: String(grant), requestId: `r-${Math.random()}`, now: Date.now(), body });
    const id = `task-${(count += 1)}`;
    queue.push({ id, kind: "llm_infer", args: { sealed_request: request, guest_key: guestKey, principal: { kind: "shared", grant_id: grant, revision: 1 } } });
    await until(() => !queue.some((task) => task.id === id));
    return async () => {
      await until(() => done.has(id));
      const relayed = lines.get(id) ?? [];
      const parsed = relayed.map((line) => JSON.parse(line) as { h?: never; c?: never });
      const reader = openComputeResponse(turn, parsed[0]!.h!);
      const pieces = parsed.slice(1).map((line) => reader.open(line.c!));
      return { relayed, text: pieces.map((piece) => piece.text).join(""), extras: pieces.map((piece) => piece.extra), final: reader.done };
    };
  }
  return { runtime, send, sendAsync };
}

const MESSAGES = [
  { role: "system", content: "You are Twoody, a helpful personal AI assistant.\nToday is Sunday 18 October 2026." },
  { role: "user", content: "Bonjour" },
  { role: "assistant", content: "Salut Claire" },
  { role: "user", content: "" },
];
const warm = (model: string, extra: Record<string, unknown> = {}) => ({ warm: true, model, max_tokens: 1, messages: MESSAGES, ...extra });

test("a warm reads ahead for the model the computer holds, awake or asleep: one token, no tools, no reasoning; the guest gets an empty answer at once", async (t) => {
  const { runtime, send } = await setup(t, { "Qwen3.5-9B": "loaded", "Qwen3.5-4B": "unloaded" });
  const answer = await send(warm("Qwen3.5-9B"));
  assert.equal(answer.text, "");
  assert.equal(answer.final, true);
  await until(() => runtime.completions.length === 1);
  const asked = runtime.completions[0]!;
  assert.equal(asked.model, "Qwen3.5-9B");
  assert.equal(asked.max_tokens, 1);
  assert.equal(asked.temperature, 0);
  assert.equal(asked.tools, undefined);
  assert.deepEqual(asked.chat_template_kwargs, { enable_thinking: false });
  assert.deepEqual(asked.messages, MESSAGES, "the conversation as the question will start it");
  // The router itself asked never to load a model for it.
  assert.match(runtime.urls[0]!, /\?autoload=false$/);

  // Asleep (--sleep-idle-seconds passed): woken, it is the one it holds.
  const asleep = await setup(t, { "Qwen3.5-9B": "sleeping" });
  await asleep.send(warm("Qwen3.5-9B"), 8);
  await until(() => asleep.runtime.completions.length === 1);
});

test("a model gone between the check and the read is not loaded again: the router refuses, nothing is read", async (t) => {
  const { runtime, send } = await setup(t, { "Qwen3.5-9B": "loaded" });
  // Listed as held when asked, unloaded by the time the read comes (the
  // owner chose another model meanwhile): what the router answers then.
  runtime.state.goneAtRead = "Qwen3.5-9B";
  await send(warm("Qwen3.5-9B"), 31);
  await until(() => runtime.calls.some((call) => call.path === "/v1/chat/completions"));
  await pause(200);
  assert.equal(runtime.completions.length, 0, "refused by the router, never loaded");
  assert.ok(runtime.calls.filter((call) => call.path === "/v1/chat/completions").every((call) => call.body.includes('"max_tokens":1')));
});

test("a warm never loads a model: another one than the one held, one not installed, or any model of a runtime that cannot say which it holds", async (t) => {
  const { runtime, send } = await setup(t, { "Qwen3.5-9B": "loaded", "Qwen3.5-4B": "unloaded" });
  await send(warm("Qwen3.5-4B"), 1);
  await send(warm("gpt-oss-120b"), 2);
  await send(warm("Qwen3.5-9B", { model: "Qwen3.5-4B" }), 3);
  runtime.state.statuses = { "Qwen3.5-9B": "loading", "Qwen3.5-4B": "unloaded" };
  await send(warm("Qwen3.5-9B"), 4);
  // Its read, had it been allowed, done before another runtime is set up.
  await pause(300);
  const ollama = await setup(t, { "qwen3:14b": null, "glm4:9b": null });
  await ollama.send(warm("qwen3:14b"), 5);
  await pause(300);
  assert.equal(runtime.completions.length, 0, "the model was never asked");
  assert.equal(ollama.runtime.completions.length, 0, "nor a runtime that lists models without saying which it holds");
});

test("warms cannot exhaust the computer: a burst from one grant is read once, none while that grant's question runs; what reaches the model is bounded whatever the warm says", async (t) => {
  const slow = await setup(t, { "Qwen3.5-9B": "loaded" });
  slow.runtime.state.questionMs = 600;
  const question = await slow.sendAsync({ model: "Qwen3.5-9B", messages: MESSAGES.slice(0, 2) }, 21);
  await until(() => slow.runtime.completions.length === 1);
  await slow.send(warm("Qwen3.5-9B"), 21);
  assert.equal((await question()).text, "Bonjour");
  await pause(200);
  assert.equal(slow.runtime.completions.length, 1, "no read while the grant's question was written");

  const { runtime, send } = await setup(t, { "Qwen3.5-9B": "loaded" });
  for (let i = 0; i < 6; i += 1) await send(warm("Qwen3.5-9B", i === 0 ? { tools: [{ type: "function", function: { name: "read_file" } }], tool_choice: "required", max_tokens: 100_000, temperature: 2, chat_template_kwargs: { enable_thinking: true }, reasoning_effort: "high" } : {}));
  await pause(300);
  assert.equal(runtime.completions.length, 1, "one read for six warms");
  const asked = runtime.completions[0]!;
  assert.equal(asked.max_tokens, 1);
  assert.equal(asked.tools, undefined);
  assert.equal(asked.tool_choice, undefined);
  assert.deepEqual(asked.chat_template_kwargs, { enable_thinking: false });
  assert.equal(asked.reasoning_effort, "none");
});

test("the guest learns nothing from a warm: the same answer whether it was read, refused for its model, or too soon", async (t) => {
  const { runtime, send } = await setup(t, { "Qwen3.5-9B": "loaded", "Qwen3.5-4B": "unloaded" });
  const read = await send(warm("Qwen3.5-9B"), 11);
  const notHeld = await send(warm("Qwen3.5-4B"), 12);
  const tooSoon = await send(warm("Qwen3.5-9B"), 11);
  await pause(200);
  assert.equal(runtime.completions.length, 1);
  for (const answer of [read, notHeld, tooSoon]) {
    assert.equal(answer.relayed.length, 2, "a header and one final piece");
    assert.equal(answer.text, "");
    assert.deepEqual(answer.extras, [{}], "nothing beside the empty text: no model, no outcome");
  }
});

test("a question is answered without reasoning, whatever the guest asks", async (t) => {
  const { runtime, send } = await setup(t, { "Qwen3.5-9B": "loaded" });
  const answer = await send({ model: "Qwen3.5-9B", messages: MESSAGES.slice(0, 2), chat_template_kwargs: { enable_thinking: true }, reasoning_effort: "high", thinking_budget_tokens: 50_000 });
  assert.equal(answer.text, "Bonjour");
  const asked = runtime.completions[0]!;
  assert.deepEqual(asked.chat_template_kwargs, { enable_thinking: false });
  assert.equal(asked.reasoning_effort, "none");
  assert.equal(asked.thinking_budget_tokens, undefined);
});

// ── The rules themselves, with a clock ─────────────────────────────────────

function warmer(options: { held?: boolean; fail?: boolean } = {}) {
  let clock = 1_000_000;
  const ran: string[] = [];
  const running: Array<() => void> = [];
  const instance = createGuestWarmer({
    run: async (body) => {
      ran.push(String(body.model));
      if (options.fail) throw new Error("runtime down");
      await new Promise<void>((resolve) => running.push(resolve));
    },
    held: async () => options.held ?? true,
    now: () => clock,
  });
  /// The read running now ends (once it has started).
  const finish = async () => {
    await until(() => running.length > 0);
    running.shift()!();
  };
  return { instance, ran, tick: (ms: number) => (clock += ms), finish };
}

test("one warm per grant every 15 s, each grant its own; one at a time on the computer; none during the grant's question", async () => {
  const { instance, ran, tick, finish } = warmer();
  const first = instance.request("7", { model: "m" });
  assert.equal(await instance.request("8", { model: "m" }), "busy", "one at a time");
  await finish();
  assert.equal(await first, "warmed");
  tick(5_000);
  assert.equal(await instance.request("7", { model: "m" }), "rate");
  const other = instance.request("8", { model: "m" });
  await finish();
  assert.equal(await other, "warmed", "another grant has its own pace");
  tick(WARM_EVERY_MS);
  const ended = instance.turnStarted("7");
  assert.equal(await instance.request("7", { model: "m" }), "turn");
  ended();
  ended();
  const after = instance.request("7", { model: "m" });
  await finish();
  assert.equal(await after, "warmed");
  assert.deepEqual(ran, ["m", "m", "m"]);
});

test("a warm refused for its model still counts: the runtime cannot be probed faster than a warm may run", async () => {
  const { instance, ran, tick } = warmer({ held: false });
  assert.equal(await instance.request("7", { model: "other" }), "not_held");
  tick(1_000);
  assert.equal(await instance.request("7", { model: "other" }), "rate");
  assert.deepEqual(ran, []);
  const failing = warmer({ fail: true });
  assert.equal(await failing.instance.request("7", { model: "m" }), "failed");
  failing.tick(WARM_EVERY_MS);
  assert.equal(await failing.instance.request("7", { model: "m" }), "failed", "tried again only after the interval");
});
