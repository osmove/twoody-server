import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A session given to another computer of the account (`peer:<name>`)
// reaches /api/v1/peer/* and nothing else, whatever carries its token: a
// header, the WebSocket's `?token=`, or a request made up from one.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-peer-scope-"));

const { buildApp } = await import("../src/app.js");
const { authenticate, ensureSetupToken } = await import("../src/auth.js");
const { pairDevice } = await import("../src/pairing.js");

const app = await buildApp();
await app.ready();
test.after(() => app.close());

const desktop = (await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } })).json();
const peer = pairDevice({ deviceName: "Mac mini", role: "peer" });

async function firstMessage(url: string): Promise<{ type: string; error?: string }> {
  let socket: { terminate(): void } | null = null;
  const message = new Promise<{ type: string; error?: string }>((resolve, reject) => {
    void app
      .injectWS(url, {}, {
        onInit: (ws) => {
          socket = ws;
          ws.once("message", (raw: Buffer) => resolve(JSON.parse(raw.toString())));
          ws.once("error", reject);
        },
      })
      .catch(reject);
  });
  try {
    return await message;
  } finally {
    (socket as { terminate(): void } | null)?.terminate();
  }
}

test("/ws refuses a peer session's ?token=, and takes the Desktop's", async () => {
  assert.deepEqual(await firstMessage(`/ws?token=${encodeURIComponent(peer.token)}`), { type: "error", error: "unauthorized" });
  assert.equal((await firstMessage(`/ws?token=${encodeURIComponent(desktop.token)}`)).type, "hello");
});

test("authenticate() refuses a peer session outside /api/v1/peer/*, however the request was made", async () => {
  const as = (url: string | undefined, headers: Record<string, string>) => authenticate({ url, headers } as never);
  assert.equal(await as("/api/v1/me", { authorization: `Bearer ${peer.token}` }), null);
  assert.equal(await as("/api/v1/me", { "x-user-token": peer.token }), null);
  assert.equal(await as(undefined, { authorization: `Bearer ${peer.token}` }), null, "a request with no url is not one for /api/v1/peer/*");
  assert.equal(await as("/api/v1/peer/../me", { authorization: `Bearer ${peer.token}` }), null);
  assert.equal(await as("/api/v1/peer/%2e%2e/me", { authorization: `Bearer ${peer.token}` }), null);
  assert.equal((await as("/api/v1/peer/status", { authorization: `Bearer ${peer.token}` }))?.sessionId, peer.sessionId);
  assert.ok(await as("/api/v1/me", { authorization: `Bearer ${desktop.token}` }), "other sessions are not concerned");
});

test("over HTTP, a peer session is refused outside /api/v1/peer/*, in a header or in the query", async () => {
  for (const url of ["/api/v1/me", "/api/v1/discussions", `/api/v1/me?token=${peer.token}`]) {
    const response = await app.inject({ method: "GET", url, headers: url.includes("?token=") ? {} : { "x-user-token": peer.token } });
    assert.ok([401, 403].includes(response.statusCode), `${url}: ${response.statusCode}`);
  }
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/peer/status", headers: { "x-user-token": peer.token } })).statusCode, 200);
});
