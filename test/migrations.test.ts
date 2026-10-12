// Versioned migrations (src/migrations): a database from before them —
// dates in seconds, « macos-<hex> » ids, contacts' phones as strings, the
// old table and column names — comes out converged, its rows all kept and
// a copy saved first; a fresh one comes out the same; a newer one is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyBaseline } from "../src/migrations/baseline.ts";
import { migrate, SCHEMA_VERSION, schemaVersion } from "../src/migrations/index.ts";

const quiet = () => undefined;
const tables = (db: Database.Database) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%fts%' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'document_chunks%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
const columns = (db: Database.Database, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);

function legacyDatabase() {
  const dir = mkdtempSync(join(tmpdir(), "twoody-migrations-"));
  const db = new Database(join(dir, "local.db"));
  legacyBaseline(db);
  const s = 1_790_000_000; // seconds, as before
  const hex = "0123456789abcdef0123456789abcdef";
  db.prepare("INSERT INTO users (id, email, prefs_json, created_at) VALUES ('u1', 'u@example.com', '{\"memory_mode\":\"full\"}', ?)").run(s);
  db.prepare("INSERT INTO discussions (id, user_id, channel, title, created_at, last_activity_at) VALUES ('d1', 'u1', 'desktop', 'Bonjour', ?, ?)").run(s, s);
  db.prepare("INSERT INTO messages (id, discussion_id, user_id, role, content, sources_json, created_at) VALUES ('m1', 'd1', 'u1', 'assistant', 'Les tomates', '[{\"n\":1}]', ?)").run(s);
  db.prepare("INSERT INTO contacts (id, user_id, name, origin, phones_json, emails_json, created_at, updated_at) VALUES (?, 'u1', 'Paul', 'macos', '[\"0612\"]', '[]', ?, ?)").run(`macos-${hex}`, s, s);
  db.prepare("INSERT INTO memories (id, user_id, kind, content, tags_json, entity_type, entity_id, created_at, updated_at) VALUES ('mem1', 'u1', 'user', 'Paul est mon frère', '[\"important\"]', 'contact', ?, ?, ?)").run(`macos-${hex}`, s, s);
  db.prepare("INSERT INTO providers (id, user_id, kind, name, created_at, updated_at) VALUES ('p1', 'u1', 'local_openai', 'llama', ?, ?)").run(s, s);
  db.prepare("INSERT INTO usage_events (id, user_id, at, source, prompt_tokens, completion_tokens, message_id) VALUES ('e1', 'u1', ?, 'chat', 10, 2, 'm1')").run(s * 1000);
  db.prepare("INSERT INTO account_peers (computer_id, user_id, name, state, enabled, created_at, updated_at) VALUES ('c1', 'u1', 'Pi', 'linked', 1, ?, ?)").run(s, s);
  db.prepare("INSERT INTO turn_traces (id, user_id, at, kind, message_id, outcome, trace_json) VALUES ('t1', 'u1', ?, 'chat', 'm1', 'answered', '{\"tokens\":{}}')").run(s * 1000);
  db.prepare("INSERT INTO turn_prompts (trace_id, user_id, message_id, prompt_json) VALUES ('t1', 'u1', 'm1', '{\"messages\":[]}')").run();
  return { dir, db, hex, s };
}

test("a database from before migrations comes out converged, every row kept, a copy saved first", () => {
  const { dir, db, hex, s } = legacyDatabase();
  migrate(db, { dataDir: dir, log: quiet });
  assert.equal(schemaVersion(db), SCHEMA_VERSION);
  assert.equal(readdirSync(join(dir, "backups")).length, 1, "a copy of the database from before");

  for (const gone of ["usage_events", "providers", "account_peers", "turn_traces", "turn_prompts"]) assert.ok(!tables(db).includes(gone), gone);
  assert.deepEqual(db.prepare("SELECT id, occurred_at FROM model_calls").all(), [{ id: "e1", occurred_at: s * 1000 }]);
  assert.equal((db.prepare("SELECT name FROM llm_endpoints").get() as { name: string }).name, "llama");
  assert.equal((db.prepare("SELECT name FROM account_computers").get() as { name: string }).name, "Pi");
  assert.deepEqual(db.prepare("SELECT id, occurred_at, trace, prompt FROM message_traces").get(), { id: "t1", occurred_at: s * 1000, trace: '{"tokens":{}}', prompt: '{"messages":[]}' });

  for (const [table, gone] of [["users", "prefs_json"], ["messages", "sources_json"], ["memories", "tags_json"], ["contacts", "phones_json"]]) assert.ok(!columns(db, table).includes(gone), `${table}.${gone}`);
  assert.equal((db.prepare("SELECT prefs FROM users").get() as { prefs: string }).prefs, '{"memory_mode":"full"}');
  assert.equal((db.prepare("SELECT created_at FROM users").get() as { created_at: number }).created_at, s * 1000);
  assert.deepEqual(db.prepare("SELECT created_at, last_activity_at FROM discussions").get(), { created_at: s * 1000, last_activity_at: s * 1000 });
  // Migration 3: where a title comes from; unknown for the ones before.
  assert.deepEqual(db.prepare("SELECT title, title_source FROM discussions").get(), { title: "Bonjour", title_source: null });

  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  assert.deepEqual(db.prepare("SELECT id, phones, emails FROM contacts").get(), { id: uuid, phones: '[{"label":null,"value":"0612"}]', emails: "[]" });
  assert.deepEqual(db.prepare("SELECT entity_id, tags, confidence FROM memories").get(), { entity_id: uuid, tags: '["important"]', confidence: 1 });

  // The conversations' index came back on the renamed column.
  assert.equal((db.prepare("SELECT count(*) AS n FROM message_fts").get() as { n: number }).n, 1);
  db.prepare("UPDATE users SET prefs = '{\"memory_mode\":\"none\"}'").run();
  assert.equal((db.prepare("SELECT count(*) AS n FROM message_fts").get() as { n: number }).n, 0, "the person's memory mode still drives the index");

  // Run again: nothing to do, nothing saved again.
  migrate(db, { dataDir: dir, log: quiet });
  assert.equal(readdirSync(join(dir, "backups")).length, 1);
  assert.equal(db.pragma("foreign_key_check").length, 0);
});

test("a fresh database gets the same schema, without a copy", () => {
  const dir = mkdtempSync(join(tmpdir(), "twoody-migrations-"));
  const fresh = new Database(join(dir, "local.db"));
  migrate(fresh, { dataDir: dir, log: quiet });
  assert.ok(!existsSync(join(dir, "backups")));
  const { dir: oldDir, db: old } = legacyDatabase();
  migrate(old, { dataDir: oldDir, log: quiet });
  assert.deepEqual(tables(fresh), tables(old));
  for (const table of tables(old)) assert.deepEqual(columns(fresh, table).sort(), columns(old, table).sort(), table);
});

test("a database a newer Twoody migrated is refused, not misread", () => {
  const dir = mkdtempSync(join(tmpdir(), "twoody-migrations-"));
  const db = new Database(join(dir, "local.db"));
  db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
  assert.throws(() => migrate(db, { dataDir: dir, log: quiet }), /newer than this server/);
});

test("migration 9 indexes the Japanese, Chinese and Korean passages already there by their pairs, every passage kept as it was", () => {
  const dir = mkdtempSync(join(tmpdir(), "twoody-migrations-"));
  const db = new Database(join(dir, "local.db"));
  migrate(db, { dataDir: dir, log: quiet });
  // A library indexed by version 8: passages, and no document_grams yet.
  db.exec("DROP TABLE document_grams");
  db.pragma("user_version = 8");
  db.prepare("INSERT INTO users (id, email, created_at) VALUES ('u1', 'u@example.com', ?)").run(Date.now());
  const passages = [
    ["ja", "各当事者は、三か月の解約予告期間をもって書面で通知する。"],
    ["fr", "Chaque partie peut le résilier avec un préavis de trois mois."],
    ["zh", "解除通知期为三个月。"],
    ["ko", "3개월의 해지 예고 기간을 두고"],
  ];
  for (const [id, text] of passages) db.prepare("INSERT INTO document_chunks (text, document_id, user_id, page, position) VALUES (?, ?, 'u1', 1, 0)").run(text, id);
  const before = db.prepare("SELECT rowid, text, document_id FROM document_chunks ORDER BY rowid").all();

  migrate(db, { dataDir: dir, log: quiet });
  assert.equal(schemaVersion(db), SCHEMA_VERSION);
  assert.equal(readdirSync(join(dir, "backups")).length, 1, "a copy of the database from before");
  assert.deepEqual(db.prepare("SELECT rowid, text, document_id FROM document_chunks ORDER BY rowid").all(), before, "the passages as they were");
  assert.deepEqual((db.prepare("SELECT document_id FROM document_grams ORDER BY rowid").all() as Array<{ document_id: string }>).map((row) => row.document_id), ["ja", "zh", "ko"]);
  const found = (query: string) => (db.prepare("SELECT c.document_id FROM document_grams g JOIN document_chunks c ON c.rowid = g.rowid WHERE document_grams MATCH ?").all(query) as Array<{ document_id: string }>).map((row) => row.document_id);
  assert.deepEqual(found('"解約 約予 予告 告期 期間"'), ["ja"]);
  assert.deepEqual(found('"解除 除通 通知 知期"'), ["zh"]);
  assert.deepEqual(found('"해지" AND "예고" AND "기간"'), ["ko"]);
});
