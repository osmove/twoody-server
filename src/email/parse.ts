import { convert } from "html-to-text";
import { simpleParser, type AddressObject, type EmailAddress } from "mailparser";

// What an e-mail is made of, as Twoody keeps it (Capacités → E-mails):
// pure helpers, tested without a mail server (test/email.test.ts). The
// ideas come from the account's Gmail import (twoody-backend
// email_intelligence/gmail_importer.rb: the plain text first, HTML turned
// into text otherwise; Email.normalize_subject for conversations), not its
// code.

/// The text of a message kept, at most (the rest is said to be cut).
export const TEXT_BODY_MAX_CHARS = 20_000;
/// What is read of a message: its first bytes. Headers and text come
/// first; what follows is attachments, which are not read.
export const SOURCE_MAX_BYTES = 256 * 1024;

export interface MailAddress {
  name: string | null;
  address: string;
}

/// The folders Twoody uses: INBOX and Sent are read, Drafts written to.
export type FolderRole = "inbox" | "sent" | "drafts";

// ─── Subjects and conversations ─────────────────────────────────────────

/// « RE: », « TR: », « Fwd: », « Rép. : », « AW: »… as mail clients write them.
const REPLY_PREFIX = /^\s*(?:re|fwd?|tr|r[ée]p\.?|aw|wg|sv|vs|rv|enc|antw)(?:\s*\[\d+\])?\s*:\s*/i;

/// « RE: TR: Réunion de lundi » → « réunion de lundi »: the subject a
/// conversation keeps, whatever replies and forwards added.
export function normalizeSubject(subject: string | null | undefined): string {
  let rest = (subject ?? "").trim();
  for (let guard = 0; guard < 10 && REPLY_PREFIX.test(rest); guard += 1) rest = rest.replace(REPLY_PREFIX, "");
  return rest.trim().toLowerCase();
}

/// The subject of an answer: « Re: » before it, unless it starts with one.
export function replySubject(subject: string | null | undefined): string {
  const given = (subject ?? "").trim();
  if (/^\s*(?:re|r[ée]p\.?|aw|sv|antw)(?:\s*\[\d+\])?\s*:/i.test(given)) return given;
  return given ? `Re: ${given}` : "Re:";
}

/// A Message-ID as headers write it: « <abc@example.com> ».
export function cleanMessageId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!id || id.length > 998 || /\s/.test(id)) return null;
  return id.startsWith("<") ? id : `<${id}>`;
}

export function messageIdList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\s+/) : [];
  return raw.map(cleanMessageId).filter((id): id is string => !!id).slice(-50);
}

/// Which conversation a message belongs to: the server's own thread when
/// it has one (Gmail, OBJECTID), else the first message its References
/// name — the one the conversation started with — else itself.
export function threadIdOf(input: { serverThreadId?: string | null; references?: string[]; inReplyTo?: string | null; messageId?: string | null }): string | null {
  if (input.serverThreadId) return `server:${input.serverThreadId}`;
  const root = input.references?.[0] ?? input.inReplyTo ?? input.messageId;
  return root ? `message:${root.toLowerCase()}` : null;
}

// ─── Addresses ───────────────────────────────────────────────────────────

const ADDRESS = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;

/// An address as kept: trimmed, its domain in lower case; null when it is
/// not one.
export function cleanAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const address = value.trim().replace(/^mailto:/i, "");
  if (address.length > 320 || !ADDRESS.test(address)) return null;
  const at = address.lastIndexOf("@");
  return `${address.slice(0, at)}@${address.slice(at + 1).toLowerCase()}`;
}

function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().replace(/^["']|["']$/g, "").trim();
  return name ? name.slice(0, 200) : null;
}

/// mailparser's addresses (groups unfolded), 100 at most.
export function addressList(value: AddressObject | AddressObject[] | undefined | null): MailAddress[] {
  const out: MailAddress[] = [];
  const add = (entry: EmailAddress) => {
    if (entry.group) entry.group.forEach(add);
    const address = cleanAddress(entry.address);
    if (address && out.length < 100) out.push({ name: cleanName(entry.name), address });
  };
  for (const object of Array.isArray(value) ? value : value ? [value] : []) object.value?.forEach(add);
  return out;
}

/// IMAP's own (ENVELOPE) addresses, the same way.
export function envelopeAddresses(value: Array<{ name?: string; address?: string }> | undefined | null): MailAddress[] {
  return (value ?? []).map((entry) => ({ name: cleanName(entry.name), address: cleanAddress(entry.address) })).filter((entry): entry is MailAddress => !!entry.address).slice(0, 100);
}

/// « René Dupont <rene@example.com> », or the address alone.
export function formatAddress(address: MailAddress): string {
  return address.name && address.name.toLowerCase() !== address.address.toLowerCase() ? `${address.name} <${address.address}>` : address.address;
}

/// Who an e-mail is from and to, as one line: searched by name or address.
export function peopleText(...lists: Array<MailAddress | MailAddress[] | null | undefined>): string {
  return lists.flatMap((list) => (Array.isArray(list) ? list : list ? [list] : [])).map(formatAddress).join("; ").slice(0, 4_000);
}

/// Recipients as a model or a person writes them: « paul@x.fr, René
/// <rene@y.fr>; lea@z.fr », or a list of such strings.
export function parseRecipients(value: unknown): { addresses: MailAddress[]; invalid: string[] } {
  const pieces: string[] = [];
  for (const item of Array.isArray(value) ? value : [value]) {
    if (typeof item !== "string") continue;
    // Commas and semicolons separate them, except within quotes or <…>.
    let current = "";
    let quoted = false;
    let angled = false;
    for (const char of item) {
      if (char === '"') quoted = !quoted;
      else if (char === "<" && !quoted) angled = true;
      else if (char === ">" && !quoted) angled = false;
      if ((char === "," || char === ";") && !quoted && !angled) {
        pieces.push(current);
        current = "";
      } else current += char;
    }
    pieces.push(current);
  }
  const addresses: MailAddress[] = [];
  const invalid: string[] = [];
  for (const piece of pieces.map((one) => one.trim()).filter(Boolean)) {
    const named = /^(.*?)<([^<>]+)>$/.exec(piece);
    const address = cleanAddress(named ? named[2] : piece);
    if (!address) {
      invalid.push(piece.slice(0, 120));
      continue;
    }
    if (!addresses.some((known) => known.address.toLowerCase() === address.toLowerCase())) addresses.push({ name: named ? cleanName(named[1]) : null, address });
  }
  return { addresses, invalid };
}

// ─── Bodies ──────────────────────────────────────────────────────────────

const HTML_TEXT = {
  wordwrap: false,
  selectors: [
    // Links as their words only: tracking addresses are noise to a model.
    { selector: "a", options: { ignoreHref: true } },
    { selector: "img", format: "skip" },
    { selector: "td", format: "block", options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
    { selector: "th", format: "block", options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
    ...["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) => ({ selector, options: { uppercase: false } })),
  ],
};

/// An HTML body as text: its words, paragraphs and lists; no links, images
/// or layout.
export function htmlToPlain(html: string): string {
  try {
    return tidyText(convert(html.slice(0, 2_000_000), HTML_TEXT));
  } catch {
    return tidyText(html.replace(/<(?:style|script)[\s\S]*?<\/(?:style|script)>/gi, " ").replace(/<[^>]+>/g, " "));
  }
}

/// Line ends, spaces and the invisible characters newsletters pad with.
export function tidyText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[   ]/g, " ")
    .replace(/[­͏​-‏⁠﻿]/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/^[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/// At most `max` characters, cut at a word.
export function capText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const cut = text.slice(0, max);
  const space = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"));
  return { text: (space > 0 && space >= max - 200 ? cut.slice(0, space) : cut).trimEnd(), truncated: true };
}

/// The text to keep: the plain part when there is a real one, else the
/// HTML part as text.
export function bodyOf(parsed: { text?: string; html?: string | false }): { text: string; format: "text" | "html" } {
  const plain = tidyText(parsed.text ?? "");
  const html = typeof parsed.html === "string" ? parsed.html : "";
  // A plain part of a few words (« Voir la version en ligne ») next to an
  // HTML one: the HTML holds the message.
  if (html && plain.length < 40) {
    const converted = htmlToPlain(html);
    if (converted.length > plain.length) return { text: converted, format: "html" };
  }
  return { text: plain, format: "text" };
}

// ─── Flags, folders, attachments ─────────────────────────────────────────

export interface FlagState {
  is_read: boolean;
  is_replied: boolean;
  important: boolean;
  deleted: boolean;
}

/// IMAP's flags as the account's columns say them.
export function flagState(flags: Iterable<string>): FlagState {
  const set = new Set([...flags].map((flag) => flag.toLowerCase()));
  return { is_read: set.has("\\seen"), is_replied: set.has("\\answered"), important: set.has("\\flagged"), deleted: set.has("\\deleted") };
}

export interface ListedFolder {
  path: string;
  name: string;
  specialUse: string | null;
  /// How the server's list said it: "extension" (SPECIAL-USE), "name" (guessed from a known name).
  specialUseSource: string | null;
  flags: string[];
}

export function folderRole(folder: Pick<ListedFolder, "path" | "specialUse">): FolderRole | null {
  if (folder.path.toUpperCase() === "INBOX" || folder.specialUse === "\\Inbox") return "inbox";
  if (folder.specialUse === "\\Sent") return "sent";
  if (folder.specialUse === "\\Drafts") return "drafts";
  return null;
}

/// INBOX, Sent and Drafts in what the server lists: what the server says
/// of a folder first (SPECIAL-USE), a known name otherwise.
export function pickFolders(list: ListedFolder[]): Partial<Record<FolderRole, ListedFolder>> {
  const rank = (folder: ListedFolder) => (folder.specialUseSource === "extension" ? 0 : folder.specialUseSource === "user" ? 1 : 2);
  const picked: Partial<Record<FolderRole, ListedFolder>> = {};
  for (const folder of [...list].sort((a, b) => rank(a) - rank(b))) {
    if (folder.flags.some((flag) => flag.toLowerCase() === "\\noselect" || flag.toLowerCase() === "\\nonexistent")) continue;
    const role = folderRole(folder);
    if (role && !picked[role]) picked[role] = folder;
  }
  return picked;
}

export interface StructureNode {
  part?: string;
  type?: string;
  parameters?: Record<string, string>;
  size?: number;
  disposition?: string;
  dispositionParameters?: Record<string, string>;
  childNodes?: StructureNode[];
}

export interface AttachmentInfo {
  filename: string;
  mime_type: string;
  size: number | null;
}

/// The attachments a message's structure lists (names, types and sizes:
/// their content is never read).
export function attachmentsOf(node: StructureNode | null | undefined, out: AttachmentInfo[] = []): AttachmentInfo[] {
  if (!node || out.length >= 30) return out;
  const type = (node.type ?? "").toLowerCase();
  const filename = node.dispositionParameters?.filename ?? node.parameters?.name ?? null;
  const disposition = (node.disposition ?? "").toLowerCase();
  if (type === "message/rfc822") {
    out.push({ filename: filename ?? "message.eml", mime_type: type, size: typeof node.size === "number" ? node.size : null });
    return out;
  }
  if (!type.startsWith("multipart/") && (disposition === "attachment" || (filename && !type.startsWith("text/")))) {
    out.push({ filename: (filename ?? "attachment").slice(0, 200), mime_type: type || "application/octet-stream", size: typeof node.size === "number" ? node.size : null });
  }
  for (const child of node.childNodes ?? []) attachmentsOf(child, out);
  return out;
}

/// The bytes of a message's text parts (plain and HTML, attachments left
/// out), by its structure; null without one.
export function textBytes(node: StructureNode | null | undefined): number | null {
  if (!node) return null;
  const type = (node.type ?? "").toLowerCase();
  if (type === "message/rfc822" || (node.disposition ?? "").toLowerCase() === "attachment") return 0;
  if (node.childNodes?.length) return node.childNodes.reduce((sum, child) => sum + (textBytes(child) ?? 0), 0);
  return type === "text/plain" || type === "text/html" ? node.size ?? 0 : 0;
}

/// Whether a source cut at `read` bytes may have lost some of the text:
/// not when the message is whole, nor when its text parts fit well within
/// what was read (the attachments after them were cut).
export function textMayBeCut(size: number | null, read: number, structure: StructureNode | null | undefined): boolean {
  if (size === null || size <= read) return false;
  const text = textBytes(structure);
  return text === null || text + 16 * 1024 > read;
}

// ─── A whole message ─────────────────────────────────────────────────────

export interface ParsedEmail {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  subject: string | null;
  from: MailAddress | null;
  to: MailAddress[];
  cc: MailAddress[];
  replyTo: MailAddress[];
  /// The Date header (ms), when it is one.
  sentAt: number | null;
  text: string;
  format: "text" | "html";
  /// The text kept is not the whole of it.
  truncated: boolean;
}

function validDate(value: unknown): number | null {
  const time = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > 0 ? time : null;
}

/// A message's source (its first SOURCE_MAX_BYTES): headers and text.
/// `cut`: the source read is not the whole message.
export async function parseEmail(source: Buffer, options: { cut?: boolean } = {}): Promise<ParsedEmail> {
  const parsed = await simpleParser(source, { skipHtmlToText: true, skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
  const body = bodyOf(parsed);
  const kept = capText(body.text, TEXT_BODY_MAX_CHARS);
  const references = messageIdList(parsed.references);
  return {
    messageId: cleanMessageId(parsed.messageId),
    inReplyTo: messageIdList(parsed.inReplyTo)[0] ?? null,
    references,
    subject: parsed.subject?.replace(/\s+/g, " ").trim().slice(0, 998) || null,
    from: addressList(parsed.from)[0] ?? null,
    to: addressList(parsed.to),
    cc: addressList(parsed.cc),
    replyTo: addressList(parsed.replyTo),
    sentAt: validDate(parsed.date),
    text: kept.text,
    format: body.format,
    truncated: kept.truncated || options.cut === true,
  };
}

export { validDate };
