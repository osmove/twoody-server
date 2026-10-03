import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A connector whose service asks for a sign-in (OAuth, as the MCP spec
// says): discovered from its 401, Twoody registered there, PKCE, the code
// back at this server, tokens kept on this computer and renewed (Jimmy,
// 03/10/2026).

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-connectors-oauth-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
delete process.env.BRIDGE_LOCAL_LLM_ENDPOINT;

// The service: an MCP server behind OAuth, and its authorization server.
const seen = { registered: [] as unknown[], tokens: [] as Record<string, string>[], challenge: "", valid: new Set<string>() };
let issued = 0;
const service = createServer((req: IncomingMessage, res: ServerResponse) => {
  const base = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const url = new URL(req.url!, base);
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return json(200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["pages.read"] });
    if (url.pathname === "/.well-known/oauth-authorization-server") return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register` });
    if (url.pathname === "/register") { seen.registered.push(JSON.parse(raw)); return json(201, { client_id: "twoody-client" }); }
    if (url.pathname === "/token") {
      const form = Object.fromEntries(new URLSearchParams(raw));
      seen.tokens.push(form);
      if (form.grant_type === "authorization_code") {
        const verified = createHash("sha256").update(form.code_verifier ?? "").digest("base64url") === seen.challenge;
        if (form.code !== "the-code" || !verified || form.resource !== `${base}/mcp`) return json(400, { error: "invalid_grant" });
      } else if (form.refresh_token !== "refresh-1") return json(400, { error: "invalid_grant" });
      const token = `good-${++issued}`;
      seen.valid.add(token);
      return json(200, { access_token: token, refresh_token: "refresh-1", expires_in: 3600, token_type: "Bearer" });
    }
    if (url.pathname === "/mcp") {
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!seen.valid.has(bearer)) return json(401, { error: "unauthorized" }, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
      const message = JSON.parse(raw) as { id?: number; method: string };
      if (message.id === undefined) { res.writeHead(202); return res.end(); }
      const result = message.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "pages", version: "1" } }
        : message.method === "tools/list" ? { tools: [{ name: "search_pages", description: "Searches the pages", inputSchema: { type: "object", properties: {} } }] }
          : { content: [{ type: "text", text: "3 pages" }] };
      // As an event stream, as Streamable HTTP may answer.
      res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "s1" });
      return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
    }
    json(404, {});
  });
});
await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const app = await buildApp();
test.after(async () => { await app.close(); await new Promise((resolve) => service.close(resolve)); });
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const headers = { authorization: `Bearer ${paired.json().token}`, host: "127.0.0.1:47821" };
let id = "";
let authorizationUrl: URL;

test("a service that asks for a sign-in: the connector says so, and Twoody registers itself there", async () => {
  const added = await app.inject({ method: "POST", url: "/connectors", headers, payload: { connector: { name: "Pages", url: `${base}/mcp` } } });
  assert.equal(added.statusCode, 201, added.body);
  id = added.json().connector.id;
  assert.deepEqual(added.json().connector.oauth, { required: true, connected: false, service: null, client_id_given: false });
  const started = await app.inject({ method: "POST", url: `/connectors/${id}/oauth/start`, headers });
  assert.equal(started.statusCode, 200, started.body);
  authorizationUrl = new URL(started.json().authorization_url);
  assert.equal(authorizationUrl.origin + authorizationUrl.pathname, `${base}/authorize`);
  const params = Object.fromEntries(authorizationUrl.searchParams);
  assert.equal(params.client_id, "twoody-client");
  assert.equal(params.redirect_uri, "http://127.0.0.1:47821/connectors/oauth/callback");
  assert.equal(params.code_challenge_method, "S256");
  assert.equal(params.resource, `${base}/mcp`);
  assert.equal(params.scope, "pages.read");
  assert.deepEqual((seen.registered[0] as { redirect_uris: string[] }).redirect_uris, ["http://127.0.0.1:47821/connectors/oauth/callback"]);
  seen.challenge = params.code_challenge!;
  // Only from this computer: a sign-in page whose way back is elsewhere is refused.
  // (The server's own guard turns a foreign host away first: 421.)
  assert.ok([421, 422].includes((await app.inject({ method: "POST", url: `/connectors/${id}/oauth/start`, headers: { ...headers, host: "twoody.example.com" } })).statusCode));
});

test("the browser comes back with the code: tokens kept on this computer, never shown, and the tools read", async () => {
  const back = await app.inject({ url: `/connectors/oauth/callback?code=the-code&state=${authorizationUrl.searchParams.get("state")}` });
  assert.equal(back.statusCode, 200);
  assert.match(back.body, /Twoody est connecté à Pages/);
  let connector: { oauth: { connected: boolean; required: boolean; service: string }; tools: Array<{ name: string }> } | undefined;
  for (let i = 0; i < 100 && !connector?.tools.length; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    connector = (await app.inject({ url: "/connectors", headers })).json().connectors[0];
  }
  assert.deepEqual(connector!.tools.map((tool) => tool.name), ["search_pages"]);
  assert.deepEqual([connector!.oauth.connected, connector!.oauth.required], [true, false]);
  const listed = (await app.inject({ url: "/connectors", headers })).body;
  assert.doesNotMatch(listed, /good-1|refresh-1/);
  assert.match(readFileSync(join(process.env.TWOODY_DATA_DIR!, "connectors.json"), "utf8"), /refresh-1/);
  // The same state cannot be used twice.
  const again = await app.inject({ url: `/connectors/oauth/callback?code=the-code&state=${authorizationUrl.searchParams.get("state")}` });
  assert.match(again.body, /expiré/);
});

test("a token the service no longer takes is renewed with the refresh token, once", async () => {
  seen.valid.delete("good-1");
  const restarted = await app.inject({ method: "POST", url: `/connectors/${id}/start`, headers });
  assert.equal(restarted.statusCode, 200, restarted.body);
  assert.equal(seen.tokens.at(-1)!.grant_type, "refresh_token");
  assert.equal(seen.tokens.at(-1)!.resource, `${base}/mcp`);
});

test("signed out: the tokens go; the service asks again", async () => {
  const out = await app.inject({ method: "POST", url: `/connectors/${id}/oauth/sign_out`, headers });
  assert.equal(out.json().connector.oauth.connected, false);
  assert.doesNotMatch(readFileSync(join(process.env.TWOODY_DATA_DIR!, "connectors.json"), "utf8"), /good-2/);
  const refused = await app.inject({ method: "POST", url: `/connectors/${id}/start`, headers });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().error, "sign_in_required");
});
