import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, renameSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, basename } from "node:path";
import Fastify from "fastify";
import type { RemoteCodeBridge, RemoteCodeSignal } from "../src/remoteCodeBridge.js";

const dir = mkdtempSync(join(tmpdir(), "twoody-remote-code-"));
process.env.TWOODY_DATA_DIR = dir;
const { sqlite } = await import("../src/db.js");
const { createAuthSession } = await import("../src/auth.js");
const { remoteCodeRoutes } = await import("../src/routes/remoteCode.js");
const { remoteCodeBridgeOver } = await import("../src/remoteCodeBridge.js");

sqlite.prepare("INSERT INTO users(id,email,created_at) VALUES(?,?,?)").run("owner", "test@invalid.test", Date.now());
const phone = createAuthSession("owner", "pair:iPhone");
const ordinary = createAuthSession("owner");
const headers = { authorization: `Bearer ${phone.token}` };
const ID = "11111111-2222-4333-8444-555555555555";

// The Desktop, faked: answers commands, and lets the test emit Code's events.
const calls: Array<{ command: string; input: Record<string, unknown> }> = [];
const listeners = new Set<(signal: RemoteCodeSignal) => void>();
let off = false;
let afterSnapshot: (() => void) | null = null;
const fake: RemoteCodeBridge = {
  async ask(command, input) {
    calls.push({ command, input });
    if (off && command !== "list") throw new Error("remote_code_off");
    if (command === "list") return off ? { enabled: false, workspaces: [], sessions: [] } : { enabled: true, workspaces: [{ path: "/work/app", name: "app" }], sessions: [] };
    if (command === "session") {
      if (input.sessionId !== ID) throw new Error("session_unavailable");
      const hook = afterSnapshot;
      if (hook) setTimeout(hook, 5);
      return { seq: 5, session: { id: ID, title: "Fix", workspace: "/work/app", items: [], running: true }, pending: [{ callId: "c1", name: "run_command", kind: "exec", summary: "npm test" }], output: {} };
    }
    if (command === "send") return { id: ID };
    if (command === "approve") {
      if (input.callId !== "c1") throw new Error("approval_unavailable");
      return { decided: true };
    }
    return { stopped: true };
  },
  follow(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
const emit = (signal: RemoteCodeSignal) => { for (const listener of [...listeners]) listener(signal); };

const app = Fastify();
await app.register(remoteCodeRoutes, { bridge: () => fake, streamMs: 60 });
const lone = Fastify();
await lone.register(remoteCodeRoutes, { bridge: () => null });
after(async () => {
  await app.close();
  await lone.close();
  sqlite.close();
  mkdirSync(join(homedir(), ".Trash"), { recursive: true });
  renameSync(dir, join(homedir(), ".Trash", basename(dir)));
});

test("only a paired phone reaches Code, and only with the Desktop there", async () => {
  assert.equal((await app.inject({ url: "/code/sessions" })).statusCode, 401);
  const refused = await app.inject({ url: "/code/sessions", headers: { authorization: `Bearer ${ordinary.token}` } });
  assert.equal(refused.statusCode, 403);
  assert.deepEqual(refused.json(), { error: "not_paired_phone" });
  const alone = await lone.inject({ url: "/code/sessions", headers });
  assert.equal(alone.statusCode, 503);
  assert.deepEqual(alone.json(), { error: "desktop_unavailable" });
  assert.equal(calls.length, 0);
  const listed = await app.inject({ url: "/code/sessions", headers });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().enabled, true);
});

test("commands carry the phone's input and map the Desktop's refusals", async () => {
  calls.length = 0;
  const started = await app.inject({ method: "POST", url: "/code/sessions", headers, payload: { workspace: "/work/app", text: "fix it", mode: "plan", request_id: "request-123456789" } });
  assert.equal(started.statusCode, 201);
  assert.deepEqual(started.json(), { id: ID });
  assert.deepEqual(calls[0], { command: "send", input: { workspace: "/work/app", text: "fix it", mode: "plan", requestId: "request-123456789" } });
  assert.equal((await app.inject({ method: "POST", url: `/code/sessions/${ID}/messages`, headers, payload: { text: "go on" } })).statusCode, 202);
  assert.equal((await app.inject({ method: "POST", url: `/code/sessions/${ID}/messages`, headers, payload: { text: "go", mode: "full-access" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: `/code/sessions/${ID}/approvals/c1`, headers, payload: { decision: "allow-session" } })).statusCode, 400);
  const decided = await app.inject({ method: "POST", url: `/code/sessions/${ID}/approvals/c1`, headers, payload: { decision: "deny", reason: "not now" } });
  assert.equal(decided.statusCode, 200);
  assert.deepEqual(calls.at(-1), { command: "approve", input: { sessionId: ID, callId: "c1", decision: "deny", reason: "not now" } });
  const gone = await app.inject({ method: "POST", url: `/code/sessions/${ID}/approvals/c2`, headers, payload: { decision: "allow" } });
  assert.equal(gone.statusCode, 404);
  assert.deepEqual(gone.json(), { error: "approval_unavailable" });
  assert.equal((await app.inject({ method: "POST", url: `/code/sessions/${ID}/stop`, headers })).statusCode, 200);
  const snapshot = await app.inject({ url: `/code/sessions/${ID}`, headers });
  assert.equal(snapshot.statusCode, 200);
  assert.equal(snapshot.json().seq, undefined);
  assert.equal(snapshot.json().pending[0].callId, "c1");
  assert.equal((await app.inject({ url: "/code/sessions/99999999-2222-4333-8444-555555555555", headers })).statusCode, 404);
  assert.equal((await app.inject({ url: "/code/sessions/../../etc", headers })).statusCode, 404);
});

test("while off, the list says so and everything else is refused", async () => {
  off = true;
  try {
    const listed = await app.inject({ url: "/code/sessions", headers });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().enabled, false);
    for (const request of [
      { url: `/code/sessions/${ID}` },
      { method: "POST" as const, url: "/code/sessions", payload: { workspace: "/work/app", text: "x" } },
      { method: "POST" as const, url: `/code/sessions/${ID}/stop` },
      { method: "POST" as const, url: `/code/sessions/${ID}/stream` },
    ]) {
      const refused = await app.inject({ ...request, headers });
      assert.equal(refused.statusCode, 403);
      assert.deepEqual(refused.json(), { error: "remote_code_off" });
    }
    assert.equal(listeners.size, 0);
  } finally {
    off = false;
  }
});

test("the stream opens with the snapshot, then this session's newer events, and ends", async () => {
  afterSnapshot = () => {
    emit({ type: "event", seq: 5, event: { sessionId: ID, type: "item", item: { id: "old" } } });
    emit({ type: "event", seq: 6, event: { sessionId: "other", type: "item", item: { id: "elsewhere" } } });
    emit({ type: "event", seq: 7, event: { sessionId: ID, type: "approval", request: { callId: "c2", kind: "edit" } } });
    emit({ type: "event", seq: 8, event: { sessionId: ID, type: "output", itemId: "t1", chunk: "ok\n" } });
  };
  const response = await app.inject({ method: "POST", url: `/code/sessions/${ID}/stream`, headers });
  afterSnapshot = null;
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers["content-type"]), /text\/event-stream/);
  const events = response.body.split("\n\n").filter((block) => block.startsWith("event: ")).map((block) => {
    const [name, data] = block.split("\n");
    return { name: name!.slice("event: ".length), data: JSON.parse(data!.slice("data: ".length)) };
  });
  assert.deepEqual(events.map((event) => event.name), ["snapshot", "approval", "output", "end"]);
  assert.equal(events[0]!.data.session.id, ID);
  assert.equal(events[0]!.data.seq, undefined);
  assert.deepEqual(events[1]!.data, { sessionId: ID, request: { callId: "c2", kind: "edit" } });
  assert.deepEqual(events[3]!.data, { reason: "time" });
  assert.equal(listeners.size, 0);
});

test("turning the switch off on the Mac closes the stream", async () => {
  afterSnapshot = () => emit({ type: "off" });
  const response = await app.inject({ method: "POST", url: `/code/sessions/${ID}/stream`, headers });
  afterSnapshot = null;
  assert.match(response.body, /event: off\ndata: {"error":"remote_code_off"}/);
  assert.doesNotMatch(response.body, /event: end/);
  assert.equal(listeners.size, 0);
});

test("the bridge says when a phone follows, and matches answers to questions", async () => {
  const posted: unknown[] = [];
  let receive: (event: { data: unknown }) => void = () => {};
  const bridge = remoteCodeBridgeOver({ on: (_event, listener) => { receive = listener; }, postMessage: (message) => posted.push(message) }, 50);
  const heard: RemoteCodeSignal[] = [];
  const stop = bridge.follow((signal) => heard.push(signal));
  const stopOther = bridge.follow(() => {});
  assert.deepEqual(posted, [{ type: "remote-code-subscribe", on: true }]);
  receive({ data: { type: "remote-code-event", seq: 3, event: { sessionId: ID, type: "state", running: true } } });
  assert.deepEqual(heard, [{ type: "event", seq: 3, event: { sessionId: ID, type: "state", running: true } }]);
  const answer = bridge.ask("list", {});
  const question = posted[1] as { type: string; id: string; command: string };
  assert.equal(question.type, "remote-code");
  assert.equal(question.command, "list");
  receive({ data: { type: "remote-code-result", id: question.id, result: { enabled: true } } });
  assert.deepEqual(await answer, { enabled: true });
  const refused = bridge.ask("session", { sessionId: ID });
  receive({ data: { type: "remote-code-result", id: (posted[2] as { id: string }).id, error: "remote_code_off" } });
  await assert.rejects(refused, /remote_code_off/);
  await assert.rejects(bridge.ask("list", {}), /desktop_timeout/);
  stop();
  assert.equal(posted.filter((message) => (message as { type: string }).type === "remote-code-subscribe").length, 1);
  stopOther();
  assert.deepEqual(posted.at(-1), { type: "remote-code-subscribe", on: false });
});
