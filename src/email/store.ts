import { randomUUID } from "node:crypto";
import { sqlite } from "../db.js";
import { emailsSchema } from "../migrations/0004_emails.js";
import { buildMatchQuery } from "../documents/query.js";
import type { MailSecurity } from "../outbound.js";
import type { AttachmentInfo, FlagState, FolderRole, MailAddress } from "./parse.js";

// The copy of the person's mailbox on this computer (migration 4,
// src/migrations/0004_emails.ts): the mailbox set up, its folders, its
// messages and their full-text index. Nothing here talks to a server.

export type SourceStatus = "active" | "error" | "removed";

export interface EmailSource {
  id: string;
  user_id: string;
  provider: string;
  email_address: string;
  display_name: string | null;
  imap_host: string;
  imap_port: number;
  imap_security: MailSecurity;
  username: string;
  status: SourceStatus;
  import_after: number | null;
  last_synced_at: number | null;
  last_imported_at: number | null;
  last_error: string | null;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}

export interface EmailFolder {
  id: string;
  email_source_id: string;
  path: string;
  name: string | null;
  special_use: string | null;
  role: FolderRole | null;
  uid_validity: number | null;
  last_uid: number;
  synced_after: number | null;
  message_count: number | null;
  last_synced_at: number | null;
}

export interface EmailRow {
  id: string;
  user_id: string;
  email_source_id: string;
  email_folder_id: string;
  uid: number | null;
  uid_validity: number | null;
  provider_message_id: string | null;
  provider_thread_id: string | null;
  direction: "inbound" | "outbound";
  status: "inbox" | "sent";
  subject: string | null;
  from_name: string | null;
  from_email: string | null;
  to_name: string | null;
  to_email: string | null;
  recipients: { to: MailAddress[]; cc: MailAddress[]; reply_to: MailAddress[] };
  text_body: string | null;
  body_format: "text" | "html";
  body_truncated: boolean;
  is_read: boolean;
  is_replied: boolean;
  important: boolean;
  provider_internal_date: number | null;
  sent_at: number | null;
  size: number | null;
  attachments: AttachmentInfo[];
  labels: string[];
  metadata: { in_reply_to?: string | null; references?: string[] };
  trashed_at: number | null;
}

let ready = false;

/// The tables, made should this database have skipped migration 4.
function ensure() {
  if (ready) return;
  if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'emails'").get()) emailsSchema(sqlite);
  ready = true;
}

const json = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string") return fallback;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed === null || parsed === undefined ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
};

function sourceOf(row: Record<string, unknown> | undefined): EmailSource | null {
  if (!row) return null;
  return {
    ...(row as unknown as EmailSource),
    imap_security: row.imap_security === "starttls" ? "starttls" : "tls",
    metadata: json(row.metadata, {}),
  };
}

// ─── The mailbox ─────────────────────────────────────────────────────────

/// The mailbox the person set up (the one not removed).
export function activeSource(userId: string): EmailSource | null {
  ensure();
  return sourceOf(sqlite.prepare("SELECT * FROM email_sources WHERE user_id = ? AND status != 'removed' ORDER BY created_at DESC LIMIT 1").get(userId) as Record<string, unknown> | undefined);
}

export function sourceById(userId: string, id: string): EmailSource | null {
  ensure();
  return sourceOf(sqlite.prepare("SELECT * FROM email_sources WHERE user_id = ? AND id = ?").get(userId, id) as Record<string, unknown> | undefined);
}

/// Mailboxes removed whose copy the person kept, with their messages.
export function keptCopies(userId: string): Array<{ id: string; email_address: string; messages: number; removed_at: number }> {
  ensure();
  return sqlite.prepare(`SELECT s.id, s.email_address, s.updated_at AS removed_at, (SELECT count(*) FROM emails e WHERE e.email_source_id = s.id) AS messages
    FROM email_sources s WHERE s.user_id = ? AND s.status = 'removed' ORDER BY s.updated_at DESC`).all(userId) as Array<{ id: string; email_address: string; messages: number; removed_at: number }>;
}

export interface SourceSettings {
  email_address: string;
  display_name?: string | null;
  imap_host: string;
  imap_port: number;
  imap_security: MailSecurity;
  username: string;
  import_after: number;
  /// The window the person chose, in days (the page shows it again).
  window_days?: number | null;
  preset?: string | null;
}

const sameMailbox = (a: Pick<EmailSource, "email_address" | "imap_host" | "username">, b: Pick<SourceSettings, "email_address" | "imap_host" | "username">) =>
  a.email_address.toLowerCase() === b.email_address.toLowerCase() && a.imap_host.toLowerCase() === b.imap_host.toLowerCase() && a.username === b.username;

/// The mailbox as the person set it up now. The same mailbox keeps its
/// copy and where its sync stands; another one replaces it — the copy of
/// the one before is kept (`replaced`), its password is the caller's to
/// forget; a mailbox removed earlier and set up again finds its copy back.
export function saveSource(userId: string, settings: SourceSettings, now = Date.now()): { source: EmailSource; replaced: EmailSource | null } {
  ensure();
  const current = activeSource(userId);
  const metadata = JSON.stringify({ preset: settings.preset ?? null, window_days: settings.window_days ?? null });
  const write = (id: string) => {
    sqlite.prepare(`UPDATE email_sources SET email_address = ?, display_name = ?, imap_host = ?, imap_port = ?, imap_security = ?, username = ?,
      import_after = ?, status = 'active', last_error = NULL, metadata = ?, updated_at = ? WHERE id = ?`)
      .run(settings.email_address, settings.display_name ?? null, settings.imap_host, settings.imap_port, settings.imap_security, settings.username, settings.import_after, metadata, now, id);
  };
  return sqlite.transaction(() => {
    if (current && sameMailbox(current, settings)) {
      write(current.id);
      return { source: sourceById(userId, current.id)!, replaced: null };
    }
    if (current) sqlite.prepare("UPDATE email_sources SET status = 'removed', updated_at = ? WHERE id = ?").run(now, current.id);
    const before = (sqlite.prepare("SELECT * FROM email_sources WHERE user_id = ? AND status = 'removed' ORDER BY updated_at DESC").all(userId) as Array<Record<string, unknown>>)
      .map(sourceOf)
      .find((source) => source && source.id !== current?.id && sameMailbox(source, settings));
    if (before) {
      write(before.id);
      return { source: sourceById(userId, before.id)!, replaced: current };
    }
    const id = randomUUID();
    sqlite.prepare(`INSERT INTO email_sources (id, user_id, provider, email_address, display_name, imap_host, imap_port, imap_security, username, status, import_after, metadata, created_at, updated_at)
      VALUES (?, ?, 'imap', ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
      .run(id, userId, settings.email_address, settings.display_name ?? null, settings.imap_host, settings.imap_port, settings.imap_security, settings.username, settings.import_after, metadata, now, now);
    return { source: sourceById(userId, id)!, replaced: current };
  })();
}

export function noteSync(sourceId: string, change: { status?: SourceStatus; last_error?: string | null; last_synced_at?: number; last_imported_at?: number }, now = Date.now()) {
  ensure();
  const fields = Object.entries(change).filter(([, value]) => value !== undefined);
  if (!fields.length) return;
  // Never brings a removed mailbox back.
  sqlite.prepare(`UPDATE email_sources SET ${fields.map(([key]) => `${key} = ?`).join(", ")}, updated_at = ? WHERE id = ? AND status != 'removed'`)
    .run(...fields.map(([, value]) => value as string | number | null), now, sourceId);
}

/// Removed: no more sync. Its copy stays, searchable, until deleted.
export function markRemoved(sourceId: string, now = Date.now()) {
  ensure();
  sqlite.prepare("UPDATE email_sources SET status = 'removed', updated_at = ? WHERE id = ?").run(now, sourceId);
}

/// The mailbox and its copy on this computer, gone (the messages one by
/// one, so that their index follows).
export function deleteSource(sourceId: string) {
  ensure();
  sqlite.transaction(() => {
    sqlite.prepare("DELETE FROM emails WHERE email_source_id = ?").run(sourceId);
    sqlite.prepare("DELETE FROM email_folders WHERE email_source_id = ?").run(sourceId);
    sqlite.prepare("DELETE FROM email_sources WHERE id = ?").run(sourceId);
  })();
}

/// Users with a mailbox to keep in step.
export function usersWithMailboxes(): string[] {
  ensure();
  return (sqlite.prepare("SELECT DISTINCT user_id FROM email_sources WHERE status != 'removed'").all() as Array<{ user_id: string }>).map((row) => row.user_id);
}

// ─── Folders ─────────────────────────────────────────────────────────────

function folderOf(row: Record<string, unknown> | undefined): EmailFolder | null {
  return row ? (row as unknown as EmailFolder) : null;
}

export function foldersOf(sourceId: string): EmailFolder[] {
  ensure();
  return (sqlite.prepare("SELECT * FROM email_folders WHERE email_source_id = ? ORDER BY role IS NULL, role, path").all(sourceId) as Array<Record<string, unknown>>).map((row) => folderOf(row)!);
}

export function folderFor(sourceId: string, role: FolderRole): EmailFolder | null {
  ensure();
  return folderOf(sqlite.prepare("SELECT * FROM email_folders WHERE email_source_id = ? AND role = ? LIMIT 1").get(sourceId, role) as Record<string, unknown> | undefined);
}

/// The folder the server lists for a role, kept (another folder taking the
/// role keeps its own row: what was read in it stays).
export function upsertFolder(sourceId: string, folder: { path: string; name: string | null; special_use: string | null; role: FolderRole }, now = Date.now()): EmailFolder {
  ensure();
  return sqlite.transaction(() => {
    sqlite.prepare("UPDATE email_folders SET role = NULL, updated_at = ? WHERE email_source_id = ? AND role = ? AND path != ?").run(now, sourceId, folder.role, folder.path);
    const existing = folderOf(sqlite.prepare("SELECT * FROM email_folders WHERE email_source_id = ? AND path = ?").get(sourceId, folder.path) as Record<string, unknown> | undefined);
    if (existing) {
      sqlite.prepare("UPDATE email_folders SET name = ?, special_use = ?, role = ?, updated_at = ? WHERE id = ?").run(folder.name, folder.special_use, folder.role, now, existing.id);
      return folderOf(sqlite.prepare("SELECT * FROM email_folders WHERE id = ?").get(existing.id) as Record<string, unknown>)!;
    }
    const id = randomUUID();
    sqlite.prepare("INSERT INTO email_folders (id, email_source_id, path, name, special_use, role, last_uid, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)")
      .run(id, sourceId, folder.path, folder.name, folder.special_use, folder.role, now, now);
    return folderOf(sqlite.prepare("SELECT * FROM email_folders WHERE id = ?").get(id) as Record<string, unknown>)!;
  })();
}

/// The server renumbered the folder (another UIDVALIDITY): its messages
/// lose their UIDs — they are kept, and found again by their Message-ID.
export function renumberedFolder(folderId: string, now = Date.now()) {
  ensure();
  sqlite.transaction(() => {
    sqlite.prepare("UPDATE emails SET uid = NULL, updated_at = ? WHERE email_folder_id = ?").run(now, folderId);
    sqlite.prepare("UPDATE email_folders SET last_uid = 0, synced_after = NULL, uid_validity = NULL, updated_at = ? WHERE id = ?").run(now, folderId);
  })();
}

export function saveFolderState(folderId: string, state: { uid_validity: number; last_uid: number; synced_after: number; message_count: number; last_synced_at: number }) {
  ensure();
  sqlite.prepare("UPDATE email_folders SET uid_validity = ?, last_uid = ?, synced_after = ?, message_count = ?, last_synced_at = ?, updated_at = ? WHERE id = ?")
    .run(state.uid_validity, state.last_uid, state.synced_after, state.message_count, state.last_synced_at, state.last_synced_at, folderId);
}

export function knownUids(folderId: string): Set<number> {
  ensure();
  return new Set((sqlite.prepare("SELECT uid FROM emails WHERE email_folder_id = ? AND uid IS NOT NULL").all(folderId) as Array<{ uid: number }>).map((row) => row.uid));
}

/// The UIDs of the folder's most recent messages here, to read their flags again.
export function recentUids(folderId: string, limit: number): number[] {
  ensure();
  return (sqlite.prepare("SELECT uid FROM emails WHERE email_folder_id = ? AND uid IS NOT NULL ORDER BY uid DESC LIMIT ?").all(folderId, limit) as Array<{ uid: number }>).map((row) => row.uid);
}

// ─── Messages ────────────────────────────────────────────────────────────

export type NewEmail = Omit<EmailRow, "id">;

/// Kept: a message already here (same UID, or the same Message-ID that lost
/// its UID) only has its flags brought up to date. True when it is new.
export function saveEmail(email: NewEmail, now = Date.now()): boolean {
  ensure();
  return sqlite.transaction(() => {
    const same = (email.uid !== null
      ? sqlite.prepare("SELECT id FROM emails WHERE email_folder_id = ? AND uid = ?").get(email.email_folder_id, email.uid)
      : undefined) as { id: string } | undefined;
    const orphan = !same && email.provider_message_id
      ? (sqlite.prepare("SELECT id FROM emails WHERE email_folder_id = ? AND provider_message_id = ? AND uid IS NULL LIMIT 1").get(email.email_folder_id, email.provider_message_id) as { id: string } | undefined)
      : undefined;
    const existing = same ?? orphan;
    if (existing) {
      sqlite.prepare("UPDATE emails SET uid = ?, uid_validity = ?, is_read = ?, is_replied = ?, important = ?, trashed_at = ?, updated_at = ? WHERE id = ?")
        .run(email.uid, email.uid_validity, email.is_read ? 1 : 0, email.is_replied ? 1 : 0, email.important ? 1 : 0, email.trashed_at, now, existing.id);
      return false;
    }
    sqlite.prepare(`INSERT INTO emails (id, user_id, email_source_id, email_folder_id, uid, uid_validity, provider_message_id, provider_thread_id, provider_label_ids,
        direction, status, subject, from_name, from_email, to_name, to_email, recipients, people, text_body, body_format, body_truncated,
        is_read, is_replied, important, provider_internal_date, sent_at, size, attachment_metadata, metadata, trashed_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        randomUUID(), email.user_id, email.email_source_id, email.email_folder_id, email.uid, email.uid_validity, email.provider_message_id, email.provider_thread_id, JSON.stringify(email.labels),
        email.direction, email.status, email.subject, email.from_name, email.from_email, email.to_name, email.to_email, JSON.stringify(email.recipients),
        peopleLine(email), email.text_body, email.body_format, email.body_truncated ? 1 : 0,
        email.is_read ? 1 : 0, email.is_replied ? 1 : 0, email.important ? 1 : 0, email.provider_internal_date, email.sent_at, email.size,
        JSON.stringify({ attachments: email.attachments }), JSON.stringify(email.metadata), email.trashed_at, now, now,
      );
    return true;
  })();
}

/// Names and addresses of everyone on it, for the search.
function peopleLine(email: Pick<NewEmail, "from_name" | "from_email" | "recipients">): string {
  const people = [
    email.from_email ? { name: email.from_name, address: email.from_email } : null,
    ...email.recipients.to, ...email.recipients.cc,
  ].filter((entry): entry is MailAddress => !!entry);
  return people.map((entry) => (entry.name ? `${entry.name} ${entry.address}` : entry.address)).join("; ").slice(0, 4_000);
}

/// Flags read again on the server.
export function updateFlags(folderId: string, uid: number, state: FlagState, now = Date.now()) {
  ensure();
  sqlite.prepare(`UPDATE emails SET is_read = ?, is_replied = ?, important = ?, trashed_at = CASE WHEN ? THEN coalesce(trashed_at, ?) ELSE NULL END, updated_at = ?
    WHERE email_folder_id = ? AND uid = ? AND (is_read != ? OR is_replied != ? OR important != ? OR (trashed_at IS NULL) = ?)`)
    .run(state.is_read ? 1 : 0, state.is_replied ? 1 : 0, state.important ? 1 : 0, state.deleted ? 1 : 0, now, now, folderId, uid,
      state.is_read ? 1 : 0, state.is_replied ? 1 : 0, state.important ? 1 : 0, state.deleted ? 1 : 0);
}

function emailOf(row: Record<string, unknown>): EmailRow {
  const attachments = json<{ attachments?: AttachmentInfo[] }>(row.attachment_metadata, {}).attachments;
  return {
    id: row.id as string,
    user_id: row.user_id as string,
    email_source_id: row.email_source_id as string,
    email_folder_id: row.email_folder_id as string,
    uid: (row.uid as number | null) ?? null,
    uid_validity: (row.uid_validity as number | null) ?? null,
    provider_message_id: (row.provider_message_id as string | null) ?? null,
    provider_thread_id: (row.provider_thread_id as string | null) ?? null,
    direction: row.direction === "outbound" ? "outbound" : "inbound",
    status: row.status === "sent" ? "sent" : "inbox",
    subject: (row.subject as string | null) ?? null,
    from_name: (row.from_name as string | null) ?? null,
    from_email: (row.from_email as string | null) ?? null,
    to_name: (row.to_name as string | null) ?? null,
    to_email: (row.to_email as string | null) ?? null,
    recipients: { to: [], cc: [], reply_to: [], ...json(row.recipients, {}) },
    text_body: (row.text_body as string | null) ?? null,
    body_format: row.body_format === "html" ? "html" : "text",
    body_truncated: row.body_truncated === 1,
    is_read: row.is_read === 1,
    is_replied: row.is_replied === 1,
    important: row.important === 1,
    provider_internal_date: (row.provider_internal_date as number | null) ?? null,
    sent_at: (row.sent_at as number | null) ?? null,
    size: (row.size as number | null) ?? null,
    attachments: Array.isArray(attachments) ? attachments : [],
    labels: json<string[]>(row.provider_label_ids, []),
    metadata: json(row.metadata, {}),
    trashed_at: (row.trashed_at as number | null) ?? null,
  };
}

export interface EmailSearch {
  /// Words of the subject, the people or the text.
  query?: string | null;
  /// A name or an address of the sender.
  from?: string | null;
  /// Received on or after / before (ms).
  after?: number | null;
  before?: number | null;
  folder?: "inbox" | "sent" | null;
  limit?: number;
}

export interface EmailHit extends EmailRow {
  snippet: string | null;
}

const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const wordsOf = (text: string) => fold(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/// Whether a sender (« René », « rene@example.com », « Dupont ») is the one
/// an e-mail is from: each of its words starts a word of the sender's name
/// or address.
export function fromSender(email: Pick<EmailRow, "from_name" | "from_email">, sender: string): boolean {
  const wanted = wordsOf(sender);
  if (!wanted.length) return true;
  const words = wordsOf(`${email.from_name ?? ""} ${email.from_email ?? ""}`);
  return wanted.every((one) => words.some((word) => word.startsWith(one)));
}

/// How many rows a sender's search reads at most to find its e-mails among
/// those that only name them (sent to them, copied).
const SENDER_SCAN = 5_000;

/// The person's e-mails that match, best first when words are given,
/// newest first otherwise; never the ones flagged deleted on the server.
export function searchEmails(userId: string, search: EmailSearch): EmailHit[] {
  ensure();
  const limit = Math.max(1, Math.min(50, search.limit ?? 10));
  const filters: string[] = ["e.user_id = ?", "e.trashed_at IS NULL"];
  const values: Array<string | number> = [userId];
  if (search.after) { filters.push("e.provider_internal_date >= ?"); values.push(search.after); }
  if (search.before) { filters.push("e.provider_internal_date < ?"); values.push(search.before); }
  if (search.folder) { filters.push("e.status = ?"); values.push(search.folder); }
  const words = search.query ? buildMatchQuery(search.query) : null;
  const sender = search.from?.trim() ?? "";
  // The sender's words, all of them, among the people (the index folds
  // accents: « rene » finds « René »); checked against the sender alone
  // below.
  const senderTerms = wordsOf(sender).slice(0, 8).map((word) => `"${word}"*`);
  const match = [words ? `(${words})` : null, senderTerms.length ? `people : (${senderTerms.join(" AND ")})` : null].filter(Boolean).join(" AND ");
  const statement = match
    ? sqlite.prepare(`SELECT e.*, snippet(email_fts, 2, '', '', '…', 24) AS snippet
        FROM email_fts JOIN emails e ON e.rowid = email_fts.rowid
        WHERE email_fts MATCH ? AND ${filters.join(" AND ")}
        ORDER BY ${words ? "bm25(email_fts, 4.0, 2.0, 1.0), " : ""}e.provider_internal_date DESC LIMIT ?`)
    : sqlite.prepare(`SELECT e.*, NULL AS snippet FROM emails e WHERE ${filters.join(" AND ")} ORDER BY e.provider_internal_date DESC LIMIT ?`);
  const found: EmailHit[] = [];
  for (const row of statement.iterate(...(match ? [match] : []), ...values, senderTerms.length ? SENDER_SCAN : limit) as Iterable<Record<string, unknown>>) {
    const email = emailOf(row);
    if (senderTerms.length && !fromSender(email, sender)) continue;
    found.push({ ...email, snippet: (row.snippet as string | null) ?? null });
    if (found.length >= limit) break;
  }
  return found;
}

/// One e-mail of the person, by its id or the start of it (8 characters at
/// least, and only one e-mail starting so).
export function findEmail(userId: string, id: string): EmailRow | null {
  ensure();
  const given = id.trim().toLowerCase();
  if (!/^[0-9a-f-]{8,36}$/.test(given)) return null;
  const rows = sqlite.prepare("SELECT * FROM emails WHERE user_id = ? AND id LIKE ? LIMIT 2").all(userId, `${given}%`) as Array<Record<string, unknown>>;
  return rows.length === 1 ? emailOf(rows[0]!) : null;
}

/// The other e-mails of its conversation here, oldest first.
export function conversationOf(userId: string, email: EmailRow, limit = 10): EmailRow[] {
  ensure();
  if (!email.provider_thread_id) return [];
  return (sqlite.prepare("SELECT * FROM emails WHERE user_id = ? AND provider_thread_id = ? AND id != ? ORDER BY provider_internal_date ASC LIMIT ?")
    .all(userId, email.provider_thread_id, email.id, limit) as Array<Record<string, unknown>>).map(emailOf);
}

/// The latest e-mails of a mailbox (the page's list).
export function recentEmails(userId: string, options: { sourceId?: string | null; folder?: "inbox" | "sent" | null; limit?: number } = {}): EmailRow[] {
  ensure();
  const filters = ["user_id = ?", "trashed_at IS NULL"];
  const values: Array<string | number> = [userId];
  if (options.sourceId) { filters.push("email_source_id = ?"); values.push(options.sourceId); }
  if (options.folder) { filters.push("status = ?"); values.push(options.folder); }
  return (sqlite.prepare(`SELECT * FROM emails WHERE ${filters.join(" AND ")} ORDER BY provider_internal_date DESC LIMIT ?`)
    .all(...values, Math.max(1, Math.min(100, options.limit ?? 20))) as Array<Record<string, unknown>>).map(emailOf);
}

/// How many messages are kept here, by folder, for a mailbox.
export function countsOf(sourceId: string): { inbox: number; sent: number; unread: number } {
  ensure();
  const row = sqlite.prepare(`SELECT sum(status = 'inbox') AS inbox, sum(status = 'sent') AS sent, sum(status = 'inbox' AND is_read = 0 AND trashed_at IS NULL) AS unread
    FROM emails WHERE email_source_id = ?`).get(sourceId) as { inbox: number | null; sent: number | null; unread: number | null };
  return { inbox: row.inbox ?? 0, sent: row.sent ?? 0, unread: row.unread ?? 0 };
}

/// Whether the person has any e-mail here at all (a mailbox, or a copy kept).
export function hasEmails(userId: string): boolean {
  ensure();
  return Boolean(sqlite.prepare("SELECT 1 FROM emails WHERE user_id = ? LIMIT 1").get(userId));
}
