import type Database from "better-sqlite3";
import { createMessageFts } from "./fts.js";

// The schema as it stood before versioned migrations (03/10/2026): every
// table created if missing and every column added if missing, as the boot
// used to do. Run only on a database at user_version 0 — a fresh one, or
// one from before migrations — and never again after; ./index.ts then
// takes it from there. Kept as it was: changing it would change the
// starting point of every migration.
export function legacyBaseline(sqlite: Database.Database) {

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    password_digest TEXT,
    prefs_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS auth_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    token_digest TEXT NOT NULL,
    client_kind TEXT NOT NULL DEFAULT 'cli',
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    origin TEXT,
    requester_computer_id TEXT,
    vault_device_id TEXT
  );

  CREATE TABLE IF NOT EXISTS pairing_codes (
    code TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
    purpose TEXT NOT NULL DEFAULT 'cli',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    claimed_at INTEGER,
    claimed_by TEXT
  );

  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT,
    client_kind TEXT NOT NULL DEFAULT 'twoody',
    token_digest TEXT NOT NULL,
    last_seen_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tunnel_peers (
    public_key TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT,
    paired_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    session_id TEXT
  );

  CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    base_url TEXT,
    model TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS discussions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    channel TEXT NOT NULL DEFAULT 'cli',
    title TEXT,
    summary TEXT,
    summary_through TEXT,
    created_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    discussion_id TEXT NOT NULL REFERENCES discussions(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_discussion_created
    ON messages (discussion_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_discussions_user_activity
    ON discussions (user_id, last_activity_at DESC);

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    title TEXT NOT NULL DEFAULT '',
    notes TEXT,
    due_at INTEGER,
    done_at INTEGER,
    priority INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_user_done_due
    ON tasks (user_id, done_at, due_at);

  CREATE TABLE IF NOT EXISTS reminders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    project_id TEXT,
    text TEXT NOT NULL DEFAULT '',
    title TEXT,
    subtitle TEXT,
    notify_at INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    channel TEXT NOT NULL DEFAULT 'push',
    reminder_type TEXT NOT NULL DEFAULT 'once',
    cron TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_reminders_user_status_notify
    ON reminders (user_id, status, notify_at);

  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT,
    first_name TEXT,
    middle_name TEXT,
    last_name TEXT,
    email TEXT,
    phone_country_code TEXT,
    phone_number TEXT,
    relation_type TEXT,
    relation_subtype TEXT,
    origin TEXT NOT NULL DEFAULT 'local',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_contacts_user_name
    ON contacts (user_id, name);

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL DEFAULT '',
    description TEXT,
    status TEXT NOT NULL DEFAULT 'confirmed',
    kind TEXT NOT NULL DEFAULT 'event',
    notes TEXT,
    start_time INTEGER NOT NULL,
    end_time INTEGER,
    all_day INTEGER NOT NULL DEFAULT 0,
    location TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_events_user_start
    ON events (user_id, start_time);

  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    title TEXT,
    body TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_notes_user_pinned_updated
    ON notes (user_id, pinned DESC, updated_at DESC);

  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL DEFAULT 'user',
    title TEXT,
    content TEXT NOT NULL DEFAULT '',
    tags_json TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT 'manual',
    source_ref TEXT,
    entity_type TEXT,
    entity_id TEXT,
    superseded_by_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_memories_user_updated
    ON memories (user_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS document_folders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, path)
  );

  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    folder_id TEXT NOT NULL REFERENCES document_folders(id),
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    ext TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    chars INTEGER NOT NULL DEFAULT 0,
    indexed_at INTEGER,
    UNIQUE (user_id, path)
  );

  CREATE TABLE IF NOT EXISTS document_semantic_settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id), enabled INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS document_labels (
    document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    category TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS document_embeddings (
    user_id TEXT NOT NULL REFERENCES users(id),
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    position INTEGER NOT NULL, model TEXT NOT NULL, hash TEXT NOT NULL, vector BLOB NOT NULL,
    PRIMARY KEY(document_id,position)
  );

  CREATE INDEX IF NOT EXISTS idx_documents_folder ON documents (folder_id);

  -- Full-text index of the extracted text. unicode61 with
  -- remove_diacritics lets "delai preavis" find "délai de préavis".
  CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks USING fts5(
    text,
    document_id UNINDEXED,
    user_id UNINDEXED,
    page UNINDEXED,
    position UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2'
  );

  CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    relationship TEXT,
    slug TEXT NOT NULL,
    email TEXT,
    enrollment_state TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS wake_word_samples (
    id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL REFERENCES members(id),
    word TEXT NOT NULL,
    prefix TEXT,
    filename TEXT,
    content_type TEXT,
    audio_base64 TEXT,
    duration_ms INTEGER,
    sample_rate INTEGER,
    source TEXT NOT NULL DEFAULT 'app',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS voice_profiles (
    id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL UNIQUE REFERENCES members(id),
    method TEXT NOT NULL DEFAULT 'raw',
    source TEXT NOT NULL DEFAULT 'app',
    filename TEXT,
    content_type TEXT,
    file_base64 TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS face_embeddings (
    id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL UNIQUE REFERENCES members(id),
    model TEXT NOT NULL DEFAULT 'insightface',
    source TEXT NOT NULL DEFAULT 'app',
    image_base64 TEXT,
    embedding_json TEXT,
    filename TEXT,
    content_type TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS usage_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    at INTEGER NOT NULL,
    source TEXT NOT NULL,
    model TEXT,
    client TEXT,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER,
    prompt_ms INTEGER,
    generation_ms INTEGER,
    ttft_ms INTEGER,
    estimated INTEGER NOT NULL DEFAULT 0,
    message_id TEXT
  );
  CREATE INDEX IF NOT EXISTS usage_events_user_at ON usage_events (user_id, at);
  CREATE UNIQUE INDEX IF NOT EXISTS usage_events_message ON usage_events (message_id) WHERE message_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS usage_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id),
    at INTEGER NOT NULL,
    span_s INTEGER NOT NULL DEFAULT 15,
    cpu_pct REAL,
    ram_used_bytes INTEGER,
    ram_total_bytes INTEGER,
    gpu_pct REAL,
    runtime_rss_bytes INTEGER,
    app_rss_bytes INTEGER
  );
  CREATE INDEX IF NOT EXISTS usage_samples_user_at ON usage_samples (user_id, at);
  CREATE INDEX IF NOT EXISTS usage_samples_span_at ON usage_samples (span_s, at);

  CREATE TABLE IF NOT EXISTS usage_machines (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    cpu_model TEXT,
    cores INTEGER,
    ram_total_bytes INTEGER,
    gpu_name TEXT,
    os TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS usage_meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS account_peers (
    computer_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    kind TEXT,
    platform TEXT,
    state TEXT NOT NULL,
    request_id TEXT,
    request_expires_at INTEGER,
    host_key TEXT,
    url TEXT,
    token TEXT,
    tunnel_key TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    trusted INTEGER NOT NULL DEFAULT 0,
    origin TEXT,
    expected_tunnel_key TEXT,
    checked_tunnel_key TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

const userColumns = sqlite.prepare("PRAGMA table_info(users)").all() as Array<{
  name: string;
}>;
if (!userColumns.some((column) => column.name === "password_digest")) {
  sqlite.exec("ALTER TABLE users ADD COLUMN password_digest TEXT");
}
if (!userColumns.some((column) => column.name === "prefs_json")) {
  sqlite.exec("ALTER TABLE users ADD COLUMN prefs_json TEXT NOT NULL DEFAULT '{}'");
}

const messageColumns = sqlite.prepare("PRAGMA table_info(messages)").all() as Array<{
  name: string;
}>;
if (!messageColumns.some((column) => column.name === "sources_json")) {
  sqlite.exec("ALTER TABLE messages ADD COLUMN sources_json TEXT");
}
if (!messageColumns.some((column) => column.name === "reasoning")) {
  sqlite.exec("ALTER TABLE messages ADD COLUMN reasoning TEXT");
}
if (!messageColumns.some((column) => column.name === "reasoning_ms")) {
  sqlite.exec("ALTER TABLE messages ADD COLUMN reasoning_ms INTEGER");
}
if (!messageColumns.some((column) => column.name === "vault_ref")) {
  sqlite.exec("ALTER TABLE messages ADD COLUMN vault_ref TEXT");
}
for (const [name, type] of [["prompt_tokens", "INTEGER"], ["completion_tokens", "INTEGER"], ["tokens_estimated", "INTEGER"], ["client", "TEXT"], ["answered_by_json", "TEXT"], ["sent_content", "TEXT"], ["channel", "TEXT"]] as const) {
  if (!messageColumns.some((column) => column.name === name)) sqlite.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`);
}

const discussionColumns = sqlite.prepare("PRAGMA table_info(discussions)").all() as Array<{
  name: string;
}>;
if (!discussionColumns.some((column) => column.name === "title")) {
  sqlite.exec("ALTER TABLE discussions ADD COLUMN title TEXT");
}
if (!discussionColumns.some((column) => column.name === "summary")) {
  sqlite.exec("ALTER TABLE discussions ADD COLUMN summary TEXT");
}
if (!discussionColumns.some((column) => column.name === "summary_through")) {
  sqlite.exec("ALTER TABLE discussions ADD COLUMN summary_through TEXT");
}
if (!discussionColumns.some((column) => column.name === "context_json")) {
  sqlite.exec("ALTER TABLE discussions ADD COLUMN context_json TEXT");
}
if (!discussionColumns.some((column) => column.name === "vault_id")) {
  sqlite.exec("ALTER TABLE discussions ADD COLUMN vault_id TEXT");
}
sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS discussions_user_vault ON discussions(user_id, vault_id) WHERE vault_id IS NOT NULL");
sqlite.exec("CREATE INDEX IF NOT EXISTS messages_vault_ref ON messages(discussion_id, vault_ref) WHERE vault_ref IS NOT NULL");

const tunnelPeerColumns = sqlite.prepare("PRAGMA table_info(tunnel_peers)").all() as Array<{
  name: string;
}>;
if (!tunnelPeerColumns.some((column) => column.name === "session_id")) {
  sqlite.exec("ALTER TABLE tunnel_peers ADD COLUMN session_id TEXT");
}

// A peer is not trusted with this computer's person's data until the
// Desktop says so (29/09/2026).
const peerColumns = sqlite.prepare("PRAGMA table_info(account_peers)").all() as Array<{ name: string }>;
if (!peerColumns.some((column) => column.name === "trusted")) {
  sqlite.exec("ALTER TABLE account_peers ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0");
}

// How a session was given (29/09/2026). The sessions from before are
// the Desktop's own when they were its signup or its pairing as « Twoody
// Desktop » with no tunnel key (a phone always brings one).
const sessionColumns = sqlite.prepare("PRAGMA table_info(auth_sessions)").all() as Array<{ name: string }>;
if (!sessionColumns.some((column) => column.name === "origin")) {
  sqlite.exec("ALTER TABLE auth_sessions ADD COLUMN origin TEXT");
  sqlite.exec(
    "UPDATE auth_sessions SET origin = 'owner' WHERE client_kind = 'desktop' OR (client_kind = 'pair:Twoody Desktop' AND id NOT IN (SELECT session_id FROM tunnel_peers WHERE session_id IS NOT NULL))",
  );
}

if (!sessionColumns.some((column) => column.name === "requester_computer_id")) {
  sqlite.exec("ALTER TABLE auth_sessions ADD COLUMN requester_computer_id TEXT");
}

// The mesh (docs/mesh-design.md §1, lot S2, 30/09/2026): the vault device a
// phone's session was given to, and the links asked for by the roster.
if (!sessionColumns.some((column) => column.name === "vault_device_id")) {
  sqlite.exec("ALTER TABLE auth_sessions ADD COLUMN vault_device_id TEXT");
}
// Which approval rule let a session in, and the device-access it carried
// (30/09/2026): who may name this computer's vault anchors, and seal turns.
for (const name of ["approval_rule", "device_access_json"]) {
  if (!sessionColumns.some((column) => column.name === name)) sqlite.exec(`ALTER TABLE auth_sessions ADD COLUMN ${name} TEXT`);
}
if (!peerColumns.some((column) => column.name === "origin")) {
  sqlite.exec("ALTER TABLE account_peers ADD COLUMN origin TEXT");
}
// The key a peer's answer must carry, and the one the person checked
// (30/09/2026): the account's listing never picks the key of a link.
for (const name of ["expected_tunnel_key", "checked_tunnel_key"]) {
  if (!peerColumns.some((column) => column.name === name)) sqlite.exec(`ALTER TABLE account_peers ADD COLUMN ${name} TEXT`);
}

// Memories through the vault's « memories » stream (docs/mesh-design.md §3,
// lot S5, src/vault/memories.ts): the clock and event of the version held
// here, and the opened events themselves — this computer's own tombstones
// among them, kept even when the account withholds them.
const memoryColumns = sqlite.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
for (const name of ["hlc", "vault_event_id"]) {
  if (!memoryColumns.some((column) => column.name === name)) sqlite.exec(`ALTER TABLE memories ADD COLUMN ${name} TEXT`);
}
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS memory_vault_events (
    event_id TEXT PRIMARY KEY,
    stream_id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    own INTEGER NOT NULL DEFAULT 0,
    sealed_json TEXT,
    sent INTEGER NOT NULL DEFAULT 0,
    seq INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_memory_vault_events_stream ON memory_vault_events (stream_id, sent);
  CREATE TABLE IF NOT EXISTS memory_vault_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);
// When the account stored an event (its own clock, ms): an event stamped
// further ahead of it than the HLC allows never counts (vault/contracts.ts
// mergeMemories).
if (!(sqlite.prepare("PRAGMA table_info(memory_vault_events)").all() as Array<{ name: string }>).some((column) => column.name === "stored_at")) {
  sqlite.exec("ALTER TABLE memory_vault_events ADD COLUMN stored_at INTEGER");
}

// Contacts and events copied from the Mac's own apps (29/09/2026).
for (const [table, columns] of [
  ["contacts", [["source", "TEXT"], ["external_id", "TEXT"], ["organization", "TEXT"], ["phones_json", "TEXT"], ["emails_json", "TEXT"], ["birthday", "TEXT"], ["addresses_json", "TEXT"]]],
  ["events", [["source", "TEXT"], ["external_id", "TEXT"], ["calendar", "TEXT"]]],
] as const) {
  const existing = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  for (const [name, type] of columns) {
    if (!existing.some((column) => column.name === name)) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_user_source ON ${table} (user_id, source)`);
}

// Mémoire v2 (docs/memory-v2-design.md §2), one block per lot.
//
// L1: the memories' vectors, on this computer only (each computer embeds
// with its own model): keyed by memory and model, with the hash of the
// text they were made from — a memory edited since is embedded again.
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS memory_embeddings (
    memory_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    model TEXT NOT NULL,
    hash TEXT NOT NULL,
    vector BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (memory_id, model)
  );
  CREATE INDEX IF NOT EXISTS idx_memory_embeddings_user ON memory_embeddings (user_id, model);
`);

// L2 (block B): the people, projects and places the memories are about,
// their other names and how they relate (src/memory/entities.ts). The
// entities travel later (L8: hlc, vault_event_id); which memory names
// which entity is worked out on each computer (memory_entities).
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL DEFAULT 'person',
    name TEXT NOT NULL,
    norm TEXT NOT NULL,
    note TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    merged_into TEXT,
    hlc TEXT,
    vault_event_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_entities_user_norm ON entities (user_id, norm);
  CREATE TABLE IF NOT EXISTS entity_aliases (
    entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    alias TEXT NOT NULL,
    norm TEXT NOT NULL,
    PRIMARY KEY (entity_id, norm)
  );
  CREATE TABLE IF NOT EXISTS entity_relations (
    from_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    to_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    hlc TEXT,
    PRIMARY KEY (from_id, to_id, label)
  );
  CREATE INDEX IF NOT EXISTS idx_entity_relations_to ON entity_relations (to_id);
  CREATE TABLE IF NOT EXISTS memory_entities (
    memory_id TEXT NOT NULL,
    entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    how TEXT NOT NULL,
    PRIMARY KEY (memory_id, entity_id)
  );
  CREATE INDEX IF NOT EXISTS idx_memory_entities_entity ON memory_entities (entity_id);
`);

// L4a: a conversation's memory mode, and what each answer was given of
// the memories.
for (const [table, name] of [["discussions", "memory_mode"], ["messages", "memory_json"]] as const) {
  const existing = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!existing.some((column) => column.name === name)) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${name} TEXT`);
}

// L3: how often each memory rode on a message (src/memory/retrieve.ts),
// for the profile's « most used ». On this computer only, never synchronised.
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS memory_usage (
    memory_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    uses INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memory_usage_user ON memory_usage (user_id, uses);
`);

// L5a: the full-text index of the conversations (./fts.ts).
createMessageFts(sqlite, "prefs_json");

// L6: what the learner read of each conversation (the rowid of the last
// message it went through), and the facts it was not sure enough of to keep
// on its own: « À confirmer » (src/memory/learner.ts). On this computer only
// — candidates travel later (docs/memory-v2-design.md §6, phase 2).
{
  const columns = sqlite.prepare("PRAGMA table_info(discussions)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "learned_through")) {
    sqlite.exec("ALTER TABLE discussions ADD COLUMN learned_through INTEGER");
    // The conversations held before were learned message by message as
    // they went: read already.
    sqlite.exec("UPDATE discussions SET learned_through = (SELECT MAX(rowid) FROM messages m WHERE m.discussion_id = discussions.id)");
  }
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS memory_candidates (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      norm TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'user',
      category TEXT,
      confidence REAL NOT NULL,
      sensitive INTEGER NOT NULL DEFAULT 0,
      evidence TEXT,
      supersedes_id TEXT,
      discussion_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      memory_id TEXT,
      created_at INTEGER NOT NULL,
      decided_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_memory_candidates_user ON memory_candidates (user_id, status);
    -- What the learner kept or proposed from a conversation: shown in that
    -- conversation (« Mémoire mise à jour ») and, once, in the next one.
    CREATE TABLE IF NOT EXISTS memory_notices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      discussion_id TEXT NOT NULL,
      saved_json TEXT NOT NULL DEFAULT '[]',
      proposed INTEGER NOT NULL DEFAULT 0,
      announced INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_notices_discussion ON memory_notices (discussion_id);
    CREATE INDEX IF NOT EXISTS idx_memory_notices_user ON memory_notices (user_id, announced);
    -- « Ce n'est pas la même chose »: pairs of memories the person said differ.
    CREATE TABLE IF NOT EXISTS memory_pairs_dismissed (
      user_id TEXT NOT NULL,
      a TEXT NOT NULL,
      b TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, a, b)
    );
  `);
}

// What happened in each answer, for debugging (src/diagnostics/traces.ts):
// the model and computer, the documents decision, the tools offered and
// called, the size of each part of the prompt, the time of each step. On
// this computer only; nothing is sent anywhere.
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS turn_traces (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'chat',
    discussion_id TEXT,
    message_id TEXT,
    client TEXT,
    model TEXT,
    outcome TEXT NOT NULL,
    error TEXT,
    total_ms INTEGER,
    trace_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_turn_traces_user_at ON turn_traces (user_id, at);
  CREATE INDEX IF NOT EXISTS idx_turn_traces_message ON turn_traces (message_id);
  -- What the model was given for an answer — instructions, profile,
  -- history, the message, the tools offered — for « Détails » under it
  -- (Jimmy, 03/10/2026). This computer only, like the traces.
  CREATE TABLE IF NOT EXISTS turn_prompts (
    trace_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    message_id TEXT,
    prompt_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_turn_prompts_message ON turn_prompts (message_id);
`);

// Projects (docs/projects-design.md, lot P1): what the person is working
// towards, and what hangs off it. A project is known by an entity of the
// memory graph (kind « project »), so the memories naming it are its own.
{
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      entity_id TEXT,
      title TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'other',
      size TEXT NOT NULL DEFAULT 'small',
      status TEXT NOT NULL DEFAULT 'active',
      brief TEXT,
      started_at INTEGER,
      due_at INTEGER,
      done_at INTEGER,
      budget_cents INTEGER,
      currency TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      hlc TEXT,
      vault_event_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_projects_user ON projects (user_id, status);
    CREATE TABLE IF NOT EXISTS project_documents (
      project_id TEXT NOT NULL,
      computer_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      name TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, computer_id, document_id)
    );
  `);
  for (const table of ["tasks", "events", "discussions"]) {
    const existing = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!existing.some((column) => column.name === "project_id")) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN project_id TEXT`);
  }
  // « À confirmer » also holds projects the learner found (candidate_type
  // « project »), with what it found of them.
  const candidateColumns = sqlite.prepare("PRAGMA table_info(memory_candidates)").all() as Array<{ name: string }>;
  if (!candidateColumns.some((column) => column.name === "candidate_type")) sqlite.exec("ALTER TABLE memory_candidates ADD COLUMN candidate_type TEXT NOT NULL DEFAULT 'fact'");
  if (!candidateColumns.some((column) => column.name === "payload_json")) sqlite.exec("ALTER TABLE memory_candidates ADD COLUMN payload_json TEXT");
}

}
