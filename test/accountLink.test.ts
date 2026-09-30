import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startFakeBackend } from "./helpers/fakeBackend.js";

// Linking a headless server to an account by a device code
// (docs/multi-computer-design.md §2), against a backend that honours the
// Lot 1 contract: pending → slow_down → approved once, denied, expired;
// account.json 0600; /account/link on this machine and on the network;
// the Bonjour TXT record.

const dataDir = mkdtempSync(join(tmpdir(), "twoody-account-link-"));
process.env.TWOODY_DATA_DIR = dataDir;
process.env.TWOODY_LINK_POLL_MS = "20";
delete process.env.TWOODY_USER_TOKEN;
delete process.env.TWOODY_ADMIN_TOKEN;

const backend = await startFakeBackend();
process.env.TWOODY_BACKEND_URL = backend.url;

const { pollOnce, linkState, linkView, logout, onLinkChanged, resetLinkForTests, startLink } = await import("../src/account/link.js");
const { accountPath, linkedAccount, readAccountFile } = await import("../src/account/store.js");
const { bonjourTxt } = await import("../src/bonjour.js");
const { buildApp } = await import("../src/app.js");
const { ensureLocalUser } = await import("../src/pairing.js");
const { tunnelIdentity } = await import("../src/tunnel/identity.js");

const app = await buildApp();
test.after(async () => {
  resetLinkForTests();
  await app.close();
  await backend.close();
});

async function until(check: () => boolean, ms = 3_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("a code is asked for, polled while pending, slowed down, then linked once; account.json is 0600", async () => {
  const states: string[] = [];
  const off = onLinkChanged((state) => states.push(state));
  const view = await startLink({ name: "Raspberry Pi" });
  assert.equal(view.state, "pending");
  assert.match(view.user_code!, /^[A-Z]{4}-[A-Z]{4}$/);
  assert.equal(view.verification_uri, "https://twoody.com/appareil");

  const login = backend.logins.at(-1)!;
  assert.equal(login.name, "Raspberry Pi");
  assert.equal(login.public_key, readAccountFile()!.pairing_key.pub, "the login carries the pairing key");
  assert.equal(login.tunnel_public_key, tunnelIdentity().publicKey.toString("hex"), "and the tunnel key, whose security code the console shows");
  assert.equal(login.device_token, readAccountFile()!.device_token);

  await until(() => login.polls >= 2);
  assert.equal(linkState(), "pending");
  login.slowDownNext = true;
  await until(() => login.polls >= 4);
  assert.equal(linkState(), "pending", "slow_down keeps waiting");

  backend.approveLogin(login.user_code, { kind: "computer", public_key: "ab".repeat(32), name: "Mac de Jimmy" });
  await until(() => linkState() === "linked");
  off();

  const account = linkedAccount()!;
  const computer = backend.computers.find((c) => c.id === login.computer_id)!;
  assert.equal(account.computer.id, String(computer.id));
  assert.equal(account.computer.credential, computer.credential);
  assert.equal(account.user_token, backend.userToken);
  assert.equal(account.backend_url, backend.url);
  assert.deepEqual(account.approvers, [{ public_key: "ab".repeat(32), kind: "computer", name: "Mac de Jimmy" }]);
  assert.equal(statSync(accountPath()).mode & 0o777, 0o600);
  assert.equal(statSync(dataDir).mode & 0o777, 0o700);
  assert.ok(states.includes("pending") && states.at(-1) === "linked");
  assert.equal(linkView().account_computer_id, String(computer.id));
  assert.equal(linkView().account, "account 7", "without more from the backend, the account's id");

  // Delivered once: a later poll of the same code would be 410.
  const again = await backend.fetch(`${backend.url}/api/v1/computer_logins/poll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_code: login.device_code }),
  });
  assert.equal(again.status, 410);
});

test("the environment's user token takes precedence over the file's", () => {
  process.env.TWOODY_USER_TOKEN = "from-the-environment";
  try {
    assert.equal(linkedAccount()!.user_token, "from-the-environment");
  } finally {
    delete process.env.TWOODY_USER_TOKEN;
  }
});

test("logout removes the computer from the account and account.json", async () => {
  const id = Number(linkedAccount()!.computer.id);
  await logout();
  assert.equal(linkState(), "unlinked");
  assert.equal(readAccountFile(), null);
  assert.ok(!backend.computers.some((c) => c.id === id));
  assert.ok(backend.calls.includes(`DELETE /account_computers/${id}`));
});

test("a refused code ends unlinked, saying so", async () => {
  const view = await startLink();
  backend.denyLogin(view.user_code!);
  await until(() => linkState() === "unlinked");
  assert.equal(linkView().last_error, "denied");
});

test("an expired code ends unlinked, saying so", async () => {
  await startLink();
  const login = backend.logins.at(-1)!;
  login.expires_at = Date.now() - 1;
  await until(() => linkState() === "unlinked");
  assert.equal(linkView().last_error, "expired");
  assert.equal(await pollOnce(), "unlinked");
});

test("/account/link: the code is the console's only; the network starts one while fresh, never replaces it, and sees {state, fp}", async () => {
  resetLinkForTests();
  const lan = { remoteAddress: "192.168.1.30" };
  const fp = readAccountFile()!.pairing_key.pub.slice(0, 8);
  let fromLan = await app.inject({ method: "GET", url: "/account/link", ...lan });
  assert.equal(fromLan.statusCode, 200);
  assert.deepEqual(fromLan.json(), { state: "unlinked", fp });

  // Fresh: the Desktop on the network may start a code, not read it.
  const logins = backend.logins.length;
  const started = await app.inject({ method: "POST", url: "/account/link", payload: {}, ...lan });
  assert.equal(started.statusCode, 201);
  assert.deepEqual(started.json(), { state: "pending", fp });
  assert.equal(backend.logins.length, logins + 1);
  const code = backend.logins.at(-1)!.user_code;

  // Asked again, from the network or the console: the live code stays, and the backend is not asked.
  const again = await app.inject({ method: "POST", url: "/account/link", payload: {}, ...lan });
  assert.equal(again.statusCode, 200);
  assert.deepEqual(again.json(), { state: "pending", fp });
  const fromConsole = await app.inject({ method: "POST", url: "/account/link", payload: {}, remoteAddress: "127.0.0.1" });
  assert.equal(fromConsole.statusCode, 200);
  assert.equal(fromConsole.json().user_code, code);
  assert.equal(backend.logins.length, logins + 1, "one live code at a time");
  fromLan = await app.inject({ method: "GET", url: "/api/v1/account/link", ...lan });
  assert.deepEqual(fromLan.json(), { state: "pending", fp });
  const local = await app.inject({ method: "GET", url: "/account/link", remoteAddress: "127.0.0.1" });
  assert.equal(local.json().user_code, code);
  const tunnelled = await app.inject({ method: "GET", url: "/account/link", remoteAddress: "127.0.0.1", headers: { "x-twoody-via-tunnel": "1" } });
  assert.deepEqual(tunnelled.json(), { state: "pending", fp }, "a request through the tunnel is not this machine");

  // Refused: the network gets no new code before the old one would have expired; the console does.
  backend.denyLogin(code);
  await until(() => linkState() === "unlinked");
  const throttled = await app.inject({ method: "POST", url: "/account/link", payload: {}, ...lan });
  assert.equal(throttled.statusCode, 429);
  assert.equal(throttled.json().user_code, undefined);
  assert.ok(Number(throttled.headers["retry-after"]) > 0);
  assert.equal(backend.logins.length, logins + 1);
  const fresh = await app.inject({ method: "POST", url: "/account/link", payload: {}, remoteAddress: "127.0.0.1" });
  assert.equal(fresh.statusCode, 201);
  assert.match(fresh.json().user_code, /^[A-Z]{4}-[A-Z]{4}$/);

  // No longer fresh: the network may not start a code any more.
  ensureLocalUser();
  fromLan = await app.inject({ method: "GET", url: "/account/link", ...lan });
  assert.deepEqual(fromLan.json(), { state: "pending", fp });
  const refused = await app.inject({ method: "POST", url: "/account/link", payload: {}, ...lan });
  assert.equal(refused.statusCode, 403);
  assert.equal((await app.inject({ method: "DELETE", url: "/account/link", ...lan })).statusCode, 403);
  assert.equal((await app.inject({ method: "GET", url: "/account/approvals", ...lan })).statusCode, 403);
  assert.equal((await app.inject({ method: "DELETE", url: "/account/link", remoteAddress: "127.0.0.1", headers: { "x-twoody-via-tunnel": "1" } })).statusCode, 403);
  resetLinkForTests();
});

test("a code asked for from the network waits three minutes before another attempt, even when the backend failed", async () => {
  resetLinkForTests();
  const { startLink: start, LinkThrottledError } = await import("../src/account/link.js");
  const saved = process.env.TWOODY_BACKEND_URL;
  process.env.TWOODY_BACKEND_URL = "http://127.0.0.1:1";
  try {
    await assert.rejects(start({ fromNetwork: true }), (err: Error) => !(err instanceof LinkThrottledError));
    await assert.rejects(start({ fromNetwork: true }), LinkThrottledError);
  } finally {
    process.env.TWOODY_BACKEND_URL = saved;
    resetLinkForTests();
  }
});

test("once linked, the console says which account (masked), and the network still only {state, fp}", async () => {
  backend.pollExtras.account = { email: "jimmy.douieb@gmail.com", name: "Jimmy" };
  try {
    const started = await app.inject({ method: "POST", url: "/account/link", payload: {}, remoteAddress: "127.0.0.1" });
    assert.equal(started.statusCode, 201);
    backend.approveLogin(started.json().user_code, null);
    await until(() => linkState() === "linked");
    const fp = readAccountFile()!.pairing_key.pub.slice(0, 8);
    assert.deepEqual((await app.inject({ method: "GET", url: "/account/link", remoteAddress: "192.168.1.30" })).json(), { state: "linked", fp });
    const local = (await app.inject({ method: "GET", url: "/account/link", remoteAddress: "127.0.0.1" })).json();
    assert.equal(local.account, "j***@gmail.com");
    assert.equal(local.user_code, undefined);
    assert.equal(readAccountFile()!.account_label, "j***@gmail.com");
    assert.ok(!JSON.stringify(readAccountFile()).includes("jimmy.douieb"), "only the masked form is kept");
  } finally {
    delete backend.pollExtras.account;
    await logout().catch(() => undefined);
  }
});

test("the security code: shown on the console and the admin page, from the tunnel key; never to the network", async () => {
  const { securityCode } = await import("../src/vault/contracts.js");
  const code = securityCode(new Uint8Array(tunnelIdentity().publicKey));
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
  const local = (await app.inject({ method: "GET", url: "/account/link", remoteAddress: "127.0.0.1" })).json();
  assert.equal(local.security_code, code);
  assert.notEqual(local.security_code, local.fp, "the 8-hex fp is Bonjour's hint only");
  const fromLan = (await app.inject({ method: "GET", url: "/account/link", remoteAddress: "192.168.1.30" })).json();
  assert.deepEqual(Object.keys(fromLan).sort(), ["fp", "state"]);
  const tunnelled = (await app.inject({ method: "GET", url: "/account/link", remoteAddress: "127.0.0.1", headers: { "x-twoody-via-tunnel": "relay" } })).json();
  assert.equal(tunnelled.security_code, undefined, "through the tunnel is not the console");
  const admin = await app.inject({ url: "/admin", remoteAddress: "127.0.0.1" });
  assert.equal(admin.statusCode, 200);
  assert.ok(admin.body.includes(code), "the admin page shows it");
});

test("the account's label: e-mail masked, else the name masked, else its id", async () => {
  const { accountLabel, maskEmail } = await import("../src/account/link.js");
  assert.equal(maskEmail("jimmy@gmail.com"), "j***@gmail.com");
  assert.equal(maskEmail("@gmail.com"), null);
  assert.equal(accountLabel({ account_id: 7, user: { email: "claire@exemple.fr" } }), "c***@exemple.fr");
  assert.equal(accountLabel({ account_id: 7, account: { name: "Élodie" } }), "É***");
  assert.equal(accountLabel({ account_id: 7 }), "account 7");
  assert.equal(accountLabel({}), null);
});

test("the Bonjour TXT record says whether the server is in an account, and its fingerprint", () => {
  assert.deepEqual(bonjourTxt({ port: 3000, version: "0.3.0", paired: false, account: "unlinked", fp: "1f0b6205" }), {
    version: "0.3.0",
    api: "/api/v1",
    paired: "false",
    account: "unlinked",
    fp: "1f0b6205",
  });
  assert.deepEqual(bonjourTxt({ port: 3000, version: "0.3.0", paired: true }), { version: "0.3.0", api: "/api/v1", paired: "true" });
});
