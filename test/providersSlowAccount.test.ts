import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startFakeRuntime } from "./helpers/fakeBackend.js";

// /providers must not wait on a slow account. Its computers come from the
// account (the vault's roster, then `account_computers`), through the
// Desktop when embedded: on 05/10/2026 api.twoody.com answered in 2.5 to
// 13.6 s and every /providers took 13 to 33 s — the model line under the
// composer, its icons and the model picker of Twoody Desktop waited as long.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-providers-slow-account-"));
delete process.env.TWOODY_BACKEND_URL;
delete process.env.TWOODY_USER_TOKEN;
delete process.env.BRIDGE_LOCAL_LLM_ENDPOINT;

const runtime = await startFakeRuntime({ models: ["qwen3:8b"], reply: () => "Bonjour." });

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { setDesktopAccount } = await import("../src/account/service.js");
const { setBackendRelay } = await import("../src/account/backend.js");
const { meshRoster, setRosterSource } = await import("../src/vault/roster.js");
const { forgetAccountComputers } = await import("../src/peers/index.js");
const { COMPUTERS_WAIT_MS } = await import("../src/routes/providers.js");

const app = await buildApp();
test.after(async () => {
  setBackendRelay(null);
  setRosterSource(null);
  setDesktopAccount(null);
  await app.close();
  await runtime.close();
});

const desktop = (await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } })).json();
const auth = { "x-user-token": desktop.token };
assert.equal((await app.inject({ method: "POST", url: "/providers/local", headers: auth, payload: { url: runtime.url, model: "qwen3:8b" } })).statusCode, 201);

// The account, as the Desktop relays it: `delay` ms for each answer.
let delay = 0;
let asked = 0;
let rosterAsked = 0;
const later = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), delay));
setDesktopAccount({ backendUrl: "https://account.invalid", userToken: "fake", deviceToken: "fake", computerId: "c-self", computerName: "Mac" });
setRosterSource(() => {
  rosterAsked += 1;
  return later(null);
});
setBackendRelay(({ path }) => {
  if (path !== "account_computers") return null;
  asked += 1;
  return later({ status: 200, body: { computers: [{ id: "c-pi", name: "Raspberry Pi", kind: "server", online: true }] } });
});

async function providers() {
  const started = Date.now();
  const response = await app.inject({ method: "GET", url: "/providers", headers: auth });
  assert.equal(response.statusCode, 200);
  return { body: response.json() as { providers: Array<{ model: string }>; computers?: Array<{ id: string; self: boolean }> }, ms: Date.now() - started };
}

test("a quick account: /providers lists its computers", async () => {
  const { body } = await providers();
  assert.equal(body.providers[0].model, "qwen3:8b");
  assert.deepEqual(body.computers?.map((c) => c.id), ["c-self", "c-pi"]);
});

test("a slow account: /providers answers in time with the computers it last knew, and keeps the late answer", async () => {
  delay = 2 * COMPUTERS_WAIT_MS;
  // Neither the roster nor the account's list is still fresh: both are asked.
  meshRoster().invalidate();
  forgetAccountComputers();
  const before = rosterAsked;
  const first = await providers();
  assert.ok(first.ms < COMPUTERS_WAIT_MS + 1_000, `answered in ${first.ms} ms`);
  assert.equal(first.body.providers[0].model, "qwen3:8b");
  assert.deepEqual(first.body.computers?.map((c) => c.id), ["c-self", "c-pi"], "the list known before");
  // Asked again while the account has not answered: one question, not two.
  const second = await providers();
  assert.ok(second.ms < COMPUTERS_WAIT_MS + 1_000);
  assert.equal(rosterAsked, before + 1, "the account is asked once at a time");
  // The roster, then the account's computers: the question goes on after
  // the answer, and reaches the account.
  const asking = asked;
  for (const started = Date.now(); asked === asking && Date.now() - started < 20_000; ) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(asked, asking + 1);
  delay = 0;
  assert.deepEqual((await providers()).body.computers?.map((c) => c.id), ["c-self", "c-pi"]);
});

test("no account any more: no computers, whatever was known", async () => {
  setDesktopAccount(null);
  const { body } = await providers();
  assert.equal(body.computers, undefined);
});
