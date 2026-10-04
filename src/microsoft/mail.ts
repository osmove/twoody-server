import { capText, cleanMessageId, envelopeAddresses, htmlToPlain, TEXT_BODY_MAX_CHARS, tidyText, type AttachmentInfo, type MailAddress } from "../email/parse.js";
import { GRAPH_ME } from "../outbound.js";
import { GraphError, type GraphSession } from "./graph.js";

// The mailbox through Microsoft Graph (Capacités → E-mails, 04/10/2026): an
// Outlook.com or Microsoft 365 mailbox read with the link's access token
// (link.ts), without IMAP — which Outlook.com wants switched on by hand, many
// organisations switch off, and an account without an Outlook mailbox does
// not have. What is asked of Graph, each request through the door of
// src/outbound.ts by the session of graph.ts:
//   - the Inbox, Sent Items and Drafts folders, by their well-known names:
//     their id, the name the person sees, how many messages they hold;
//   - the changes of Inbox and Sent Items (delta): first every message
//     received since the start of the window, newest first, then, every
//     round, what changed since — new messages, read or flagged elsewhere,
//     removed from the folder (@removed) — their text as Graph writes it
//     from the HTML (Prefer: outlook.body-content-type="text");
//   - the names, types and sizes of a new message's attachments, never
//     their content;
//   - one write: a draft, created in Drafts from its MIME text, once the
//     person allowed it in the chat. Never sent.
// Nothing is marked read, moved or deleted there. Here Graph's words become
// Twoody's; the copy is kept by src/email/graphMailbox.ts.

/// The folders Twoody uses, by Graph's well-known names.
export const MAIL_FOLDERS = { inbox: "inbox", sent: "sentitems", drafts: "drafts" } as const;
export type MailFolderRole = keyof typeof MAIL_FOLDERS;

export interface GraphMailFolder {
  id: string;
  /// As the person sees it (« Boîte de réception »).
  name: string | null;
  /// Messages in it, at Microsoft.
  total: number | null;
}

/// What a change gives of a message.
const MESSAGE_FIELDS = "id,internetMessageId,conversationId,subject,from,sender,toRecipients,ccRecipients,replyTo,receivedDateTime,sentDateTime,isRead,flag,hasAttachments,body";
/// Messages per page of changes: a page of long newsletters stays a few megabytes.
const PAGE_SIZE = 50;
/// The text Graph makes of each message, and pages of changes that size.
export const MAIL_PREFER = `outlook.body-content-type="text", odata.maxpagesize=${PAGE_SIZE}`;
/// A message's attachments, at most (as over IMAP).
const MAX_ATTACHMENTS = 30;

const query = (params: Record<string, string>) => new URLSearchParams(params).toString();
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function str(value: unknown, max = 500): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/// A time as Graph's filter takes it: « 2026-07-06T22:00:00Z ».
const isoSeconds = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/// One of the three folders, by its well-known name.
export async function mailFolder(session: GraphSession, role: MailFolderRole): Promise<GraphMailFolder> {
  const body = await session.get(`${GRAPH_ME}/mailFolders/${MAIL_FOLDERS[role]}?${query({ $select: "id,displayName,totalItemCount" })}`);
  const id = str(body.id, 2_000);
  if (!id) throw new GraphError("graph_failed");
  return { id, name: str(body.displayName, 200), total: typeof body.totalItemCount === "number" && Number.isFinite(body.totalItemCount) ? body.totalItemCount : null };
}

/// The first page of a round of a folder's changes: every message received
/// since `since`, newest first. Graph keeps what was asked in the links it
/// gives back; they are followed as given.
export function deltaStart(folderId: string, since: number): string {
  return `${GRAPH_ME}/mailFolders/${encodeURIComponent(folderId)}/messages/delta?${query({ $select: MESSAGE_FIELDS, $filter: `receivedDateTime ge ${isoSeconds(since)}`, $orderby: "receivedDateTime desc" })}`;
}

export interface DeltaPage {
  changes: Array<Record<string, unknown>>;
  /// The next page of this round…
  next: string | null;
  /// …or, the round over, where the next one starts.
  delta: string | null;
}

/// One page of a round of changes.
export async function deltaPage(session: GraphSession, url: string): Promise<DeltaPage> {
  const body = await session.get(url, { prefer: MAIL_PREFER });
  const next = typeof body["@odata.nextLink"] === "string" ? body["@odata.nextLink"] : null;
  const delta = typeof body["@odata.deltaLink"] === "string" ? body["@odata.deltaLink"] : null;
  // A page that leads nowhere: the round could never end.
  if (!next && !delta) throw new GraphError("graph_failed");
  return { changes: Array.isArray(body.value) ? body.value.filter(isObject) : [], next, delta };
}

/// A message of a change, in Twoody's words.
export interface GraphMessage {
  id: string;
  /// Gone from the folder: deleted, or moved elsewhere.
  removed: boolean;
  messageId: string | null;
  conversationId: string | null;
  subject: string | null;
  from: MailAddress | null;
  to: MailAddress[];
  cc: MailAddress[];
  replyTo: MailAddress[];
  receivedAt: number | null;
  sentAt: number | null;
  /// Null when the change does not say.
  isRead: boolean | null;
  flagged: boolean | null;
  hasAttachments: boolean;
  /// Its text (null when the change does not give it), cut as over IMAP.
  text: string | null;
  format: "text" | "html";
  truncated: boolean;
}

function addressOf(value: unknown): MailAddress | null {
  const email = isObject(value) && isObject(value.emailAddress) ? value.emailAddress : null;
  return email ? envelopeAddresses([{ name: typeof email.name === "string" ? email.name : undefined, address: typeof email.address === "string" ? email.address : undefined }])[0] ?? null : null;
}

function addressesOf(value: unknown): MailAddress[] {
  return (Array.isArray(value) ? value : []).map(addressOf).filter((one): one is MailAddress => !!one).slice(0, 100);
}

function instant(value: unknown): number | null {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/// Graph says « true » now and then where it means true.
function bool(value: unknown): boolean | null {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

/// Graph's text of an HTML message, as the IMAP path keeps one: a link as
/// its words only (Graph writes « Voir<https://track…> »: tracking addresses
/// are noise to a model), no picture's place (« [cid:image001.png@…] »).
export function graphText(body: unknown): { text: string; format: "text" | "html"; truncated: boolean } | null {
  if (!isObject(body) || typeof body.content !== "string") return null;
  const html = typeof body.contentType === "string" && body.contentType.toLowerCase() === "html";
  const text = html
    ? htmlToPlain(body.content)
    : tidyText(body.content.slice(0, 2_000_000).replace(/<(?:https?|mailto):[^\s<>]*>/gi, "").replace(/\[cid:[^\]\s]*\]/gi, ""));
  const kept = capText(text, TEXT_BODY_MAX_CHARS);
  return { text: kept.text, format: html ? "html" : "text", truncated: kept.truncated };
}

/// A change of a round as a message; null for what is no message.
export function graphMessage(change: Record<string, unknown>): GraphMessage | null {
  const id = str(change.id, 2_000);
  if (!id) return null;
  const text = graphText(change.body);
  const flag = isObject(change.flag) && typeof change.flag.flagStatus === "string" ? change.flag.flagStatus : null;
  return {
    id,
    removed: isObject(change["@removed"]),
    messageId: cleanMessageId(change.internetMessageId),
    conversationId: str(change.conversationId, 2_000),
    subject: typeof change.subject === "string" ? change.subject.replace(/\s+/g, " ").trim().slice(0, 998) || null : null,
    from: addressOf(change.from) ?? addressOf(change.sender),
    to: addressesOf(change.toRecipients),
    cc: addressesOf(change.ccRecipients),
    replyTo: addressesOf(change.replyTo),
    receivedAt: instant(change.receivedDateTime),
    sentAt: instant(change.sentDateTime),
    isRead: bool(change.isRead),
    flagged: flag === null ? null : flag.toLowerCase() === "flagged",
    hasAttachments: bool(change.hasAttachments) === true,
    text: text?.text ?? null,
    format: text?.format ?? "text",
    truncated: text?.truncated ?? false,
  };
}

/// The names, types and sizes of a message's attachments — never their
/// content. Those shown in its text (inline: a logo, a signature) are left
/// out, as Graph's own hasAttachments leaves them out; an attached e-mail
/// is « message/rfc822 », as over IMAP.
export async function attachmentsOf(session: GraphSession, messageId: string): Promise<AttachmentInfo[]> {
  const body = await session.get(`${GRAPH_ME}/messages/${encodeURIComponent(messageId)}/attachments?${query({ $select: "name,contentType,size,isInline" })}`);
  const out: AttachmentInfo[] = [];
  for (const item of Array.isArray(body.value) ? body.value.filter(isObject) : []) {
    if (item.isInline === true) continue;
    const kind = typeof item["@odata.type"] === "string" ? item["@odata.type"].toLowerCase() : "";
    const type = str(item.contentType, 200)?.toLowerCase() ?? (kind.endsWith("itemattachment") ? "message/rfc822" : "application/octet-stream");
    out.push({ filename: str(item.name, 200) ?? (type === "message/rfc822" ? "message.eml" : "attachment"), mime_type: type, size: typeof item.size === "number" && Number.isFinite(item.size) ? item.size : null });
    if (out.length >= MAX_ATTACHMENTS) break;
  }
  return out;
}

/// A draft created in Drafts from its MIME text (as Graph takes it: base64,
/// sent as text/plain): Graph's id for it. Never sent.
export async function createDraft(session: GraphSession, mime: Buffer): Promise<{ id: string | null }> {
  const created = await session.post(`${GRAPH_ME}/messages`, mime.toString("base64"), "text/plain");
  return { id: str(created.id, 2_000) };
}
