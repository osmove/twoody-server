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

test("migration 11 makes file_actions, and keeps the one a computer made on first use with its rows; migration 12 adds entities.removed_at (archived_at since 14)", () => {
  const made = (db: Database.Database) => db.exec(`CREATE TABLE IF NOT EXISTS file_actions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, discussion_id TEXT NOT NULL, message_id TEXT, kind TEXT NOT NULL, status TEXT NOT NULL,
      plan TEXT NOT NULL, result TEXT, asker_session TEXT, asker_app INTEGER NOT NULL DEFAULT 0, model TEXT, language TEXT NOT NULL,
      created_at INTEGER NOT NULL, decided_at INTEGER, done_at INTEGER);
    CREATE INDEX IF NOT EXISTS file_actions_discussion ON file_actions(discussion_id);
    CREATE INDEX IF NOT EXISTS file_actions_message ON file_actions(message_id);`);
  const atVersion10 = (withTable: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), "twoody-migrations-"));
    const db = new Database(join(dir, "local.db"));
    migrate(db, { dataDir: dir, log: quiet, upTo: 10 });
    db.prepare("INSERT INTO users (id, email, created_at) VALUES ('u1', 'u@example.com', ?)").run(Date.now());
    db.prepare("INSERT INTO entities (id, user_id, kind, name, norm, source, created_at, updated_at) VALUES ('e1', 'u1', 'person', 'Nadine', 'nadine', 'manual', 1, 1)").run();
    if (withTable) {
      made(db);
      db.prepare("INSERT INTO file_actions (id, user_id, discussion_id, kind, status, plan, language, created_at) VALUES ('a1', 'u1', 'd1', 'sort', 'done', '{}', 'fr', 1)").run();
    }
    return { dir, db };
  };
  for (const withTable of [true, false]) {
    const { dir, db } = atVersion10(withTable);
    migrate(db, { dataDir: dir, log: quiet });
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    assert.deepEqual(columns(db, "file_actions"), ["id", "user_id", "discussion_id", "message_id", "kind", "status", "plan", "result", "asker_session", "asker_app", "model", "language", "created_at", "decided_at", "done_at"]);
    assert.deepEqual((db.prepare("SELECT id FROM file_actions").all() as Array<{ id: string }>).map((row) => row.id), withTable ? ["a1"] : [], "the rows made before are kept");
    assert.deepEqual(db.prepare("SELECT name, archived_at FROM entities").all(), [{ name: "Nadine", archived_at: null }], "nobody removed by the migration");
    // The store's old first-use statement on a migrated database: nothing changes.
    made(db);
    assert.equal((db.prepare("SELECT count(*) AS n FROM file_actions").get() as { n: number }).n, withTable ? 1 : 0);
  }
});

/// A database as Twoody 0.13.103 and the Pi (a9d161a) leave it — version 12 —
/// with a row in each table migrations 13 to 15 touch.
function atVersion12() {
  const dir = mkdtempSync(join(tmpdir(), "twoody-migrations-"));
  const db = new Database(join(dir, "local.db"));
  migrate(db, { dataDir: dir, log: quiet, upTo: 12 });
  assert.equal(schemaVersion(db), 12);
  db.prepare("INSERT INTO users (id, email, created_at) VALUES ('u1', 'u@example.com', 1)").run();
  const share = (id: string, label: string, right: string, revokedBy: string | null) =>
    db.prepare(`INSERT INTO folder_shares (id, user_id, folder_id, kind, grantee_user_id, label, "right", expires_at, created_at, updated_at, revision, revoked_at, revoked_by)
      VALUES (?, 'u1', 'f1', 'person', '42', ?, ?, NULL, 10, 20, 2, ?, ?)`).run(id, label, right, revokedBy ? 30 : null, revokedBy);
  share("8f0c3a52-1d2e-4c1b-9b7a-0f6c1c2d3e4f", "Contrats", "read", null);
  share("1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9", "Bail", "ask", "grantee");
  const entity = (id: string, name: string, created: number, removed: number | null) =>
    db.prepare("INSERT INTO entities (id, user_id, kind, name, norm, source, created_at, updated_at, removed_at) VALUES (?, 'u1', ?, ?, ?, 'manual', ?, ?, ?)")
      .run(id, id === "self" ? "self" : "person", name, name.toLowerCase(), created, created, removed);
  entity("self", "Moi", 100, null);
  entity("nadine", "Nadine", 200, null);
  entity("paul", "Paul", 300, 400);
  const relation = db.prepare("INSERT INTO entity_relations (from_id, to_id, label, kind, source) VALUES (?, ?, ?, ?, ?)");
  relation.run("self", "nadine", "mère", "mother", "manual");
  relation.run("self", "paul", "frère", "brother", "learned");
  relation.run("nadine", "paul", "fils", "son", "manual");
  db.prepare("INSERT INTO entity_contacts (entity_id, contact_id, how, created_at) VALUES ('nadine', 'c1', 'confirmed', 500)").run();
  db.prepare("INSERT INTO peer_document_audit (user_id, computer_id, action, document_id, name, bytes, at, share_id, outcome) VALUES ('u1', 'share:x', 'search', 'd1', 'bail.pdf', 12, 600, 'x', 'ok')").run();
  return { dir, db };
}

test("migrations 13 to 15 on a version 12 database: the account's names, ids and dates for the people's links, occurred_at; every row kept", () => {
  const { dir, db } = atVersion12();
  migrate(db, { dataDir: dir, log: quiet });
  assert.equal(schemaVersion(db), SCHEMA_VERSION);
  assert.equal(readdirSync(join(dir, "backups")).length, 1, "a copy of the version 12 database first");

  // 13: folder_shares under the account's names, values as they were.
  assert.deepEqual(columns(db, "folder_shares"), ["id", "user_id", "folder_id", "kind", "grantee_user_id", "grantee_name", "organization_id", "organization_name", "folder_label", "access_right", "expires_at", "created_at", "updated_at", "revision", "revoked_at", "revoked_reason", "published_at"]);
  assert.deepEqual(db.prepare("SELECT id, folder_label, access_right, revoked_at, revoked_reason, revision FROM folder_shares ORDER BY created_at, folder_label").all(), [
    { id: "1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9", folder_label: "Bail", access_right: "ask", revoked_at: 30, revoked_reason: "grantee", revision: 2 },
    { id: "8f0c3a52-1d2e-4c1b-9b7a-0f6c1c2d3e4f", folder_label: "Contrats", access_right: "read", revoked_at: null, revoked_reason: null, revision: 2 },
  ]);

  // 14: archived_at, relations with an id and dates, in their order; contacts' updated_at.
  assert.ok(!columns(db, "entities").includes("removed_at"));
  assert.deepEqual(db.prepare("SELECT id, archived_at FROM entities ORDER BY created_at").all(), [{ id: "self", archived_at: null }, { id: "nadine", archived_at: null }, { id: "paul", archived_at: 400 }]);
  assert.deepEqual(columns(db, "entity_relations"), ["id", "from_id", "to_id", "label", "kind", "source", "hlc", "created_at", "updated_at"]);
  const relations = db.prepare("SELECT id, from_id, to_id, label, kind, source, created_at, updated_at FROM entity_relations ORDER BY rowid").all() as Array<{ id: string; from_id: string; to_id: string; label: string; kind: string; source: string; created_at: number; updated_at: number }>;
  assert.deepEqual(relations.map((r) => [r.from_id, r.to_id, r.label, r.kind, r.source, r.created_at, r.updated_at]), [
    ["self", "nadine", "mère", "mother", "manual", 200, 200],
    ["self", "paul", "frère", "brother", "learned", 300, 300],
    ["nadine", "paul", "fils", "son", "manual", 300, 300],
  ], "the later of the two people's dates");
  assert.equal(new Set(relations.map((r) => r.id)).size, 3);
  for (const r of relations) assert.match(r.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.throws(() => db.prepare("INSERT INTO entity_relations (id, from_id, to_id, label, created_at, updated_at) VALUES ('x', 'self', 'nadine', 'mère', 1, 1)").run(), /UNIQUE/, "the pair and label stay unique");
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'entity_relations' AND name = 'idx_entity_relations_to'").all(), [{ name: "idx_entity_relations_to" }]);
  assert.deepEqual(db.prepare("SELECT entity_id, contact_id, how, created_at, updated_at FROM entity_contacts").all(), [{ entity_id: "nadine", contact_id: "c1", how: "confirmed", created_at: 500, updated_at: 500 }]);
  // Deleting a person still takes their links (ON DELETE CASCADE kept).
  db.pragma("foreign_keys = ON");
  assert.deepEqual(db.pragma("foreign_key_check"), []);

  // 15: occurred_at.
  assert.ok(!columns(db, "peer_document_audit").includes("at"));
  assert.deepEqual(db.prepare("SELECT action, name, bytes, occurred_at, share_id, outcome FROM peer_document_audit").all(), [{ action: "search", name: "bail.pdf", bytes: 12, occurred_at: 600, share_id: "x", outcome: "ok" }]);
});

test("migrations 13 to 15 run again change nothing (idempotent), and a fresh database comes out the same as a migrated one", async () => {
  const { folderShareNames } = await import("../src/migrations/0013_folder_share_names.ts");
  const { peopleRows } = await import("../src/migrations/0014_people_rows.ts");
  const { peerDocumentAudit } = await import("../src/migrations/0015_peer_document_audit.ts");
  const { dir, db } = atVersion12();
  migrate(db, { dataDir: dir, log: quiet });
  const snapshot = () => JSON.stringify(["folder_shares", "entities", "entity_relations", "entity_contacts", "peer_document_audit"].map((table) => [columns(db, table), db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const before = snapshot();
  folderShareNames(db);
  peopleRows(db);
  peerDocumentAudit(db);
  assert.equal(snapshot(), before);

  const freshDir = mkdtempSync(join(tmpdir(), "twoody-migrations-"));
  const fresh = new Database(join(freshDir, "local.db"));
  migrate(fresh, { dataDir: freshDir, log: quiet });
  const ddl = (d: Database.Database) => (d.prepare("SELECT name, sql FROM sqlite_master WHERE tbl_name IN ('folder_shares', 'entity_relations', 'entity_contacts', 'peer_document_audit') ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
  assert.deepEqual(ddl(fresh), ddl(db));
  for (const table of ["folder_shares", "entities", "entity_relations", "entity_contacts", "peer_document_audit"]) assert.deepEqual(columns(fresh, table), columns(db, table), table);
});

test("migration 16 gives a walled-off project's folder its identity and its disk's root, every folder kept; run again, it changes nothing", async () => {
  const { walledFolderPlaces } = await import("../src/migrations/0016_walled_folder_places.ts");
  const dir = mkdtempSync(join(tmpdir(), "twoody-migrations-"));
  const db = new Database(join(dir, "local.db"));
  migrate(db, { dataDir: dir, log: quiet, upTo: 15 });
  db.prepare("INSERT INTO users (id, email, created_at) VALUES ('u1', 'u@example.com', 1)").run();
  db.prepare("INSERT INTO projects (id, user_id, title, status, isolated, created_at, updated_at) VALUES ('p1', 'u1', 'Tessane SAS', 'active', 1, 1, 1)").run();
  db.prepare("INSERT INTO document_folders (id, user_id, path, created_at, project_id) VALUES ('f1', 'u1', '/Users/claire/Cabinet', 1, NULL), ('f2', 'u1', '/Users/claire/Cabinet/Tessane', 2, 'p1')").run();
  migrate(db, { dataDir: dir, log: quiet, upTo: 16 });
  assert.equal(schemaVersion(db), 16);
  assert.deepEqual(columns(db, "document_folders").slice(-2), ["identity", "volume"]);
  const rows = () => db.prepare("SELECT id, path, project_id, identity, volume FROM document_folders ORDER BY id").all();
  assert.deepEqual(rows(), [
    { id: "f1", path: "/Users/claire/Cabinet", project_id: null, identity: null, volume: null },
    { id: "f2", path: "/Users/claire/Cabinet/Tessane", project_id: "p1", identity: null, volume: null },
  ]);
  const before = JSON.stringify([columns(db, "document_folders"), rows()]);
  walledFolderPlaces(db);
  assert.equal(JSON.stringify([columns(db, "document_folders"), rows()]), before);
  const freshDir = mkdtempSync(join(tmpdir(), "twoody-migrations-"));
  const fresh = new Database(join(freshDir, "local.db"));
  migrate(fresh, { dataDir: freshDir, log: quiet, upTo: 16 });
  assert.deepEqual(columns(fresh, "document_folders"), columns(db, "document_folders"));
});

test("migration 17 makes the tables of the projects' overviews, every project kept; run again, it changes nothing", async () => {
  const { projectOverviews } = await import("../src/migrations/0017_project_overviews.ts");
  const dir = mkdtempSync(join(tmpdir(), "twoody-migrations-"));
  const db = new Database(join(dir, "local.db"));
  migrate(db, { dataDir: dir, log: quiet, upTo: 16 });
  db.prepare("INSERT INTO users (id, email, created_at) VALUES ('u1', 'u@example.com', 1)").run();
  db.prepare("INSERT INTO projects (id, user_id, title, status, isolated, created_at, updated_at) VALUES ('p1', 'u1', 'Velora', 'active', 1, 1, 1)").run();
  migrate(db, { dataDir: dir, log: quiet, upTo: 17 });
  assert.equal(schemaVersion(db), 17);
  assert.deepEqual(columns(db, "project_overviews"), ["id", "user_id", "project_id", "folder", "language", "sections", "documents", "built_at", "created_at", "updated_at", "deleted_at"]);
  assert.deepEqual(columns(db, "project_overview_versions"), ["id", "overview_id", "sections", "documents", "changes", "status", "created_at", "updated_at", "decided_at"]);
  assert.ok(columns(db, "project_document_digests").includes("items"));
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n, 1);
  const tables = () => JSON.stringify(["project_overviews", "project_overview_versions", "project_document_digests"].map((table) => columns(db, table)));
  const before = tables();
  projectOverviews(db);
  assert.equal(tables(), before);
});

test("migration 18 makes the table of the 👍 / 👎 under the answers, one per answer; run again, it changes nothing", async () => {
  const { answerVotes } = await import("../src/migrations/0018_answer_votes.ts");
  const dir = mkdtempSync(join(tmpdir(), "twoody-migrations-"));
  const db = new Database(join(dir, "local.db"));
  migrate(db, { dataDir: dir, log: quiet, upTo: 17 });
  migrate(db, { dataDir: dir, log: quiet, upTo: 18 });
  assert.equal(schemaVersion(db), 18);
  assert.deepEqual(columns(db, "answer_votes"), ["id", "user_id", "message_id", "discussion_id", "vote", "reason", "comment", "model", "created_at", "updated_at", "deleted_at"]);
  db.prepare("INSERT INTO answer_votes (id, user_id, message_id, vote, created_at, updated_at) VALUES ('v1', 'u1', 'm1', 'up', 1, 1)").run();
  assert.throws(() => db.prepare("INSERT INTO answer_votes (id, user_id, message_id, vote, created_at, updated_at) VALUES ('v2', 'u1', 'm1', 'down', 1, 1)").run(), /UNIQUE/);
  const before = JSON.stringify(columns(db, "answer_votes"));
  answerVotes(db);
  assert.equal(JSON.stringify(columns(db, "answer_votes")), before);
});

test("migration 19 gives each granted folder its choice for files only online, left unread by default; run again, it changes nothing", async () => {
  const { cloudFiles } = await import("../src/migrations/0019_cloud_files.ts");
  const dir = mkdtempSync(join(tmpdir(), "twoody-migrations-"));
  const db = new Database(join(dir, "local.db"));
  migrate(db, { dataDir: dir, log: quiet, upTo: 18 });
  db.prepare("INSERT INTO users (id, email, created_at) VALUES ('u1', 'u@example.com', 1)").run();
  db.prepare("INSERT INTO document_folders (id, user_id, path, created_at) VALUES ('f1', 'u1', '/Users/x/OneDrive/Velora', 1)").run();
  migrate(db, { dataDir: dir, log: quiet, upTo: 19 });
  assert.equal(schemaVersion(db), 19);
  assert.ok(columns(db, "document_folders").includes("cloud_files"));
  assert.equal((db.prepare("SELECT cloud_files FROM document_folders WHERE id = 'f1'").get() as { cloud_files: string | null }).cloud_files, null);
  cloudFiles(db);
  assert.equal(columns(db, "document_folders").filter((name) => name === "cloud_files").length, 1);
});

test("migration 20 gives each project its tags, none at first; run again, it changes nothing", async () => {
  const { projectTags } = await import("../src/migrations/0020_project_tags.ts");
  const dir = mkdtempSync(join(tmpdir(), "twoody-migrations-"));
  const db = new Database(join(dir, "local.db"));
  migrate(db, { dataDir: dir, log: quiet, upTo: 19 });
  db.prepare("INSERT INTO users (id, email, created_at) VALUES ('u1', 'u@example.com', 1)").run();
  db.prepare("INSERT INTO projects (id, user_id, title, created_at, updated_at) VALUES ('p1', 'u1', 'Achat d’un Mac mini', 1, 1)").run();
  migrate(db, { dataDir: dir, log: quiet, upTo: 20 });
  assert.equal(schemaVersion(db), 20);
  assert.equal((db.prepare("SELECT tags FROM projects WHERE id = 'p1'").get() as { tags: string }).tags, "[]");
  projectTags(db);
  assert.equal(columns(db, "projects").filter((name) => name === "tags").length, 1);
});

test("migration 21 makes the table of the local API keys, empty; run again, it changes nothing", async () => {
  const { apiKeys } = await import("../src/migrations/0021_api_keys.ts");
  const dir = mkdtempSync(join(tmpdir(), "twoody-migrations-"));
  const db = new Database(join(dir, "local.db"));
  migrate(db, { dataDir: dir, log: quiet, upTo: 20 });
  db.prepare("INSERT INTO users (id, email, created_at) VALUES ('u1', 'u@example.com', 1)").run();
  migrate(db, { dataDir: dir, log: quiet });
  assert.equal(schemaVersion(db), 21);
  assert.deepEqual(columns(db, "api_keys").sort(), ["created_at", "id", "last_used_at", "name", "prefix", "revoked_at", "token_digest", "updated_at", "user_id"]);
  assert.equal((db.prepare("SELECT count(*) AS n FROM api_keys").get() as { n: number }).n, 0);
  apiKeys(db);
  assert.equal((db.prepare("SELECT count(*) AS n FROM users").get() as { n: number }).n, 1);
});
