import assert from "node:assert/strict";
import test from "node:test";
import type { ComputerStatus } from "../src/account/status.js";
import { estimate, priorTps, rank, type ComputerView, type RouteAsk } from "../src/router/score.js";

// The router's choice, table-driven (docs/multi-computer-design.md §3).

function status(over: Partial<ComputerStatus> & { models?: ComputerStatus["models"] } = {}): ComputerStatus {
  return {
    app_version: "0.3.0",
    models: [{ id: "qwen3:8b", loaded: true }],
    load: { cpu_pct: 10, gpu_pct: null, ram_used_pct: 40, at: null },
    tps: {},
    inflight: 0,
    accepts: ["chat", "background"],
    tools: true,
    ...over,
  };
}

function view(id: string, over: Partial<ComputerView> = {}, s: Partial<ComputerStatus> = {}): ComputerView {
  return { id, name: id, self: id === "mac", platform: id === "mac" ? "macos-arm64" : "linux", kind: id === "mac" ? "desktop" : "server", status: status(s), statusAgeMs: 1_000, loads: [], ...over };
}

const ask = (over: Partial<RouteAsk> = {}): RouteAsk => ({ model: "qwen3:8b", tools: false, purpose: "chat", tokens: 300, ...over });
const order = (views: ComputerView[], a: RouteAsk) => rank(views, a).map((c) => `${c.computerId}:${c.model}`);

test("table: who is a candidate, and in which order", () => {
  const rows: Array<[string, ComputerView[], RouteAsk, string[]]> = [
    ["the faster computer first", [view("mac", {}, { tps: { "qwen3:8b": 10 } }), view("pi", {}, { tps: { "qwen3:8b": 40 } })], ask(), ["pi:qwen3:8b", "mac:qwen3:8b"]],
    ["this computer wins within 20 %", [view("mac", {}, { tps: { "qwen3:8b": 25 } }), view("pi", {}, { tps: { "qwen3:8b": 29 } })], ask(), ["mac:qwen3:8b", "pi:qwen3:8b"]],
    ["exact model only", [view("mac", {}, { models: [{ id: "llama3:8b", loaded: true }] }), view("pi")], ask(), ["pi:qwen3:8b"]],
    ["a stale status is out", [view("mac"), view("pi", { statusAgeMs: 61_000 }, { tps: { "qwen3:8b": 500 } })], ask(), ["mac:qwen3:8b"]],
    ["at its limit is out", [view("mac"), view("pi", {}, { inflight: 2, tps: { "qwen3:8b": 500 } })], ask(), ["mac:qwen3:8b"]],
    ["memory full and the model not loaded is out", [view("mac"), view("pi", {}, { models: [{ id: "qwen3:8b", loaded: false }], load: { cpu_pct: 5, gpu_pct: null, ram_used_pct: 95, at: null } })], ask(), ["mac:qwen3:8b"]],
    ["memory full but loaded stays", [view("mac", {}, { tps: { "qwen3:8b": 5 } }), view("pi", {}, { tps: { "qwen3:8b": 50 }, load: { cpu_pct: 5, gpu_pct: null, ram_used_pct: 95, at: null } })], ask(), ["pi:qwen3:8b", "mac:qwen3:8b"]],
    ["tools need tools", [view("mac"), view("pi", {}, { tools: false, tps: { "qwen3:8b": 500 } })], ask({ tools: true }), ["mac:qwen3:8b"]],
    ["a peer that takes no background work is out of it", [view("mac"), view("pi", {}, { accepts: ["chat"], tps: { "qwen3:8b": 500 } })], ask({ purpose: "background" }), ["mac:qwen3:8b"]],
    ["automatic: each with its loaded model", [view("mac", { defaultModel: "qwen3:8b" }, { models: [{ id: "qwen3:8b", loaded: false }, { id: "gemma3:4b", loaded: true }] }), view("pi", {}, { models: [{ id: "qwen3:1.7b", loaded: true }], tps: { "qwen3:1.7b": 60 } })], ask({ model: null }), ["pi:qwen3:1.7b", "mac:gemma3:4b"]],
    ["automatic: the default model when nothing is loaded", [view("mac", { defaultModel: "qwen3:14b" }, { models: [{ id: "qwen3:8b", loaded: false }, { id: "qwen3:14b", loaded: false }] })], ask({ model: null }), ["mac:qwen3:14b"]],
    ["no one holds it", [view("mac"), view("pi")], ask({ model: "mistral" }), []],
  ];
  for (const [name, views, a, expected] of rows) assert.deepEqual(order(views, a), expected, name);
});

test("table: the estimate", () => {
  const pi = view("pi");
  const rows: Array<[string, ComputerView, { id: string; loaded: boolean }, number]> = [
    ["unmeasured Linux server: 10 tok/s", pi, { id: "qwen3:8b", loaded: true }, 30],
    ["unmeasured Mac: 30 tok/s", view("mac"), { id: "qwen3:8b", loaded: true }, 10],
    ["measured", view("pi", {}, { tps: { "qwen3:8b": 20 } }), { id: "qwen3:8b", loaded: true }, 15],
    ["not loaded: +10 s", view("pi", {}, { tps: { "qwen3:8b": 20 } }), { id: "qwen3:8b", loaded: false }, 25],
    ["one running: +15 s", view("pi", {}, { tps: { "qwen3:8b": 20 }, inflight: 1 }), { id: "qwen3:8b", loaded: true }, 30],
    ["hot twice: ×1.5", view("pi", { loads: [{ cpu_pct: 90, gpu_pct: null }, { cpu_pct: 20, gpu_pct: 95 }] }, { tps: { "qwen3:8b": 20 } }), { id: "qwen3:8b", loaded: true }, 22.5],
    ["hot once is not hot", view("pi", { loads: [{ cpu_pct: 20, gpu_pct: null }, { cpu_pct: 95, gpu_pct: null }] }, { tps: { "qwen3:8b": 20 } }), { id: "qwen3:8b", loaded: true }, 15],
  ];
  for (const [name, v, model, expected] of rows) assert.equal(estimate(v, model, 300), expected, name);
  assert.equal(priorTps({ platform: "linux-arm64", kind: null, self: true }), 10);
  assert.equal(priorTps({ platform: "linux-x64", kind: null, self: true }), 30);
  assert.equal(priorTps({ platform: "linux", kind: "server", self: false }), 10);
});

test("stickiness: the previous computer keeps the conversation unless another is 30 % better", () => {
  const mac = view("mac", {}, { tps: { "qwen3:8b": 20 } }); // 15 s
  const slightly = view("pi", {}, { tps: { "qwen3:8b": 26 } }); // 11.5 s: 23 % better
  const much = view("pi", {}, { tps: { "qwen3:8b": 40 } }); // 7.5 s: 50 % better
  assert.equal(rank([mac, slightly], ask({ previous: "mac" }))[0]!.computerId, "mac");
  assert.equal(rank([mac, much], ask({ previous: "mac" }))[0]!.computerId, "pi");
  // Sticky to a peer too, even against this computer's 20 % margin.
  const piSlow = view("pi", {}, { tps: { "qwen3:8b": 18 } }); // 16.7 s
  assert.equal(rank([mac, piSlow], ask({ previous: "pi" }))[0]!.computerId, "pi");
  assert.equal(rank([mac, piSlow], ask({ previous: null }))[0]!.computerId, "mac");
  // A previous computer that is no longer a candidate does not hold on.
  assert.equal(rank([mac, view("pi", { statusAgeMs: 90_000 })], ask({ previous: "pi" }))[0]!.computerId, "mac");
});
