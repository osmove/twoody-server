import { randomUUID } from "node:crypto";
import { sqlite } from "../db.js";
import { emailsSchema } from "../migrations/0004_emails.js";
import { buildMatchQuery, cjkTerms, queryTerms, termsFound } from "../documents/query.js";
import { cjkSnippet, cjkWordsFound, hasCjk, likePatterns } from "../documents/cjk.js";
import type { MailSecurity } from "../outbound.js";
import { asksSomething, automatedSender, type AttachmentInfo, type FlagState, type FolderRole, type MailAddress } from "./parse.js";

// The copy of the person's mailboxes on this computer (migration 4,
// src/migrations/0004_emails.ts): the mailboxes set up — several, each its
// own row, its own folders, its own sync (05/10/2026: « si je veux mettre
// aussi mon email perso ») — their messages and their full-text index.
// Nothing here talks to a server.
//
// A mailbox read through Microsoft Graph (graphMailbox.ts) needs no column
// of its own: a message's Graph id is kept in its metadata (`graph_id`; it
// has no IMAP UID), and where each folder's round of changes stands in the
// mailbox's metadata (`graph_folders`). One read through the Gmail API
// (gmailMailbox.ts) likewise: a message's Gmail id in its metadata
// (`gmail_id`), where the mailbox's changes stand in the mailbox's
// (`gmail_sync`).

export type SourceStatus = "active" | "error" | "removed";

/// How the mailbox is opened: its password, over IMAP; Microsoft's sign-in,
/// over IMAP (an Outlook.com or Microsoft 365 mailbox linked by Twoody
/// 0.13.76, microsoft.ts, kept working as it was until the person signs in
/// again); the link to Microsoft Graph, no IMAP at all (graphMailbox.ts); or
/// Google's sign-in, read through the Gmail API, no IMAP either
/// (gmailMailbox.ts). Kept in its metadata; a mailbox set up before
/// Microsoft's has a password.
export type MailAuth = "password" | "microsoft" | "graph" | "gmail";

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
  auth: MailAuth;
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
  /// `graph_id`: the message's id at Microsoft Graph, for a mailbox read
  /// through it; `gmail_id`: at Gmail, for one read through the Gmail API.
  metadata: { in_reply_to?: string | null; references?: string[]; automated?: boolean; graph_id?: string; gmail_id?: string };
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
  const metadata = json<Record<string, unknown>>(row.metadata, {});
  return {
    ...(row as unknown as EmailSource),
    imap_security: row.imap_security === "starttls" ? "starttls" : "tls",
    auth: metadata.auth === "microsoft" || metadata.auth === "graph" || metadata.auth === "gmail" ? metadata.auth : "password",
    metadata,
  };
}

// ─── The mailbox ─────────────────────────────────────────────────────────

/// Mailboxes a person may set up at most.
export const MAX_MAILBOXES = 10;

/// The mailboxes the person set up (not removed), the first set up first.
export function activeSources(userId: string): EmailSource[] {
  ensure();
  return (sqlite.prepare("SELECT * FROM email_sources WHERE user_id = ? AND status != 'removed' ORDER BY created_at ASC, rowid ASC").all(userId) as Array<Record<string, unknown>>)
    .map((row) => sourceOf(row)!);
}

/// The first mailbox the person set up: the one a draft is written from
/// when nothing says which — and the one clients that know of a single
/// mailbox are shown.
export function activeSource(userId: string): EmailSource | null {
  return activeSources(userId)[0] ?? null;
}

/// The person's mailbox read through Microsoft Graph: one at most, the
/// account of the one link to Microsoft (src/microsoft/link.ts).
export function graphSource(userId: string): EmailSource | null {
  return activeSources(userId).find((source) => source.auth === "graph") ?? null;
}

/// The addresses of every mailbox of the person, removed ones included (a
/// copy kept), by id: which mailbox an e-mail is from.
export function sourceAddresses(userId: string): Map<string, string> {
  ensure();
  return new Map((sqlite.prepare("SELECT id, email_address FROM email_sources WHERE user_id = ?").all(userId) as Array<{ id: string; email_address: string }>).map((row) => [row.id, row.email_address]));
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
  auth?: MailAuth;
}

const sameMailbox = (a: Pick<EmailSource, "email_address" | "imap_host" | "username">, b: Pick<SourceSettings, "email_address" | "imap_host" | "username">) =>
  a.email_address.toLowerCase() === b.email_address.toLowerCase() && a.imap_host.toLowerCase() === b.imap_host.toLowerCase() && a.username === b.username;

/// A mailbox as the person set it up now: the same mailbox (its address,
/// server and user name) keeps its copy and where its sync stands; one set
/// up at an address another mailbox has (other settings), or in place of
/// the one being edited (`replacing`), takes its place — the copy of the
/// one before is kept (`replaced`), its password is the caller's to forget;
/// any other is added next to the others; a mailbox removed earlier and set
/// up again finds its copy back.
export function saveSource(userId: string, settings: SourceSettings, options: { replacing?: string | null; now?: number } = {}): { source: EmailSource; replaced: EmailSource | null } {
  ensure();
  const now = options.now ?? Date.now();
  // The same mailbox still read through Graph keeps where its folders'
  // rounds of changes stand: signed in again, it does not read them anew.
  const metadataFor = (before: EmailSource | null) => JSON.stringify({
    preset: settings.preset ?? null, window_days: settings.window_days ?? null, auth: settings.auth ?? "password",
    ...(before?.auth === "graph" && settings.auth === "graph" && before.metadata.graph_folders ? { graph_folders: before.metadata.graph_folders } : {}),
    // And one read through the Gmail API, where its changes stand.
    ...(before?.auth === "gmail" && settings.auth === "gmail" && before.metadata.gmail_sync ? { gmail_sync: before.metadata.gmail_sync } : {}),
  });
  const write = (before: EmailSource) => {
    sqlite.prepare(`UPDATE email_sources SET email_address = ?, display_name = ?, imap_host = ?, imap_port = ?, imap_security = ?, username = ?,
      import_after = ?, status = 'active', last_error = NULL, metadata = ?, updated_at = ? WHERE id = ?`)
      .run(settings.email_address, settings.display_name ?? null, settings.imap_host, settings.imap_port, settings.imap_security, settings.username, settings.import_after, metadataFor(before), now, before.id);
  };
  const remove = (source: EmailSource) => sqlite.prepare("UPDATE email_sources SET status = 'removed', updated_at = ? WHERE id = ?").run(now, source.id);
  return sqlite.transaction(() => {
    const active = activeSources(userId);
    const edited = options.replacing ? active.find((source) => source.id === options.replacing) ?? null : null;
    const same = active.find((source) => sameMailbox(source, settings));
    if (same) {
      write(same);
      // Edited into another mailbox already set up: the one edited stops.
      const replaced = edited && edited.id !== same.id ? edited : null;
      if (replaced) remove(replaced);
      return { source: sourceById(userId, same.id)!, replaced };
    }
    const current = edited ?? active.find((source) => source.email_address.toLowerCase() === settings.email_address.toLowerCase()) ?? null;
    if (current) remove(current);
    const before = (sqlite.prepare("SELECT * FROM email_sources WHERE user_id = ? AND status = 'removed' ORDER BY updated_at DESC").all(userId) as Array<Record<string, unknown>>)
      .map(sourceOf)
      .find((source) => source && source.id !== current?.id && sameMailbox(source, settings));
    if (before) {
      write(before);
      return { source: sourceById(userId, before.id)!, replaced: current };
    }
    const id = randomUUID();
    sqlite.prepare(`INSERT INTO email_sources (id, user_id, provider, email_address, display_name, imap_host, imap_port, imap_security, username, status, import_after, metadata, created_at, updated_at)
      VALUES (?, ?, 'imap', ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
      .run(id, userId, settings.email_address, settings.display_name ?? null, settings.imap_host, settings.imap_port, settings.imap_security, settings.username, settings.import_after, metadataFor(null), now, now);
    return { source: sourceById(userId, id)!, replaced: current };
  })();
}

/// Whether setting up this mailbox would add one (not the same as one set
/// up, nor at the address of one, nor in place of the one edited).
export function addsMailbox(userId: string, settings: Pick<SourceSettings, "email_address" | "imap_host" | "username">, replacing: string | null): boolean {
  const active = activeSources(userId);
  if (replacing && active.some((source) => source.id === replacing)) return false;
  return !active.some((source) => sameMailbox(source, settings) || source.email_address.toLowerCase() === settings.email_address.toLowerCase());
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
    insertEmail(email, now);
    return true;
  })();
}

/// A new message, as it is: its row's id.
function insertEmail(email: NewEmail, now: number): string {
  const id = randomUUID();
  sqlite.prepare(`INSERT INTO emails (id, user_id, email_source_id, email_folder_id, uid, uid_validity, provider_message_id, provider_thread_id, provider_label_ids,
      direction, status, subject, from_name, from_email, to_name, to_email, recipients, people, text_body, body_format, body_truncated,
      is_read, is_replied, important, provider_internal_date, sent_at, size, attachment_metadata, metadata, trashed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id, email.user_id, email.email_source_id, email.email_folder_id, email.uid, email.uid_validity, email.provider_message_id, email.provider_thread_id, JSON.stringify(email.labels),
      email.direction, email.status, email.subject, email.from_name, email.from_email, email.to_name, email.to_email, JSON.stringify(email.recipients),
      peopleLine(email), email.text_body, email.body_format, email.body_truncated ? 1 : 0,
      email.is_read ? 1 : 0, email.is_replied ? 1 : 0, email.important ? 1 : 0, email.provider_internal_date, email.sent_at, email.size,
      JSON.stringify({ attachments: email.attachments }), JSON.stringify(email.metadata), email.trashed_at, now, now,
    );
  return id;
}

// ─── Through Microsoft Graph ─────────────────────────────────────────────

/// Where a folder's round of changes stands, for a mailbox read through
/// Microsoft Graph: the start of the window the round was asked with, the
/// next page of a round under way, and where the next round starts.
export interface GraphFolderState {
  since: number;
  next_link: string | null;
  delta_link: string | null;
}

/// The folders read through Graph.
export type GraphReadRole = "inbox" | "sent";

function sourceMetadata(sourceId: string): Record<string, unknown> | null {
  const row = sqlite.prepare("SELECT metadata FROM email_sources WHERE id = ? AND status != 'removed'").get(sourceId) as { metadata: string } | undefined;
  return row ? json<Record<string, unknown>>(row.metadata, {}) : null;
}

export function graphFolderState(sourceId: string, role: GraphReadRole): GraphFolderState | null {
  ensure();
  const kept = (sourceMetadata(sourceId)?.graph_folders as Record<string, Partial<GraphFolderState>> | undefined)?.[role];
  if (!kept || typeof kept.since !== "number") return null;
  return { since: kept.since, next_link: typeof kept.next_link === "string" ? kept.next_link : null, delta_link: typeof kept.delta_link === "string" ? kept.delta_link : null };
}

/// Noted for the mailbox (null: none, to start a new round) — never for one
/// removed meanwhile.
export function saveGraphFolderState(sourceId: string, role: GraphReadRole, state: GraphFolderState | null, now = Date.now()): void {
  ensure();
  sqlite.transaction(() => {
    const metadata = sourceMetadata(sourceId);
    if (!metadata) return;
    const folders = { ...((metadata.graph_folders as Record<string, unknown> | undefined) ?? {}) };
    if (state) folders[role] = state;
    else delete folders[role];
    sqlite.prepare("UPDATE email_sources SET metadata = ?, updated_at = ? WHERE id = ? AND status != 'removed'").run(JSON.stringify({ ...metadata, graph_folders: folders }), now, sourceId);
  })();
}

const SPECIAL_USE: Record<FolderRole, string> = { inbox: "\\Inbox", sent: "\\Sent", drafts: "\\Drafts" };

/// A folder of a mailbox read through Graph: the one kept for its role (from
/// IMAP before the mailbox moved to Graph: its messages are the same), else
/// a new one under Graph's well-known name; the name the person sees, Graph's.
export function graphFolder(sourceId: string, role: FolderRole, wellKnown: string, name: string | null, now = Date.now()): EmailFolder {
  ensure();
  const existing = folderFor(sourceId, role);
  if (!existing) return upsertFolder(sourceId, { path: wellKnown, name, special_use: SPECIAL_USE[role], role }, now);
  if (name && name !== existing.name) sqlite.prepare("UPDATE email_folders SET name = ?, updated_at = ? WHERE id = ?").run(name, now, existing.id);
  return { ...existing, name: name ?? existing.name };
}

/// A round of a folder's changes finished.
export function noteGraphFolder(folderId: string, state: { synced_after: number; message_count: number | null; last_synced_at: number }): void {
  ensure();
  sqlite.prepare("UPDATE email_folders SET synced_after = ?, message_count = coalesce(?, message_count), last_synced_at = ?, updated_at = ? WHERE id = ?")
    .run(state.synced_after, state.message_count, state.last_synced_at, state.last_synced_at, folderId);
}

/// Where a message's id at its service is kept in its metadata: Microsoft
/// Graph's, or Gmail's (the same code keeps both copies).
export type RemoteIdKey = "graph_id" | "gmail_id";
const idPath = (key: RemoteIdKey) => (key === "gmail_id" ? "$.gmail_id" : "$.graph_id");

/// The folder's messages read through Graph (or Gmail's API): their id
/// there, and their row.
export function graphIdsIn(folderId: string, key: RemoteIdKey = "graph_id"): Map<string, string> {
  ensure();
  const path = idPath(key);
  const rows = sqlite.prepare(`SELECT id, json_extract(metadata, '${path}') AS remote_id FROM emails WHERE email_folder_id = ? AND json_extract(metadata, '${path}') IS NOT NULL`).all(folderId) as Array<{ id: string; remote_id: string }>;
  return new Map(rows.map((row) => [row.remote_id, row.id]));
}

/// The row of the folder a message read through Graph already is, by its
/// Message-ID: one kept from IMAP before the mailbox moved to Graph, or one
/// removed from the folder and back since (under another Graph id).
function counterpart(folderId: string, messageId: string | null, key: RemoteIdKey = "graph_id"): string | null {
  if (!messageId) return null;
  const path = idPath(key);
  const row = sqlite.prepare(`SELECT id FROM emails WHERE email_folder_id = ? AND provider_message_id = ?
      AND (json_extract(metadata, '${path}') IS NULL OR trashed_at IS NOT NULL)
    ORDER BY json_extract(metadata, '${path}') IS NULL DESC, provider_internal_date DESC LIMIT 1`).get(folderId, messageId) as { id: string } | undefined;
  return row?.id ?? null;
}

/// Whether a message read through Graph (or Gmail's API) is already here,
/// kept another way.
export function graphCounterpart(folderId: string, messageId: string | null, key: RemoteIdKey = "graph_id"): boolean {
  ensure();
  return counterpart(folderId, messageId, key) !== null;
}

/// Where the window's first reading of one folder stands, for a mailbox
/// read through the Gmail API: the next page of its list (null: from the
/// start), or read to its end.
export interface GmailBackfillCursor {
  page_token: string | null;
  done: boolean;
}

/// Where a mailbox read through the Gmail API stands: the start of the
/// window its messages were listed from, Gmail's history id its next round
/// of changes starts at, and — while the window's first reading is under
/// way, over several rounds if need be — where INBOX's and SENT's lists stand.
export interface GmailSyncState {
  since: number;
  history_id: string | null;
  backfill: Record<GraphReadRole, GmailBackfillCursor> | null;
}

function cursorOf(value: unknown): GmailBackfillCursor {
  const kept = (value && typeof value === "object" ? value : {}) as Partial<GmailBackfillCursor>;
  const token = typeof kept.page_token === "string" && kept.page_token.length <= 2_000 ? kept.page_token : null;
  return { page_token: token, done: kept.done === true };
}

export function gmailSyncState(sourceId: string): GmailSyncState | null {
  ensure();
  const kept = sourceMetadata(sourceId)?.gmail_sync as (Partial<Omit<GmailSyncState, "backfill">> & { backfill?: Record<string, unknown> | null }) | undefined;
  if (!kept || typeof kept.since !== "number") return null;
  const backfill = kept.backfill && typeof kept.backfill === "object" ? { inbox: cursorOf(kept.backfill.inbox), sent: cursorOf(kept.backfill.sent) } : null;
  return { since: kept.since, history_id: typeof kept.history_id === "string" && /^\d{1,30}$/.test(kept.history_id) ? kept.history_id : null, backfill };
}

/// Noted for the mailbox (null: none, to list it again) — never for one
/// removed meanwhile.
export function saveGmailSyncState(sourceId: string, state: GmailSyncState | null, now = Date.now()): void {
  ensure();
  sqlite.transaction(() => {
    const metadata = sourceMetadata(sourceId);
    if (!metadata) return;
    const next = { ...metadata };
    if (state) next.gmail_sync = state.backfill ? state : { since: state.since, history_id: state.history_id };
    else delete next.gmail_sync;
    sqlite.prepare("UPDATE email_sources SET metadata = ?, updated_at = ? WHERE id = ? AND status != 'removed'").run(JSON.stringify(next), now, sourceId);
  })();
}

/// Why the last round stopped before its end without failing: the mailbox's
/// service limits the pace (`rate_limited`; the next round, soon, carries on).
export type SyncPause = "rate_limited";

export function syncPauseOf(source: EmailSource): SyncPause | null {
  return source.metadata.sync_pause === "rate_limited" ? "rate_limited" : null;
}

/// Noted (null: the last round went to its end) — never for a mailbox removed meanwhile.
export function noteSyncPause(sourceId: string, pause: SyncPause | null, now = Date.now()): void {
  ensure();
  sqlite.transaction(() => {
    const metadata = sourceMetadata(sourceId);
    if (!metadata || (metadata.sync_pause ?? null) === pause) return;
    const next = { ...metadata };
    if (pause) next.sync_pause = pause;
    else delete next.sync_pause;
    sqlite.prepare("UPDATE email_sources SET metadata = ?, updated_at = ? WHERE id = ? AND status != 'removed'").run(JSON.stringify(next), now, sourceId);
  })();
}

/// Whether the window's first reading of a mailbox is still under way.
export function firstReadUnderway(source: EmailSource): boolean {
  if (source.auth === "gmail") {
    const state = gmailSyncState(source.id);
    return !state || !!state.backfill;
  }
  return source.last_synced_at === null;
}

/// What a change of Graph (or of Gmail) says of one message.
export interface GraphChange {
  graphId: string;
  /// Gone from the folder: deleted, or moved elsewhere.
  removed: boolean;
  /// The message as it is kept when new; null for a removal.
  email: NewEmail | null;
  /// Read and flagged now (null: the change does not say).
  isRead: boolean | null;
  flagged: boolean | null;
}

/// A page of changes kept, all or none: what is new added, what was here
/// brought up to date (read, flagged, back in the folder), what left the
/// folder hidden — kept, as a message flagged deleted is, never purged.
/// `known` (Graph id → row) follows. How many messages are new.
export function saveGraphChanges(folderId: string, changes: GraphChange[], known: Map<string, string>, now = Date.now(), key: RemoteIdKey = "graph_id"): number {
  ensure();
  const path = idPath(key);
  return sqlite.transaction(() => {
    let added = 0;
    for (const change of changes) {
      const row = known.get(change.graphId);
      if (change.removed) {
        if (row) sqlite.prepare("UPDATE emails SET trashed_at = coalesce(trashed_at, ?), updated_at = ? WHERE id = ?").run(now, now, row);
        continue;
      }
      const flags = [change.isRead === null ? null : change.isRead ? 1 : 0, change.flagged === null ? null : change.flagged ? 1 : 0] as const;
      if (row) {
        sqlite.prepare("UPDATE emails SET is_read = coalesce(?, is_read), important = coalesce(?, important), trashed_at = NULL, updated_at = ? WHERE id = ?").run(...flags, now, row);
        continue;
      }
      const email = change.email;
      if (!email) continue;
      const before = counterpart(folderId, email.provider_message_id, key);
      if (before) {
        // The same e-mail: it takes its Graph (or Gmail) id and conversation, its UID goes.
        sqlite.prepare(`UPDATE emails SET uid = NULL, uid_validity = NULL, provider_thread_id = coalesce(?, provider_thread_id), is_read = coalesce(?, is_read), important = coalesce(?, important),
            trashed_at = NULL, metadata = json_set(metadata, '${path}', ?), updated_at = ? WHERE id = ?`)
          .run(email.provider_thread_id, ...flags, change.graphId, now, before);
        known.set(change.graphId, before);
        continue;
      }
      known.set(change.graphId, insertEmail(email, now));
      added += 1;
    }
    return added;
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
  const cjk = search.query ? cjkTerms(search.query) : [];
  if (cjk.length) return emailsByPairs(search.query!, cjk, sender, filters, values, limit);
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

/// How many e-mails the search by pairs reads at most, newest first.
const PAIRS_SCAN = 2_000;

/// A search in Japanese, Chinese or Korean (10/10/2026): email_fts cuts
/// words at spaces only (src/documents/cjk.ts), so the e-mails holding any
/// pair of the words' characters are read, newest first, and those holding
/// most of a word's pairs kept — the more words, then the newer, first.
function emailsByPairs(query: string, cjk: string[], sender: string, filters: string[], values: Array<string | number>, limit: number): EmailHit[] {
  const patterns = likePatterns(cjk);
  const others = queryTerms(query).filter((term) => !hasCjk(term));
  const near = patterns.map(() => "(e.subject LIKE ? OR e.people LIKE ? OR e.text_body LIKE ?)").join(" OR ");
  const rows = sqlite.prepare(`SELECT e.* FROM emails e WHERE ${filters.join(" AND ")} AND (${near})
      ORDER BY e.provider_internal_date DESC LIMIT ?`)
    .all(...values, ...patterns.flatMap((pattern) => [pattern, pattern, pattern]), PAIRS_SCAN) as Array<Record<string, unknown>>;
  const scored: Array<{ hit: EmailHit; found: number; at: number }> = [];
  for (const row of rows) {
    const email = emailOf(row);
    if (sender && !fromSender(email, sender)) continue;
    const text = `${email.subject ?? ""}\n${String(row.people ?? "")}\n${email.text_body ?? ""}`;
    const words = cjkWordsFound(text, cjk);
    if (words === 0) continue;
    scored.push({ hit: { ...email, snippet: cjkSnippet(email.text_body ?? email.subject ?? "", cjk, 100) }, found: words + termsFound(text, others), at: Number(row.provider_internal_date) || 0 });
  }
  return scored.sort((a, b) => b.found - a.found || b.at - a.at).slice(0, limit).map((entry) => entry.hit);
}

/// Received e-mails the person has not answered yet, that ask them
/// something, from a person (not a list, a newsletter or a notice): not
/// flagged answered, and no answer of theirs after it in its conversation.
/// Newest first.
export function unansweredEmails(userId: string, options: { after?: number | null; limit?: number } = {}): EmailRow[] {
  ensure();
  const rows = sqlite.prepare(`SELECT e.* FROM emails e
    WHERE e.user_id = ? AND e.status = 'inbox' AND e.trashed_at IS NULL AND e.is_replied = 0
      AND (? IS NULL OR e.provider_internal_date >= ?)
      AND coalesce(json_extract(e.metadata, '$.automated'), 0) = 0
      AND NOT EXISTS (SELECT 1 FROM emails s WHERE s.user_id = e.user_id AND s.status = 'sent' AND s.provider_thread_id = e.provider_thread_id
                      AND s.provider_internal_date > e.provider_internal_date)
    ORDER BY e.provider_internal_date DESC LIMIT 300`).all(userId, options.after ?? null, options.after ?? null) as Array<Record<string, unknown>>;
  return rows.map(emailOf).filter((email) => !automatedSender(email.from_email) && asksSomething(email.text_body)).slice(0, Math.max(1, Math.min(30, options.limit ?? 10)));
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

/// The latest e-mails of a mailbox, or of some (the page's list).
export function recentEmails(userId: string, options: { sourceId?: string | null; sourceIds?: string[] | null; folder?: "inbox" | "sent" | null; limit?: number } = {}): EmailRow[] {
  ensure();
  const filters = ["user_id = ?", "trashed_at IS NULL"];
  const values: Array<string | number> = [userId];
  if (options.sourceId) { filters.push("email_source_id = ?"); values.push(options.sourceId); }
  if (options.sourceIds) {
    if (!options.sourceIds.length) return [];
    filters.push(`email_source_id IN (${options.sourceIds.map(() => "?").join(", ")})`);
    values.push(...options.sourceIds);
  }
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
