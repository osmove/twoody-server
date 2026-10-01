import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Mémoire v2, lot L1 (docs/memory-v2-design.md §3): the memories get vectors
// from this computer's embedding model, on by default once its files are
// here, made after a write when the computer generates nothing, kept in
// memory_embeddings by memory and model with the hash of their text, and
// read through a cache dropped at every write. The documents keep their
// own switch. The model is a stand-in llama-server (a node script) that
// logs what it is asked to embed.

const dir = mkdtempSync(join(tmpdir(), "twoody-memory-embeddings-"));
process.env.TWOODY_DATA_DIR = join(dir, "data");
const log = join(dir, "embedded.log");
writeFileSync(log, "");
const fake = join(dir, "fake-llama-server.cjs");
writeFileSync(fake, `#!/usr/bin/env node
const http = require("http");
const fs = require("fs");
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const key = args[args.indexOf("--api-key") + 1];
http.createServer((req, res) => {
  if (req.headers.authorization !== "Bearer " + key) { res.writeHead(401); return res.end(); }
  if (req.url === "/health") { res.writeHead(200); return res.end("{}"); }
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const { input } = JSON.parse(raw);
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(input) + "\\n");
    // Words hashed into 1024 dimensions: the same text, the same vector.
    const v = new Array(1024).fill(0);
    for (const w of String(input).toLowerCase().split(/\\W+/).filter(Boolean)) {
      let h = 0;
      for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      v[h % 1024] += 1;
    }
    v[1023] += 0.001;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ embedding: v }] }));
  });
}).listen(port, "127.0.0.1");
`);
chmodSync(fake, 0o755);
process.env.TWOODY_EMBEDDING_BINARY = fake;
process.env.TWOODY_EMBEDDING_MODEL = fake;

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { sqlite } = await import("../src/db.js");
const { EMBED_MODEL, stopEmbeddings } = await import("../src/embeddings.js");
const { embedMemoryQuery, embedPendingMemories, memoryVectors, MEMORY_QUERY_INSTRUCTION } = await import("../src/memory/embeddings.js");
const { flushMemoryWork } = await import("../src/memory/changes.js");
const { semanticStatus } = await import("../src/documents/semantic.js");
const { beginGeneration } = await import("../src/account/inflight.js");

const app = await buildApp();
test.after(async () => {
  stopEmbeddings();
  await app.close();
});

const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const headers = { authorization: `Bearer ${paired.json().token}` };
const userId = paired.json().user_id as string;
const embedded = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string);
const rows = () => sqlite.prepare("SELECT memory_id, model, hash FROM memory_embeddings WHERE user_id = ? ORDER BY memory_id").all(userId) as Array<{ memory_id: string; model: string; hash: string }>;
const write = async (content: string, title: string | null = null) => {
  const res = await app.inject({ method: "POST", url: "/memories", headers, payload: { memory: { content, title } } });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().id as string;
};

test("on by default with the model files here; the documents' switch stays off", async () => {
  const me = (await app.inject({ url: "/me", headers })).json();
  assert.equal(me.memory_embeddings, true);
  assert.equal(me.memory_embedding_status.enabled, true);
  assert.equal(me.memory_embedding_status.available, true);
  assert.equal(semanticStatus(userId).enabled, false, "« Rechercher par le sens » for documents is its own switch");
});

test("a memory written gets its vector a moment later, keyed by memory and model; the cache follows every write", async () => {
  const id = await write("Élodie aime le jazz manouche.", "Musique");
  assert.equal(memoryVectors(userId).has(id), false, "not embedded yet");
  await flushMemoryWork();
  assert.deepEqual(rows().map((r) => [r.memory_id, r.model]), [[id, EMBED_MODEL]]);
  assert.equal(embedded().at(-1), "Musique: Élodie aime le jazz manouche.", "a passage is embedded as it is, with its title");
  const first = memoryVectors(userId).get(id)!;
  assert.equal(first.length, 1024);
  assert.ok(Math.abs(first.reduce((s, x) => s + x * x, 0) - 1) < 1e-4, "normalised");

  // Edited: the old vector no longer counts at once, a new one is made.
  assert.equal((await app.inject({ method: "PATCH", url: `/memories/${id}`, headers, payload: { memory: { content: "Élodie aime le jazz et la bossa nova." } } })).statusCode, 200);
  assert.equal(memoryVectors(userId).has(id), false, "the cache was dropped, and the stale vector is not read");
  await flushMemoryWork();
  assert.equal(embedded().at(-1), "Musique: Élodie aime le jazz et la bossa nova.");
  assert.ok(memoryVectors(userId).has(id));

  // Deleted: its vector goes.
  assert.equal((await app.inject({ method: "DELETE", url: `/memories/${id}`, headers })).statusCode, 204);
  assert.equal(memoryVectors(userId).has(id), false);
  await flushMemoryWork();
  assert.deepEqual(rows(), []);
});

test("the same text twice is embedded once; nothing is embedded while the computer generates", async () => {
  const a = await write("Léa est en CM2.");
  await flushMemoryWork();
  const calls = embedded().length;
  const b = await write("Léa est en CM2.");
  await flushMemoryWork();
  assert.equal(embedded().length, calls, "the vector there is was taken");
  assert.ok(memoryVectors(userId).has(a) && memoryVectors(userId).has(b));

  const done = beginGeneration("chat");
  try {
    await write("Hugo fait du judo le mercredi.");
    const result = await embedPendingMemories(userId);
    assert.equal(result.yielded, true);
    assert.equal(result.embedded, 0);
    assert.equal(embedded().length, calls);
  } finally {
    done();
  }
  await flushMemoryWork();
  assert.equal(embedded().at(-1), "Hugo fait du judo le mercredi.");
});

test("a question is embedded with the memories' own instruction", async () => {
  const vector = await embedMemoryQuery("Que fait Hugo le mercredi ?");
  assert.equal(vector.length, 1024);
  assert.equal(embedded().at(-1), `Instruct: ${MEMORY_QUERY_INSTRUCTION}\nQuery: Que fait Hugo le mercredi ?`);
});

test("switched off in /me: the vectors go and none is made; on again, they come back", async () => {
  const off = await app.inject({ method: "PATCH", url: "/me", headers, payload: { user: { memory_embeddings: false } } });
  assert.equal(off.json().memory_embeddings, false);
  await flushMemoryWork();
  assert.deepEqual(rows(), []);
  const calls = embedded().length;
  await write("Le chien s'appelle Pilou.");
  await flushMemoryWork();
  assert.equal(embedded().length, calls);
  assert.equal(memoryVectors(userId).size, 0);

  await app.inject({ method: "PATCH", url: "/me", headers, payload: { user: { memory_embeddings: true } } });
  await flushMemoryWork();
  const count = (sqlite.prepare("SELECT COUNT(*) AS n FROM memories WHERE user_id = ?").get(userId) as { n: number }).n;
  assert.equal(rows().length, count);
  assert.equal((await app.inject({ url: "/me", headers })).json().memory_embedding_status.indexed, count);
});
