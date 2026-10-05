import { capabilityOn } from "../localCapabilities.js";
import { graphHeldUntil } from "../microsoft/graph.js";
import { openSourceMailbox } from "./credentials.js";
import { gmailErrorCode, syncGmailMailbox, type GmailErrorCode } from "./gmailMailbox.js";
import { graphMailErrorCode, syncGraphMailbox, type GraphMailErrorCode } from "./graphMailbox.js";
import { MailError, mailErrorCode, type FetchedMail, type MailErrorCode, type MailSession } from "./imap.js";
import {
  attachmentsOf, automatedSender, envelopeAddresses, flagState, parseEmail, pickFolders, textMayBeCut, threadIdOf, validDate,
  type FolderRole, type MailAddress, type ParsedEmail,
} from "./parse.js";
import {
  activeSources, knownUids, noteSync, noteSyncPause, sourceById, recentUids, renumberedFolder, saveEmail, saveFolderState, syncPauseOf, updateFlags, upsertFolder, usersWithMailboxes,
  type EmailFolder, type EmailSource, type NewEmail, type SyncPause,
} from "./store.js";

// Keeps the copy of each of the person's mailboxes up to date, each on its
// own (one stopped, or waiting for the person, holds no other back): INBOX and Sent, the
// last 90 days at first (the window the person chose), then what is new,
// by UID — every 10 minutes while E-mails is on, and when the person asks.
// Read-only on the server: folders opened with EXAMINE, messages read with
// BODY.PEEK; nothing is marked, moved or deleted there. A mailbox read
// through Microsoft Graph is kept up to date the same way, with Graph's
// changes instead of UIDs (graphMailbox.ts); one read through the Gmail API
// with Gmail's history (gmailMailbox.ts).

export const SYNC_INTERVAL_MS = 10 * 60_000;
/// After a round the mailbox's service cut short (it limits the pace), the
/// next one comes sooner.
export const PAUSED_INTERVAL_MS = 3 * 60_000;
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
  error: MailboxErrorCode | null;
  /// The round stopped before its end without failing: the service limits
  /// the pace, the next round carries on.
  paused: SyncPause | null;
}

/// What goes wrong with a mailbox: over IMAP, through Graph, or through the
/// Gmail API.
export type MailboxErrorCode = MailErrorCode | GraphMailErrorCode | GmailErrorCode;

export type SyncOutcome = { ok: true; imported: number; paused?: SyncPause } | { ok: false; error: MailboxErrorCode };

const progress = new Map<string, SyncProgress>();
const running = new Map<string, Promise<SyncOutcome>>();

const idle = (): SyncProgress => ({ running: false, started_at: null, finished_at: null, folder: null, fetched: 0, to_fetch: 0, imported: 0, error: null, paused: null });

export function syncProgress(sourceId: string): SyncProgress {
  return { ...(progress.get(sourceId) ?? idle()) };
}

/// Reads what is new in one of the person's mailboxes — or, without one
/// named, in each of them, one after the other. One sync at a time per
/// mailbox: asked again while one runs, the same one is answered. Several
/// mailboxes answer together: the first failure, else what all kept.
export async function syncMailbox(userId: string, sourceId: string | null = null): Promise<SyncOutcome> {
  if (sourceId) {
    const source = sourceById(userId, sourceId);
    return source && source.status !== "removed" ? syncSource(userId, source) : { ok: false, error: "not_configured" };
  }
  const sources = activeSources(userId);
  if (!sources.length) return { ok: false, error: "not_configured" };
  const outcomes: SyncOutcome[] = [];
  for (const source of sources) outcomes.push(await syncSource(userId, source));
  const failed = outcomes.find((outcome) => !outcome.ok);
  if (failed) return failed;
  const imported = outcomes.reduce((sum, outcome) => sum + (outcome.ok ? outcome.imported : 0), 0);
  const paused = outcomes.find((outcome) => outcome.ok && outcome.paused);
  return { ok: true, imported, ...(paused?.ok && paused.paused ? { paused: paused.paused } : {}) };
}

function syncSource(userId: string, source: EmailSource): Promise<SyncOutcome> {
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

/// Still to be read: E-mails on, and this mailbox still set up.
function stillWanted(userId: string, sourceId: string): boolean {
  if (!capabilityOn(userId, "email")) return false;
  const source = sourceById(userId, sourceId);
  return !!source && source.status !== "removed";
}

/// No failure of the mailbox: E-mails turned off, or the link to Microsoft
/// Graph changed, while it was read.
const STOPPED = new Set<string>(["email_off", "not_linked"]);

async function runSync(userId: string, source: EmailSource): Promise<SyncOutcome> {
  const state: SyncProgress = { ...idle(), running: true, started_at: Date.now() };
  progress.set(source.id, state);
  let session: MailSession | null = null;
  try {
    if (source.auth === "graph") {
      await syncGraphMailbox(userId, source, state, () => stillWanted(userId, source.id));
      return roundDone(source, state);
    }
    if (source.auth === "gmail") {
      // Gmail limiting the pace past the round's patience: no failure, the
      // next round (sooner) carries on where this one stopped.
      const round = await syncGmailMailbox(userId, source, state, () => stillWanted(userId, source.id));
      state.paused = round.paused;
      return roundDone(source, state);
    }
    session = await openSourceMailbox(source, stillWanted(userId, source.id));
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
    return roundDone(source, state);
  } catch (err) {
    const code: MailboxErrorCode = source.auth === "graph" ? graphMailErrorCode(err) : source.auth === "gmail" ? gmailErrorCode(err) : mailErrorCode(err);
    state.error = code;
    if (!STOPPED.has(code)) noteSync(source.id, { status: "error", last_error: code, last_synced_at: Date.now() });
    return { ok: false, error: code };
  } finally {
    state.running = false;
    state.folder = null;
    state.finished_at = Date.now();
    await session?.close().catch(() => undefined);
  }
}

/// A round that did not fail, noted: cut short (`paused`) or to its end.
function roundDone(source: EmailSource, state: SyncProgress): SyncOutcome {
  const now = Date.now();
  noteSync(source.id, { status: "active", last_error: null, last_synced_at: now, ...(state.imported ? { last_imported_at: now } : {}) });
  noteSyncPause(source.id, state.paused);
  return { ok: true, imported: state.imported, ...(state.paused ? { paused: state.paused } : {}) };
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
    metadata: { in_reply_to: inReplyTo, references, ...(parsed?.automated || automatedSender(from?.address) ? { automated: true } : {}) },
    trashed_at: flags.deleted ? Date.now() : null,
  };
  return saveEmail(email);
}

// ── Every 10 minutes ───────────────────────────────────────────────────

/// What only the person can mend: a password refused or missing, or one the
/// server wants of another kind (an app password), IMAP turned off, a
/// sign-in to finish in the provider's web page; a Microsoft or Google
/// sign-in to do again or an approval it waits for, IMAP access refused to
/// Twoody; through Graph or the Gmail API, the mailbox refused to Twoody, the
/// sign-in without the mailbox's permission or another account's, an account
/// without a mailbox there. Not too many connections: they close by
/// themselves, the next round tries again.
const PERSON_ERRORS = new Set([
  "auth_failed", "password_missing", "app_password_required", "imap_disabled", "web_login_required",
  "signin_required", "admin_consent_required", "imap_refused", "graph_refused", "gmail_refused", "scope_missing", "no_mailbox", "other_account",
]);

export function needsThePerson(error: string | null | undefined): boolean {
  return !!error && PERSON_ERRORS.has(error);
}

/// Whether a mailbox is due: never read, or read more than an interval ago
/// — except after its password or sign-in was refused (asking again and
/// again could get the account locked: the person gives it again, or asks).
export function syncDue(source: EmailSource, now = Date.now(), intervalMs = SYNC_INTERVAL_MS): boolean {
  if (source.status === "removed") return false;
  if (needsThePerson(source.last_error)) return false;
  return source.last_synced_at === null || now - source.last_synced_at >= Math.min(intervalMs, nextRoundAfter(source));
}

/// How long after a round the next one comes: sooner after one cut short.
export function nextRoundAfter(source: EmailSource): number {
  return syncPauseOf(source) ? PAUSED_INTERVAL_MS : SYNC_INTERVAL_MS;
}

/// Checks every minute which mailboxes are due (E-mails on), and reads
/// them; started with the server (index.ts), never in the tests.
export function startEmailSync(options: { checkEveryMs?: number; intervalMs?: number } = {}) {
  let stopped = false;
  const check = async () => {
    for (const userId of usersWithMailboxes()) {
      for (const source of activeSources(userId)) {
        if (stopped) return;
        if (!capabilityOn(userId, "email") || !syncDue(source, Date.now(), options.intervalMs)) continue;
        // Microsoft Graph asked to wait past a round (graph.ts): not before then.
        if (source.auth === "graph" && graphHeldUntil(userId) !== null) continue;
        await syncMailbox(userId, source.id).catch(() => undefined);
      }
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
