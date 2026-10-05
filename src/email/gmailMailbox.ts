import { capabilityOn } from "../localCapabilities.js";
import { googleAccess, GoogleSignInError, type GoogleSignInCode } from "../google/token.js";
import { retryAfterMs } from "../microsoft/graph.js";
import { GMAIL_ME, gmailDoor, GmailDoorClosedError, gmailFetch, type GmailDoorReason, type GmailDoorState } from "../outbound.js";
import { mailSecret } from "./credentials.js";
import { attachmentsOf, automatedSender, parseEmail, SOURCE_MAX_BYTES, threadIdOf, type AttachmentInfo, type StructureNode } from "./parse.js";
import {
  activeSource, folderFor, gmailSyncState, graphFolder, graphIdsIn, noteGraphFolder, saveGmailSyncState, saveGraphChanges,
  type EmailFolder, type EmailSource, type GraphChange, type GraphReadRole, type SourceSettings,
} from "./store.js";
import type { SyncProgress } from "./sync.js";

// A Gmail mailbox read through the Gmail API (« Se connecter avec Google »,
// Capacités → E-mails, 05/10/2026), not over IMAP: Google's sign-in, done by
// the Desktop's main process (twoody-desktop src/main/googleSignIn.ts,
// permissions gmail.readonly and gmail.compose — never the permission to
// send alone, nor to change labels), whose refresh token is kept as a password is
// (credentials.ts). An app password needs two-step verification and is
// refused by many Google Workspace organisations; this sign-in needs
// neither.
//
// What is asked of Gmail, each request through the door of src/outbound.ts
// (which opens nothing that sends, deletes, trashes or relabels):
//   - the account's address and where its changes stand (profile), its
//     labels (INBOX, SENT, DRAFT);
//   - the messages of INBOX and SENT received since the start of the window
//     (messages, with `after:`), then, every 10 minutes, what changed since
//     (history): new messages, read or starred elsewhere, out of the label,
//     trashed or deleted;
//   - each new message as Gmail keeps it (format=full): its headers, its
//     text parts, the names, types and sizes of its attachments, never their
//     content; a text part Gmail keeps apart, fetched alone;
//   - one write: a draft, created in Drafts once the person allowed it in
//     the chat (POST drafts). Never sent.
// The person sees and the chat reads the same as over IMAP: the same tables
// (store.ts), a message's Gmail id kept in its metadata (`gmail_id`). A
// message gone from INBOX or SENT at Gmail is hidden here as a message
// flagged deleted is, never purged.

const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_DAYS = 90;
const REQUEST_TIMEOUT_MS = 30_000;
/// Tries of one address when Gmail asks to wait.
const MAX_TRIES = 4;
/// Waited at most, in one go, between two tries; longer, the round stops.
const MAX_WAIT_MS = 2 * 60_000;
/// Pages of one list, at most: a guard against a list that never ends.
const MAX_PAGES = 500;
/// Messages listed per page, and read before what was read is kept.
const PAGE = 100;
const BATCH = 20;
/// A text part Gmail keeps apart is read up to this size.
const APART_TEXT_MAX_BYTES = 4 * 1024 * 1024;

/// Gmail's system labels for the folders Twoody uses.
export const GMAIL_LABELS = { inbox: "INBOX", sent: "SENT", drafts: "DRAFT" } as const;
const READ_ROLES: GraphReadRole[] = ["inbox", "sent"];

export type GmailErrorCode =
  | GoogleSignInCode | GmailDoorReason
  // Gmail refuses this account's mail to Twoody (401 with a new token,
  // 403); the account has no Gmail (a Google account whose mail is
  // elsewhere); the permission to read it was not granted; the sign-in is
  // another account's than the address set up; a message listed earlier is
  // gone since; Gmail asks to wait longer than a round, cannot be reached,
  // answers something else; or its changes can no longer be followed from
  // where the last round ended (to list the window again).
  | "gmail_refused" | "no_mailbox" | "scope_missing" | "other_account" | "gone" | "throttled" | "gmail_unreachable" | "gmail_failed" | "sync_reset";

export class GmailError extends Error {
  constructor(public code: GmailErrorCode, public status: number | null = null) {
    super(code);
    this.name = "GmailError";
  }
}

export function gmailErrorCode(err: unknown): GmailErrorCode {
  if (err instanceof GmailError) return err.code;
  if (err instanceof GoogleSignInError) return err.code;
  if (err instanceof GmailDoorClosedError) return err.reason;
  return "gmail_failed";
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/// What a refusal of Gmail means — from its status, its error's reasons and
/// status words (never its message, which may name the account) and the
/// address asked.
export function gmailRefusal(status: number, body: unknown, target: string): GmailError {
  const error = isObject(body) && isObject(body.error) ? body.error : {};
  const reasons = new Set<string>((Array.isArray(error.errors) ? error.errors : []).map((one) => (isObject(one) && typeof one.reason === "string" ? one.reason : "")).filter(Boolean));
  const words = typeof error.status === "string" ? error.status : "";
  const details = JSON.stringify(Array.isArray(error.details) ? error.details : []);
  let path = "";
  try {
    path = new URL(target).pathname;
  } catch {
    // Not an address: said as anything else, below.
  }
  if (status === 404 && /\/history$/.test(path)) return new GmailError("sync_reset", status);
  if (status === 404 && /\/messages\/[^/]+$/.test(path)) return new GmailError("gone", status);
  // « Mail service not enabled »: a Google account without Gmail.
  if ((status === 400 || status === 403 || status === 412) && (reasons.has("failedPrecondition") || words === "FAILED_PRECONDITION")) return new GmailError("no_mailbox", status);
  if (status === 403 && (reasons.has("insufficientPermissions") || /ACCESS_TOKEN_SCOPE_INSUFFICIENT/.test(details))) return new GmailError("scope_missing", status);
  if ((status === 403 || status === 429) && ["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "concurrentLimitExceeded"].some((reason) => reasons.has(reason))) return new GmailError("throttled", status);
  if (status === 401 || status === 403) return new GmailError("gmail_refused", status);
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return new GmailError("throttled", status);
  return new GmailError("gmail_failed", status);
}

type Transport = (target: string, init: RequestInit, door: GmailDoorState) => Promise<Response>;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let transport: Transport = gmailFetch;
let sleep: (ms: number) => Promise<void> = wait;

/// For the tests: Gmail answered by a fake (null: the real one), and the
/// waits Gmail asks for made by `sleep`. The door is asked all the same.
export function useGmailForTests(fake: ((target: string, init: RequestInit) => Promise<Response>) | null, options: { sleep?: (ms: number) => Promise<void> } = {}): void {
  transport = fake ? (target, init) => fake(target, init) : gmailFetch;
  sleep = options.sleep ?? wait;
}

/// Reading one mailbox with its sign-in: its access token, renewed when
/// needed, and each request through the door as it stands at that moment.
class GmailSession {
  private access: string | null = null;

  constructor(private readonly refreshToken: string, private readonly door: () => GmailDoorState) {}

  private async accessToken(fresh = false): Promise<string> {
    const got = await googleAccess(this.refreshToken, this.door(), { fresh });
    this.access = got.accessToken;
    return got.accessToken;
  }

  get(url: string): Promise<Record<string, unknown>> {
    return this.request("GET", url);
  }

  /// A draft created (E-mails, once the person allowed it): the only thing
  /// ever written at Gmail.
  post(url: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", url, JSON.stringify(body));
  }

  /// One request, through the door as it stands, answered as JSON. A token
  /// Gmail refuses was perhaps withdrawn before its time: a new one is got,
  /// once. Asked to wait, it waits — a write only when Gmail says it did
  /// nothing (429), a read whenever.
  private async request(method: "GET" | "POST", url: string, body?: string): Promise<Record<string, unknown>> {
    let renewed = false;
    for (let attempt = 1; ; attempt += 1) {
      const token = this.access ?? (await this.accessToken());
      let response: Response;
      try {
        // The door first, whoever answers.
        gmailDoor(url, method, this.door());
        response = await transport(url, {
          method,
          headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
          ...(body !== undefined ? { body } : {}),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, this.door());
      } catch (err) {
        if (err instanceof GmailDoorClosedError) throw err;
        throw new GmailError("gmail_unreachable");
      }
      if (response.status === 401 && !renewed) {
        renewed = true;
        await response.body?.cancel().catch(() => undefined);
        await this.accessToken(true);
        continue;
      }
      const answer = (await response.json().catch(() => null)) as unknown;
      if (response.ok && isObject(answer)) return answer;
      const refusal = gmailRefusal(response.status, answer, url);
      if (refusal.code === "throttled" && (method === "GET" || response.status === 429)) {
        const asked = retryAfterMs(response.headers.get("retry-after")) ?? 2 ** attempt * 1_000;
        if (asked > MAX_WAIT_MS || attempt >= MAX_TRIES) throw refusal;
        await sleep(asked);
        continue;
      }
      throw refusal;
    }
  }
}

const query = (params: Record<string, string | string[]>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) for (const one of Array.isArray(value) ? value : [value]) search.append(key, one);
  return search.toString();
};

function str(value: unknown, max = 500): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/// A Gmail id: letters and digits (Gmail's are hexadecimal).
const gmailId = (value: unknown): string | null => (typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value) ? value : null);

// ── The account, its labels ─────────────────────────────────────────────

/// The address Google signed in, and where its changes stand now.
async function profileOf(session: GmailSession): Promise<{ address: string | null; historyId: string | null }> {
  const body = await session.get(`${GMAIL_ME}/profile`);
  const historyId = typeof body.historyId === "string" && /^\d{1,30}$/.test(body.historyId) ? body.historyId : null;
  return { address: str(body.emailAddress, 320), historyId };
}

export interface GmailFolder {
  /// Gmail's label id (INBOX, SENT, DRAFT).
  id: string;
  name: string | null;
}

export interface GmailTested {
  folders: { inbox: GmailFolder; sent: GmailFolder | null; drafts: GmailFolder | null };
}

/// A session on the mailbox being set up (its sign-in just given, or kept).
function setUpSession(userId: string, refreshToken: string): GmailSession {
  return new GmailSession(refreshToken, () => ({ gmailMailbox: true, emailOn: capabilityOn(userId, "email") }));
}

/// The mailbox set up, still this one and still read through the Gmail API.
function stillGmail(userId: string, sourceId: string): boolean {
  const current = activeSource(userId);
  return current?.id === sourceId && current.auth === "gmail";
}

/// Gmail tried once for this mailbox — the person asked: the account Google
/// signed in is this address, its labels found; nothing read.
export async function testGmailMailbox(userId: string, settings: SourceSettings, refreshToken: string): Promise<{ ok: true; tested: GmailTested } | { ok: false; error: GmailErrorCode }> {
  try {
    const session = setUpSession(userId, refreshToken);
    const profile = await profileOf(session);
    if (!profile.address || profile.address.toLowerCase() !== settings.email_address.toLowerCase()) return { ok: false, error: "other_account" };
    const body = await session.get(`${GMAIL_ME}/labels`);
    const labels = new Map<string, string | null>();
    for (const label of Array.isArray(body.labels) ? body.labels.filter(isObject) : []) {
      const id = str(label.id, 200);
      if (id) labels.set(id, str(label.name, 200));
    }
    const found = (role: keyof typeof GMAIL_LABELS): GmailFolder | null => (labels.has(GMAIL_LABELS[role]) ? { id: GMAIL_LABELS[role], name: labels.get(GMAIL_LABELS[role]) ?? GMAIL_LABELS[role] } : null);
    const inbox = found("inbox");
    if (!inbox) return { ok: false, error: "no_mailbox" };
    return { ok: true, tested: { folders: { inbox, sent: found("sent"), drafts: found("drafts") } } };
  } catch (err) {
    return { ok: false, error: gmailErrorCode(err) };
  }
}

/// The folders found kept for the mailbox: the one a role had over IMAP
/// before (its messages are the same, its name kept), else Gmail's label.
export function keepGmailFolders(sourceId: string, folders: GmailTested["folders"]): void {
  for (const role of ["inbox", "sent", "drafts"] as const) {
    const found = folders[role];
    if (found) graphFolder(sourceId, role, found.id, folderFor(sourceId, role) ? null : found.name);
  }
}

// ── A message ───────────────────────────────────────────────────────────

interface GmailPart {
  mimeType?: unknown;
  filename?: unknown;
  headers?: unknown;
  body?: unknown;
  parts?: unknown;
}

function headersOf(part: GmailPart): Array<{ name: string; value: string }> {
  return (Array.isArray(part.headers) ? part.headers : [])
    .filter(isObject)
    .map((header) => ({ name: typeof header.name === "string" ? header.name : "", value: typeof header.value === "string" ? header.value : "" }))
    .filter((header) => header.name);
}

const headerOf = (part: GmailPart, name: string) => headersOf(part).find((header) => header.name.toLowerCase() === name)?.value ?? null;
const partsOf = (part: GmailPart): GmailPart[] => (Array.isArray(part.parts) ? part.parts.filter(isObject) : []);
const mimeOf = (part: GmailPart) => (typeof part.mimeType === "string" ? part.mimeType.toLowerCase() : "");
const bodyOf = (part: GmailPart) => (isObject(part.body) ? part.body : {});

/// A part as an IMAP structure, for the attachments' names (parse.ts).
function structureOf(part: GmailPart): StructureNode {
  const disposition = headerOf(part, "content-disposition");
  const filename = typeof part.filename === "string" && part.filename ? part.filename : undefined;
  const size = bodyOf(part).size;
  return {
    type: mimeOf(part) || undefined,
    size: typeof size === "number" ? size : undefined,
    disposition: disposition ? disposition.split(";")[0]!.trim() : undefined,
    ...(filename ? { dispositionParameters: { filename } } : {}),
    childNodes: partsOf(part).map(structureOf),
  };
}

/// The text parts to keep (a plain one and an HTML one, the first of each,
/// attachments left out), each with its Content-Type.
function textParts(root: GmailPart): Array<{ part: GmailPart; type: string }> {
  const found: Partial<Record<"text/plain" | "text/html", GmailPart>> = {};
  const walk = (part: GmailPart) => {
    const type = mimeOf(part);
    if (type === "message/rfc822" || (typeof part.filename === "string" && part.filename)) return;
    if ((type === "text/plain" || type === "text/html") && !found[type]) found[type] = part;
    for (const child of partsOf(part)) walk(child);
  };
  walk(root);
  return (["text/plain", "text/html"] as const).filter((type) => found[type]).map((type) => ({ part: found[type]!, type }));
}

/// The headers the copy reads, as the message has them (one line each).
const KEPT_HEADERS = ["subject", "from", "to", "cc", "reply-to", "date", "message-id", "in-reply-to", "references", "list-id", "list-unsubscribe", "precedence", "auto-submitted"];

/// The message as a short MIME text — its headers and text parts — read by
/// the same parser as over IMAP (parse.ts): the same addresses, subjects,
/// conversations, signs of a machine.
async function sourceOf(session: GmailSession, messageId: string, payload: GmailPart): Promise<{ source: Buffer; cut: boolean }> {
  const lines = headersOf(payload)
    .filter((header) => KEPT_HEADERS.includes(header.name.toLowerCase()))
    .map((header) => `${header.name}: ${header.value.replace(/[\r\n]+/g, " ").slice(0, 8_000)}`);
  const boundary = "twoody-gmail-part";
  const chunks: string[] = [];
  let cut = false;
  for (const { part, type } of textParts(payload)) {
    const body = bodyOf(part);
    let data = typeof body.data === "string" ? Buffer.from(body.data, "base64url") : null;
    // Gmail keeps a large text part apart, as it keeps an attachment.
    const apart = gmailId(body.attachmentId);
    if (!data && apart && typeof body.size === "number" && body.size <= APART_TEXT_MAX_BYTES) {
      const fetched = await session.get(`${GMAIL_ME}/messages/${messageId}/attachments/${apart}`);
      data = typeof fetched.data === "string" ? Buffer.from(fetched.data, "base64url") : null;
    } else if (!data && apart) cut = true;
    if (!data) continue;
    if (data.length > SOURCE_MAX_BYTES) {
      data = data.subarray(0, SOURCE_MAX_BYTES);
      cut = true;
    }
    const contentType = (headerOf(part, "content-type") ?? `${type}; charset=utf-8`).replace(/[\r\n]+/g, " ");
    chunks.push(`--${boundary}\r\nContent-Type: ${contentType}\r\nContent-Transfer-Encoding: base64\r\n\r\n${data.toString("base64").replace(/.{76}/g, "$&\r\n")}\r\n`);
  }
  const head = [...lines, "MIME-Version: 1.0", `Content-Type: multipart/alternative; boundary="${boundary}"`].join("\r\n");
  return { source: Buffer.from(`${head}\r\n\r\n${chunks.join("")}--${boundary}--\r\n`, "utf8"), cut };
}

/// Gmail's thread id is the hexadecimal of the one its IMAP server gives
/// (X-GM-THRID): said in decimal, a conversation read over IMAP before
/// stays the same one.
export function gmailThreadId(threadId: unknown): string | null {
  if (typeof threadId !== "string" || !/^[0-9a-f]{1,16}$/i.test(threadId)) return null;
  return BigInt(`0x${threadId}`).toString(10);
}

interface GmailMeta {
  id: string;
  labels: Set<string>;
  internalDate: number | null;
}

function metaOf(body: Record<string, unknown>): GmailMeta | null {
  const id = gmailId(body.id);
  if (!id) return null;
  const internal = Number(body.internalDate);
  return {
    id,
    labels: new Set((Array.isArray(body.labelIds) ? body.labelIds : []).filter((label): label is string => typeof label === "string")),
    internalDate: Number.isFinite(internal) && internal > 0 ? internal : null,
  };
}

/// Whether a message is in that folder at Gmail: its label, and neither in
/// the trash nor spam.
const inFolder = (meta: GmailMeta, role: GraphReadRole) => meta.labels.has(GMAIL_LABELS[role]) && !meta.labels.has("TRASH") && !meta.labels.has("SPAM");

/// A message's labels, or null when it is gone.
async function metaFor(session: GmailSession, id: string): Promise<GmailMeta | null> {
  try {
    return metaOf(await session.get(`${GMAIL_ME}/messages/${id}?${query({ format: "minimal" })}`));
  } catch (err) {
    if (err instanceof GmailError && err.code === "gone") return null;
    throw err;
  }
}

/// A new message, read whole (format=full: headers, text, the attachments'
/// names), as a change of the copy; null when it is gone.
async function newMessage(session: GmailSession, userId: string, source: EmailSource, folder: EmailFolder, role: GraphReadRole, id: string): Promise<GraphChange | null> {
  let body: Record<string, unknown>;
  try {
    body = await session.get(`${GMAIL_ME}/messages/${id}?${query({ format: "full" })}`);
  } catch (err) {
    if (err instanceof GmailError && err.code === "gone") return null;
    throw err;
  }
  const meta = metaOf(body);
  if (!meta || !isObject(body.payload)) return null;
  const payload = body.payload as GmailPart;
  const { source: mime, cut } = await sourceOf(session, meta.id, payload);
  const parsed = await parseEmail(mime, { cut }).catch(() => null);
  const attachments: AttachmentInfo[] = attachmentsOf(structureOf(payload));
  const isRead = !meta.labels.has("UNREAD");
  const flagged = meta.labels.has("STARRED");
  const from = parsed?.from ?? null;
  const to = parsed?.to ?? [];
  const references = parsed?.references ?? [];
  const inReplyTo = parsed?.inReplyTo ?? null;
  const size = Number(body.sizeEstimate);
  return {
    graphId: meta.id,
    removed: false,
    isRead,
    flagged,
    email: {
      user_id: userId,
      email_source_id: source.id,
      email_folder_id: folder.id,
      uid: null,
      uid_validity: null,
      provider_message_id: parsed?.messageId ?? null,
      provider_thread_id: threadIdOf({ serverThreadId: gmailThreadId(body.threadId), references, inReplyTo, messageId: parsed?.messageId ?? null }),
      direction: role === "sent" ? "outbound" : "inbound",
      status: role,
      subject: parsed?.subject ?? null,
      from_name: from?.name ?? null,
      from_email: from?.address ?? null,
      to_name: to[0]?.name ?? null,
      to_email: to[0]?.address ?? null,
      recipients: { to, cc: parsed?.cc ?? [], reply_to: parsed?.replyTo ?? [] },
      text_body: parsed?.text || null,
      body_format: parsed?.format ?? "text",
      body_truncated: parsed?.truncated ?? false,
      is_read: isRead,
      // Gmail does not say it: « en attente de réponse » looks for the
      // person's answer in the conversation.
      is_replied: false,
      important: flagged,
      provider_internal_date: meta.internalDate ?? parsed?.sentAt ?? null,
      sent_at: parsed?.sentAt ?? null,
      size: Number.isFinite(size) && size > 0 ? size : null,
      attachments,
      labels: [],
      metadata: { in_reply_to: inReplyTo, references, gmail_id: meta.id, ...(parsed?.automated || automatedSender(from?.address) ? { automated: true } : {}) },
      trashed_at: null,
    },
  };
}

// ── The copy ────────────────────────────────────────────────────────────

/// The session of the mailbox set up, with the sign-in kept for it.
function syncSession(userId: string, source: EmailSource): { session: GmailSession; refreshToken: string } {
  const secret = mailSecret(source.id);
  if (secret?.kind !== "google") throw new GmailError("signin_required");
  return {
    refreshToken: secret.refreshToken,
    session: new GmailSession(secret.refreshToken, () => ({ gmailMailbox: stillGmail(userId, source.id), emailOn: capabilityOn(userId, "email") })),
  };
}

/// Reads what changed in INBOX and SENT since the last round, into the
/// copy: the changes since then (history), or — none kept, the window now
/// starting earlier, or Gmail no longer able to say them — the window's
/// messages listed again (those kept already are not read again). `wanted`:
/// E-mails still on and this mailbox still the one set up — asked again
/// before each batch is kept.
export async function syncGmailMailbox(userId: string, source: EmailSource, state: SyncProgress, wanted: () => boolean): Promise<void> {
  if (!wanted()) throw new GmailError("email_off");
  const { session, refreshToken } = syncSession(userId, source);
  // The sign-in changed meanwhile: what this round read is not kept.
  const stillWanted = () => {
    const secret = mailSecret(source.id);
    return wanted() && secret?.kind === "google" && secret.refreshToken === refreshToken;
  };
  const folders = {} as Record<GraphReadRole, EmailFolder>;
  for (const role of READ_ROLES) folders[role] = graphFolder(source.id, role, GMAIL_LABELS[role], folderFor(source.id, role) ? null : GMAIL_LABELS[role]);
  const since = source.import_after ?? Date.now() - DEFAULT_WINDOW_DAYS * DAY_MS;
  const kept = gmailSyncState(source.id);
  if (kept?.history_id && kept.since <= since) {
    try {
      await followHistory(session, userId, source, folders, kept.since, kept.history_id, state, stillWanted);
      return;
    } catch (err) {
      if (!(err instanceof GmailError && err.code === "sync_reset")) throw err;
    }
  }
  await listWindow(session, userId, source, folders, since, state, stillWanted);
}

/// Every message of INBOX and SENT received since `since`, newest first;
/// those not kept yet read and kept, a batch at a time. Where the mailbox's
/// changes stood before the listing is kept at the end — not if it stopped
/// before.
async function listWindow(
  session: GmailSession, userId: string, source: EmailSource, folders: Record<GraphReadRole, EmailFolder>, since: number, state: SyncProgress, wanted: () => boolean,
): Promise<void> {
  const { historyId } = await profileOf(session);
  for (const role of READ_ROLES) {
    if (!wanted()) return;
    state.folder = role;
    const folder = folders[role];
    const known = graphIdsIn(folder.id, "gmail_id");
    const ids: string[] = [];
    let pageToken: string | null = null;
    for (let page = 0; ; page += 1) {
      if (page >= MAX_PAGES) throw new GmailError("gmail_failed");
      const body = await session.get(`${GMAIL_ME}/messages?${query({ labelIds: GMAIL_LABELS[role], q: `after:${Math.floor(since / 1_000)}`, maxResults: String(PAGE), ...(pageToken ? { pageToken } : {}) })}`);
      for (const item of Array.isArray(body.messages) ? body.messages.filter(isObject) : []) {
        const id = gmailId(item.id);
        if (id && !known.has(id)) ids.push(id);
      }
      pageToken = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : null;
      if (!pageToken) break;
    }
    state.to_fetch += ids.length;
    for (let start = 0; start < ids.length; start += BATCH) {
      if (!wanted()) return;
      const changes: GraphChange[] = [];
      for (const id of ids.slice(start, start + BATCH)) {
        const change = await newMessage(session, userId, source, folder, role, id);
        if (change) changes.push(change);
        state.fetched += 1;
      }
      if (!wanted()) return;
      state.imported += saveGraphChanges(folder.id, changes, known, Date.now(), "gmail_id");
    }
    noteGraphFolder(folder.id, { synced_after: since, message_count: await labelTotal(session, GMAIL_LABELS[role]), last_synced_at: Date.now() });
  }
  if (wanted()) saveGmailSyncState(source.id, { since, history_id: historyId });
}

/// How many messages a label holds at Gmail (null: it does not say).
async function labelTotal(session: GmailSession, label: string): Promise<number | null> {
  const body = await session.get(`${GMAIL_ME}/labels/${label}`);
  return typeof body.messagesTotal === "number" && Number.isFinite(body.messagesTotal) ? body.messagesTotal : null;
}

/// The changes since `historyId`: the messages they touch, each asked how
/// it stands now — in INBOX or SENT, read, starred — and kept so: a new one
/// read whole, one kept brought up to date, one gone from the folder hidden.
async function followHistory(
  session: GmailSession, userId: string, source: EmailSource, folders: Record<GraphReadRole, EmailFolder>, since: number, historyId: string, state: SyncProgress, wanted: () => boolean,
): Promise<void> {
  const touched = new Set<string>();
  let latest = historyId;
  let pageToken: string | null = null;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) throw new GmailError("gmail_failed");
    const body = await session.get(`${GMAIL_ME}/history?${query({
      startHistoryId: historyId, historyTypes: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"], maxResults: "500", ...(pageToken ? { pageToken } : {}),
    })}`);
    for (const record of Array.isArray(body.history) ? body.history.filter(isObject) : []) {
      for (const key of ["messages", "messagesAdded", "messagesDeleted", "labelsAdded", "labelsRemoved"]) {
        for (const entry of Array.isArray(record[key]) ? (record[key] as unknown[]).filter(isObject) : []) {
          const id = gmailId(isObject(entry.message) ? entry.message.id : entry.id);
          if (id) touched.add(id);
        }
      }
    }
    if (typeof body.historyId === "string" && /^\d{1,30}$/.test(body.historyId)) latest = body.historyId;
    pageToken = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : null;
    if (!pageToken) break;
  }
  const known = { inbox: graphIdsIn(folders.inbox.id, "gmail_id"), sent: graphIdsIn(folders.sent.id, "gmail_id") };
  const ids = [...touched];
  state.to_fetch += ids.length;
  for (let start = 0; start < ids.length; start += BATCH) {
    if (!wanted()) return;
    const changes: Record<GraphReadRole, GraphChange[]> = { inbox: [], sent: [] };
    for (const id of ids.slice(start, start + BATCH)) {
      const meta = await metaFor(session, id);
      for (const role of READ_ROLES) {
        const here = known[role].has(id);
        if (!meta || !inFolder(meta, role)) {
          if (here) changes[role].push({ graphId: id, removed: true, email: null, isRead: null, flagged: null });
          continue;
        }
        if (here) {
          changes[role].push({ graphId: id, removed: false, email: null, isRead: !meta.labels.has("UNREAD"), flagged: meta.labels.has("STARRED") });
          continue;
        }
        // Back in the folder from before the window: not copied.
        if (meta.internalDate !== null && meta.internalDate < since) continue;
        state.folder = role;
        const change = await newMessage(session, userId, source, folders[role], role, id);
        if (change) changes[role].push(change);
      }
      state.fetched += 1;
    }
    if (!wanted()) return;
    for (const role of READ_ROLES) state.imported += saveGraphChanges(folders[role].id, changes[role], known[role], Date.now(), "gmail_id");
  }
  if (!wanted()) return;
  const now = Date.now();
  for (const role of READ_ROLES) noteGraphFolder(folders[role].id, { synced_after: since, message_count: null, last_synced_at: now });
  saveGmailSyncState(source.id, { since, history_id: latest });
}

// ── The draft ───────────────────────────────────────────────────────────

/// A draft the person allowed, created in the mailbox's Drafts from its
/// MIME text (the same as over IMAP): never sent.
export async function saveGmailDraft(userId: string, source: EmailSource, mime: Buffer): Promise<{ ok: true; folder: string; uid: null } | { ok: false; error: GmailErrorCode }> {
  try {
    const { session } = syncSession(userId, source);
    await session.post(`${GMAIL_ME}/drafts`, { message: { raw: mime.toString("base64url") } });
    const drafts = folderFor(source.id, "drafts");
    return { ok: true, folder: drafts?.name ?? drafts?.path ?? GMAIL_LABELS.drafts, uid: null };
  } catch (err) {
    return { ok: false, error: gmailErrorCode(err) };
  }
}
