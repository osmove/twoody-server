import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bareCompletion, createComputeHost } from "../src/compute/computeHost.js";
import {
  createComputeIdentity, openComputeResponse, publicIdentity, sealComputeRequest,
} from "../src/compute/computeSeal.js";

// Claire's device seals a question for this computer; the host opens it,
// runs the model (a stand-in here) without tools and seals the answer in
// pieces; Claire's device reads them. The account in between only ever
// carries the blocks and lines below.

const NOW = 1_790_600_000_000;

function setup() {
  let clock = NOW;
  const path = join(mkdtempSync(join(tmpdir(), "twoody-compute-")), "compute-keys.json");
  const host = createComputeHost({ path, now: () => clock });
  host.rotate();
  const keys = host.publicKeys();
  const guest = createComputeIdentity();
  const hostPublic = { encPublic: keys.identity.enc_public, signPublic: keys.identity.sign_public };
  const ask = (requestId: string, body: unknown = { model: "qwen3-14b", messages: [{ role: "user", content: "Bonjour" }] }) =>
    sealComputeRequest({ guest, host: hostPublic, prekey: keys.prekeys[0]!, grantId: "5", requestId, now: clock, body });
  const args = (request: unknown) => ({
    principal: { kind: "shared", grant_id: 5 },
    sealed_request: request,
    guest_key: { enc_public: publicIdentity(guest).encPublic, sign_public: publicIdentity(guest).signPublic },
  });
  return { host, path, keys, guest, ask, args, tick: (ms: number) => (clock += ms) };
}

async function run(host: ReturnType<typeof createComputeHost>, args: unknown, answer = ["Bon", "jour"], seen: { body?: Record<string, unknown> } = {}) {
  const lines: string[] = [];
  await host.runSealedTurn({
    args: args as never,
    minIntervalMs: 0,
    send: async (line) => {
      lines.push(line);
    },
    runModel: async (body, onPiece) => {
      seen.body = body;
      for (const piece of answer) onPiece(piece);
      return { model: "qwen3-14b" };
    },
  });
  return lines;
}

test("a sealed question is answered sealed, and the relay carries nothing readable", async () => {
  const { host, ask, args } = setup();
  const { request, turn } = ask("r-1");
  const seen: { body?: Record<string, unknown> } = {};
  const lines = await run(host, args(request), ["Bon", "jour Claire"], seen);
  assert.deepEqual(seen.body?.messages, [{ role: "user", content: "Bonjour" }]);

  const parsed = lines.map((line) => JSON.parse(line));
  assert.ok(lines.every((line) => line.endsWith("\n")), "one JSON line each");
  const reader = openComputeResponse(turn, parsed[0].h);
  const text = parsed.slice(1).map((line) => reader.open(line.c).text).join("");
  assert.equal(text, "Bonjour Claire");
  assert.equal(reader.done, true);
  const relayed = JSON.stringify(request) + lines.join("");
  for (const clear of ["Bonjour", "Claire", "qwen3"]) assert.ok(!relayed.includes(clear), clear);
});

test("the same request relayed twice is answered once", async () => {
  const { host, ask, args } = setup();
  const { request } = ask("r-1");
  await run(host, args(request));
  await assert.rejects(run(host, args(request)), /replay/);
});

test("the guest's device is pinned per grant the first time, and kept", async () => {
  const { host, ask, args, guest } = setup();
  await run(host, args(ask("r-1").request));
  await run(host, args(ask("r-2").request));
  const pins = host.pins()["5"];
  assert.equal(pins?.length, 1);
  assert.equal(pins?.[0]?.enc_public, publicIdentity(guest).encPublic);
});

test("a question signed by another device than the one it names is refused", async () => {
  const { host, ask, args } = setup();
  const { request } = ask("r-1");
  const stranger = publicIdentity(createComputeIdentity());
  await assert.rejects(run(host, { ...args(request), guest_key: { enc_public: stranger.encPublic, sign_public: stranger.signPublic } }), /guest|signature/);
});

test("the keys stay in a file only this user reads; the prekey changes daily and its secrets go after 48 h", () => {
  const { host, path, keys, tick } = setup();
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const stored = readFileSync(path, "utf8");
  assert.ok(stored.includes(keys.prekeys[0]!.id));
  assert.equal(host.rotate(), false, "nothing to do the same day");
  tick(25 * 3600 * 1000);
  assert.equal(host.rotate(), true, "a new prekey the next day");
  assert.equal(host.publicKeys().prekeys.length, 2);
  tick(24 * 3600 * 1000);
  host.rotate();
  assert.ok(!host.publicKeys().prekeys.some((prekey) => prekey.id === keys.prekeys[0]!.id), "the first one is gone after 48 h");
  assert.ok(!readFileSync(path, "utf8").includes(keys.prekeys[0]!.id), "and so are its secrets");
});

test("the model gets text messages and a bound, never tools", () => {
  const body = bareCompletion({
    model: "qwen3-14b",
    tools: [{ type: "function" }],
    tool_choice: "auto",
    max_tokens: 1_000_000,
    messages: [{ role: "system", content: "s" }, { role: "tool", content: "x" }, { role: "user", content: "q", name: "n" }, { role: "user", content: 3 }],
  });
  assert.deepEqual(body, {
    model: "qwen3-14b",
    messages: [{ role: "system", content: "s" }, { role: "user", content: "q" }],
    max_tokens: 4096,
    temperature: 0.2,
    chat_template_kwargs: { enable_thinking: false },
    reasoning_effort: "none",
  });
  assert.throws(() => bareCompletion({ messages: [] }), /malformed/);
});

test("no reasoning before the answer, whatever the guest's body asks (18/10/2026: 33 s of it before the first word)", () => {
  const body = bareCompletion({
    messages: [{ role: "user", content: "q" }],
    chat_template_kwargs: { enable_thinking: true },
    reasoning_effort: "high",
    thinking_budget_tokens: 50_000,
  });
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(body.reasoning_effort, "none");
  assert.equal("thinking_budget_tokens" in body, false);
});

test("a warm is answered at once and empty, the same with or without a read; what it asks goes to `warm`, bounded, never to the model's turn", async () => {
  const { host, ask, args } = setup();
  const body = { warm: true, model: "qwen3-14b", max_tokens: 9_999, tools: [{ type: "function" }], messages: [{ role: "system", content: "s" }, { role: "user", content: "Bonjour" }, { role: "assistant", content: "Salut" }, { role: "user", content: "" }] };
  const answers: Array<{ text: string; lines: number; extra: unknown[] }> = [];
  const asked: Array<{ body: Record<string, unknown>; grant: string }> = [];
  for (const [index, withWarm] of [true, false].entries()) {
    const { request, turn } = ask(`w-${index}`, body);
    const lines: string[] = [];
    let modelRan = false;
    await host.runSealedTurn({
      args: args(request) as never,
      minIntervalMs: 0,
      send: async (line) => void lines.push(line),
      runModel: async () => {
        modelRan = true;
        return {};
      },
      ...(withWarm ? { warm: (warmBody: Record<string, unknown>, grant: string) => void asked.push({ body: warmBody, grant }) } : {}),
    });
    assert.equal(modelRan, false, "a warm never runs as a question");
    const parsed = lines.map((line) => JSON.parse(line));
    const reader = openComputeResponse(turn, parsed[0].h);
    const pieces = parsed.slice(1).map((line) => reader.open(line.c));
    assert.equal(reader.done, true);
    answers.push({ text: pieces.map((piece) => piece.text).join(""), lines: lines.length, extra: pieces.map((piece) => piece.extra) });
  }
  assert.deepEqual(answers[0], answers[1], "the guest cannot tell");
  assert.deepEqual(answers[0], { text: "", lines: 2, extra: [{}] });
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.grant, "5");
  assert.deepEqual(asked[0]!.body, {
    model: "qwen3-14b",
    messages: body.messages,
    max_tokens: 1,
    temperature: 0,
    chat_template_kwargs: { enable_thinking: false },
    reasoning_effort: "none",
  });
});

test("a malformed warm is refused before anything is answered, as a question is", async () => {
  const { host, ask, args } = setup();
  const { request } = ask("w-bad", { warm: true, messages: [] });
  const lines: string[] = [];
  let warmed = false;
  await assert.rejects(host.runSealedTurn({ args: args(request) as never, minIntervalMs: 0, send: async (line) => void lines.push(line), runModel: async () => ({}), warm: () => void (warmed = true) }), /malformed/);
  assert.deepEqual(lines, []);
  assert.equal(warmed, false);
});
