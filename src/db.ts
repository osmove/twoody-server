import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { join } from "path";
import { homedir } from "os";
import { chmodSync, existsSync, mkdirSync } from "fs";
import { migrate } from "./migrations/index.js";
import { createMessageFts, rebuildMessageIndex as rebuildFts } from "./migrations/fts.js";

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
  prefsJson: text("prefs").notNull().default("{}"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const authSessions = sqliteTable("auth_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  tokenDigest: text("token_digest").notNull(),
  clientKind: text("client_kind").notNull().default("cli"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
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
  deviceAccessJson: text("device_access"),
});

export const pairingCodes = sqliteTable("pairing_codes", {
  code: text("code").primaryKey(),
  userId: text("user_id").references(() => users.id),
  purpose: text("purpose").notNull().default("cli"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
  claimedBy: text("claimed_by"),
});

export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  name: text("name"),
  clientKind: text("client_kind").notNull().default("twoody"),
  tokenDigest: text("token_digest").notNull(),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const tunnelPeers = sqliteTable("tunnel_peers", {
  // The device's long-lived X25519 public key, in hex. It is the name
  // the tunnel knows it by: a device that loses its key is a device
  // that pairs again.
  publicKey: text("public_key").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  name: text("name"),
  pairedAt: integer("paired_at", { mode: "timestamp_ms" }).notNull(),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
  // The session the device was given when it paired: removing the device
  // takes both, and a device that signs out forgets its key.
  sessionId: text("session_id"),
});

// The account's other computers this one sends questions to (a Raspberry
// Pi next to the Mac): paired as a peer through the account
// (docs/multi-computer-design.md §3, routes/peers.ts). `token` is the
// `peer:` session the other computer gave this one; it only opens
// /api/v1/peer/* there.
export const accountComputers = sqliteTable("account_computers", {
  computerId: text("computer_id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  kind: text("kind"),
  platform: text("platform"),
  /// requested → linked (or failed, with the reason in `error`).
  state: text("state").notNull(),
  requestId: text("request_id"),
  requestExpiresAt: integer("request_expires_at", { mode: "timestamp_ms" }),
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
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const llmEndpoints = sqliteTable("llm_endpoints", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  baseUrl: text("base_url"),
  model: text("model"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const discussions = sqliteTable("discussions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  channel: text("channel").notNull().default("cli"),
  // Title for the index list — set on first message via the first ~60
  // chars of the user's prompt, then replaced by a short one the model
  // writes once the first answer is in (src/discussionTitles.ts).
  title: text("title"),
  // Where `title` comes from: "question" (the first ~60 chars, given at
  // once), "model" (written by the model after the first answer,
  // src/discussionTitles.ts) or "given" (brought with a synchronised
  // conversation, a rename); null before migration 3. Only a "question"
  // title is ever replaced by the model.
  titleSource: text("title_source"),
  // A compaction's summary of the conversation up to `summaryThrough` (a
  // message id): the model is given it instead of those messages.
  summary: text("summary"),
  summaryThrough: text("summary_through"),
  // What the model is given of this conversation, kept from one turn to the
  // next so that each turn only adds to it (chatContext.ts, ContextState):
  // JSON, rebuilt at a cut point.
  contextJson: text("context"),
  // The encrypted conversation this one mirrors (the vault's conversation
  // id), when its exchanges are synchronised between the person's devices.
  vaultId: text("vault_id"),
  // Which memories this conversation's turns are given (Mémoire v2, L4a):
  // "full", "profile" or "none"; null follows the person's setting (/me).
  memoryMode: text("memory_mode"),
  // The rowid of the last message the learner went through (L6).
  learnedThrough: integer("learned_through"),
  /// The project the conversation is mostly about (docs/projects-design.md);
  /// in an isolated project (src/projects/isolation.ts), set when it starts
  /// and never changed.
  projectId: text("project_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  lastActivityAt: integer("last_activity_at", { mode: "timestamp_ms" }).notNull(),
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
  sourcesJson: text("sources"),
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
  // How a question was put: « recording » when said (the phone's
  // microphone), else typed — kept so the conversation shows it again
  // (Jimmy, 02/10/2026: the microphones were gone once reloaded).
  channel: text("channel"),
  // What an answer cost, as the runtime counted it (estimated when it did
  // not say), and who asked: « iPhone », a device's name, or
  // « this-computer » — the Devices screen's usage (28/09/2026).
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  tokensEstimated: integer("tokens_estimated", { mode: "boolean" }),
  client: text("client"),
  // Which of the account's computers wrote an answer, and how it was
  // chosen: {computer_id, computer_name, model, routed}.
  answeredByJson: text("answered_by"),
  // What an answer was given of the person's memories (Mémoire v2, L4a):
  // {mode, profile_tokens, relevant_tokens, items: [{id, title, score}]},
  // as the final event of /queries said it.
  memoryJson: text("memory"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
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
  dueAt: integer("due_at", { mode: "timestamp_ms" }),
  doneAt: integer("done_at", { mode: "timestamp_ms" }),
  priority: integer("priority"),
  /// The project it belongs to (docs/projects-design.md).
  projectId: text("project_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
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
  notifyAt: integer("notify_at", { mode: "timestamp_ms" }),
  status: text("status").notNull().default("active"),
  channel: text("channel").notNull().default("push"),
  reminderType: text("reminder_type").notNull().default("once"),
  cron: text("cron"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
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
  phonesJson: text("phones"),
  emailsJson: text("emails"),
  birthday: text("birthday"),
  addressesJson: text("addresses"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
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
  startTime: integer("start_time", { mode: "timestamp_ms" }).notNull(),
  endTime: integer("end_time", { mode: "timestamp_ms" }),
  allDay: integer("all_day", { mode: "boolean" }).notNull().default(false),
  location: text("location"),
  /// Null for an event made here; "macos" for one copied from the Mac's
  /// Calendar app, which the next copy replaces.
  source: text("source"),
  externalId: text("external_id"),
  calendar: text("calendar"),
  /// The project it belongs to (docs/projects-design.md).
  projectId: text("project_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
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
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
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
  tagsJson: text("tags").notNull().default("[]"),
  /// How sure Twoody is of it, 0 to 1 (as on the account).
  confidence: real("confidence").notNull().default(1),
  source: text("source").notNull().default("manual"),
  sourceRef: text("source_ref"),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  supersededById: text("superseded_by_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
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
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  // The isolated project whose documents this folder holds (migration 6,
  // src/projects/isolation.ts): searched in its conversations only.
  projectId: text("project_id"),
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
  indexedAt: integer("indexed_at", { mode: "timestamp_ms" }),
});

export const members = sqliteTable("members", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  relationship: text("relationship"),
  slug: text("slug").notNull(),
  email: text("email"),
  enrollmentState: text("enrollment_state").notNull().default("{}"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
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
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const voiceProfiles = sqliteTable("voice_profiles", {
  id: text("id").primaryKey(),
  memberId: text("member_id").notNull().unique().references(() => members.id),
  method: text("method").notNull().default("raw"),
  source: text("source").notNull().default("app"),
  filename: text("filename"),
  contentType: text("content_type"),
  fileBase64: text("file_base64"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const faceEmbeddings = sqliteTable("face_embeddings", {
  id: text("id").primaryKey(),
  memberId: text("member_id").notNull().unique().references(() => members.id),
  model: text("model").notNull().default("insightface"),
  source: text("source").notNull().default("app"),
  imageBase64: text("image_base64"),
  embeddingJson: text("embedding"),
  filename: text("filename"),
  contentType: text("content_type"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/// One call to a model, whoever made it: a chat answer, a Twoody Code or
/// Agent step (reported by the desktop app), a memory extraction. What
/// the usage and performance screens add up (Jimmy, 29/09/2026). Times in
/// ms; `cachedTokens`, `promptMs`, `generationMs` and `ttftMs` are null
/// when the runtime did not say; `estimated` when the tokens were counted
/// from the characters. `messageId`: the answer it came with, if any.
export const modelCalls = sqliteTable("model_calls", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
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

// ── migrations ───────────────────────────────────────────────────────────────

// The schema is brought up to date before anything reads it
// (src/migrations/index.ts): the historical baseline for a database at
// version 0, then each numbered migration not yet applied, the file saved
// first when it holds data.
migrate(sqlite, { dataDir: DATA_DIR, dbPath: DB_PATH });
// The conversations' full-text index is checked at every start, as before
// migrations: rebuilt from the messages if it went missing.
createMessageFts(sqlite, "prefs");

/// Indexes again every message it should hold (src/migrations/fts.ts).
export function rebuildMessageIndex() {
  rebuildFts(sqlite);
}

export const db = drizzle(sqlite);
export { sqlite };
