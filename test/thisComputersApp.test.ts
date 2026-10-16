import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// « This computer's app » (routes/usage.ts isThisComputersApp) is the
// owner's session *and* a request from this very machine (auth.ts
// fromThisMachine): the routes that change what this computer reads, runs,
// connects to or keeps, or that give its secrets, refuse the owner's token
// carried through the tunnel, a proxy or the local network, and any other
// device's session (docs/connectors-security-review.md, « Other routes »).
// What the iPhone reads keeps working.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-this-computers-app-"));
// E-mails and Google Analytics / Search Console are offered to this
// account (src/reservedFeatures.ts: kept for the accounts Osmove chooses).
process.env.TWOODY_RESERVED_FEATURES = "all";
process.env.TWOODY_BONJOUR_DISABLED = "1";
delete process.env.HOME_ASSISTANT_URL;
delete process.env.HOME_ASSISTANT_TOKEN;

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken, createAuthSession } = await import("../src/auth.js");
const app = await buildApp();
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const mac = { authorization: `Bearer ${paired.json().token}` };
const userId = paired.json().user_id as string;
test.after(() => app.close());

const owner = createAuthSession(userId, "desktop", "owner").token;
const attackers: Array<[string, { headers: Record<string, string>; remoteAddress?: string }]> = [
  ["a device paired by code", { headers: { authorization: `Bearer ${createAuthSession(userId, "pair:iPhone", "code").token}` } }],
  ["the owner's token through the relay", { headers: { authorization: `Bearer ${owner}`, "x-twoody-via-tunnel": "relay" } }],
  ["the owner's token through the local network's tunnel", { headers: { authorization: `Bearer ${owner}`, "x-twoody-via-tunnel": "direct" } }],
  ["the owner's session from the local network (its password typed on another device)", { headers: { authorization: `Bearer ${owner}` }, remoteAddress: "192.168.1.20" }],
  ["the owner's token through a proxy", { headers: { authorization: `Bearer ${owner}`, "x-forwarded-for": "203.0.113.9" } }],
];

const folder = mkdtempSync(join(homedir(), ".twoody-this-app-test-"));
// Put in the Trash afterwards, not deleted (AGENTS.md rule 6).
test.after(async () => {
  const { mkdirSync, renameSync } = await import("node:fs");
  const { basename } = await import("node:path");
  const trash = join(homedir(), ".Trash");
  mkdirSync(trash, { recursive: true });
  renameSync(folder, join(trash, basename(folder)));
});

const sensitive = [
  { method: "PUT" as const, url: "/home/config", payload: { url: "http://127.0.0.1:1", token: "t" } },
  { method: "DELETE" as const, url: "/home/config" },
  { method: "POST" as const, url: "/email/account", payload: { address: "a@b.c" } },
  { method: "GET" as const, url: "/email/recent" },
  { method: "POST" as const, url: "/google_data/link", payload: {} },
  { method: "DELETE" as const, url: "/google_data" },
  { method: "POST" as const, url: "/microsoft_graph/account", payload: {} },
  { method: "GET" as const, url: "/bank" },
  { method: "PATCH" as const, url: "/local_capabilities/documents", payload: { enabled: true } },
  { method: "PUT" as const, url: "/local_capabilities_order", payload: { order: [] } },
  { method: "PUT" as const, url: "/local_sync/contacts", payload: { source: "apple", contacts: [] } },
  { method: "POST" as const, url: "/local_documents/folders", payload: { path: folder } },
  { method: "POST" as const, url: "/local_documents/personal", payload: { confirmed: true } },
  { method: "DELETE" as const, url: "/local_documents/folders/nope" },
  { method: "DELETE" as const, url: "/paired_devices/nope" },
  { method: "GET" as const, url: "/devices/llm_keys" },
  { method: "POST" as const, url: "/local_shares/serve", payload: {} },
];

test("what changes this computer, or gives its secrets: refused to any other device, and to the owner's token from elsewhere", async () => {
  for (const [who, how] of attackers) {
    for (const ask of sensitive) {
      const response = await app.inject({ ...ask, headers: how.headers, ...(how.remoteAddress ? { remoteAddress: how.remoteAddress } : {}) });
      // Refused for who it is — not for some other reason that would hide the gap.
      assert.ok(response.statusCode === 401 || (response.statusCode === 403 && response.json().error === "desktop_app_only"), `${who}: ${ask.method} ${ask.url} → ${response.statusCode} ${response.body}`);
    }
  }
  const folders = await app.inject({ url: "/local_documents/folders", headers: mac });
  assert.ok(!folders.body.includes(folder), "no folder was granted");
});

test("the same, from this computer's app on this computer: not refused", async () => {
  for (const ask of sensitive) {
    if (ask.url === "/local_documents/personal") continue; // would index the home folder
    const response = await app.inject({ ...ask, headers: mac });
    assert.notEqual(response.statusCode, 401, `${ask.method} ${ask.url} → ${response.body}`);
    assert.notEqual(response.statusCode === 403 && response.json().error, "desktop_app_only", `${ask.method} ${ask.url} → ${response.body}`);
  }
});

test("what the iPhone reads still answers it, through the tunnel", async () => {
  const phone = { authorization: `Bearer ${createAuthSession(userId, "pair:iPhone", "code").token}`, "x-twoody-via-tunnel": "relay" };
  for (const url of ["/local_capabilities", "/home", "/local_documents/folders", "/connectors", "/usage", "/providers"]) {
    const response = await app.inject({ url, headers: phone });
    assert.equal(response.statusCode, 200, `${url} → ${response.statusCode} ${response.body}`);
  }
});

test("Home Assistant: a new address needs its token again — the kept one is never sent elsewhere", async () => {
  const seen: Array<{ server: string; authorization: string | undefined }> = [];
  const homeAssistant = (name: string) => createServer((req: IncomingMessage, res: ServerResponse) => {
    seen.push({ server: name, authorization: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([{ entity_id: "light.salon", state: "off", attributes: { friendly_name: "Salon" } }]));
  });
  const real = homeAssistant("real");
  const other = homeAssistant("other");
  await new Promise<void>((resolve) => real.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  const at = (server: typeof real) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const set = await app.inject({ method: "PUT", url: "/home/config", headers: mac, payload: { url: at(real), token: "ha-secret" } });
    assert.equal(set.statusCode, 200, set.body);
    // The same address, no token typed: the one kept goes on.
    assert.equal((await app.inject({ method: "PUT", url: "/home/config", headers: mac, payload: { url: at(real), token: "" } })).statusCode, 200);
    // Another address, no token typed: refused, and nothing reaches it.
    const moved = await app.inject({ method: "PUT", url: "/home/config", headers: mac, payload: { url: at(other), token: "" } });
    assert.equal(moved.statusCode, 422, moved.body);
    assert.equal(moved.json().error, "token_required");
    assert.deepEqual(seen.filter((one) => one.server === "other"), []);
    assert.ok(seen.every((one) => one.server === "real" && one.authorization === "Bearer ha-secret"));
  } finally {
    await app.inject({ method: "DELETE", url: "/home/config", headers: mac });
    real.close();
    other.close();
  }
});
