import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// What ChatGPT, Claude, Gemini or Copilot knows of the person, pasted back
// (29/09/2026): each fact a memory, the whole answer kept.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-import-"));

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { factsFromImport, kindOfFact } = await import("../src/memoryLearning.js");

const app = await buildApp();
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "iPhone" } });
const headers = { authorization: `Bearer ${paired.json().token}` };

const ANSWER = `Voici ce que je sais de vous :

## Identité
- Jimmy habite à Antony.
- Jimmy est consultant IT freelance.
* **Famille** : Jimmy a une compagne, Claire-Sophie.
1. Jimmy préfère des réponses concises, en français.
2. Jimmy travaille sur un projet d'assistant IA local, Twoody.
- Jimmy habite à Antony.
- ok`;

test("an answer's lines become facts: bullets and numbering stripped, headings and repeats left out", () => {
  assert.deepEqual(factsFromImport(ANSWER), [
    "Jimmy habite à Antony.",
    "Jimmy est consultant IT freelance.",
    "Famille : Jimmy a une compagne, Claire-Sophie.",
    "Jimmy préfère des réponses concises, en français.",
    "Jimmy travaille sur un projet d'assistant IA local, Twoody.",
  ]);
  assert.equal(kindOfFact("Jimmy préfère des réponses concises, en français."), "feedback");
  assert.equal(kindOfFact("Jimmy travaille sur un projet d'assistant IA local, Twoody."), "project");
  assert.equal(kindOfFact("Jimmy habite à Antony."), "user");
});

test("an import keeps each fact once, and the whole answer", async () => {
  const first = await app.inject({ method: "POST", url: "/api/v1/memories/import", headers, payload: { text: ANSWER, source: "chatgpt" } });
  assert.equal(first.statusCode, 201);
  const body = first.json();
  assert.equal(body.imported, 5);
  assert.equal(body.skipped, 0);
  assert.ok(body.memories.every((row: { source: string; source_ref: string; tags: string[] }) => row.source === "import" && row.source_ref === "chatgpt" && row.tags.includes("import")));
  const archive = (await app.inject({ method: "GET", url: `/api/v1/memories/${body.archive_id}`, headers })).json();
  assert.equal(archive.kind, "reference");
  assert.match(archive.title, /Import ChatGPT du/);
  assert.match(archive.content, /Claire-Sophie/);

  const again = (await app.inject({ method: "POST", url: "/api/v1/memories/import", headers, payload: { text: ANSWER, source: "claude" } })).json();
  assert.equal(again.imported, 0);
  assert.equal(again.skipped, 5);

  assert.equal((await app.inject({ method: "POST", url: "/api/v1/memories/import", headers, payload: { text: "  \n- ok\n" } })).statusCode, 400);
});
