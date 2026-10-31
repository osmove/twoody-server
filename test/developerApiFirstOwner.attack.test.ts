import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A server nobody has set up yet (Docker, twoody serve), and its first API
// key (routes/developerApi.ts keyOwner, 31/10/2026). The console of this
// machine that also gives the setup token makes the owner — what /auth/pair
// makes from anywhere for the token alone. The attacks: the console without
// the token or with a wrong one, the token from the network (with
// TWOODY_API_ALLOW_NETWORK too), through the tunnel, through a proxy, from a
// web page; the token to make a second owner once there is one. Then
// `twoody-server api-key create | list | revoke` against a listening server.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-first-owner-"));
delete process.env.TWOODY_ADMIN_TOKEN;
delete process.env.TWOODY_API_ALLOW_NETWORK;
delete process.env.TWOODY_RUNTIME;
process.env.BRIDGE_LOCAL_LLM_ENDPOINT = "http://127.0.0.1:9/v1";

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { sqlite } = await import("../src/db.js");

const app = await buildApp();
await app.ready();
test.after(async () => {
  await app.close();
});

const HOST = { host: "127.0.0.1:3000" };
const users = () => (sqlite.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
const keys = () => (sqlite.prepare("SELECT COUNT(*) AS n FROM api_keys").get() as { n: number }).n;
const make = (headers: Record<string, string>, remoteAddress?: string) =>
  app.inject({ method: "POST", url: "/api/v1/api_keys", headers, payload: { name: "first" }, ...(remoteAddress ? { remoteAddress } : {}) });

test("no owner: the token is refused anywhere but this machine's console, and nothing is made", async () => {
  const token = ensureSetupToken()!.token;
  const given = { "x-twoody-setup-token": token };
  const attempts: Array<[string, Record<string, string>, string?]> = [
    ["the console without the token", { ...HOST }],
    ["the console with a wrong token", { ...HOST, "x-twoody-setup-token": `${token}x` }],
    ["the console with an empty token", { ...HOST, "x-twoody-setup-token": " " }],
    ["the token from the network", { ...HOST, ...given }, "192.168.1.20"],
    ["the token from Docker's bridge", { host: "172.17.0.2:3000", ...given }, "172.17.0.1"],
    ["the token through the tunnel", { ...HOST, ...given, "x-twoody-via-tunnel": "1" }],
    ["the token through a proxy", { ...HOST, ...given, "x-forwarded-for": "203.0.113.9" }],
    ["the token from a web page", { ...HOST, ...given, origin: "https://evil.example" }],
    ["the token from a web page (Sec-Fetch-Site)", { ...HOST, ...given, "sec-fetch-site": "cross-site" }],
    ["the token as a bearer", { ...HOST, authorization: `Bearer ${token}` }, "192.168.1.20"],
  ];
  for (const allowNetwork of [false, true]) {
    if (allowNetwork) process.env.TWOODY_API_ALLOW_NETWORK = "1";
    try {
      for (const [label, headers, remoteAddress] of attempts) {
        const res = await make(headers, remoteAddress);
        assert.ok([401, 403, 409].includes(res.statusCode), `${label} (network ${allowNetwork}): ${res.statusCode} ${res.body}`);
        assert.equal(users(), 0, label);
        assert.equal(keys(), 0, label);
      }
    } finally {
      delete process.env.TWOODY_API_ALLOW_NETWORK;
    }
  }
  // Listing and revoking never make an owner, token or not.
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/api_keys", headers: { ...HOST, ...given } })).statusCode, 409);
  assert.equal(users(), 0);
});

test("the console with the token makes the owner and the key, once; the token never makes a second owner", async () => {
  const token = ensureSetupToken()!.token;
  const first = await make({ ...HOST, "x-twoody-setup-token": token });
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(users(), 1);
  const owner = (sqlite.prepare("SELECT id, password_digest FROM users").get() as { id: string; password_digest: string | null });
  assert.equal(owner.password_digest, null);
  // No session was made for it: nobody holds a credential of this owner but the key.
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM auth_sessions").get() as { n: number }).n, 0);

  // The key opens /v1/* from this machine (the runtime is down: not 401/403).
  const key = first.json().token as string;
  const models = await app.inject({ method: "GET", url: "/v1/models", headers: { ...HOST, authorization: `Bearer ${key}` } });
  assert.ok(![401, 403].includes(models.statusCode), models.body);

  // Again, with or without the token: the same owner.
  assert.equal((await make({ ...HOST, "x-twoody-setup-token": token })).statusCode, 201);
  assert.equal((await make({ ...HOST })).statusCode, 201);
  assert.equal(users(), 1);
  const owners = sqlite.prepare("SELECT DISTINCT user_id FROM api_keys").all() as Array<{ user_id: string }>;
  assert.deepEqual(owners.map((row) => row.user_id), [owner.id]);

  // From the network, an owner existing changes nothing.
  process.env.TWOODY_API_ALLOW_NETWORK = "1";
  try {
    const res = await make({ host: "172.17.0.2:3000", "x-twoody-setup-token": token }, "172.17.0.1");
    assert.ok([401, 403].includes(res.statusCode), res.body);
  } finally {
    delete process.env.TWOODY_API_ALLOW_NETWORK;
  }
});

test("twoody-server api-key create | list | revoke, against the listening server", async () => {
  await app.listen({ port: 0, host: "127.0.0.1" });
  process.env.PORT = String((app.server.address() as AddressInfo).port);
  const { runApiKeyCommand } = await import("../src/cli/apiKeys.js");
  const printed: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => void printed.push(args.join(" "));
  console.error = () => {};
  try {
    assert.equal(await runApiKeyCommand(["create", "my", "script"]), 0);
    const token = printed.at(-1)!;
    assert.match(token, /^twk_[A-Za-z0-9_-]{43}$/);
    assert.equal(await runApiKeyCommand(["list"]), 0);
    const row = printed.find((line) => line.includes("my script"))!;
    assert.ok(row && !row.includes(token));
    const id = row.trim().split(/\s+/)[0]!;
    assert.equal(await runApiKeyCommand(["revoke", id]), 0);
    const after = await app.inject({ method: "GET", url: "/v1/models", headers: { ...HOST, authorization: `Bearer ${token}` } });
    assert.equal(after.statusCode, 401);
    assert.equal(await runApiKeyCommand(["revoke", "nope"]), 1);
    assert.equal(await runApiKeyCommand(["frobnicate"]), 2);
  } finally {
    console.log = log;
    console.error = error;
  }
});
