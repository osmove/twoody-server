import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The developer API (docs/developer-api-design.md): /v1/* answers a program
// of this machine with a live local API key, and nothing else. The
// attacks: no key, a forged, a revoked or a session token in place of a
// key; a key from another address, through the tunnel, through a proxy, from
// a web page (an Origin, Sec-Fetch-Site, a rebound name); the key used on
// Twoody's own routes; a phone, a peer or a code-paired device making keys;
// what reaches the model (the request as sent, nothing of the person's).

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-developer-api-"));
delete process.env.TWOODY_ADMIN_TOKEN;
delete process.env.TWOODY_API_ALLOW_NETWORK;
delete process.env.TWOODY_RUNTIME;

// A runtime that records what it is sent.
const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
const runtime = createServer(async (req: IncomingMessage, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString();
  if (req.method === "GET" && req.url?.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ data: [{ id: "Fake-9B" }] }));
  }
  if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
    const body = JSON.parse(text);
    seen.push({ url: req.url, body });
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Bon" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "jour" } }], usage: { prompt_tokens: 7, completion_tokens: 2 } })}\n\n`);
      return res.end("data: [DONE]\n\n");
    }
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "Bonjour" }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 1 } }));
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((resolve) => runtime.listen(0, "127.0.0.1", resolve));
process.env.BRIDGE_LOCAL_LLM_ENDPOINT = `http://127.0.0.1:${(runtime.address() as AddressInfo).port}/v1`;

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { pairDevice } = await import("../src/pairing.js");
const { sqlite } = await import("../src/db.js");

const app = await buildApp();
await app.ready();
test.after(async () => {
  await app.close();
  runtime.close();
});

// The Desktop: the owner, paired with the setup token from this machine.
const desktop = (await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } })).json();
const HOST = { host: "127.0.0.1:47821" };
const owner = { ...HOST, authorization: `Bearer ${desktop.token}` };

async function makeKey(name = "tests"): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/api_keys", headers: owner, payload: { name } });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().token;
}
const chat = { model: "Fake-9B", messages: [{ role: "user", content: "Bonjour" }] };

test("a key from this machine lists the models and gets an answer, streamed or not, with what was sent and nothing else", async () => {
  const key = await makeKey();
  assert.match(key, /^twk_[A-Za-z0-9_-]{43}$/);
  const models = await app.inject({ method: "GET", url: "/v1/models", headers: { ...HOST, authorization: `Bearer ${key}` } });
  assert.equal(models.statusCode, 200);
  assert.deepEqual(models.json().data.map((m: { id: string }) => m.id), ["Fake-9B"]);
  assert.equal(models.json().object, "list");

  seen.length = 0;
  const answer = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { ...HOST, authorization: `Bearer ${key}` }, payload: { ...chat, x_secret: "dropped", user: "dropped" } });
  assert.equal(answer.statusCode, 200, answer.body);
  assert.equal(answer.json().choices[0].message.content, "Bonjour");
  assert.equal(seen.length, 1);
  // The messages as the program sent them: no system prompt, memory,
  // document or tool of Twoody added; unknown fields dropped.
  assert.deepEqual(seen[0]!.body.messages, chat.messages);
  assert.equal(seen[0]!.body.x_secret, undefined);
  assert.equal(seen[0]!.body.user, undefined);
  assert.equal(seen[0]!.body.tools, undefined);

  const streamed = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { ...HOST, authorization: `Bearer ${key}` }, payload: { ...chat, stream: true } });
  assert.equal(streamed.statusCode, 200);
  assert.match(streamed.headers["content-type"] as string, /event-stream/);
  assert.match(streamed.body, /Bon/);
  assert.match(streamed.body, /\[DONE\]/);

  const usage = sqlite.prepare("SELECT source, client FROM model_calls WHERE source = 'api'").all() as Array<{ source: string; client: string }>;
  assert.equal(usage.length, 2);
  assert.equal(usage[0]!.client, "api:tests");
  // Nothing of the conversation is kept.
  assert.equal((sqlite.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n, 0);
  assert.equal((sqlite.prepare("SELECT count(*) AS n FROM discussions").get() as { n: number }).n, 0);
});

test("no key, a forged key, a session token, a revoked key: 401 in OpenAI's shape", async () => {
  const forged = "twk_" + "A".repeat(43);
  for (const authorization of [undefined, `Bearer ${forged}`, `Bearer ${desktop.token}`, "Bearer ", `Basic ${Buffer.from("x:y").toString("base64")}`]) {
    const res = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { ...HOST, ...(authorization ? { authorization } : {}) }, payload: chat });
    assert.equal(res.statusCode, 401, String(authorization));
    assert.equal(res.json().error.code, "invalid_api_key");
    assert.equal(res.json().error.type, "authentication_error");
  }
  const key = await makeKey("to revoke");
  const id = (await app.inject({ method: "GET", url: "/api/v1/api_keys", headers: owner })).json().api_keys.find((k: { name: string }) => k.name === "to revoke").id;
  assert.equal((await app.inject({ method: "DELETE", url: `/api/v1/api_keys/${id}`, headers: owner })).statusCode, 204);
  const res = await app.inject({ method: "GET", url: "/v1/models", headers: { ...HOST, authorization: `Bearer ${key}` } });
  assert.equal(res.statusCode, 401);
  // Revoked, not deleted.
  const row = sqlite.prepare("SELECT revoked_at FROM api_keys WHERE id = ?").get(id) as { revoked_at: number | null };
  assert.ok(row.revoked_at);
});

test("a valid key is refused from anywhere but this machine's programs", async () => {
  const key = await makeKey();
  const auth = { authorization: `Bearer ${key}` };
  const cases: Array<[string, Parameters<typeof app.inject>[0]]> = [
    ["another address", { method: "GET", url: "/v1/models", headers: { ...HOST, ...auth }, remoteAddress: "192.168.1.20" }],
    ["through the tunnel", { method: "GET", url: "/v1/models", headers: { ...HOST, ...auth, "x-twoody-via-tunnel": "1" } }],
    ["through a proxy", { method: "GET", url: "/v1/models", headers: { ...HOST, ...auth, "x-forwarded-for": "203.0.113.9" } }],
    ["from a web page (Origin)", { method: "GET", url: "/v1/models", headers: { ...HOST, ...auth, origin: "https://evil.example" } }],
    ["from a web page (Sec-Fetch-Site)", { method: "POST", url: "/v1/chat/completions", headers: { ...HOST, ...auth, "sec-fetch-site": "cross-site" }, payload: chat }],
    ["a local-network name rebound here", { method: "GET", url: "/v1/models", headers: { host: "evil.local:47821", ...auth } }],
    ["0.0.0.0", { method: "GET", url: "/v1/models", headers: { host: "0.0.0.0:47821", ...auth } }],
  ];
  for (const [label, request] of cases) {
    const res = await app.inject(request);
    assert.equal(res.statusCode, 403, label);
    assert.equal(res.json().error.code, "local_only", label);
  }
  // A site's own domain never gets that far (webOrigin.ts hostGuard).
  assert.equal((await app.inject({ method: "GET", url: "/v1/models", headers: { host: "evil.example", ...auth } })).statusCode, 421);
});

test("TWOODY_API_ALLOW_NETWORK lets a key in from another address (Docker), never from a web page", async () => {
  const key = await makeKey();
  process.env.TWOODY_API_ALLOW_NETWORK = "1";
  try {
    const ok = await app.inject({ method: "GET", url: "/v1/models", headers: { host: "172.17.0.2:47821", authorization: `Bearer ${key}` }, remoteAddress: "172.17.0.1" });
    assert.equal(ok.statusCode, 200);
    const page = await app.inject({ method: "GET", url: "/v1/models", headers: { host: "172.17.0.2:47821", authorization: `Bearer ${key}`, origin: "https://evil.example" }, remoteAddress: "172.17.0.1" });
    assert.equal(page.statusCode, 403);
    const tunnel = await app.inject({ method: "GET", url: "/v1/models", headers: { ...HOST, authorization: `Bearer ${key}`, "x-twoody-via-tunnel": "1" } });
    assert.equal(tunnel.statusCode, 403);
  } finally {
    delete process.env.TWOODY_API_ALLOW_NETWORK;
  }
});

test("a key opens /v1/* and nothing of Twoody's own: memories, conversations, keys", async () => {
  const key = await makeKey();
  for (const url of ["/api/v1/memories", "/api/v1/discussions", "/api/v1/me", "/api/v1/api_keys", "/api/v1/local_documents/folders"]) {
    // From a web page, so that this machine's console rule does not apply:
    // the key alone must not be a session.
    const res = await app.inject({ method: "GET", url, headers: { ...HOST, authorization: `Bearer ${key}`, origin: "null" } });
    assert.ok([401, 403].includes(res.statusCode), `${url} answered ${res.statusCode}`);
  }
  const make = await app.inject({ method: "POST", url: "/api/v1/api_keys", headers: { ...HOST, authorization: `Bearer ${key}`, origin: "null" }, payload: { name: "more" } });
  assert.ok([401, 403].includes(make.statusCode));
});

test("only the owner here makes keys: not a code-paired device, a peer, nor the owner's token through the tunnel or from a page elsewhere", async () => {
  const phone = pairDevice({ deviceName: "iPhone", role: "device", origin: "code" });
  const peer = pairDevice({ deviceName: "Mac mini", role: "peer" });
  const page = { origin: "null" };
  const attempts: Array<[string, Record<string, string>, string?]> = [
    ["a code-paired phone", { ...HOST, ...page, authorization: `Bearer ${phone.token}` }],
    ["a code-paired phone through the tunnel", { ...HOST, authorization: `Bearer ${phone.token}`, "x-twoody-via-tunnel": "1" }],
    ["a peer", { ...HOST, authorization: `Bearer ${peer.token}` }],
    ["the owner's token through the tunnel", { ...HOST, authorization: `Bearer ${desktop.token}`, "x-twoody-via-tunnel": "1" }],
    ["the owner's token from the network", { ...HOST, authorization: `Bearer ${desktop.token}` }, "192.168.1.20"],
    ["nobody, from the network", { ...HOST }, "192.168.1.20"],
    ["nobody, from a web page", { ...HOST, origin: "https://evil.example" }],
  ];
  for (const [label, headers, remoteAddress] of attempts) {
    const res = await app.inject({ method: "POST", url: "/api/v1/api_keys", headers, payload: { name: label }, ...(remoteAddress ? { remoteAddress } : {}) });
    assert.ok([401, 403].includes(res.statusCode), `${label}: ${res.statusCode} ${res.body}`);
  }
  const listed = (await app.inject({ method: "GET", url: "/api/v1/api_keys", headers: owner })).json().api_keys as Array<{ name: string }>;
  assert.ok(!listed.some((k) => attempts.some(([label]) => k.name === label)));
});

test("the console of this machine makes keys; the list never shows a token", async () => {
  const res = await app.inject({ method: "POST", url: "/api/v1/api_keys", headers: HOST, payload: { name: "console" } });
  assert.equal(res.statusCode, 201);
  const token = res.json().token as string;
  const listed = await app.inject({ method: "GET", url: "/api/v1/api_keys", headers: HOST });
  assert.equal(listed.statusCode, 200);
  assert.ok(!listed.body.includes(token));
  assert.ok(!listed.body.includes(token.slice(12)));
  const row = listed.json().api_keys.find((k: { name: string }) => k.name === "console");
  assert.equal(row.prefix, token.slice(0, 12));
  // Only its digest is stored.
  const stored = sqlite.prepare("SELECT * FROM api_keys WHERE id = ?").get(row.id) as Record<string, unknown>;
  assert.ok(!Object.values(stored).some((value) => value === token));
});

test("bad requests: OpenAI-shaped 400 and 404, a model that is not here", async () => {
  const key = await makeKey();
  const headers = { ...HOST, authorization: `Bearer ${key}` };
  const missing = await app.inject({ method: "POST", url: "/v1/chat/completions", headers, payload: { model: "Fake-9B" } });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.json().error.type, "invalid_request_error");
  const nowhere = await app.inject({ method: "POST", url: "/v1/chat/completions", headers, payload: { ...chat, model: "gpt-4o" } });
  assert.equal(nowhere.statusCode, 404);
  assert.equal(nowhere.json().error.code, "model_not_found");
  const embeddings = await app.inject({ method: "POST", url: "/v1/embeddings", headers, payload: { input: "bonjour" } });
  assert.equal(embeddings.statusCode, 404, "no semantic model in the tests");
});
