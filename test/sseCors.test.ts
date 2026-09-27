import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A browser only reads an answer that says it may: the stream of
// /queries is written to the raw response, which skipped the CORS headers
// Fastify's hook had set — a web client saw every answer blocked.
process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-sse-cors-"));

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");

const llm = createServer((req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "tiny" }] }));
    return;
  }
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Bonjour" } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((resolve) => llm.listen(0, "127.0.0.1", resolve));
const llmUrl = `http://127.0.0.1:${(llm.address() as AddressInfo).port}`;

const app = await buildApp();
const paired = await app.inject({
  method: "POST",
  url: "/auth/pair",
  payload: { setup_token: ensureSetupToken()!.token, device_name: "Web" },
});
const headers = { authorization: `Bearer ${paired.json().token}` };
await app.inject({ method: "POST", url: "/providers/local", headers, payload: { url: `${llmUrl}/v1`, model: "tiny" } });

test.after(async () => {
  await app.close();
  await new Promise((resolve) => llm.close(resolve));
});

test("the answer's stream carries the CORS headers a browser needs", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/queries",
    headers: { ...headers, origin: "http://localhost:8081", accept: "text/event-stream", "content-type": "application/json" },
    payload: { content: "Bonjour", force_new_discussion: true },
  });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers["content-type"]), /text\/event-stream/);
  assert.equal(response.headers["access-control-allow-origin"], "http://localhost:8081");
  assert.match(response.body, /event: final/);
});
