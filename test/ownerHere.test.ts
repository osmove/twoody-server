import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The owner's session counts as the person only where its token cannot have
// been carried by someone else (Jimmy, 11/10/2026; docs/trust-routes-review.md
// residuals 1 and 2; AGENTS.md rule 12):
//
//   - meshRequester (sessionTrust.ts) takes the owner's session from this
//     very machine, or through the tunnel from the very key it was paired
//     with (ownerHere) — no longer from the local network, a proxy, the
//     relay's stamp alone or another device's tunnel. Behind it: the
//     memories, the synchronised history, the whole traces, the person's
//     tools, the connectors in a chat, the other computers' documents.
//   - /auth/signin and /auth/signup take the password on this machine, or
//     sealed through the tunnel, or with the admin token of a server
//     published with TWOODY_ADMIN_TOKEN — never in clear on the local
//     network. Another machine pairs (`twoody pair`).
//
// Each attack below passed on the code before. The legitimate callers — the
// Desktop on this machine, the console, the iPhone through its own tunnel, a
// phone given a headless server's setup token — keep working.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-owner-here-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
process.env.LOG_LEVEL ??= "warn";
delete process.env.TWOODY_ADMIN_TOKEN;
delete process.env.TWOODY_RUNTIME;

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken, createAuthSession } = await import("../src/auth.js");
const { pairDevice } = await import("../src/pairing.js");
const { setDesktopAccount } = await import("../src/account/service.js");
const { setRosterSource } = await import("../src/vault/roster.js");
const { meshVault } = await import("./helpers/meshVault.js");

const MAC = "3c9e1f27-6a4b-4d8c-9e2f-7b1a5c3d9e40";
setDesktopAccount({ backendUrl: "http://127.0.0.1:9", userToken: "unused", computerId: MAC, computerName: "Mac de Jimmy" });
const app = await buildApp();

// A headless server's first account, made on its own machine: a password.
const EMAIL = "jimmy@example.com";
const PASSWORD = "correct horse battery";
const signup = await app.inject({ method: "POST", url: "/auth/signup", payload: { email: EMAIL, password: PASSWORD, setup_token: ensureSetupToken()!.token } });
assert.equal(signup.statusCode, 201, signup.body);
const mac = { authorization: `Bearer ${signup.json().token}` };
const userId = signup.json().user_id as string;

const vault = meshVault(userId);
const iphone = vault.person("iPhone de Jimmy");
vault.desktop("Mac de Jimmy", MAC, iphone);
await setRosterSource(async () => vault.input([iphone])).refresh();

test.after(async () => {
  setRosterSource(null);
  setDesktopAccount(null);
  delete process.env.TWOODY_ADMIN_TOKEN;
  await app.close();
});

const sealedFrom = (key: string) => ({ "x-twoody-via-tunnel": "relay", "x-twoody-tunnel-peer": key });

// The person's iPhone (rule 5: its device-access), through its own tunnel.
const phoneKey = randomBytes(32).toString("hex");
const phone = { authorization: `Bearer ${pairDevice({ deviceName: "iPhone de Jimmy", tunnelPublicKey: phoneKey, origin: "mesh", vaultDeviceId: iphone.id, approvalRule: "device_access", deviceAccessJson: JSON.stringify(vault.deviceAccess(iphone, phoneKey, MAC)) }).token}`, ...sealedFrom(phoneKey) };
// An iPad paired by the code on the screen: its tunnel key.
const codeKey = randomBytes(32).toString("hex");
pairDevice({ deviceName: "iPad de la cuisine", tunnelPublicKey: codeKey, origin: "code" });
// A phone given the setup token: an owner session, with its own tunnel key.
const ownerPhoneKey = randomBytes(32).toString("hex");
const ownerPhone = { authorization: `Bearer ${pairDevice({ deviceName: "iPhone", tunnelPublicKey: ownerPhoneKey, origin: "owner" }).token}`, ...sealedFrom(ownerPhoneKey) };
// What /auth/signin gave whoever had the password (the CLI signed in from another machine).
const ownerToken = createAuthSession(userId, "cli", "owner").token;

type How = { headers: Record<string, string>; remoteAddress?: string };
const ownerElsewhere: Array<[string, How]> = [
  ["the owner's session from the local network", { headers: { authorization: `Bearer ${ownerToken}` }, remoteAddress: "192.168.1.20" }],
  ["the owner's token through the relay, without a key", { headers: { authorization: `Bearer ${ownerToken}`, "x-twoody-via-tunnel": "relay" } }],
  ["the owner's token inside another device's tunnel", { headers: { authorization: `Bearer ${ownerToken}`, ...sealedFrom(codeKey) } }],
  ["the owner's token through a proxy", { headers: { authorization: `Bearer ${ownerToken}`, "x-forwarded-for": "203.0.113.9" } }],
];
const legitimate: Array<[string, How]> = [
  ["the Desktop on this machine", { headers: mac }],
  ["the CLI's owner session on this machine", { headers: { authorization: `Bearer ${ownerToken}` } }],
  ["the person's iPhone through its own tunnel", { headers: phone }],
  ["a phone with the setup token, through its own tunnel", { headers: ownerPhone }],
];
type Ask = { method: "GET" | "POST"; url: string; payload?: unknown };
const send = (how: How, ask: Ask) =>
  app.inject({ ...ask, headers: how.headers, ...(how.remoteAddress ? { remoteAddress: how.remoteAddress } : {}) } as Parameters<typeof app.inject>[0]);

// What only the person reaches (meshRequester): memories, traces, the person's tools, the history's import.
const personOnly: Ask[] = [
  { method: "GET", url: "/memories" },
  { method: "GET", url: "/memories/candidates" },
  { method: "POST", url: "/memories", payload: { memory: { content: "Planted by whoever listened on the Wi-Fi" } } },
  { method: "GET", url: "/diagnostics/full?after=0" },
  { method: "GET", url: "/diagnostics/turns" },
  { method: "POST", url: "/tool_calls", payload: { name: "memory_search", arguments: { query: "banque" } } },
  { method: "POST", url: "/discussions/import", payload: { vault_id: "0123456789abcdef0123456789abcdef", title: "x", turns: [] } },
];

test("the owner's token from anywhere but this machine or its own tunnel is not the person: memories, traces, tools, history refused", async () => {
  for (const [who, how] of ownerElsewhere) {
    for (const ask of personOnly) {
      const response = await send(how, ask);
      // Refused for who it is — not for another reason that would hide the gap.
      assert.equal(response.statusCode, 403, `${who}: ${ask.method} ${ask.url} → ${response.statusCode} ${response.body}`);
      assert.equal(response.json().error, "person_device_required", `${who}: ${ask.method} ${ask.url}`);
    }
    // The connectors in its messages: not its to use.
    const connectors = await send(how, { method: "GET", url: "/connectors" });
    assert.equal(connectors.statusCode, 200, connectors.body);
    assert.ok((connectors.json().connectors as Array<{ from_devices: boolean }>).every((one) => !one.from_devices));
  }
  const memories = (await send({ headers: mac }, { method: "GET", url: "/memories" })).json() as { memories?: Array<{ content: string }> };
  assert.ok(!JSON.stringify(memories).includes("Planted"), "no memory written");
});

test("the Desktop on this machine, the iPhone and a setup-token phone through their own tunnel still reach them", async () => {
  for (const [who, how] of legitimate) {
    for (const ask of personOnly.filter((one) => one.method === "GET")) {
      const response = await send(how, ask);
      assert.equal(response.statusCode, 200, `${who}: ${ask.method} ${ask.url} → ${response.statusCode} ${response.body}`);
    }
    const tool = await send(how, { method: "POST", url: "/tool_calls", payload: { name: "memory_search", arguments: { query: "banque" } } });
    assert.notEqual(tool.statusCode, 403, `${who}: memory_search → ${tool.body}`);
  }
  const written = await send({ headers: phone }, { method: "POST", url: "/memories", payload: { memory: { content: "Jimmy prefers tea" } } });
  assert.ok(written.statusCode === 200 || written.statusCode === 201, written.body);
});

// ── the password (routes/session.ts mayTakePassword) ───────────────────────

const signin = (how: How) => send(how, { method: "POST", url: "/auth/signin", payload: { email: EMAIL, password: PASSWORD, client_kind: "cli" } });

test("the password in clear from the local network, a proxy or the relay's stamp alone: no session, pointed to `twoody pair`", async () => {
  const attackers: Array<[string, How]> = [
    ["another machine of the local network", { headers: {}, remoteAddress: "192.168.1.20" }],
    ["through a proxy", { headers: { "x-forwarded-for": "203.0.113.9" } }],
    ["the relay's stamp without a tunnel key", { headers: { "x-twoody-via-tunnel": "relay" } }],
    ["a forged tunnel stamp from the local network", { headers: sealedFrom(phoneKey), remoteAddress: "192.168.1.20" }],
  ];
  for (const [who, how] of attackers) {
    for (const url of ["/auth/signin", "/api/v1/auth/signin"]) {
      const response = await send(how, { method: "POST", url, payload: { email: EMAIL, password: PASSWORD, client_kind: "cli" } });
      assert.equal(response.statusCode, 403, `${who} ${url}: ${response.body}`);
      assert.equal(response.json().error, "signin_local_only");
      assert.match(response.json().message, /twoody pair/);
      assert.equal(response.json().token, undefined);
    }
    // Sign-up too (here the account exists: refused before it is even looked at).
    const up = await send(how, { method: "POST", url: "/auth/signup", payload: { email: "x@example.com", password: "whatever123", setup_token: "guess" } });
    assert.equal(up.json().error, "signin_local_only", `${who}: signup ${up.body}`);
  }
  // The admin token set on the server is not enough without it in the request.
  process.env.TWOODY_ADMIN_TOKEN = "published-admin-token";
  try {
    assert.equal((await signin({ headers: {}, remoteAddress: "192.168.1.20" })).json().error, "signin_local_only");
    assert.equal((await signin({ headers: { "x-admin-token": "wrong" }, remoteAddress: "192.168.1.20" })).json().error, "signin_local_only");
  } finally {
    delete process.env.TWOODY_ADMIN_TOKEN;
  }
});

test("the password on this machine, sealed through the tunnel, or with the published server's admin token: signed in", async () => {
  assert.equal((await signin({ headers: {} })).statusCode, 200);
  assert.equal((await signin({ headers: sealedFrom(phoneKey) })).statusCode, 200);
  process.env.TWOODY_ADMIN_TOKEN = "published-admin-token";
  try {
    const published = await signin({ headers: { "x-admin-token": "published-admin-token" }, remoteAddress: "203.0.113.9" });
    assert.equal(published.statusCode, 200, published.body);
    assert.ok(published.json().token);
    // On this machine, the admin token set or not.
    assert.equal((await signin({ headers: {} })).statusCode, 200);
  } finally {
    delete process.env.TWOODY_ADMIN_TOKEN;
  }
  // A wrong password is still a wrong password.
  assert.equal((await send({ headers: {} }, { method: "POST", url: "/auth/signin", payload: { email: EMAIL, password: "nope nope" } })).statusCode, 401);
});
