import { capabilityOn } from "../localCapabilities.js";
import { mailPassword } from "./credentials.js";
import { MailError, mailErrorCode, openMailSession, type FetchedMail, type MailErrorCode, type MailSession } from "./imap.js";
import {
  attachmentsOf, envelopeAddresses, flagState, parseEmail, pickFolders, textMayBeCut, threadIdOf, validDate,
  type FolderRole, type MailAddress, type ParsedEmail,
} from "./parse.js";
import {
  activeSource, knownUids, noteSync, recentUids, renumberedFolder, saveEmail, saveFolderState, updateFlags, upsertFolder, usersWithMailboxes,
  type EmailFolder, type EmailSource, type NewEmail,
} from "./store.js";

// Keeps the copy of the person's mailbox up to date: INBOX and Sent, the
// last 90 days at first (the window the person chose), then what is new,
// by UID — every 10 minutes while E-mails is on, and when the person asks.
// Read-only on the server: folders opened with EXAMINE, messages read with
// BODY.PEEK; nothing is marked, moved or deleted there.

export const SYNC_INTERVAL_MS = 10 * 60_000;
export const DEFAULT_WINDOW_DAYS = 90;
const DAY_MS = 86_400_000;
/// Messages read per FETCH.
const BATCH = 40;
/// The latest messages whose flags (read, answered) are read again.
const FLAGS_WINDOW = 1_000;

export interface SyncProgress {
  running: boolean;
  started_at: number | null;
  finished_at: number | null;
  /// The folder being read.
  folder: FolderRole | null;
  /// Messages read so far, out of how many to read.
  fetched: number;
  to_fetch: number;
  /// New messages kept by the last sync.
  imported: number;
  error: MailErrorCode | null;
}

export type SyncOutcome = { ok: true; imported: number } | { ok: false; error: MailErrorCode };

const progress = new Map<string, SyncProgress>();
const running = new Map<string, Promise<SyncOutcome>>();

const idle = (): SyncProgress => ({ running: false, started_at: null, finished_at: null, folder: null, fetched: 0, to_fetch: 0, imported: 0, error: null });

export function syncProgress(sourceId: string): SyncProgress {
  return { ...(progress.get(sourceId) ?? idle()) };
}

/// Reads what is new in the person's mailbox. One sync at a time per
/// mailbox: asked again while one runs, the same one is answered.
export function syncMailbox(userId: string): Promise<SyncOutcome> {
  const source = activeSource(userId);
  if (!source) return Promise.resolve({ ok: false, error: "not_configured" });
  const current = running.get(source.id);
  if (current) return current;
  const job = runSync(userId, source).finally(() => running.delete(source.id));
  running.set(source.id, job);
  return job;
}

/// Whether a sync of this mailbox is under way.
export function syncRunning(sourceId: string): boolean {
  return running.has(sourceId);
}

/// Still to be read: E-mails on, and this mailbox still the one set up.
function stillWanted(userId: string, sourceId: string): boolean {
  return capabilityOn(userId, "email") && activeSource(userId)?.id === sourceId;
}

async function runSync(userId: string, source: EmailSource): Promise<SyncOutcome> {
  const state: SyncProgress = { ...idle(), running: true, started_at: Date.now() };
  progress.set(source.id, state);
  let session: MailSession | null = null;
  try {
    const password = mailPassword(source.id);
    if (!password) throw new MailError("password_missing");
    session = await openMailSession(
      { host: source.imap_host, port: source.imap_port, security: source.imap_security, username: source.username, password },
      { configured: { host: source.imap_host, port: source.imap_port }, emailOn: stillWanted(userId, source.id) },
    );
    const picked = pickFolders(await session.listFolders());
    if (!picked.inbox) throw new MailError("no_inbox");
    const folders: Partial<Record<FolderRole, EmailFolder>> = {};
    for (const role of ["inbox", "sent", "drafts"] as const) {
      const listed = picked[role];
      if (listed) folders[role] = upsertFolder(source.id, { path: listed.path, name: listed.name, special_use: listed.specialUse, role });
    }
    for (const role of ["inbox", "sent"] as const) {
      const folder = folders[role];
      if (!folder || !stillWanted(userId, source.id)) continue;
      state.folder = role;
      state.imported += await syncFolder(session, userId, source, folder, state);
    }
    const now = Date.now();
    noteSync(source.id, { status: "active", last_error: null, last_synced_at: now, ...(state.imported ? { last_imported_at: now } : {}) });
    return { ok: true, imported: state.imported };
  } catch (err) {
    const code = mailErrorCode(err);
    state.error = code;
    // E-mails switched off is no failure of the mailbox.
    if (code !== "email_off") noteSync(source.id, { status: "error", last_error: code, last_synced_at: Date.now() });
    return { ok: false, error: code };
  } finally {
    state.running = false;
    state.folder = null;
    state.finished_at = Date.now();
    await session?.close().catch(() => undefined);
  }
}

/// One folder: renumbered by the server → its UIDs are dropped (the
/// messages stay); then what is new since the last UID read, and what the
/// window holds that is not here yet; then the flags of the latest ones.
async function syncFolder(session: MailSession, userId: string, source: EmailSource, folder: EmailFolder, state: SyncProgress): Promise<number> {
  const opened = await session.openFolder(folder.path);
  // RFC 3501 has every server say it; one that does not is taken as never
  // renumbering (0).
  if (!Number.isFinite(opened.uidValidity)) opened.uidValidity = 0;
  let current = folder;
  if (folder.uid_validity !== null && folder.uid_validity !== opened.uidValidity) {
    renumberedFolder(folder.id);
    current = { ...folder, uid_validity: null, last_uid: 0, synced_after: null };
  }
  const since = source.import_after ?? Date.now() - DEFAULT_WINDOW_DAYS * DAY_MS;
  const known = knownUids(folder.id);
  const wanted = new Set<number>();
  if (current.last_uid > 0) {
    for (const uid of await session.searchFrom(current.last_uid + 1)) if (uid > current.last_uid && !known.has(uid)) wanted.add(uid);
  }
  if (current.synced_after === null || since < current.synced_after) {
    for (const uid of await session.searchSince(new Date(since))) if (!known.has(uid)) wanted.add(uid);
  }
  // The newest first: the latest mail is here first.
  const uids = [...wanted].sort((a, b) => b - a);
  state.to_fetch += uids.length;
  let imported = 0;
  let complete = true;
  for (let start = 0; start < uids.length; start += BATCH) {
    if (!stillWanted(userId, source.id)) { complete = false; break; }
    for (const mail of await session.fetchMessages(uids.slice(start, start + BATCH))) {
      if (await keep(userId, source, current, opened.uidValidity, mail)) imported += 1;
      state.fetched += 1;
    }
  }
  // The flags of the latest ones (read elsewhere, answered, flagged).
  if (complete && stillWanted(userId, source.id)) {
    const recent = recentUids(folder.id, FLAGS_WINDOW).filter((uid) => !wanted.has(uid));
    for (const { uid, flags } of recent.length ? await session.fetchFlags(recent) : []) updateFlags(folder.id, uid, flagState(flags));
  }
  if (complete) {
    const highest = uids.reduce((max, uid) => Math.max(max, uid), Math.max(current.last_uid, opened.uidNext > 0 ? opened.uidNext - 1 : 0));
    saveFolderState(folder.id, { uid_validity: opened.uidValidity, last_uid: highest, synced_after: since, message_count: opened.exists, last_synced_at: Date.now() });
  }
  return imported;
}

/// One message read, kept.
async function keep(userId: string, source: EmailSource, folder: EmailFolder, uidValidity: number, mail: FetchedMail): Promise<boolean> {
  const role = folder.role === "sent" ? "sent" : "inbox";
  const parsed: ParsedEmail | null = mail.source
    ? await parseEmail(mail.source, { cut: textMayBeCut(mail.size, mail.source.length, mail.structure) }).catch(() => null)
    : null;
  const envelope = mail.envelope;
  const from: MailAddress | null = parsed?.from ?? envelopeAddresses(envelope?.from)[0] ?? null;
  const to = parsed?.to.length ? parsed.to : envelopeAddresses(envelope?.to);
  const cc = parsed?.cc.length ? parsed.cc : envelopeAddresses(envelope?.cc);
  const replyTo = parsed?.replyTo.length ? parsed.replyTo : envelopeAddresses(envelope?.replyTo);
  const messageId = parsed?.messageId ?? (typeof envelope?.messageId === "string" ? envelope.messageId : null);
  const references = parsed?.references ?? [];
  const inReplyTo = parsed?.inReplyTo ?? (typeof envelope?.inReplyTo === "string" ? envelope.inReplyTo : null);
  const flags = flagState(mail.flags);
  const email: NewEmail = {
    user_id: userId,
    email_source_id: source.id,
    email_folder_id: folder.id,
    uid: mail.uid,
    uid_validity: uidValidity,
    provider_message_id: messageId,
    provider_thread_id: threadIdOf({ serverThreadId: mail.threadId, references, inReplyTo, messageId }),
    direction: role === "sent" ? "outbound" : "inbound",
    status: role,
    subject: parsed?.subject ?? (envelope?.subject?.trim() || null),
    from_name: from?.name ?? null,
    from_email: from?.address ?? null,
    to_name: to[0]?.name ?? null,
    to_email: to[0]?.address ?? null,
    recipients: { to, cc, reply_to: replyTo },
    text_body: parsed?.text || null,
    body_format: parsed?.format ?? "text",
    body_truncated: parsed?.truncated ?? false,
    is_read: flags.is_read,
    is_replied: flags.is_replied,
    important: flags.important,
    provider_internal_date: mail.internalDate ?? parsed?.sentAt ?? validDate(envelope?.date) ?? null,
    sent_at: parsed?.sentAt ?? validDate(envelope?.date),
    size: mail.size,
    attachments: attachmentsOf(mail.structure),
    labels: mail.labels.slice(0, 50),
    metadata: { in_reply_to: inReplyTo, references },
    trashed_at: flags.deleted ? Date.now() : null,
  };
  return saveEmail(email);
}

// ── Every 10 minutes ───────────────────────────────────────────────────

/// Whether a mailbox is due: never read, or read more than an interval ago
/// — except after its password was refused (asking again and again could
/// get the account locked: the person gives it again, or asks).
export function syncDue(source: EmailSource, now = Date.now(), intervalMs = SYNC_INTERVAL_MS): boolean {
  if (source.status === "removed") return false;
  if (source.last_error === "auth_failed" || source.last_error === "password_missing") return false;
  return source.last_synced_at === null || now - source.last_synced_at >= intervalMs;
}

/// Checks every minute which mailboxes are due (E-mails on), and reads
/// them; started with the server (index.ts), never in the tests.
export function startEmailSync(options: { checkEveryMs?: number; intervalMs?: number } = {}) {
  let stopped = false;
  const check = async () => {
    for (const userId of usersWithMailboxes()) {
      if (stopped) return;
      const source = activeSource(userId);
      if (!source || !capabilityOn(userId, "email") || !syncDue(source, Date.now(), options.intervalMs)) continue;
      await syncMailbox(userId).catch(() => undefined);
    }
  };
  const timer = setInterval(() => void check(), options.checkEveryMs ?? 60_000);
  timer.unref?.();
  const first = setTimeout(() => void check(), 20_000);
  first.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      clearTimeout(first);
    },
  };
}
