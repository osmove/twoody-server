import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { asciiHeaderValue, heartbeatHeader } from "../src/bridgeClient.js";
import { createCompletionAccumulator, createDeltaRelay, createSseDataParser } from "../src/executors/completionStream.js";
import { configureLocalModels, isChatModelId, isPlaceholderModel, resolveTarget } from "../src/executors/localModels.js";
import { inferenceTimeoutMs, runLlmInfer } from "../src/executors/llmInfer.js";

test("a streamed completion is rebuilt as an ordinary one", () => {
  const accumulator = createCompletionAccumulator();
  const texts = [
    { choices: [{ delta: { role: "assistant", content: "Bon" } }] },
    { choices: [{ delta: { content: "jour" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 12, completion_tokens: 2 } },
  ].map((chunk) => accumulator.push(chunk));

  assert.deepEqual(texts, ["Bon", "jour", "", ""]);
  const result = accumulator.result({ id: "abc", model: "qwen3-14b", content: "Bonjour" });
  assert.equal(result.choices[0].message.content, "Bonjour");
  assert.equal(result.choices[0].finish_reason, "stop");
  assert.equal(result.choices[0].message.tool_calls, undefined);
  assert.deepEqual(result.usage, { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 });
  assert.equal(result.model, "qwen3-14b");
});

test("tool calls split across chunks are put back together, in order", () => {
  const accumulator = createCompletionAccumulator();
  accumulator.push({ choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", function: { name: "get_weather", arguments: '{"city":' } }] } }] });
  accumulator.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "get_local_time", arguments: "{}" } }] } }] });
  accumulator.push({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '"Paris"}' } }] } }] });

  const { choices } = accumulator.result({ id: "abc", model: "m", content: "" });
  assert.equal(choices[0].finish_reason, "tool_calls");
  assert.deepEqual(choices[0].message.tool_calls, [
    { id: "call_abc_0", type: "function", function: { name: "get_local_time", arguments: "{}" } },
    { id: "call_b", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
  ]);
});

test("SSE payloads survive any chunk boundary", () => {
  const seen: string[] = [];
  const parser = createSseDataParser((payload) => seen.push(payload));
  parser.push('data: {"a"');
  parser.push(':1}\r\n\r\n: keep-alive\ndata:{"b":2}\n\nda');
  parser.push("ta: [DONE]\n\ndata: tail");
  parser.flush();
  assert.deepEqual(seen, ['{"a":1}', '{"b":2}', "tail"]);
});

test("text is relayed one request at a time, and what piles up meanwhile leaves together", async () => {
  const sent: string[] = [];
  const release: Array<() => void> = [];
  const relay = createDeltaRelay(
    (text) => {
      sent.push(text);
      return new Promise<void>((resolve) => release.push(resolve)); // a slow backend
    },
    { minIntervalMs: 0 },
  );
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  relay.push("Bon");
  await tick();
  assert.deepEqual(sent, ["Bon"], "the first piece leaves at once");

  relay.push("jour");
  relay.push(" à");
  relay.push(" tous");
  await tick();
  assert.deepEqual(sent, ["Bon"], "nothing is sent while a request is in flight");

  release.shift()!();
  await tick();
  assert.deepEqual(sent, ["Bon", "jour à tous"], "what piled up leaves as one piece");

  relay.push(".");
  const drained = relay.drain();
  release.shift()!();
  await tick();
  release.shift()!();
  await drained;
  assert.equal(sent.join(""), "Bonjour à tous.");
});

test("a piece that cannot be delivered does not stop the ones after it", async () => {
  const sent: string[] = [];
  const relay = createDeltaRelay(
    async (text) => {
      sent.push(text);
      if (text === "a") throw new Error("network");
    },
    { minIntervalMs: 0 },
  );
  relay.push("a");
  await relay.drain();
  relay.push("b");
  await relay.drain();
  assert.deepEqual(sent, ["a", "b"]);
});

test("a fast model on a fast link is still held to a request rate", async () => {
  let clock = 1_000;
  const waits: number[] = [];
  const sent: string[] = [];
  const relay = createDeltaRelay(async (text) => void sent.push(text), {
    minIntervalMs: 40,
    now: () => clock,
    wait: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
  });
  relay.push("a");
  await relay.drain();
  clock += 10;
  relay.push("b");
  await relay.drain();
  assert.deepEqual(sent, ["a", "b"]);
  assert.deepEqual(waits, [30], "the second request waited out the rest of the interval");
});

test("header values are ASCII whatever the computer is called", () => {
  assert.equal(asciiHeaderValue("Jimmy’s MacBook Pro"), "Jimmy's MacBook Pro");
  assert.equal(asciiHeaderValue("Mac de Rémi — bureau"), "Mac de Remi bureau");
  assert.equal(asciiHeaderValue("笔记本"), "");

  const header = heartbeatHeader({ loadedModel: "org/modèle", tokensPerSecond: 14.26, downloadedModels: ["a", "b"] });
  assert.match(header, /^[\x20-\x7e]+$/);
  const parsed = JSON.parse(header);
  assert.equal(parsed.loaded_model, "org/modèle");
  assert.equal(parsed.tok_per_sec_recent, 14.3);
  assert.deepEqual(parsed.downloaded_models, ["a", "b"]);
  assert.ok(parsed.ram_total_gb > 0);
  assert.equal("ram_used_gb" in parsed, false, "nothing that was not measured");
});

test("placeholders and non-chat models are recognised", () => {
  for (const value of ["", " ", "local", "AUTO", undefined, null]) assert.equal(isPlaceholderModel(value), true, String(value));
  assert.equal(isPlaceholderModel("mlx-community/GLM-4-9B-0414-4bit"), false);
  assert.equal(isChatModelId("text-embedding-nomic-embed-text-v1.5"), false);
  assert.equal(isChatModelId("mlx-community/whisper-large-v3-turbo"), false);
  assert.equal(isChatModelId("mlx-community/GLM-OCR-4bit"), false);
  assert.equal(isChatModelId("allenai/olmOCR-7B-0225-preview"), false);
  assert.equal(isChatModelId("qwen3:14b"), true);
  assert.equal(isChatModelId("glm-4.5-air"), true);
});

// ─── Against fake runtimes ──────────────────────────────────────────────────

interface FakeRuntime {
  url: string;
  requests: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

async function fakeRuntime(models: string[], reply: (body: Record<string, unknown>) => { status?: number; sse?: object[]; json?: object }): Promise<FakeRuntime> {
  const requests: Array<Record<string, unknown>> = [];
  const server: Server = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
    }
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push(body);
      const answer = reply(body);
      if (answer.status && answer.status >= 400) {
        res.statusCode = answer.status;
        return res.end("unsupported field");
      }
      if (answer.json) {
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify(answer.json));
      }
      res.setHeader("Content-Type", "text/event-stream");
      for (const event of answer.sse ?? []) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

const words = (...parts: string[]) => [
  ...parts.map((content) => ({ choices: [{ delta: { content } }] })),
  { choices: [{ delta: {}, finish_reason: "stop" }] },
  { choices: [], usage: { prompt_tokens: 5, completion_tokens: parts.length } },
];

test("a model is sent to the runtime that holds it; a placeholder becomes the default", async () => {
  const mlx = await fakeRuntime(["mlx-community/Qwen3-14B-4bit"], () => ({ sse: words("mlx") }));
  const ollama = await fakeRuntime(["glm4:9b", "nomic-embed-text"], () => ({ sse: words("ollama") }));
  try {
    configureLocalModels({ endpoints: [mlx.url, ollama.url], defaultModel: "glm4:9b" });
    assert.deepEqual(await resolveTarget("glm4:9b"), { endpoint: ollama.url, model: "glm4:9b" });
    assert.deepEqual(await resolveTarget("mlx-community/Qwen3-14B-4bit"), { endpoint: mlx.url, model: "mlx-community/Qwen3-14B-4bit" });
    assert.deepEqual(await resolveTarget("local"), { endpoint: ollama.url, model: "glm4:9b" });
    // Not installed anywhere: refused, rather than letting a runtime
    // download whatever repository the backend named.
    await assert.rejects(resolveTarget("org/unknown"), /model_not_installed: org\/unknown/);

    configureLocalModels({ defaultModel: null });
    assert.deepEqual(await resolveTarget("auto"), { endpoint: mlx.url, model: "mlx-community/Qwen3-14B-4bit" });
    // A default that is no longer installed gives way to what is.
    configureLocalModels({ defaultModel: "org/removed" });
    assert.deepEqual(await resolveTarget("local"), { endpoint: mlx.url, model: "mlx-community/Qwen3-14B-4bit" });
  } finally {
    await mlx.close();
    await ollama.close();
  }
});

test("a runtime without a model list is sent the request as asked", async () => {
  const silent = await fakeRuntime([], () => ({ sse: words("ok") }));
  try {
    configureLocalModels({ endpoints: [silent.url], defaultModel: null });
    assert.deepEqual(await resolveTarget("org/any"), { endpoint: silent.url, model: "org/any" });
    assert.deepEqual(await resolveTarget("local"), { endpoint: silent.url, model: "local" });
  } finally {
    await silent.close();
  }
});

test("llm_infer streams, hides reasoning, and returns the backend's envelope", async () => {
  const runtime = await fakeRuntime(["deepseek-r1"], () => ({ sse: words("<think>", "let me see", "</think>", "\n\n", "Quatre", ".") }));
  try {
    configureLocalModels({ endpoints: [runtime.url], defaultModel: "deepseek-r1" });
    const deltas: string[] = [];
    let stats: { model: string; completionTokens: number } | null = null;
    const result = await runLlmInfer(
      { openai_body_json: JSON.stringify({ model: "local", messages: [{ role: "user", content: "2+2 ?" }], max_tokens: 512, chat_template_kwargs: { enable_thinking: false } }) },
      { onDelta: (text) => deltas.push(text), onStats: (value) => (stats = value) },
    );

    assert.equal(deltas.join(""), "Quatre.");
    assert.equal(result.model_used, "deepseek-r1");
    assert.ok(result.latency_ms >= 0);
    const completion = JSON.parse(result.response_json);
    assert.equal(completion.choices[0].message.content, "Quatre.");
    assert.equal(completion.usage.completion_tokens, 6);
    assert.equal(stats!.model, "deepseek-r1");

    const sent = runtime.requests[0];
    assert.equal(sent.model, "deepseek-r1", "the placeholder was replaced");
    assert.equal(sent.stream, true);
    assert.equal(sent.max_tokens, 512, "the backend's limits are kept");
  } finally {
    await runtime.close();
  }
});

test("a runtime that refuses the extensions is asked again without them", async () => {
  const runtime = await fakeRuntime(["strict"], (body) => ("chat_template_kwargs" in body ? { status: 400 } : { sse: words("ok") }));
  try {
    configureLocalModels({ endpoints: [runtime.url], defaultModel: "strict" });
    const result = await runLlmInfer({ openai_body_json: JSON.stringify({ model: "strict", messages: [], chat_template_kwargs: { enable_thinking: false } }) });
    assert.equal(JSON.parse(result.response_json).choices[0].message.content, "ok");
    assert.equal(runtime.requests.length, 2);
    assert.equal("stream_options" in runtime.requests[1], false);
  } finally {
    await runtime.close();
  }
});

test("a runtime that answers without streaming is understood too", async () => {
  const runtime = await fakeRuntime(["plain"], () => ({
    json: { choices: [{ message: { content: "Réponse entière." }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 4 } },
  }));
  try {
    configureLocalModels({ endpoints: [runtime.url], defaultModel: "plain" });
    const deltas: string[] = [];
    const result = await runLlmInfer({ openai_body_json: JSON.stringify({ model: "plain", messages: [] }) }, { onDelta: (text) => deltas.push(text) });
    assert.deepEqual(deltas, ["Réponse entière."]);
    assert.equal(JSON.parse(result.response_json).usage.total_tokens, 7);
  } finally {
    await runtime.close();
  }
});

test("a runtime error is reported with its status", async () => {
  const runtime = await fakeRuntime(["m"], () => ({ status: 500 }));
  try {
    configureLocalModels({ endpoints: [runtime.url], defaultModel: "m" });
    await assert.rejects(runLlmInfer({ openai_body_json: JSON.stringify({ model: "m", messages: [] }) }), /local_llm_status_500/);
    await assert.rejects(runLlmInfer({ openai_body_json: "{not json" }), /openai_body_json_invalid_json/);
  } finally {
    await runtime.close();
  }
});

// ─── The worker against a fake backend ──────────────────────────────────────

test("the worker relays a completion to the backend: heartbeat, ordered deltas, envelope", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { startBridgeClient } = await import("../src/bridgeClient.js");

  // Slow enough that the worker has time to poll again while it runs.
  const runtime = await fakeRuntime(["mlx-community/Qwen3-14B-4bit", "glm4:9b"], () => ({
    sse: words("Le ", "préavis ", "est ", "de ", "six ", "mois, ", "selon ", "l'article ", "9 ", "du ", "contrat."),
  }));

  const polls: Array<Record<string, string | undefined>> = [];
  const patches: Array<{ status: string; delta?: string; result?: Record<string, unknown>; error_message?: string }> = [];
  let handedOut = false;
  let pollsAfterClaim = 0;
  let finished: () => void;
  const done = new Promise<void>((resolve) => (finished = resolve));

  const backend = createServer((req, res) => {
    // Like the managed backend: the session is bound to a device, so the
    // token alone is refused — on polls and on reports alike.
    if (req.headers["x-device-token"] !== "device-xyz") {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: "Device token required." }));
    }
    if (req.method === "GET" && req.url?.startsWith("/bridge/tasks/next")) {
      polls.push({
        wait: new URL(req.url!, "http://x").searchParams.get("wait") ?? undefined,
        token: req.headers["x-user-token"] as string,
        device: req.headers["x-bridge-device-id"] as string,
        nickname: req.headers["x-bridge-device-nickname"] as string,
        os: req.headers["x-bridge-device-os"] as string,
        capabilities: req.headers["x-bridge-capabilities"] as string,
        heartbeat: req.headers["x-bridge-heartbeat"] as string,
      });
      if (!handedOut) {
        handedOut = true;
        res.setHeader("Content-Type", "application/json");
        return res.end(
          JSON.stringify({
            id: "task-1",
            kind: "llm_infer",
            args: { openai_body_json: JSON.stringify({ model: "glm4:9b", messages: [{ role: "user", content: "Quel préavis ?" }], max_tokens: 512 }) },
          }),
        );
      }
      pollsAfterClaim += 1;
      // A real long poll: it answers when the wait the client asked for
      // runs out (scaled down: 1 s of wait = 20 ms here).
      const wait = Number(new URL(req.url!, "http://x").searchParams.get("wait"));
      return setTimeout(() => {
        res.statusCode = 204;
        res.end();
      }, wait * 20);
    }
    if (req.method === "PATCH" && req.url === "/bridge/tasks/task-1") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      return req.on("end", () => {
        const body = JSON.parse(raw);
        patches.push(body);
        res.statusCode = 204;
        res.end();
        if (body.status === "done" || body.status === "error") finished();
      });
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const backendUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;

  const dir = mkdtempSync(join(tmpdir(), "twoody-bridge-"));
  const states: string[] = [];
  configureLocalModels({ endpoints: [runtime.url], defaultModel: "mlx-community/Qwen3-14B-4bit" });
  const client = startBridgeClient({
    backendUrl,
    userToken: "token-abc",
    deviceToken: "device-xyz",
    homeAssistantUrl: "",
    homeAssistantToken: "",
    deviceNickname: "Jimmy’s MacBook Pro",
    deviceIdPath: join(dir, "device-id"),
    capabilities: ["local-llm-provider"],
    onState: (state) => states.push(state),
  });

  try {
    await done;

    assert.equal(polls[0].wait, "1", "the first poll is a short probe, so the worker knows at once where it stands");
    assert.equal(polls[0].token, "token-abc");
    assert.equal(polls[0].device, client.deviceId);
    assert.equal(polls[0].nickname, "Jimmy's MacBook Pro");
    // What it runs, which the account's device list shows (a Pi was a "Mac").
    assert.equal(polls[0].os, { darwin: "macOS", linux: "Linux", win32: "Windows" }[process.platform as string] ?? process.platform);
    assert.equal(polls[0].capabilities, "local-llm-provider");
    const heartbeat = JSON.parse(polls[0].heartbeat!);
    assert.deepEqual(heartbeat.downloaded_models, ["mlx-community/Qwen3-14B-4bit", "glm4:9b"]);
    assert.equal(heartbeat.loaded_model, "mlx-community/Qwen3-14B-4bit");
    assert.deepEqual(states, ["online"]);

    const last = patches[patches.length - 1];
    assert.equal(last.status, "done");
    const streamed = patches.slice(0, -1);
    assert.ok(streamed.length >= 2, "the text arrives in several pieces");
    assert.ok(streamed.every((patch) => patch.status === "streaming"));
    const expected = "Le préavis est de six mois, selon l'article 9 du contrat.";
    assert.equal(streamed.map((patch) => patch.delta).join(""), expected, "in order, nothing lost");

    assert.equal(last.result!.model_used, "glm4:9b");
    assert.equal(typeof last.result!.latency_ms, "number");
    const completion = JSON.parse(last.result!.response_json as string);
    assert.equal(completion.choices[0].message.content, expected);
    assert.equal(completion.usage.completion_tokens, 11);
    assert.equal(runtime.requests[0].model, "glm4:9b", "the model the user picked is the one that ran");

    // The worker kept polling while the model wrote, and the poll that
    // follows the completion names the model that just ran.
    assert.ok(pollsAfterClaim >= 1, "the worker kept polling");
    const seen = polls.length;
    for (let i = 0; i < 100 && polls.length === seen; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(polls[polls.length - 1].wait, "25", "then it settles into long polls");
    assert.equal(JSON.parse(polls[polls.length - 1].heartbeat!).loaded_model, "glm4:9b");
  } finally {
    client.stop();
    const closed = new Promise<void>((resolve) => backend.close(() => resolve()));
    backend.closeAllConnections(); // the worker's pending long poll
    await closed;
    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a session bound to a device is refused without its device token, and the worker says so", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { startBridgeClient } = await import("../src/bridgeClient.js");

  let polls = 0;
  const backend = createServer((req, res) => {
    polls += 1;
    res.statusCode = req.headers["x-device-token"] ? 204 : 401;
    res.end(req.headers["x-device-token"] ? "" : JSON.stringify({ error: "Device token required." }));
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const backendUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
  const dir = mkdtempSync(join(tmpdir(), "twoody-bridge-"));

  const state = new Promise<string>((resolve) => {
    const client = startBridgeClient({
      backendUrl,
      userToken: "token-abc",
      homeAssistantUrl: "",
      homeAssistantToken: "",
      deviceIdPath: join(dir, "device-id"),
      capabilities: [],
      onState: (value) => {
        client.stop();
        resolve(value);
      },
    });
  });

  try {
    assert.equal(await state, "auth_failed");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(polls, 1, "a refused token is not retried every second");
  } finally {
    const closed = new Promise<void>((resolve) => backend.close(() => resolve()));
    backend.closeAllConnections();
    await closed;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a completion may run as long as the backend waits for it, less ten seconds", () => {
  assert.equal(inferenceTimeoutMs(512), 170_000);
  assert.equal(inferenceTimeoutMs(undefined), 170_000);
  assert.equal(inferenceTimeoutMs(2048), (60 + Math.ceil(2048 / 7) - 10) * 1000);
  assert.equal(inferenceTimeoutMs(1_000_000), 15 * 60 * 1000);
});
