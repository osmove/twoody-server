import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { join } from "path";
import { homedir } from "os";
import { chmodSync, existsSync, mkdirSync } from "fs";

export const DATA_DIR =
  process.env.TWOODY_DATA_DIR ?? join(homedir(), ".twoody", "data");
mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const DB_PATH = join(DATA_DIR, "local.db");
const sqlite = new Database(DB_PATH);

// Conversations, memories and voice samples live in this file, so keep
// it to the account that runs the server. The directory and the
// database are tightened on every boot (existing installs were created
// with the default umask); SQLite gives new -wal / -shm files the
// permissions of the main database, hence the chmod before WAL is
// switched on. Best-effort: some filesystems have no POSIX modes.
for (const [path, mode] of [
  [DATA_DIR, 0o700],
  [DB_PATH, 0o600],
  [`${DB_PATH}-wal`, 0o600],
  [`${DB_PATH}-shm`, 0o600],
] as const) {
  try {
    if (existsSync(path)) chmodSync(path, mode);
  } catch {
    // Leave the server usable on filesystems that refuse chmod.
  }
}

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
  /// How the session was given, which the person asking cannot choose:
  /// « owner » (signup, signin, or pairing with the setup token — the
  /// Desktop that started this server, or its first owner), « code »
  /// (pairing with the code on the screen), « account » (approved through
  /// the Twoody account, account/approvals.ts). Null for older sessions.
  origin: text("origin"),
  /// For a session given through the account to another of its computers:
  /// that computer's id in the account (the backend's `requester_computer_id`).
  /// When the account stops listing it, the session goes (peers/index.ts,
  /// revokeSessionsOfRemovedComputers). Null otherwise.
  requesterComputerId: text("requester_computer_id"),
  /// For a session given to a phone on its signed device-access-v1 (origin
  /// « mesh », account/approvals.ts rule 5): its vault device. When that
  /// device leaves the verified vault roster, the session goes
  /// (peers/index.ts). Null otherwise.
  vaultDeviceId: text("vault_device_id"),
  /// Which rule of account/approvals.ts let the session in (« approver »,
  /// « endorsed », « console », « mesh_computer », « device_access »); null
  /// for a session not given through the account.
  approvalRule: text("approval_rule"),
  /// The device-access/v2 the requester carried (JSON of its wire form),
  /// kept so that its vault device can be checked again later: for a rule
  /// 1 session, whose device the roster may not know yet when it is let in.
  deviceAccessJson: text("device_access_json"),
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

export const tunnelPeers = sqliteTable("tunnel_peers", {
  // The device's long-lived X25519 public key, in hex. It is the name
  // the tunnel knows it by: a device that loses its key is a device
  // that pairs again.
  publicKey: text("public_key").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  name: text("name"),
  pairedAt: integer("paired_at", { mode: "timestamp" }).notNull(),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp" }),
  // The session the device was given when it paired: removing the device
  // takes both, and a device that signs out forgets its key.
  sessionId: text("session_id"),
});

// The account's other computers this one sends questions to (a Raspberry
// Pi next to the Mac): paired as a peer through the account
// (docs/multi-computer-design.md §3, routes/peers.ts). `token` is the
// `peer:` session the other computer gave this one; it only opens
// /api/v1/peer/* there.
export const accountPeers = sqliteTable("account_peers", {
  computerId: text("computer_id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  kind: text("kind"),
  platform: text("platform"),
  /// requested → linked (or failed, with the reason in `error`).
  state: text("state").notNull(),
  requestId: text("request_id"),
  requestExpiresAt: integer("request_expires_at", { mode: "timestamp" }),
  /// The other computer's pairing key (account computer public_key): what
  /// its sealed answer is opened with.
  hostKey: text("host_key"),
  url: text("url"),
  token: text("token"),
  tunnelKey: text("tunnel_key"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /// Whether turns sent to it carry what this computer knows of its person
  /// (memories, personal data, document excerpts, instructions from files).
  /// Off until the Desktop says otherwise: a peer gets the conversation only.
  trusted: integer("trusted", { mode: "boolean" }).notNull().default(false),
  /// « mesh » when this computer asked for the link by itself because the
  /// other one is in the verified vault roster (peers/index.ts): the link
  /// goes when it leaves the roster. Null for a link asked for from
  /// « Appareils », which stays (a computer that only lends its models).
  origin: text("origin"),
  /// The tunnel key the other computer's sealed answer must carry: the one
  /// whose security code the person compared, or the roster's for a
  /// link the roster asked for (peers/index.ts checkPeerRequest).
  expectedTunnelKey: text("expected_tunnel_key"),
  /// The tunnel key whose security code the person compared with the
  /// one the computer shows (« Appareils »): a link sealed to it may take
  /// turns even out of the vault roster (router/index.ts routablePeers).
  checkedTunnelKey: text("checked_tunnel_key"),
  error: text("error"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
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
  // A compaction's summary of the conversation up to `summaryThrough` (a
  // message id): the model is given it instead of those messages.
  summary: text("summary"),
  summaryThrough: text("summary_through"),
  // What the model is given of this conversation, kept from one turn to the
  // next so that each turn only adds to it (chatContext.ts, ContextState):
  // JSON, rebuilt at a cut point.
  contextJson: text("context_json"),
  // The encrypted conversation this one mirrors (the vault's conversation
  // id), when its exchanges are synchronised between the person's devices.
  vaultId: text("vault_id"),
  // Which memories this conversation's turns are given (Mémoire v2, L4a):
  // "full", "profile" or "none"; null follows the person's setting (/me).
  memoryMode: text("memory_mode"),
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
  // JSON array of the document excerpts an assistant reply was given,
  // so the citations [1], [2]… it contains stay resolvable in history.
  sourcesJson: text("sources_json"),
  // What the model reasoned before answering, and for how long (ms).
  reasoning: text("reasoning"),
  reasoningMs: integer("reasoning_ms"),
  // The exchange's ref in the encrypted history: an exchange brought from
  // another device is added once, whatever the number of imports.
  vaultRef: text("vault_ref"),
  // A prompt as the model was given it — with the excerpts, notes and
  // context of its turn — so that the next turns give it again byte for
  // byte and the runtime reuses its cache (chatContext.ts). Never sent to
  // a client.
  sentContent: text("sent_content"),
  // What an answer cost, as the runtime counted it (estimated when it did
  // not say), and who asked: « iPhone », a device's name, or
  // « this-computer » — the Devices screen's usage (28/09/2026).
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  tokensEstimated: integer("tokens_estimated", { mode: "boolean" }),
  client: text("client"),
  // Which of the account's computers wrote an answer, and how it was
  // chosen: {computer_id, computer_name, model, routed}.
  answeredByJson: text("answered_by_json"),
  // What an answer was given of the person's memories (Mémoire v2, L4a):
  // {mode, profile_tokens, relevant_tokens, items: [{id, title, score}]},
  // as the final event of /queries said it.
  memoryJson: text("memory_json"),
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

/// Lightweight local contacts. This intentionally stores the small
/// common subset used by the CLI/app contact picker rather than the
/// full phone-address-social Rails model.
export const contacts = sqliteTable("contacts", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  name: text("name"),
  firstName: text("first_name"),
  middleName: text("middle_name"),
  lastName: text("last_name"),
  email: text("email"),
  phoneCountryCode: text("phone_country_code"),
  phoneNumber: text("phone_number"),
  relationType: text("relation_type"),
  relationSubtype: text("relation_subtype"),
  origin: text("origin").notNull().default("local"),
  /// Null for a contact the person added here; "macos" for one copied
  /// from the Mac's Contacts app, which the next copy replaces.
  source: text("source"),
  externalId: text("external_id"),
  organization: text("organization"),
  phonesJson: text("phones_json"),
  emailsJson: text("emails_json"),
  birthday: text("birthday"),
  addressesJson: text("addresses_json"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

/// Local calendar events. The table is named `events` to match the
/// public REST resource, while the exported symbol stays explicit to
/// avoid confusion with the server's internal event bus.
export const calendarEvents = sqliteTable("events", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  name: text("name").notNull().default(""),
  description: text("description"),
  status: text("status").notNull().default("confirmed"),
  kind: text("kind").notNull().default("event"),
  notes: text("notes"),
  startTime: integer("start_time", { mode: "timestamp" }).notNull(),
  endTime: integer("end_time", { mode: "timestamp" }),
  allDay: integer("all_day", { mode: "boolean" }).notNull().default(false),
  location: text("location"),
  /// Null for an event made here; "macos" for one copied from the Mac's
  /// Calendar app, which the next copy replaces.
  source: text("source"),
  externalId: text("external_id"),
  calendar: text("calendar"),
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
  /// The vault's clock of the version held here (src/vault/memories.ts):
  /// null while the memory has never been through the vault.
  hlc: text("hlc"),
  /// The vault event this version comes from; "local" for a memory that
  /// stays on this computer (too long for the vault's memory events).
  vaultEventId: text("vault_event_id"),
});

/// Folders the user let Twoody read. Everything under them is indexed
/// for document Q&A; nothing outside them is ever opened.
export const documentFolders = sqliteTable("document_folders", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  path: text("path").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

/// One row per indexed file. The text itself lives in the
/// `document_chunks` FTS5 table (created below — drizzle has no
/// virtual-table support), keyed by `document_id`.
export const documents = sqliteTable("documents", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  folderId: text("folder_id").notNull().references(() => documentFolders.id),
  path: text("path").notNull(),
  name: text("name").notNull(),
  ext: text("ext").notNull(),
  size: integer("size").notNull(),
  mtimeMs: integer("mtime_ms").notNull(),
  // "indexed" | "empty" (no extractable text, e.g. a scanned PDF) | "error"
  status: text("status").notNull(),
  error: text("error"),
  chars: integer("chars").notNull().default(0),
  indexedAt: integer("indexed_at", { mode: "timestamp" }),
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

/// One call to a model, whoever made it: a chat answer, a Twoody Code or
/// Agent step (reported by the desktop app), a memory extraction. What
/// the usage and performance screens add up (Jimmy, 29/09/2026). Times in
/// ms; `cachedTokens`, `promptMs`, `generationMs` and `ttftMs` are null
/// when the runtime did not say; `estimated` when the tokens were counted
/// from the characters. `messageId`: the answer it came with, if any.
export const usageEvents = sqliteTable("usage_events", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  at: integer("at", { mode: "timestamp_ms" }).notNull(),
  source: text("source").notNull(),
  model: text("model"),
  client: text("client"),
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  cachedTokens: integer("cached_tokens"),
  promptMs: integer("prompt_ms"),
  generationMs: integer("generation_ms"),
  ttftMs: integer("ttft_ms"),
  estimated: integer("estimated", { mode: "boolean" }).notNull().default(false),
  messageId: text("message_id"),
});

/// What this computer's load was: 15-s samples (span 15) for 48 h, then
/// 5-min averages (span 300) for 30 days (src/usageStore.ts). Null where
/// the system does not say (a GPU's load off macOS, a runtime not running).
export const usageSamples = sqliteTable("usage_samples", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().references(() => users.id),
  at: integer("at", { mode: "timestamp_ms" }).notNull(),
  spanS: integer("span_s").notNull().default(15),
  cpuPct: real("cpu_pct"),
  ramUsedBytes: integer("ram_used_bytes"),
  ramTotalBytes: integer("ram_total_bytes"),
  gpuPct: real("gpu_pct"),
  runtimeRssBytes: integer("runtime_rss_bytes"),
  appRssBytes: integer("app_rss_bytes"),
});

/// The computer the samples come from, as the desktop app last said.
export const usageMachines = sqliteTable("usage_machines", {
  userId: text("user_id").primaryKey().references(() => users.id),
  cpuModel: text("cpu_model"),
  cores: integer("cores"),
  ramTotalBytes: integer("ram_total_bytes"),
  gpuName: text("gpu_name"),
  os: text("os"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
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
for (const [name, type] of [["prompt_tokens", "INTEGER"], ["completion_tokens", "INTEGER"], ["tokens_estimated", "INTEGER"], ["client", "TEXT"], ["answered_by_json", "TEXT"], ["sent_content", "TEXT"]] as const) {
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

export const db = drizzle(sqlite);
export { sqlite };
