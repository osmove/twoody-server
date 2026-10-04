import { capabilityOn } from "../localCapabilities.js";
import { isLoopbackHost, mailHostKey, validMailHost, type MailSecurity } from "../outbound.js";
import { forgetMailSecret, keepMailSecret, mailSecret, openMailbox, renewMailRefreshToken, type MailSecret } from "./credentials.js";
import { mailErrorCode, type MailErrorCode, type MailSession } from "./imap.js";
import { MICROSOFT_IMAP } from "./microsoft.js";
import { cleanAddress, pickFolders } from "./parse.js";
import { activeSource, countsOf, deleteSource, folderFor, keptCopies, markRemoved, saveSource, sourceById, type EmailSource, type SourceSettings } from "./store.js";
import { DEFAULT_WINDOW_DAYS, needsThePerson, SYNC_INTERVAL_MS, syncMailbox, syncProgress } from "./sync.js";

// Setting up the person's mailbox (Capacités → E-mails): what they give,
// checked by connecting once — at their request, through the door of
// src/outbound.ts — then kept: the settings in the database, the password
// apart (credentials.ts). Twoody connects to no mail server before this.
// An Outlook.com or Microsoft 365 mailbox gives no password: the Desktop's
// main process signs in with Microsoft and gives the refresh token
// instead, kept in the password's place (microsoft.ts).

const DAY_MS = 86_400_000;
const MIN_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 3_650;
const REFRESH_TOKEN_MAX_CHARS = 16_384;

export type AccountError = MailErrorCode | "address_required" | "invalid_address" | "host_required" | "invalid_host" | "invalid_port" | "password_required" | "invalid_window";

export interface AccountInput {
  settings: SourceSettings;
  /// Given now, or the one already kept for this mailbox.
  secret: MailSecret;
  /// A new one was given (to keep).
  newSecret: boolean;
  /// The mailbox whose kept secret it is: a refresh token Microsoft gives
  /// back in its place, even during a test, is kept there.
  keptFor: string | null;
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
  const days = given.window_days === undefined || given.window_days === null ? DEFAULT_WINDOW_DAYS : Number(given.window_days);
  if (!Number.isInteger(days) || days < MIN_WINDOW_DAYS || days > MAX_WINDOW_DAYS) return { ok: false, error: "invalid_window" };
  const preset = typeof given.preset === "string" && /^[a-z0-9_-]{1,30}$/.test(given.preset) ? given.preset : null;
  if (given.auth === "microsoft") return readMicrosoftInput(userId, given, { address, days, preset, now });
  const host = typeof given.host === "string" ? mailHostKey(given.host) : "";
  if (!host) return { ok: false, error: "host_required" };
  if (!validMailHost(host)) return { ok: false, error: "invalid_host" };
  const loopback = isLoopbackHost(host);
  const port = given.port === undefined || given.port === null || given.port === "" ? (loopback ? 1143 : 993) : Number(given.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return { ok: false, error: "invalid_port" };
  const security: MailSecurity = given.security === "starttls" || given.security === "tls" ? given.security : loopback && port !== 993 ? "starttls" : "tls";
  if (security !== "tls" && !loopback) return { ok: false, error: "tls_required" };
  const username = typeof given.username === "string" && given.username.trim() ? given.username.trim().slice(0, 320) : address;
  const settings: SourceSettings = { email_address: address, imap_host: host, imap_port: port, imap_security: security, username, import_after: windowStart(days, now), window_days: days, preset, auth: "password" };
  // Google shows its app passwords in groups of four letters: the spaces
  // are no part of them.
  let password = typeof given.password === "string" ? given.password.trim() : "";
  if (host === "imap.gmail.com") password = password.replace(/\s+/g, "");
  if (password.length > 1_000) return { ok: false, error: "password_required" };
  if (password) return { ok: true, input: { settings, secret: { kind: "password", password }, newSecret: true, keptFor: null } };
  const current = activeSource(userId);
  const kept = current && current.email_address.toLowerCase() === address.toLowerCase() && current.imap_host === host && current.username === username ? mailSecret(current.id) : null;
  return kept?.kind === "password" ? { ok: true, input: { settings, secret: kept, newSecret: false, keptFor: current!.id } } : { ok: false, error: "password_required" };
}

/// « Se connecter avec Microsoft »: Microsoft's IMAP server, the address as
/// username, and the refresh token the Desktop's main process got
/// (twoody-desktop src/main/microsoftSignIn.ts) — or, without one, the one
/// kept for this mailbox.
function readMicrosoftInput(userId: string, given: Record<string, unknown>, read: { address: string; days: number; preset: string | null; now: number }): { ok: true; input: AccountInput } | { ok: false; error: AccountError } {
  const { address } = read;
  const settings: SourceSettings = {
    email_address: address, imap_host: MICROSOFT_IMAP.host, imap_port: MICROSOFT_IMAP.port, imap_security: MICROSOFT_IMAP.security, username: address,
    import_after: windowStart(read.days, read.now), window_days: read.days, preset: read.preset ?? "outlook", auth: "microsoft",
  };
  const refreshToken = typeof given.refresh_token === "string" ? given.refresh_token.trim() : "";
  if (refreshToken.length > REFRESH_TOKEN_MAX_CHARS) return { ok: false, error: "signin_failed" };
  if (refreshToken) return { ok: true, input: { settings, secret: { kind: "microsoft", refreshToken }, newSecret: true, keptFor: null } };
  const current = activeSource(userId);
  const kept = current && current.auth === "microsoft" && current.email_address.toLowerCase() === address.toLowerCase() ? mailSecret(current.id) : null;
  return kept?.kind === "microsoft" ? { ok: true, input: { settings, secret: kept, newSecret: false, keptFor: current!.id } } : { ok: false, error: "signin_required" };
}

export interface FoundFolders {
  inbox: string | null;
  sent: string | null;
  drafts: string | null;
}

/// Connects once with these settings — the person asked — and finds the
/// folders Twoody uses. Nothing is read or written. `secret`: the one to
/// keep, a refresh token Microsoft gave back in place of the one used.
export async function testMailbox(userId: string, input: AccountInput): Promise<{ ok: true; folders: FoundFolders; secret: MailSecret } | { ok: false; error: AccountError }> {
  let session: MailSession | null = null;
  let secret = input.secret;
  try {
    const { settings } = input;
    session = await openMailbox(
      { host: settings.imap_host, port: settings.imap_port, security: settings.imap_security, username: settings.username, secret },
      { configured: { host: settings.imap_host, port: settings.imap_port, auth: settings.auth ?? "password" }, emailOn: capabilityOn(userId, "email") },
      (used, newest) => {
        if (input.keptFor) renewMailRefreshToken(input.keptFor, used, newest);
        secret = { kind: "microsoft", refreshToken: newest };
      },
    );
    const picked = pickFolders(await session.listFolders());
    if (!picked.inbox) return { ok: false, error: "no_inbox" };
    return { ok: true, folders: { inbox: picked.inbox.path, sent: picked.sent?.path ?? null, drafts: picked.drafts?.path ?? null }, secret };
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
  // The secret given, or the one Microsoft gave back during the test.
  if (read.input.newSecret || tested.secret !== read.input.secret || !mailSecret(source.id)) keepMailSecret(source.id, tested.secret);
  // Another mailbox before it: its copy stays, its password or sign-in goes.
  if (replaced && replaced.id !== source.id) forgetMailSecret(replaced.id);
  void syncMailbox(userId).catch(() => undefined);
  return { ok: true, source, folders: tested.folders };
}

/// The mailbox removed: no more sync, its password or its Microsoft sign-in
/// forgotten; its copy on this computer kept (searchable) or deleted, as
/// the person chose.
export function removeMailbox(userId: string, keepMessages: boolean): boolean {
  const source = activeSource(userId);
  if (!source) return false;
  forgetMailSecret(source.id);
  if (keepMessages) markRemoved(source.id);
  else deleteSource(source.id);
  return true;
}

/// A copy kept from a mailbox removed earlier, deleted.
export function deleteKeptCopy(userId: string, id: string): boolean {
  const source = sourceById(userId, id);
  if (!source || source.status !== "removed") return false;
  forgetMailSecret(source.id);
  deleteSource(source.id);
  return true;
}

/// What the page shows: never the password, nor any token.
export function mailboxStatus(userId: string) {
  const source = activeSource(userId);
  const kept = keptCopies(userId);
  const enabled = capabilityOn(userId, "email");
  if (!source) return { enabled, configured: false, account: null, sync: null, counts: null, folders: null, kept };
  const progress = syncProgress(source.id);
  const days = typeof source.metadata.window_days === "number" ? source.metadata.window_days : DEFAULT_WINDOW_DAYS;
  const secret = mailSecret(source.id);
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
      auth: source.auth,
      password_kept: secret?.kind === "password",
      // A Microsoft sign-in kept (without one, a new sign-in is needed).
      signin_kept: secret?.kind === "microsoft",
    },
    sync: {
      ...progress,
      status: source.status,
      last_synced_at: source.last_synced_at,
      last_imported_at: source.last_imported_at,
      last_error: source.last_error,
      next_at: enabled && source.last_synced_at && !needsThePerson(source.last_error) ? source.last_synced_at + SYNC_INTERVAL_MS : null,
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
