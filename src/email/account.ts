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
import {
  activeSources, addsMailbox, countsOf, deleteSource, firstReadUnderway, folderFor, keptCopies, markRemoved, MAX_MAILBOXES, saveSource, sourceById, syncPauseOf,
  type EmailSource, type SourceSettings,
} from "./store.js";
import { DEFAULT_WINDOW_DAYS, needsThePerson, nextRoundAfter, syncMailbox, syncProgress } from "./sync.js";

// Setting up the person's mailboxes (Capacités → E-mails) — several, each
// added, changed, read and removed on its own: what they give,
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

export type AccountError =
  | MailErrorCode | GraphMailErrorCode | GmailErrorCode | "address_required" | "invalid_address" | "host_required" | "invalid_host" | "invalid_port" | "password_required" | "invalid_window"
  // Already as many mailboxes as Twoody keeps; the one being changed is no
  // longer set up; a second Microsoft account through Graph (one link to
  // Microsoft, src/microsoft/link.ts: another Outlook mailbox takes its app
  // password over IMAP).
  | "too_many_mailboxes" | "mailbox_not_found" | "microsoft_one_account";

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

/// The mailbox being changed (« Modifier »), or null: one added — or the
/// one at the same address, changed.
interface Editing {
  replacing: string | null;
}

export interface ImapAccountInput extends Editing {
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

export interface GraphAccountInput extends Editing {
  kind: "graph";
  settings: SourceSettings;
  /// The sign-in just done, to link; null: the link kept serves.
  grant: GraphGrant | null;
}

export interface GmailAccountInput extends Editing {
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

/// The mailbox the page names (`id`): one of the person's, set up; null
/// when none is named; "unknown" when it is not one of them.
function editedMailbox(userId: string, given: Record<string, unknown>): EmailSource | null | "unknown" {
  if (given.id === undefined || given.id === null || given.id === "") return null;
  if (typeof given.id !== "string") return "unknown";
  const source = sourceById(userId, given.id);
  return source && source.status !== "removed" ? source : "unknown";
}

/// The mailbox whose kept password or sign-in serves for these settings:
/// the one being changed, else the one set up at this address.
function keptFor(userId: string, edited: EmailSource | null, address: string, match: (source: EmailSource) => boolean): EmailSource | null {
  const candidates = edited ? [edited] : activeSources(userId).filter((source) => source.email_address.toLowerCase() === address.toLowerCase());
  return candidates.find(match) ?? null;
}

/// What the person typed, checked; the password left empty keeps the one
/// already kept for the same mailbox (the screen never has it). `id`: the
/// mailbox being changed; without one, a mailbox is added (or the one at
/// the same address changed).
export function readAccountInput(userId: string, body: unknown, now = Date.now()): { ok: true; input: AccountInput } | { ok: false; error: AccountError } {
  const given = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const edited = editedMailbox(userId, given);
  if (edited === "unknown") return { ok: false, error: "mailbox_not_found" };
  const rawAddress = typeof given.address === "string" ? given.address.trim() : "";
  if (!rawAddress) return { ok: false, error: "address_required" };
  const address = cleanAddress(rawAddress);
  if (!address) return { ok: false, error: "invalid_address" };
  const days = given.window_days === undefined || given.window_days === null ? DEFAULT_WINDOW_DAYS : Number(given.window_days);
  if (!Number.isInteger(days) || days < MIN_WINDOW_DAYS || days > MAX_WINDOW_DAYS) return { ok: false, error: "invalid_window" };
  const preset = typeof given.preset === "string" && /^[a-z0-9_-]{1,30}$/.test(given.preset) ? given.preset : null;
  const read = { address, days, preset, now, edited };
  if (given.auth === "microsoft") return readMicrosoftInput(userId, given, read);
  if (given.auth === "graph") return readGraphInput(userId, given, read);
  if (given.auth === "gmail") return readGmailInput(userId, given, read);
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
  const replacing = edited?.id ?? null;
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
    return { ok: true, input: { kind: "imap", settings, secret: { kind: "password", password }, newSecret: true, keptFor: null, warnings, replacing } };
  }
  const current = keptFor(userId, edited, address, (source) => source.email_address.toLowerCase() === address.toLowerCase() && source.imap_host === host && source.username === username);
  const kept = current ? mailSecret(current.id) : null;
  return kept?.kind === "password" ? { ok: true, input: { kind: "imap", settings, secret: kept, newSecret: false, keptFor: current!.id, replacing } } : { ok: false, error: "password_required" };
}

interface ReadSoFar {
  address: string;
  days: number;
  preset: string | null;
  now: number;
  edited: EmailSource | null;
}

/// Microsoft's sign-in read over IMAP (Twoody 0.13.76, kept as it was):
/// Microsoft's IMAP server, the address as username, and the refresh token
/// the Desktop's main process got — or, without one, the one kept for this
/// mailbox.
function readMicrosoftInput(userId: string, given: Record<string, unknown>, read: ReadSoFar): { ok: true; input: AccountInput } | { ok: false; error: AccountError } {
  const { address } = read;
  const settings: SourceSettings = {
    email_address: address, imap_host: MICROSOFT_IMAP.host, imap_port: MICROSOFT_IMAP.port, imap_security: MICROSOFT_IMAP.security, username: address,
    import_after: windowStart(read.days, read.now), window_days: read.days, preset: read.preset ?? "outlook", auth: "microsoft",
  };
  const replacing = read.edited?.id ?? null;
  const refreshToken = typeof given.refresh_token === "string" ? given.refresh_token.trim() : "";
  if (refreshToken.length > REFRESH_TOKEN_MAX_CHARS) return { ok: false, error: "signin_failed" };
  if (refreshToken) return { ok: true, input: { kind: "imap", settings, secret: { kind: "microsoft", refreshToken }, newSecret: true, keptFor: null, replacing } };
  const current = keptFor(userId, read.edited, address, (source) => source.auth === "microsoft" && source.email_address.toLowerCase() === address.toLowerCase());
  const kept = current ? mailSecret(current.id) : null;
  return kept?.kind === "microsoft" ? { ok: true, input: { kind: "imap", settings, secret: kept, newSecret: false, keptFor: current!.id, replacing } } : { ok: false, error: "signin_required" };
}

/// « Se connecter avec Microsoft »: the mailbox read through Microsoft Graph,
/// with the sign-in the Desktop's main process just got (twoody-desktop
/// src/main/microsoftSignIn.ts: its refresh token, and the permissions
/// Microsoft granted) — or, without one, the link kept, when it is this
/// account's and holds the mailbox's permission. Microsoft's IMAP server
/// stays its server of record, never connected to: the same mailbox as one
/// linked by 0.13.76, whose copy it carries on.
function readGraphInput(userId: string, given: Record<string, unknown>, read: ReadSoFar): { ok: true; input: AccountInput } | { ok: false; error: AccountError } {
  const { address } = read;
  const settings: SourceSettings = {
    email_address: address, imap_host: MICROSOFT_IMAP.host, imap_port: MICROSOFT_IMAP.port, imap_security: MICROSOFT_IMAP.security, username: address,
    import_after: windowStart(read.days, read.now), window_days: read.days, preset: read.preset ?? "outlook", auth: "graph",
  };
  const replacing = read.edited?.id ?? null;
  const refreshToken = typeof given.refresh_token === "string" ? given.refresh_token.trim() : "";
  if (refreshToken.length > REFRESH_TOKEN_MAX_CHARS) return { ok: false, error: "signin_failed" };
  if (refreshToken) {
    const scopes = graphPermissions(given.scopes);
    // The mailbox's permission refused at Microsoft's page: nothing to link.
    if (!GRAPH_SCOPES.email.every((permission) => scopes.includes(permission))) return { ok: false, error: "scope_missing" };
    return { ok: true, input: { kind: "graph", settings, grant: { refreshToken, scopes }, replacing } };
  }
  const kept = mailboxLink(userId, address);
  return kept.ok ? { ok: true, input: { kind: "graph", settings, grant: null, replacing } } : { ok: false, error: kept.error };
}

/// « Se connecter avec Google »: the mailbox read through the Gmail API, with
/// the sign-in the Desktop's main process just got (twoody-desktop
/// src/main/googleSignIn.ts: its refresh token, and the permissions Google
/// granted) — or, without one, the sign-in kept for this mailbox. Gmail's
/// IMAP server stays its server of record, never connected to: the same
/// mailbox as one set up with an app password, whose copy it carries on.
/// Each Google mailbox has its own sign-in.
function readGmailInput(userId: string, given: Record<string, unknown>, read: ReadSoFar): { ok: true; input: AccountInput } | { ok: false; error: AccountError } {
  const { address } = read;
  const settings: SourceSettings = {
    email_address: address, imap_host: GMAIL_IMAP.host, imap_port: GMAIL_IMAP.port, imap_security: GMAIL_IMAP.security, username: address,
    import_after: windowStart(read.days, read.now), window_days: read.days, preset: "gmail", auth: "gmail",
  };
  const replacing = read.edited?.id ?? null;
  const refreshToken = typeof given.refresh_token === "string" ? given.refresh_token.trim() : "";
  if (refreshToken.length > REFRESH_TOKEN_MAX_CHARS) return { ok: false, error: "signin_failed" };
  if (refreshToken) {
    const scopes = typeof given.scopes === "string" ? given.scopes.split(/\s+/) : [];
    // A permission unticked at Google's page: nothing to set up.
    if (!GMAIL_SCOPES.every((scope) => scopes.includes(scope))) return { ok: false, error: "scope_missing" };
    return { ok: true, input: { kind: "gmail", settings, refreshToken, newToken: true, replacing } };
  }
  const current = keptFor(userId, read.edited, address, (source) => source.auth === "gmail" && source.email_address.toLowerCase() === address.toLowerCase());
  const kept = current ? mailSecret(current.id) : null;
  return kept?.kind === "google" ? { ok: true, input: { kind: "gmail", settings, refreshToken: kept.refreshToken, newToken: false, replacing } } : { ok: false, error: "signin_required" };
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

/// Why this mailbox cannot be set up next to the others, before anything
/// is tried: as many as Twoody keeps already; a second Microsoft account
/// through Graph.
function cannotAdd(userId: string, input: AccountInput): AccountError | null {
  if (addsMailbox(userId, input.settings, input.replacing) && activeSources(userId).length >= MAX_MAILBOXES) return "too_many_mailboxes";
  if (input.kind === "graph") {
    const address = input.settings.email_address.toLowerCase();
    const other = activeSources(userId).find((source) => source.auth === "graph" && source.email_address.toLowerCase() !== address && source.id !== input.replacing);
    if (other) return "microsoft_one_account";
  }
  return null;
}

/// Checked, then kept, and read at once: added next to the others, or in
/// place of the one changed.
export async function setUpMailbox(userId: string, body: unknown): Promise<{ ok: true; source: EmailSource; folders: FoundFolders; warnings: AccountWarning[] } | { ok: false; error: AccountError }> {
  const read = readAccountInput(userId, body);
  if (!read.ok) return read;
  const refused = cannotAdd(userId, read.input);
  if (refused) return { ok: false, error: refused };
  if (read.input.kind === "graph") return withoutWarnings(await setUpGraphMailbox(userId, read.input));
  if (read.input.kind === "gmail") return withoutWarnings(await setUpGmailMailbox(userId, read.input));
  const tested = await testImapMailbox(userId, read.input);
  if (!tested.ok) return tested;
  const { source, replaced } = saveSource(userId, read.input.settings, { replacing: read.input.replacing });
  // The secret given, or the one Microsoft gave back during the test.
  if (read.input.newSecret || tested.secret !== read.input.secret || !mailSecret(source.id)) keepMailSecret(source.id, tested.secret);
  afterReplacing(userId, source, replaced);
  void syncMailbox(userId, source.id).catch(() => undefined);
  return { ok: true, source, folders: tested.folders, warnings: accountWarnings(read.input) };
}

/// Another mailbox before it in its place: its copy stays, its password or
/// sign-in goes; one read through Graph lets go of the link it no longer uses.
function afterReplacing(userId: string, source: EmailSource, replaced: EmailSource | null): void {
  if (!replaced || replaced.id === source.id) return;
  forgetMailSecret(replaced.id);
  if (replaced.auth === "graph" && source.auth !== "graph") releaseMailboxLink(userId);
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
  const { source, replaced } = saveSource(userId, input.settings, { replacing: input.replacing });
  keepMailSecret(source.id, { kind: "google", refreshToken: input.refreshToken });
  afterReplacing(userId, source, replaced);
  keepGmailFolders(source.id, tested.tested.folders);
  void syncMailbox(userId, source.id).catch(() => undefined);
  return { ok: true, source, folders: gmailFound(tested.tested) };
}

/// Read through Microsoft Graph: tried, then kept — the sign-in just done
/// as the link to Microsoft, for Agenda and Contacts too — and read at once.
/// A mailbox linked by 0.13.76 at the same address carries on, its copy
/// kept, its own sign-in forgotten.
async function setUpGraphMailbox(userId: string, input: GraphAccountInput): Promise<{ ok: true; source: EmailSource; folders: FoundFolders } | { ok: false; error: AccountError }> {
  const tested = await testGraphMailbox(userId, input.settings, input.grant);
  if (!tested.ok) return tested;
  const { source, replaced } = saveSource(userId, input.settings, { replacing: input.replacing });
  // No password nor sign-in of its own: the link holds it.
  forgetMailSecret(source.id);
  if (replaced && replaced.id !== source.id) forgetMailSecret(replaced.id);
  if (input.grant) keepMicrosoftLink(userId, { address: input.settings.email_address, scopes: input.grant.scopes, refreshToken: tested.tested.refreshToken ?? input.grant.refreshToken });
  keepGraphFolders(source.id, tested.tested.folders);
  void syncMailbox(userId, source.id).catch(() => undefined);
  return { ok: true, source, folders: graphFound(tested.tested) };
}

/// The mailbox the page names — or, without a name, the only one — removed:
/// no more sync, its password or its Microsoft or Google sign-in forgotten;
/// its copy on this computer kept (searchable) or deleted, as the person
/// chose; one read through Graph lets go of the link. The others go on.
export function removeMailbox(userId: string, id: string | null, keepMessages: boolean): { ok: true } | { ok: false; error: "not_configured" | "mailbox_required" } {
  const active = activeSources(userId);
  if (!active.length) return { ok: false, error: "not_configured" };
  const source = id ? active.find((one) => one.id === id) : active.length === 1 ? active[0] : null;
  if (!source) return { ok: false, error: id ? "not_configured" : "mailbox_required" };
  forgetMailSecret(source.id);
  if (keepMessages) markRemoved(source.id);
  else deleteSource(source.id);
  if (source.auth === "graph") releaseMailboxLink(userId);
  return { ok: true };
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

/// What the page shows: each mailbox — never its password, nor any token —
/// its sync and its counts, and the copies kept. `account`, `sync`,
/// `counts` and `folders` are also given for the first mailbox, for a page
/// that knows of one only.
export function mailboxStatus(userId: string) {
  const enabled = capabilityOn(userId, "email");
  const kept = keptCopies(userId);
  const mailboxes = activeSources(userId).map((source) => mailboxView(userId, source, enabled));
  const first = mailboxes[0] ?? null;
  return {
    enabled,
    configured: mailboxes.length > 0,
    mailboxes,
    max_mailboxes: MAX_MAILBOXES,
    account: first?.account ?? null,
    sync: first?.sync ?? null,
    counts: first?.counts ?? null,
    folders: first?.folders ?? null,
    kept,
  };
}

function mailboxView(userId: string, source: EmailSource, enabled: boolean) {
  const progress = syncProgress(source.id);
  const days = typeof source.metadata.window_days === "number" ? source.metadata.window_days : DEFAULT_WINDOW_DAYS;
  const secret = mailSecret(source.id);
  return {
    id: source.id,
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
      next_at: enabled && source.last_synced_at && !needsThePerson(source.last_error) ? source.last_synced_at + nextRoundAfter(source) : null,
      // The last round stopped early without failing (Gmail limits the
      // pace), and whether the window's first reading is still under way.
      paused: syncPauseOf(source),
      first_read: firstReadUnderway(source),
    },
    counts: countsOf(source.id),
    // Through Graph, the names the person sees (« Boîte de réception »).
    folders: {
      inbox: folderShown(source, "inbox"),
      sent: folderShown(source, "sent"),
      drafts: folderShown(source, "drafts"),
    },
  };
}

function folderShown(source: EmailSource, role: "inbox" | "sent" | "drafts"): string | null {
  const folder = folderFor(source.id, role);
  return folder ? (source.auth === "graph" ? folder.name ?? folder.path : folder.path) : null;
}
