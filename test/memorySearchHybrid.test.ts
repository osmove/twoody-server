import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Mémoire v2, lot L5a: /memories/search with this computer's memory vectors
// — 0.7·cosine + 0.3·lexical (+0.15 for a named entity), every memory
// ranked, no threshold. A fake embedding worker puts words of one meaning
// on one dimension, so a question shares no word with the memory it finds.

const dir = mkdtempSync(join(tmpdir(), "twoody-memory-search-hybrid-"));
process.env.TWOODY_DATA_DIR = join(dir, "data");
process.env.TWOODY_BONJOUR_DISABLED = "1";
const fake = join(dir, "fake-llama-server.cjs");
writeFileSync(fake, `#!/usr/bin/env node
const http = require("http");
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const key = args[args.indexOf("--api-key") + 1];
const MEANING = { cacahuetes: "food", arachides: "food", allergies: "food", alimentaires: "food", velo: "sport", course: "sport" };
http.createServer((req, res) => {
  if (req.headers.authorization !== "Bearer " + key) { res.writeHead(401); return res.end(); }
  if (req.url === "/health") { res.writeHead(200); return res.end("{}"); }
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const input = String(JSON.parse(raw).input).split("Query: ").at(-1);
    const v = new Array(1024).fill(0);
    for (const w of input.normalize("NFD").replace(/\\p{M}/gu, "").toLowerCase().split(/\\W+/).filter(Boolean)) {
      const key = MEANING[w] || w;
      let h = 0;
      for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      v[h % 1024] += MEANING[w] ? 3 : 1;
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
const { stopEmbeddings } = await import("../src/embeddings.js");
const { embedPendingMemories } = await import("../src/memory/embeddings.js");
const { flushMemoryWork } = await import("../src/memory/changes.js");

const app = await buildApp();
test.after(async () => {
  stopEmbeddings();
  await app.close();
});

const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const headers = { authorization: `Bearer ${paired.json().token}` };
const userId = paired.json().user_id as string;
const memory = async (content: string) => (await app.inject({ method: "POST", url: "/api/v1/memories", headers, payload: { memory: { content } } })).json().id as string;

test("hybrid: the memory of the same meaning comes first without a word in common; every memory ranked, each with its cosine", async () => {
  const peanuts = await memory("Élodie ne supporte pas les cacahuètes.");
  const bike = await memory("Mathieu fait du vélo le dimanche.");
  const flat = await memory("L'appartement fait 62 mètres carrés.");
  await flushMemoryWork();
  await embedPendingMemories(userId, { busy: () => false });
  const res = await app.inject({ url: `/api/v1/memories/search?q=${encodeURIComponent("allergies alimentaires")}`, headers });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { mode: string; items: Array<{ id: string; score: number; cosine: number; lexical: number }> };
  assert.equal(body.mode, "hybrid");
  assert.equal(body.items[0].id, peanuts);
  assert.equal(body.items[0].lexical, 0, "no word in common");
  assert.ok(body.items[0].cosine > 0.3, String(body.items[0].cosine));
  assert.deepEqual(body.items.map((i) => i.id).sort(), [peanuts, bike, flat].sort(), "no threshold: every memory, ranked");
  for (const item of body.items) assert.ok(Math.abs(item.score - (0.7 * item.cosine + 0.3 * item.lexical)) < 1e-3);
  // The meaning and a word in common: both found, ahead of the third.
  const mixed = (await app.inject({ url: `/api/v1/memories/search?q=${encodeURIComponent("course appartement")}&limit=2`, headers })).json() as typeof body;
  assert.deepEqual(mixed.items.map((i) => i.id), [bike, flat]);
  assert.ok(mixed.items[1].lexical > 0 && mixed.items[0].lexical === 0, "one by meaning, one by its word");
});
