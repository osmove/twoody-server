import { capabilityOn } from "../localCapabilities.js";
import { forgetGraphLink, GRAPH_CAPABILITIES, GRAPH_SCOPES, graphLink, graphPermissions, linkGrants, releaseGraphPermissions } from "../microsoft/link.js";
import { keepMicrosoftLink } from "../microsoft/sync.js";
import { isLoopbackHost, mailHostKey, validMailHost, type MailSecurity } from "../outbound.js";
import { forgetMailSecret, keepMailSecret, mailSecret, openMailbox, renewMailRefreshToken, type MailSecret } from "./credentials.js";
import { keepGmailFolders, testGmailMailbox, type GmailErrorCode, type GmailTested } from "./gmailMailbox.js";
import { keepGraphFolders, mailboxLink, testGraphMailbox, type GraphGrant, type GraphMailErrorCode, type GraphTested } from "./graphMailbox.js";
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
// main process signs in with Microsoft and hands over the sign-in, which
// becomes the link to Microsoft Graph the mailbox is read through
// (graphMailbox.ts) — the one Agenda and Contacts use too. One linked by
// Twoody 0.13.76 kept Microsoft's refresh token in the password's place and
// is read over IMAP (microsoft.ts) until the person signs in again. A Gmail
// mailbox takes an app password, or « Se connecter avec Google »: the
// Desktop's main process signs in with Google and hands over the sign-in,
// kept in the password's place, and the mailbox is read through the Gmail
// API (gmailMailbox.ts), not over IMAP.

const DAY_MS = 86_400_000;
const MIN_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 3_650;
const REFRESH_TOKEN_MAX_CHARS = 16_384;

export type AccountError = MailErrorCode | GraphMailErrorCode | GmailErrorCode | "address_required" | "invalid_address" | "host_required" | "invalid_host" | "invalid_port" | "password_required" | "invalid_window";

/// What the person gave: a mailbox read over IMAP, through Microsoft Graph,
/// or through the Gmail API.
export type AccountInput = ImapAccountInput | GraphAccountInput | GmailAccountInput;

/// Said to the person without refusing anything: a Gmail app password that
/// does not look like one (16 letters).
export type AccountWarning = "gmail_app_password_shape";

/// Google's app passwords: 16 letters, shown in four groups of four.
const GMAIL_APP_PASSWORD = /^[a-z]{16}$/i;

/// A Gmail app password as typed or pasted: without the spaces Google shows
/// between its groups, nor invisible characters.
export function gmailAppPassword(typed: string): string {
  return typed.replace(/[\s\u200B-\u200D\u2060\uFEFF]+/g, "");
}

/// The warnings of what the person gave, for the page.
export function accountWarnings(input: AccountInput): AccountWarning[] {
  return input.kind === "imap" ? input.warnings ?? [] : [];
}

export interface ImapAccountInput {
  kind: "imap";
  settings: SourceSettings;
  /// Given now, or the one already kept for this mailbox.
  secret: MailSecret;
  /// A new one was given (to keep).
  newSecret: boolean;
  /// The mailbox whose kept secret it is: a refresh token Microsoft gives
  /// back in its place, even during a test, is kept there.
  keptFor: string | null;
  warnings?: AccountWarning[];
}

export interface GraphAccountInput {
  kind: "graph";
  settings: SourceSettings;
  /// The sign-in just done, to link; null: the link kept serves.
  grant: GraphGrant | null;
}

export interface GmailAccountInput {
  kind: "gmail";
  settings: SourceSettings;
  /// Google's refresh token: the sign-in just done, or the one kept.
  refreshToken: string;
  /// Just given (to keep).
  newToken: boolean;
}

/// What Google must have granted for a mailbox read through the Gmail API:
/// reading it, and writing drafts (gmail.compose, which could send too: the
/// door of src/outbound.ts never opens what sends).
export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"] as const;
const GMAIL_IMAP = { host: "imap.gmail.com", port: 993, security: "tls" } as const;

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
  if (given.auth === "graph") return readGraphInput(userId, given, { address, days, preset, now });
  if (given.auth === "gmail") return readGmailInput(userId, given, { address, days, now });
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
  // are no part of them, nor the invisible characters a copy from a web
  // page or a password manager may bring along (zero-width spaces and
  // joiners, word joiner, byte order mark).
  let password = typeof given.password === "string" ? given.password.trim() : "";
  if (host === "imap.gmail.com") password = gmailAppPassword(password);
  if (password.length > 1_000) return { ok: false, error: "password_required" };
  if (password) {
    // Not refused: a Google Workspace account may take another password.
    const warnings: AccountWarning[] = host === "imap.gmail.com" && !GMAIL_APP_PASSWORD.test(password) ? ["gmail_app_password_shape"] : [];
    return { ok: true, input: { kind: "imap", settings, secret: { kind: "password", password }, newSecret: true, keptFor: null, warnings } };
  }
  const current = activeSource(userId);
  const kept = current && current.email_address.toLowerCase() === address.toLowerCase() && current.imap_host === host && current.username === username ? mailSecret(current.id) : null;
  return kept?.kind === "password" ? { ok: true, input: { kind: "imap", settings, secret: kept, newSecret: false, keptFor: current!.id } } : { ok: false, error: "password_required" };
}

/// Microsoft's sign-in read over IMAP (Twoody 0.13.76, kept as it was):
/// Microsoft's IMAP server, the address as username, and the refresh token
/// the Desktop's main process got — or, without one, the one kept for this
/// mailbox.
function readMicrosoftInput(userId: string, given: Record<string, unknown>, read: { address: string; days: number; preset: string | null; now: number }): { ok: true; input: AccountInput } | { ok: false; error: AccountError } {
  const { address } = read;
  const settings: SourceSettings = {
    email_address: address, imap_host: MICROSOFT_IMAP.host, imap_port: MICROSOFT_IMAP.port, imap_security: MICROSOFT_IMAP.security, username: address,
    import_after: windowStart(read.days, read.now), window_days: read.days, preset: read.preset ?? "outlook", auth: "microsoft",
  };
  const refreshToken = typeof given.refresh_token === "string" ? given.refresh_token.trim() : "";
  if (refreshToken.length > REFRESH_TOKEN_MAX_CHARS) return { ok: false, error: "signin_failed" };
  if (refreshToken) return { ok: true, input: { kind: "imap", settings, secret: { kind: "microsoft", refreshToken }, newSecret: true, keptFor: null } };
  const current = activeSource(userId);
  const kept = current && current.auth === "microsoft" && current.email_address.toLowerCase() === address.toLowerCase() ? mailSecret(current.id) : null;
  return kept?.kind === "microsoft" ? { ok: true, input: { kind: "imap", settings, secret: kept, newSecret: false, keptFor: current!.id } } : { ok: false, error: "signin_required" };
}

/// « Se connecter avec Microsoft »: the mailbox read through Microsoft Graph,
/// with the sign-in the Desktop's main process just got (twoody-desktop
/// src/main/microsoftSignIn.ts: its refresh token, and the permissions
/// Microsoft granted) — or, without one, the link kept, when it is this
/// account's and holds the mailbox's permission. Microsoft's IMAP server
/// stays its server of record, never connected to: the same mailbox as one
/// linked by 0.13.76, whose copy it carries on.
function readGraphInput(userId: string, given: Record<string, unknown>, read: { address: string; days: number; preset: string | null; now: number }): { ok: true; input: AccountInput } | { ok: false; error: AccountError } {
  const { address } = read;
  const settings: SourceSettings = {
    email_address: address, imap_host: MICROSOFT_IMAP.host, imap_port: MICROSOFT_IMAP.port, imap_security: MICROSOFT_IMAP.security, username: address,
    import_after: windowStart(read.days, read.now), window_days: read.days, preset: read.preset ?? "outlook", auth: "graph",
  };
  const refreshToken = typeof given.refresh_token === "string" ? given.refresh_token.trim() : "";
  if (refreshToken.length > REFRESH_TOKEN_MAX_CHARS) return { ok: false, error: "signin_failed" };
  if (refreshToken) {
    const scopes = graphPermissions(given.scopes);
    // The mailbox's permission refused at Microsoft's page: nothing to link.
    if (!GRAPH_SCOPES.email.every((permission) => scopes.includes(permission))) return { ok: false, error: "scope_missing" };
    return { ok: true, input: { kind: "graph", settings, grant: { refreshToken, scopes } } };
  }
  const kept = mailboxLink(userId, address);
  return kept.ok ? { ok: true, input: { kind: "graph", settings, grant: null } } : { ok: false, error: kept.error };
}

/// « Se connecter avec Google »: the mailbox read through the Gmail API, with
/// the sign-in the Desktop's main process just got (twoody-desktop
/// src/main/googleSignIn.ts: its refresh token, and the permissions Google
/// granted) — or, without one, the sign-in kept for this mailbox. Gmail's
/// IMAP server stays its server of record, never connected to: the same
/// mailbox as one set up with an app password, whose copy it carries on.
function readGmailInput(userId: string, given: Record<string, unknown>, read: { address: string; days: number; now: number }): { ok: true; input: AccountInput } | { ok: false; error: AccountError } {
  const { address } = read;
  const settings: SourceSettings = {
    email_address: address, imap_host: GMAIL_IMAP.host, imap_port: GMAIL_IMAP.port, imap_security: GMAIL_IMAP.security, username: address,
    import_after: windowStart(read.days, read.now), window_days: read.days, preset: "gmail", auth: "gmail",
  };
  const refreshToken = typeof given.refresh_token === "string" ? given.refresh_token.trim() : "";
  if (refreshToken.length > REFRESH_TOKEN_MAX_CHARS) return { ok: false, error: "signin_failed" };
  if (refreshToken) {
    const scopes = typeof given.scopes === "string" ? given.scopes.split(/\s+/) : [];
    // A permission unticked at Google's page: nothing to set up.
    if (!GMAIL_SCOPES.every((scope) => scopes.includes(scope))) return { ok: false, error: "scope_missing" };
    return { ok: true, input: { kind: "gmail", settings, refreshToken, newToken: true } };
  }
  const current = activeSource(userId);
  const kept = current && current.auth === "gmail" && current.email_address.toLowerCase() === address.toLowerCase() ? mailSecret(current.id) : null;
  return kept?.kind === "google" ? { ok: true, input: { kind: "gmail", settings, refreshToken: kept.refreshToken, newToken: false } } : { ok: false, error: "signin_required" };
}

export interface FoundFolders {
  inbox: string | null;
  sent: string | null;
  drafts: string | null;
}

/// Tries the mailbox once — the person asked — and finds the folders Twoody
/// uses. Nothing is read or written.
export async function testMailbox(userId: string, input: AccountInput): Promise<{ ok: true; folders: FoundFolders } | { ok: false; error: AccountError }> {
  if (input.kind === "graph") {
    const tested = await testGraphMailbox(userId, input.settings, input.grant);
    return tested.ok ? { ok: true, folders: graphFound(tested.tested) } : tested;
  }
  if (input.kind === "gmail") {
    const tested = await testGmailMailbox(userId, input.settings, input.refreshToken);
    return tested.ok ? { ok: true, folders: gmailFound(tested.tested) } : tested;
  }
  const tested = await testImapMailbox(userId, input);
  return tested.ok ? { ok: true, folders: tested.folders } : tested;
}

/// The folders found through Graph, by the names the person sees.
function graphFound(tested: GraphTested): FoundFolders {
  const { inbox, sent, drafts } = tested.folders;
  return { inbox: inbox.name ?? "Inbox", sent: sent ? sent.name ?? "Sent Items" : null, drafts: drafts ? drafts.name ?? "Drafts" : null };
}

/// The labels found at Gmail, by their names.
function gmailFound(tested: GmailTested): FoundFolders {
  const { inbox, sent, drafts } = tested.folders;
  return { inbox: inbox.name ?? inbox.id, sent: sent ? sent.name ?? sent.id : null, drafts: drafts ? drafts.name ?? drafts.id : null };
}

/// Connects once with these settings and finds the folders Twoody uses.
/// `secret`: the one to keep, a refresh token Microsoft gave back in place
/// of the one used.
async function testImapMailbox(userId: string, input: ImapAccountInput): Promise<{ ok: true; folders: FoundFolders; secret: MailSecret } | { ok: false; error: AccountError }> {
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
export async function setUpMailbox(userId: string, body: unknown): Promise<{ ok: true; source: EmailSource; folders: FoundFolders; warnings: AccountWarning[] } | { ok: false; error: AccountError }> {
  const read = readAccountInput(userId, body);
  if (!read.ok) return read;
  if (read.input.kind === "graph") return withoutWarnings(await setUpGraphMailbox(userId, read.input));
  if (read.input.kind === "gmail") return withoutWarnings(await setUpGmailMailbox(userId, read.input));
  const tested = await testImapMailbox(userId, read.input);
  if (!tested.ok) return tested;
  const { source, replaced } = saveSource(userId, read.input.settings);
  // The secret given, or the one Microsoft gave back during the test.
  if (read.input.newSecret || tested.secret !== read.input.secret || !mailSecret(source.id)) keepMailSecret(source.id, tested.secret);
  // Another mailbox before it: its copy stays, its password or sign-in goes.
  if (replaced && replaced.id !== source.id) forgetMailSecret(replaced.id);
  if (replaced?.auth === "graph") releaseMailboxLink(userId);
  void syncMailbox(userId).catch(() => undefined);
  return { ok: true, source, folders: tested.folders, warnings: accountWarnings(read.input) };
}

function withoutWarnings<T extends { ok: boolean }>(done: T): T & { warnings: AccountWarning[] } {
  return { ...done, warnings: [] };
}

/// Read through the Gmail API: tried, then kept — Google's sign-in in the
/// password's place — and read at once. A mailbox set up with an app
/// password at the same address carries on, its copy kept, its password
/// forgotten.
async function setUpGmailMailbox(userId: string, input: GmailAccountInput): Promise<{ ok: true; source: EmailSource; folders: FoundFolders } | { ok: false; error: AccountError }> {
  const tested = await testGmailMailbox(userId, input.settings, input.refreshToken);
  if (!tested.ok) return tested;
  const { source, replaced } = saveSource(userId, input.settings);
  keepMailSecret(source.id, { kind: "google", refreshToken: input.refreshToken });
  if (replaced && replaced.id !== source.id) forgetMailSecret(replaced.id);
  if (replaced?.auth === "graph") releaseMailboxLink(userId);
  keepGmailFolders(source.id, tested.tested.folders);
  void syncMailbox(userId).catch(() => undefined);
  return { ok: true, source, folders: gmailFound(tested.tested) };
}

/// Read through Microsoft Graph: tried, then kept — the sign-in just done
/// as the link to Microsoft, for Agenda and Contacts too — and read at once.
/// A mailbox linked by 0.13.76 at the same address carries on, its copy
/// kept, its own sign-in forgotten.
async function setUpGraphMailbox(userId: string, input: GraphAccountInput): Promise<{ ok: true; source: EmailSource; folders: FoundFolders } | { ok: false; error: AccountError }> {
  const tested = await testGraphMailbox(userId, input.settings, input.grant);
  if (!tested.ok) return tested;
  const { source, replaced } = saveSource(userId, input.settings);
  // No password nor sign-in of its own: the link holds it.
  forgetMailSecret(source.id);
  if (replaced && replaced.id !== source.id) forgetMailSecret(replaced.id);
  if (input.grant) keepMicrosoftLink(userId, { address: input.settings.email_address, scopes: input.grant.scopes, refreshToken: tested.tested.refreshToken ?? input.grant.refreshToken });
  keepGraphFolders(source.id, tested.tested.folders);
  void syncMailbox(userId).catch(() => undefined);
  return { ok: true, source, folders: graphFound(tested.tested) };
}

/// The mailbox removed: no more sync, its password or its Microsoft sign-in
/// forgotten; its copy on this computer kept (searchable) or deleted, as
/// the person chose; one read through Graph lets go of the link.
export function removeMailbox(userId: string, keepMessages: boolean): boolean {
  const source = activeSource(userId);
  if (!source) return false;
  forgetMailSecret(source.id);
  if (keepMessages) markRemoved(source.id);
  else deleteSource(source.id);
  if (source.auth === "graph") releaseMailboxLink(userId);
  return true;
}

/// No mailbox read through Graph any more: the link stays for Agenda and
/// Contacts while it serves them — without the mailbox's permission, no
/// longer asked — and is forgotten when nothing uses it.
function releaseMailboxLink(userId: string): void {
  const link = graphLink(userId);
  if (!link) return;
  if (GRAPH_CAPABILITIES.some((capability) => capability !== "email" && linkGrants(link, capability))) releaseGraphPermissions(userId, "email");
  else forgetGraphLink(userId);
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
      // A Microsoft or Google sign-in kept (without one, a new sign-in is
      // needed): the mailbox's own, over IMAP or the Gmail API, or the link it
      // is read through.
      signin_kept: source.auth === "graph" ? mailboxLink(userId, source.email_address).ok : source.auth === "gmail" ? secret?.kind === "google" : secret?.kind === "microsoft",
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
    // Through Graph, the names the person sees (« Boîte de réception »).
    folders: {
      inbox: folderShown(source, "inbox"),
      sent: folderShown(source, "sent"),
      drafts: folderShown(source, "drafts"),
    },
    kept,
  };
}

function folderShown(source: EmailSource, role: "inbox" | "sent" | "drafts"): string | null {
  const folder = folderFor(source.id, role);
  return folder ? (source.auth === "graph" ? folder.name ?? folder.path : folder.path) : null;
}
