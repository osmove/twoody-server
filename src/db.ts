import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { join } from "path";
import { homedir } from "os";
import { mkdirSync } from "fs";

export const DATA_DIR =
  process.env.TWOODY_DATA_DIR ?? join(homedir(), ".twoody", "data");
mkdirSync(DATA_DIR, { recursive: true });

const sqlite = new Database(join(DATA_DIR, "local.db"));
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

// ── schema ────────────────────────────────────────────────────────────────────

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  passwordDigest: text("password_digest"),
  // Free-form JSON blob for prefs the iPhone/watch surfaces sync via
  // /me (default_provider, default_model, default_voice, audio_output,
  // memory_enabled, sttProvider, etc.). Keeping it as a single column
  // means new prefs don't need a migration — the server stays a thin
  // pass-through, the app owns the schema.
  prefsJson: text("prefs_json").notNull().default("{}"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const authSessions = sqliteTable("auth_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  tokenDigest: text("token_digest").notNull(),
  clientKind: text("client_kind").notNull().default("cli"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }),
});

export const pairingCodes = sqliteTable("pairing_codes", {
  code: text("code").primaryKey(),
  userId: text("user_id").references(() => users.id),
  purpose: text("purpose").notNull().default("cli"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  claimedAt: integer("claimed_at", { mode: "timestamp" }),
  claimedBy: text("claimed_by"),
});

export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  name: text("name"),
  clientKind: text("client_kind").notNull().default("twoody"),
  tokenDigest: text("token_digest").notNull(),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const providers = sqliteTable("providers", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  baseUrl: text("base_url"),
  model: text("model"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const discussions = sqliteTable("discussions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  channel: text("channel").notNull().default("cli"),
  // Cached title for the index list — set on first message via the
  // first ~60 chars of the user's prompt. Avoids a round-trip to
  // generate "real" titles in self-hosted mode (no LLM budget for
  // a separate naming call).
  title: text("title"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  lastActivityAt: integer("last_activity_at", { mode: "timestamp" }).notNull(),
});

// One row per message in a discussion (user prompt or assistant
// reply). Mirrors what the cloud serializes on `discussions/:id`
// so the iPhone's chat view can render the history without
// branching on backend. `model` and `provider` capture which LLM
// answered each turn — useful when the user hops between gpt-5.5
// and Twoody Private mid-discussion.
export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  discussionId: text("discussion_id").notNull().references(() => discussions.id),
  userId: text("user_id").notNull().references(() => users.id),
  role: text("role").notNull(),
  content: text("content").notNull(),
  provider: text("provider"),
  model: text("model"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

/// To-do items with optional due dates. Wire-compatible with the
/// cloud Rails /tasks: same shape so the iPhone/desktop drives both
/// backends from one TasksScreen. `priority` is an integer (Rails
/// uses 0-2 for low/medium/high; we accept whatever the client sends
/// and surface a `priority_label` for display).
export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  title: text("title").notNull().default(""),
  notes: text("notes"),
  dueAt: integer("due_at", { mode: "timestamp" }),
  doneAt: integer("done_at", { mode: "timestamp" }),
  priority: integer("priority"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

/// User reminders with an optional notification time. Mirrors the
/// Rails /reminders wire contract while staying local-only: no push
/// scheduling happens here yet, but clients can create, complete,
/// reopen, list, and soft-delete reminders against Twoody Server.
export const reminders = sqliteTable("reminders", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  projectId: text("project_id"),
  text: text("text").notNull().default(""),
  title: text("title"),
  subtitle: text("subtitle"),
  notifyAt: integer("notify_at", { mode: "timestamp" }),
  status: text("status").notNull().default("active"),
  channel: text("channel").notNull().default("push"),
  reminderType: text("reminder_type").notNull().default("once"),
  cron: text("cron"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

/// Free-form notes — title + body, with pin and archive flags.
/// Wire-compatible with the cloud Rails /notes (title, body, pinned,
/// archived). `preview` is computed at serialization (first ~120
/// chars of body) so the iPhone's NotesScreen + desktop's Notes tab
/// render uniformly.
export const notes = sqliteTable("notes", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  title: text("title"),
  body: text("body").notNull().default(""),
  pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

/// Free-form facts the assistant can recall during conversations.
/// Wire-compatible with the cloud Rails /memories: same shape so the
/// iPhone/desktop can drive both backends from a single MemoriesScreen.
/// `kind` is one of "user" | "feedback" | "project" | "reference".
/// `tagsJson` is a JSON array string (drizzle-only, exposed as
/// `tags: string[]` over the wire).
export const memories = sqliteTable("memories", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  kind: text("kind").notNull().default("user"),
  title: text("title"),
  content: text("content").notNull().default(""),
  tagsJson: text("tags_json").notNull().default("[]"),
  source: text("source").notNull().default("manual"),
  sourceRef: text("source_ref"),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  supersededById: text("superseded_by_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const members = sqliteTable("members", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  relationship: text("relationship"),
  slug: text("slug").notNull(),
  email: text("email"),
  enrollmentState: text("enrollment_state").notNull().default("{}"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const wakeWordSamples = sqliteTable("wake_word_samples", {
  id: text("id").primaryKey(),
  memberId: text("member_id").notNull().references(() => members.id),
  word: text("word").notNull(),
  prefix: text("prefix"),
  filename: text("filename"),
  contentType: text("content_type"),
  audioBase64: text("audio_base64"),
  durationMs: integer("duration_ms"),
  sampleRate: integer("sample_rate"),
  source: text("source").notNull().default("app"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const voiceProfiles = sqliteTable("voice_profiles", {
  id: text("id").primaryKey(),
  memberId: text("member_id").notNull().unique().references(() => members.id),
  method: text("method").notNull().default("raw"),
  source: text("source").notNull().default("app"),
  filename: text("filename"),
  contentType: text("content_type"),
  fileBase64: text("file_base64"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const faceEmbeddings = sqliteTable("face_embeddings", {
  id: text("id").primaryKey(),
  memberId: text("member_id").notNull().unique().references(() => members.id),
  model: text("model").notNull().default("insightface"),
  source: text("source").notNull().default("app"),
  imageBase64: text("image_base64"),
  embeddingJson: text("embedding_json"),
  filename: text("filename"),
  contentType: text("content_type"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

// ── migrations (run once at boot) ────────────────────────────────────────────

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
    expires_at INTEGER
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

const discussionColumns = sqlite.prepare("PRAGMA table_info(discussions)").all() as Array<{
  name: string;
}>;
if (!discussionColumns.some((column) => column.name === "title")) {
  sqlite.exec("ALTER TABLE discussions ADD COLUMN title TEXT");
}

export const db = drizzle(sqlite);
export { sqlite };
