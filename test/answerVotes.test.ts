import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// 👍 / 👎 under an answer (Jimmy, 28/10/2026): kept on this computer, one per
// answer, changed or taken back; what may go to Osmove is handed back
// (`share`): the vote, the reason and comment of a 👎, the model's catalog
// name, and the answer's technical details — never a word of the
// conversation, and nothing at all for a walled-off project's answer.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-votes-"));
delete process.env.TWOODY_USER_TOKEN;
delete process.env.TWOODY_DEVICE_TOKEN;
delete process.env.TWOODY_BACKEND_URL;

const { buildApp } = await import("../src/app.js");
const { createAuthSession, ensureSetupToken } = await import("../src/auth.js");
const { sqlite } = await import("../src/db.js");
const { recordTrace } = await import("../src/diagnostics/traces.js");

const app = await buildApp();
await app.ready();
test.after(() => app.close());
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const owner = paired.json().user_id as string;
const desktop = { authorization: `Bearer ${paired.json().token}` };
// Not « the person » here (no tunnel of its own key).
const stranger = { authorization: `Bearer ${createAuthSession(owner, "pair:iPhone").token}` };

const now = Date.now();
sqlite.prepare("INSERT INTO projects (id, user_id, title, isolated, created_at, updated_at) VALUES ('p-walled', ?, 'Dossier Tessane', 1, ?, ?)").run(owner, now, now);
for (const [id, project] of [["d-open", null], ["d-walled", "p-walled"]] as const) {
  sqlite.prepare("INSERT INTO discussions (id, user_id, project_id, created_at, last_activity_at) VALUES (?, ?, ?, ?, ?)").run(id, owner, project, now, now);
  sqlite.prepare("INSERT INTO messages (id, discussion_id, user_id, role, content, created_at) VALUES (?, ?, ?, 'user', 'Allume la cuisine', ?)").run(`q-${id}`, id, owner, now);
  sqlite.prepare("INSERT INTO messages (id, discussion_id, user_id, role, content, model, created_at) VALUES (?, ?, ?, 'assistant', 'La cuisine est allumée.', 'Qwen3.5-9B-Q4_K_M.gguf', ?)").run(`a-${id}`, id, owner, now);
  recordTrace(owner, {
    kind: "chat", discussionId: id, messageId: `a-${id}`, model: "/Users/x/models/Qwen3.5-9B-Q4_K_M.gguf", outcome: "answered", totalMs: 2400,
    detail: { provider: "builtin", tool_calls: [{ name: "control_home", ms: 30, arguments: { device: "la cuisine de Claire" } }], prompt: { last_chars: 17 } },
  } as never);
}

const vote = (message: string, payload: Record<string, unknown>, headers = desktop) => app.inject({ method: "PUT", url: `/messages/${message}/vote`, headers, payload });

test("a 👎 with its reason and comment is kept, and what may go to Osmove holds no word of the conversation", async () => {
  const response = await vote("a-d-open", { vote: "down", reason: "said_done", comment: "  Rien ne s'est passé.  " });
  assert.equal(response.statusCode, 200);
  const { vote: kept, share } = response.json();
  assert.equal(kept.vote, "down");
  assert.equal(kept.reason, "said_done");
  assert.equal(kept.comment, "Rien ne s'est passé.");
  assert.equal(share.vote, "down");
  assert.equal(share.message_id, "a-d-open");
  assert.equal(share.comment, "Rien ne s'est passé.");
  assert.equal(share.model, "Qwen3.5-9B-Q4_K_M", "the catalog name, never the path");
  assert.equal(share.telemetry.tool_names, "control_home");
  assert.equal(share.telemetry.total_ms, 2400);
  const sent = JSON.stringify(share);
  for (const word of ["cuisine", "allum", "Claire", "/Users/x"]) assert.ok(!sent.includes(word), `${word} in ${sent}`);
});

test("one vote per answer: changed, then taken back, then given again; a 👍 has no reason", async () => {
  const up = (await vote("a-d-open", { vote: "up", reason: "wrong", comment: "x" })).json();
  assert.equal(up.vote.vote, "up");
  assert.equal(up.vote.reason, null);
  assert.equal(up.share.comment, null);
  const back = (await vote("a-d-open", { vote: null })).json();
  assert.equal(back.vote, null);
  assert.equal(back.share.vote, null, "the account is told it was taken back");
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM answer_votes").get() as { n: number }).n, 1);
  assert.deepEqual((await app.inject({ method: "GET", url: "/discussions/d-open/votes", headers: desktop })).json().votes, []);
  await vote("a-d-open", { vote: "down", reason: "nonsense" });
  const listed = (await app.inject({ method: "GET", url: "/discussions/d-open/votes", headers: desktop })).json().votes;
  assert.deepEqual(listed.map((row: { message_id: string; vote: string; reason: string | null }) => [row.message_id, row.vote, row.reason]), [["a-d-open", "down", null]]);
});

test("only an answer of the person's own takes a vote", async () => {
  assert.equal((await vote("q-d-open", { vote: "up" })).statusCode, 404, "a question");
  assert.equal((await vote("nothing", { vote: "up" })).statusCode, 404);
});

test("a walled-off project's answer: kept here, never shared, and unknown where its conversations are not reached", async () => {
  const response = await vote("a-d-walled", { vote: "down", reason: "wrong", comment: "Le montant est faux." });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().vote.vote, "down");
  assert.equal(response.json().share, null);
  assert.equal((await vote("a-d-walled", { vote: "up" }, stranger)).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/discussions/d-walled/votes", headers: stranger })).statusCode, 404);
});
