import { capabilityOn } from "../localCapabilities.js";
import { isLoopbackHost, mailHostKey, validMailHost, type MailSecurity } from "../outbound.js";
import { forgetMailPassword, keepMailPassword, mailPassword } from "./credentials.js";
import { mailErrorCode, openMailSession, type MailErrorCode, type MailSession } from "./imap.js";
import { cleanAddress, pickFolders } from "./parse.js";
import { activeSource, countsOf, deleteSource, folderFor, keptCopies, markRemoved, saveSource, sourceById, type EmailSource, type SourceSettings } from "./store.js";
import { DEFAULT_WINDOW_DAYS, SYNC_INTERVAL_MS, syncMailbox, syncProgress } from "./sync.js";

// Setting up the person's mailbox (Capacités → E-mails): what they give,
// checked by connecting once — at their request, through the door of
// src/outbound.ts — then kept: the settings in the database, the password
// apart (credentials.ts). Twoody connects to no mail server before this.

const DAY_MS = 86_400_000;
const MIN_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 3_650;

export type AccountError = MailErrorCode | "address_required" | "invalid_address" | "host_required" | "invalid_host" | "invalid_port" | "password_required" | "invalid_window";

export interface AccountInput {
  settings: SourceSettings;
  /// Given now, or the one already kept for this mailbox.
  password: string;
  /// A new password was given (to keep).
  newPassword: boolean;
}

/// The first moment of the day `days` days ago, on this computer's clock.
export function windowStart(days: number, now = Date.now()): number {
  const start = new Date(now - days * DAY_MS);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

/// What the person typed, checked; the password left empty keeps the one
/// already kept for the same mailbox (the screen never has it).
export function readAccountInput(userId: string, body: unknown, now = Date.now()): { ok: true; input: AccountInput } | { ok: false; error: AccountError } {
  const given = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const rawAddress = typeof given.address === "string" ? given.address.trim() : "";
  if (!rawAddress) return { ok: false, error: "address_required" };
  const address = cleanAddress(rawAddress);
  if (!address) return { ok: false, error: "invalid_address" };
  const host = typeof given.host === "string" ? mailHostKey(given.host) : "";
  if (!host) return { ok: false, error: "host_required" };
  if (!validMailHost(host)) return { ok: false, error: "invalid_host" };
  const loopback = isLoopbackHost(host);
  const port = given.port === undefined || given.port === null || given.port === "" ? (loopback ? 1143 : 993) : Number(given.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return { ok: false, error: "invalid_port" };
  const security: MailSecurity = given.security === "starttls" || given.security === "tls" ? given.security : loopback && port !== 993 ? "starttls" : "tls";
  if (security !== "tls" && !loopback) return { ok: false, error: "tls_required" };
  const username = typeof given.username === "string" && given.username.trim() ? given.username.trim().slice(0, 320) : address;
  const days = given.window_days === undefined || given.window_days === null ? DEFAULT_WINDOW_DAYS : Number(given.window_days);
  if (!Number.isInteger(days) || days < MIN_WINDOW_DAYS || days > MAX_WINDOW_DAYS) return { ok: false, error: "invalid_window" };
  const preset = typeof given.preset === "string" && /^[a-z0-9_-]{1,30}$/.test(given.preset) ? given.preset : null;
  const settings: SourceSettings = { email_address: address, imap_host: host, imap_port: port, imap_security: security, username, import_after: windowStart(days, now), window_days: days, preset };
  // Google shows its app passwords in groups of four letters: the spaces
  // are no part of them.
  let password = typeof given.password === "string" ? given.password.trim() : "";
  if (host === "imap.gmail.com") password = password.replace(/\s+/g, "");
  if (password.length > 1_000) return { ok: false, error: "password_required" };
  if (password) return { ok: true, input: { settings, password, newPassword: true } };
  const current = activeSource(userId);
  const kept = current && current.email_address.toLowerCase() === address.toLowerCase() && current.imap_host === host && current.username === username ? mailPassword(current.id) : null;
  return kept ? { ok: true, input: { settings, password: kept, newPassword: false } } : { ok: false, error: "password_required" };
}

export interface FoundFolders {
  inbox: string | null;
  sent: string | null;
  drafts: string | null;
}

/// Connects once with these settings — the person asked — and finds the
/// folders Twoody uses. Nothing is read or written.
export async function testMailbox(userId: string, input: AccountInput): Promise<{ ok: true; folders: FoundFolders } | { ok: false; error: AccountError }> {
  let session: MailSession | null = null;
  try {
    const { settings } = input;
    session = await openMailSession(
      { host: settings.imap_host, port: settings.imap_port, security: settings.imap_security, username: settings.username, password: input.password },
      { configured: { host: settings.imap_host, port: settings.imap_port }, emailOn: capabilityOn(userId, "email") },
    );
    const picked = pickFolders(await session.listFolders());
    if (!picked.inbox) return { ok: false, error: "no_inbox" };
    return { ok: true, folders: { inbox: picked.inbox.path, sent: picked.sent?.path ?? null, drafts: picked.drafts?.path ?? null } };
  } catch (err) {
    return { ok: false, error: mailErrorCode(err) };
  } finally {
    await session?.close().catch(() => undefined);
  }
}

/// Checked, then kept, and read at once.
export async function setUpMailbox(userId: string, body: unknown): Promise<{ ok: true; source: EmailSource; folders: FoundFolders } | { ok: false; error: AccountError }> {
  const read = readAccountInput(userId, body);
  if (!read.ok) return read;
  const tested = await testMailbox(userId, read.input);
  if (!tested.ok) return tested;
  const { source, replaced } = saveSource(userId, read.input.settings);
  if (read.input.newPassword || !mailPassword(source.id)) keepMailPassword(source.id, read.input.password);
  // Another mailbox before it: its copy stays, its password goes.
  if (replaced && replaced.id !== source.id) forgetMailPassword(replaced.id);
  void syncMailbox(userId).catch(() => undefined);
  return { ok: true, source, folders: tested.folders };
}

/// The mailbox removed: no more sync, its password forgotten; its copy on
/// this computer kept (searchable) or deleted, as the person chose.
export function removeMailbox(userId: string, keepMessages: boolean): boolean {
  const source = activeSource(userId);
  if (!source) return false;
  forgetMailPassword(source.id);
  if (keepMessages) markRemoved(source.id);
  else deleteSource(source.id);
  return true;
}

/// A copy kept from a mailbox removed earlier, deleted.
export function deleteKeptCopy(userId: string, id: string): boolean {
  const source = sourceById(userId, id);
  if (!source || source.status !== "removed") return false;
  forgetMailPassword(source.id);
  deleteSource(source.id);
  return true;
}

/// What the page shows: never the password.
export function mailboxStatus(userId: string) {
  const source = activeSource(userId);
  const kept = keptCopies(userId);
  const enabled = capabilityOn(userId, "email");
  if (!source) return { enabled, configured: false, account: null, sync: null, counts: null, folders: null, kept };
  const progress = syncProgress(source.id);
  const days = typeof source.metadata.window_days === "number" ? source.metadata.window_days : DEFAULT_WINDOW_DAYS;
  return {
    enabled,
    configured: true,
    account: {
      id: source.id,
      address: source.email_address,
      host: source.imap_host,
      port: source.imap_port,
      security: source.imap_security,
      username: source.username,
      preset: typeof source.metadata.preset === "string" ? source.metadata.preset : null,
      import_after: source.import_after,
      window_days: days,
      password_kept: mailPassword(source.id) !== null,
    },
    sync: {
      ...progress,
      status: source.status,
      last_synced_at: source.last_synced_at,
      last_imported_at: source.last_imported_at,
      last_error: source.last_error,
      next_at: enabled && source.last_synced_at && source.last_error !== "auth_failed" ? source.last_synced_at + SYNC_INTERVAL_MS : null,
    },
    counts: countsOf(source.id),
    folders: {
      inbox: folderFor(source.id, "inbox")?.path ?? null,
      sent: folderFor(source.id, "sent")?.path ?? null,
      drafts: folderFor(source.id, "drafts")?.path ?? null,
    },
    kept,
  };
}
