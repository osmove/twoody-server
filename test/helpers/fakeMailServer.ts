import type { FetchedMail, MailConnector, MailSession, MailSettings } from "../../src/email/imap.js";
import { SOURCE_MAX_BYTES, type ListedFolder, type StructureNode } from "../../src/email/parse.js";

// A mailbox in memory, standing in for an IMAP server in the tests of
// « E-mails » (src/email/): folders with their UIDVALIDITY and messages
// (raw RFC 5322), the password it accepts, and a log of every command a
// session sent — to check that Twoody only reads (EXAMINE, FETCH) and
// writes nothing but a draft (APPEND) once allowed.

export interface FakeMessage {
  uid: number;
  raw: Buffer;
  flags: Set<string>;
  internalDate: number;
  structure: StructureNode | null;
}

export interface FakeFolder {
  path: string;
  specialUse: string | null;
  specialUseSource: string | null;
  uidValidity: number;
  uidNext: number;
  messages: FakeMessage[];
}

export class FakeMailServer {
  folders = new Map<string, FakeFolder>();
  log: string[] = [];
  password = "abcd efgh ijkl mnop";
  /// Sessions opened (the door let them through).
  connections = 0;
  /// What each session was given, the password left out.
  logins: Array<Omit<MailSettings, "password">> = [];

  folder(path: string, specialUse: string | null = null, specialUseSource: string | null = specialUse ? "extension" : null): FakeFolder {
    const folder: FakeFolder = { path, specialUse, specialUseSource, uidValidity: 1, uidNext: 1, messages: [] };
    this.folders.set(path, folder);
    return folder;
  }

  deliver(path: string, raw: string, options: { flags?: string[]; at?: number; structure?: StructureNode | null } = {}): number {
    const folder = this.folders.get(path)!;
    const uid = folder.uidNext;
    folder.uidNext += 1;
    folder.messages.push({ uid, raw: Buffer.from(raw), flags: new Set(options.flags ?? []), internalDate: options.at ?? Date.now(), structure: options.structure ?? { type: "text/plain", size: raw.length } });
    return uid;
  }

  /// The server renumbers a folder (another UIDVALIDITY), as after a rebuild.
  renumber(path: string) {
    const folder = this.folders.get(path)!;
    folder.uidValidity += 1;
    for (const message of folder.messages) message.uid += 100;
    folder.uidNext += 100;
  }

  connector: MailConnector = async (settings: MailSettings): Promise<MailSession> => {
    const { password, ...rest } = settings;
    this.logins.push(rest);
    this.log.push(`LOGIN ${settings.username}`);
    if (password !== this.password.replace(/\s+/g, "") && password !== this.password) {
      throw Object.assign(new Error("Invalid credentials"), { authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED" });
    }
    this.connections += 1;
    let open: FakeFolder | null = null;
    const server = this;
    const fetched = (message: FakeMessage): FetchedMail => ({
      uid: message.uid,
      flags: [...message.flags],
      internalDate: message.internalDate,
      size: message.raw.length,
      source: message.raw.subarray(0, SOURCE_MAX_BYTES),
      envelope: null,
      structure: message.structure,
      threadId: null,
      labels: [],
    });
    return {
      async listFolders(): Promise<ListedFolder[]> {
        server.log.push("LIST");
        return [...server.folders.values()].map((folder) => ({ path: folder.path, name: folder.path.split("/").pop()!, specialUse: folder.specialUse, specialUseSource: folder.specialUseSource, flags: [] }));
      },
      async openFolder(path: string) {
        server.log.push(`EXAMINE ${path}`);
        open = server.folders.get(path) ?? null;
        if (!open) throw Object.assign(new Error("Mailbox doesn't exist"), { mailboxMissing: true });
        return { uidValidity: open.uidValidity, uidNext: open.uidNext, exists: open.messages.length };
      },
      async searchSince(since: Date) {
        server.log.push(`SEARCH SINCE ${open!.path}`);
        return open!.messages.filter((message) => message.internalDate >= since.getTime()).map((message) => message.uid);
      },
      async searchFrom(firstUid: number) {
        server.log.push(`SEARCH UID ${firstUid}:* ${open!.path}`);
        return open!.messages.filter((message) => message.uid >= firstUid).map((message) => message.uid);
      },
      async fetchMessages(uids: number[]) {
        server.log.push(`FETCH ${open!.path} ${[...uids].sort((a, b) => a - b).join(",")}`);
        return open!.messages.filter((message) => uids.includes(message.uid)).sort((a, b) => a.uid - b.uid).map(fetched);
      },
      async fetchFlags(uids: number[]) {
        server.log.push(`FETCH FLAGS ${open!.path} ${uids.length}`);
        return open!.messages.filter((message) => uids.includes(message.uid)).map((message) => ({ uid: message.uid, flags: [...message.flags] }));
      },
      async appendDraft(path: string, raw: Buffer) {
        server.log.push(`APPEND ${path}`);
        const folder = server.folders.get(path);
        if (!folder) throw Object.assign(new Error("Mailbox doesn't exist"), { mailboxMissing: true });
        const uid = server.deliver(path, raw.toString("utf8"), { flags: ["\\Draft", "\\Seen"] });
        return { uid };
      },
      async close() {
        server.log.push("LOGOUT");
      },
    };
  };
}

/// An e-mail as a server keeps it.
export function rfc822(message: {
  from: string;
  to: string;
  subject: string;
  date?: Date;
  messageId: string;
  inReplyTo?: string;
  references?: string;
  cc?: string;
  text?: string;
  html?: string;
}): string {
  const headers = [
    `From: ${message.from}`,
    `To: ${message.to}`,
    ...(message.cc ? [`Cc: ${message.cc}`] : []),
    `Subject: ${message.subject}`,
    `Date: ${(message.date ?? new Date()).toUTCString()}`,
    `Message-ID: ${message.messageId}`,
    ...(message.inReplyTo ? [`In-Reply-To: ${message.inReplyTo}`] : []),
    ...(message.references ? [`References: ${message.references}`] : []),
    "MIME-Version: 1.0",
  ];
  if (message.html !== undefined && message.text !== undefined) {
    return [...headers, "Content-Type: multipart/alternative; boundary=b1", "", "--b1", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", message.text, "--b1", "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", message.html, "--b1--", ""].join("\r\n");
  }
  if (message.html !== undefined) return [...headers, "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", message.html, ""].join("\r\n");
  return [...headers, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", message.text ?? "", ""].join("\r\n");
}
