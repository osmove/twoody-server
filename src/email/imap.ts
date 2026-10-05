import { ImapFlow, type FetchMessageObject } from "imapflow";
import { isLoopbackHost, MailDoorClosedError, mailServerDoor, type MailDoorReason, type MailServer } from "../outbound.js";
import { SOURCE_MAX_BYTES, type ListedFolder, type StructureNode } from "./parse.js";

// The person's mail server, over IMAP (imapflow), from this computer.
//
// This is the one file that opens a connection to a mail server
// (test/emailDoor.test.ts fails otherwise), and it opens none without the
// door of src/outbound.ts: E-mails switched on, the server the person set
// up — exactly — and TLS. What it does there:
//   - lists the folders, to find INBOX, Sent and Drafts;
//   - opens INBOX and Sent read-only (EXAMINE) and reads messages with
//     BODY.PEEK: nothing is marked read, moved or deleted;
//   - writes one thing, and only after the person allowed it in the chat:
//     a draft, appended to Drafts (APPEND, flagged \Draft).
// The tests give it a fake server (useMailConnectorForTests): no network.

export interface MailSettings extends MailServer {
  username: string;
  /// Its password (LOGIN)…
  password?: string;
  /// …or an access token (AUTHENTICATE XOAUTH2): a mailbox that signs in
  /// with Microsoft (microsoft.ts).
  accessToken?: string;
}

export interface OpenedFolder {
  uidValidity: number;
  uidNext: number;
  exists: number;
}

export interface FetchedEnvelope {
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  date?: Date | string;
  from?: Array<{ name?: string; address?: string }>;
  to?: Array<{ name?: string; address?: string }>;
  cc?: Array<{ name?: string; address?: string }>;
  replyTo?: Array<{ name?: string; address?: string }>;
}

export interface FetchedMail {
  uid: number;
  flags: string[];
  /// INTERNALDATE (ms): when the server received it.
  internalDate: number | null;
  size: number | null;
  /// Its first SOURCE_MAX_BYTES.
  source: Buffer | null;
  envelope: FetchedEnvelope | null;
  structure: StructureNode | null;
  threadId: string | null;
  labels: string[];
}

/// What Twoody does on a mail server, whoever the server is.
export interface MailSession {
  listFolders(): Promise<ListedFolder[]>;
  /// Read-only (EXAMINE).
  openFolder(path: string): Promise<OpenedFolder>;
  /// UIDs of the open folder's messages received since that day.
  searchSince(since: Date): Promise<number[]>;
  /// UIDs of the open folder's messages from this UID on.
  searchFrom(firstUid: number): Promise<number[]>;
  /// Headers, flags, structure and the start of the source; never marks them read.
  fetchMessages(uids: number[]): Promise<FetchedMail[]>;
  fetchFlags(uids: number[]): Promise<Array<{ uid: number; flags: string[] }>>;
  /// A draft, flagged \Draft and \Seen: the only write.
  appendDraft(path: string, raw: Buffer): Promise<{ uid: number | null }>;
  close(): Promise<void>;
}

export type MailConnector = (settings: MailSettings) => Promise<MailSession>;

export type MailErrorCode =
  | MailDoorReason | "auth_failed" | "host_not_found" | "unreachable" | "tls_failed" | "timeout" | "no_inbox" | "no_drafts" | "password_missing" | "failed"
  // A mailbox that signs in with Microsoft (microsoft.ts): its sign-in to do
  // again, an approval it waits for, a refusal of another kind, Microsoft
  // out of reach, or its IMAP access refused to Twoody.
  | "signin_required" | "admin_consent_required" | "signin_failed" | "signin_unreachable" | "imap_refused"
  // What the server's own words say, when it says why (Gmail above all):
  // an app password wanted instead of the account's own; IMAP turned off
  // (by an organisation, or in the account's settings); a sign-in to
  // finish in the provider's web page first; too many connections open.
  | "app_password_required" | "imap_disabled" | "web_login_required" | "too_many_connections";

export class MailError extends Error {
  constructor(public code: MailErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "MailError";
  }
}

/// The server's own words, as imapflow hands them (the response line, its
/// text, the error's message): read here, in memory, and never kept, logged
/// or sent back — they may hold the account's address.
function serverWords(error: { response?: unknown; responseText?: unknown; message?: unknown; serverResponseCode?: unknown }): string {
  return [error.serverResponseCode, error.responseText, error.response, error.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .slice(0, 4_000);
}

/// What the server's words say, when they say why: the codes of
/// RFC 5530 and the sentences Gmail, Yahoo and others send.
function codeFromWords(words: string): MailErrorCode | null {
  if (!words) return null;
  if (/application-specific password required|app(?:lication)? password required/i.test(words)) return "app_password_required";
  if (/IMAP access is disabled|not enabled for IMAP|IMAP (?:access )?(?:is )?(?:disabled|not enabled)|IMAP is turned off/i.test(words)) return "imap_disabled";
  if (/\bWEBALERT\b|log ?in via your web browser|web login required|sign in (?:via|through|with) your (?:web )?browser/i.test(words)) return "web_login_required";
  if (/too many (?:simultaneous |concurrent |open )?connections|maximum number of (?:simultaneous |concurrent )?connections|\[LIMIT\]|\bLIMIT\b.*connections/i.test(words)) return "too_many_connections";
  return null;
}

/// What went wrong, said as one of a few words (never the server's own
/// text, which may hold the account's name).
export function mailErrorCode(err: unknown): MailErrorCode {
  if (err instanceof MailError) return err.code;
  if (err instanceof MailDoorClosedError) return err.reason;
  const error = (err ?? {}) as { code?: unknown; authenticationFailed?: unknown; tlsFailed?: unknown; serverResponseCode?: unknown; message?: unknown; response?: unknown; responseText?: unknown };
  const code = typeof error.code === "string" ? error.code : "";
  const said = codeFromWords(serverWords(error));
  if (said) return said;
  if (error.authenticationFailed === true || error.serverResponseCode === "AUTHENTICATIONFAILED" || error.serverResponseCode === "AUTHORIZATIONFAILED") return "auth_failed";
  if (error.tlsFailed === true || /^(?:CERT_|ERR_TLS_|ERR_SSL_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT)/.test(code)) return "tls_failed";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NONAME") return "host_not_found";
  if (["CONNECT_TIMEOUT", "GREETING_TIMEOUT", "UPGRADE_TIMEOUT", "ETIMEOUT", "ETIMEDOUT"].includes(code)) return "timeout";
  if (["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET", "NoConnection", "EConnectionClosed", "ClosedAfterConnectText", "ClosedAfterConnectTLS"].includes(code)) return "unreachable";
  return "failed";
}

/// A message read whole when its start could not be: at most this big.
const WHOLE_SOURCE_MAX_BYTES = 4 * 1024 * 1024;

/// UIDs as an IMAP set, consecutive ones as ranges ([1,2,3,5] → "1:3,5"):
/// a thousand flags read again stay a short command.
export function packUids(uids: number[]): string {
  const sorted = [...new Set(uids)].filter((uid) => Number.isInteger(uid) && uid > 0).sort((a, b) => a - b);
  const parts: string[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const first = sorted[index]!;
    while (index + 1 < sorted.length && sorted[index + 1] === sorted[index]! + 1) index += 1;
    parts.push(sorted[index] === first ? String(first) : `${first}:${sorted[index]}`);
  }
  return parts.join(",");
}

let connector: MailConnector = connectWithImapFlow;

/// For the tests: a fake server instead of the network (null: the real one).
export function useMailConnectorForTests(fake: MailConnector | null) {
  connector = fake ?? connectWithImapFlow;
}

/// The one way to a mail server: through the door (outbound.ts), then the
/// connection. `door`: the server the person set up, and whether E-mails
/// is on — checked here, at the moment of connecting, every time.
export async function openMailSession(settings: MailSettings, door: { configured: { host: string; port: number } | null; emailOn: boolean }): Promise<MailSession> {
  try {
    mailServerDoor(settings, door.configured, door.emailOn);
  } catch (err) {
    throw new MailError(mailErrorCode(err));
  }
  try {
    return await connector(settings);
  } catch (err) {
    throw new MailError(mailErrorCode(err));
  }
}

async function connectWithImapFlow(settings: MailSettings): Promise<MailSession> {
  const loopback = isLoopbackHost(settings.host);
  const client = new ImapFlow({
    host: settings.host,
    port: settings.port,
    secure: settings.security === "tls",
    // STARTTLS on this machine only (the door refuses it elsewhere), and
    // then required.
    ...(settings.security === "starttls" ? { doSTARTTLS: true } : {}),
    // With an access token, imapflow authenticates with XOAUTH2 (the
    // server's OAUTHBEARER if it offers it), never with a password.
    auth: settings.accessToken ? { user: settings.username, accessToken: settings.accessToken } : { user: settings.username, pass: settings.password ?? "" },
    // Nothing logged: commands carry the account's name.
    logger: false,
    disableAutoIdle: true,
    clientInfo: { name: "Twoody" },
    // A server's certificate is checked — but Proton Mail Bridge's own, on
    // this machine, cannot be.
    tls: loopback ? { rejectUnauthorized: false } : { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 120_000,
    // A server that sends more than this for one message is not followed.
    maxLiteralSize: 8 * 1024 * 1024,
    maxResponseSize: 16 * 1024 * 1024,
  });
  // An error event nobody listens to would bring the whole server down.
  client.on("error", () => undefined);
  await client.connect();
  return new ImapFlowSession(client);
}

class ImapFlowSession implements MailSession {
  constructor(private client: ImapFlow) {}

  async listFolders(): Promise<ListedFolder[]> {
    const listed = await this.client.list();
    return listed.map((folder) => ({
      path: folder.path,
      name: folder.name,
      specialUse: folder.specialUse ?? null,
      specialUseSource: folder.specialUseSource ?? null,
      flags: [...(folder.flags ?? [])],
    }));
  }

  async openFolder(path: string): Promise<OpenedFolder> {
    const mailbox = await this.client.mailboxOpen(path, { readOnly: true });
    return { uidValidity: Number(mailbox.uidValidity), uidNext: mailbox.uidNext, exists: mailbox.exists };
  }

  async searchSince(since: Date): Promise<number[]> {
    const found = await this.client.search({ since }, { uid: true });
    return Array.isArray(found) ? found : [];
  }

  async searchFrom(firstUid: number): Promise<number[]> {
    const found = await this.client.search({ uid: `${firstUid}:*` }, { uid: true });
    return Array.isArray(found) ? found.filter((uid) => uid >= firstUid) : [];
  }

  async fetchMessages(uids: number[]): Promise<FetchedMail[]> {
    if (!uids.length) return [];
    const out: FetchedMail[] = [];
    // Collected first: no other command may run while a FETCH streams.
    for await (const message of this.client.fetch(packUids(uids), {
      uid: true, flags: true, internalDate: true, size: true, envelope: true, bodyStructure: true, threadId: true, labels: true,
      source: { maxLength: SOURCE_MAX_BYTES },
    }, { uid: true })) {
      out.push(fetched(message));
    }
    // A server that answers the partial FETCH with nothing (seen with a
    // test server, for messages past a few KB): the whole message, when
    // it is of a reasonable size, its start kept.
    const missing = out.filter((mail) => !mail.source?.length && (mail.size ?? 0) > 0 && (mail.size ?? 0) <= WHOLE_SOURCE_MAX_BYTES);
    if (missing.length) {
      const whole = new Map<number, Buffer>();
      for await (const message of this.client.fetch(packUids(missing.map((mail) => mail.uid)), { uid: true, source: true }, { uid: true })) {
        if (message.source?.length) whole.set(message.uid, message.source);
      }
      for (const mail of missing) {
        const source = whole.get(mail.uid);
        if (source) mail.source = source.subarray(0, SOURCE_MAX_BYTES);
      }
    }
    return out;
  }

  async fetchFlags(uids: number[]): Promise<Array<{ uid: number; flags: string[] }>> {
    if (!uids.length) return [];
    const out: Array<{ uid: number; flags: string[] }> = [];
    for await (const message of this.client.fetch(packUids(uids), { uid: true, flags: true }, { uid: true })) {
      out.push({ uid: message.uid, flags: [...(message.flags ?? [])] });
    }
    return out;
  }

  async appendDraft(path: string, raw: Buffer): Promise<{ uid: number | null }> {
    const done = await this.client.append(path, raw, ["\\Draft", "\\Seen"], new Date());
    return { uid: done && typeof done.uid === "number" ? done.uid : null };
  }

  async close(): Promise<void> {
    try {
      await this.client.logout();
    } catch {
      this.client.close();
    }
  }
}

function fetched(message: FetchMessageObject): FetchedMail {
  const internal = message.internalDate instanceof Date ? message.internalDate.getTime() : typeof message.internalDate === "string" ? Date.parse(message.internalDate) : NaN;
  return {
    uid: message.uid,
    flags: [...(message.flags ?? [])],
    internalDate: Number.isFinite(internal) ? internal : null,
    size: typeof message.size === "number" ? message.size : null,
    source: message.source ?? null,
    envelope: (message.envelope as FetchedEnvelope | undefined) ?? null,
    structure: (message.bodyStructure as StructureNode | undefined) ?? null,
    threadId: message.threadId ?? null,
    labels: [...(message.labels ?? [])],
  };
}
