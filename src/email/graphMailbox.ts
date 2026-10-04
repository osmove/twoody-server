import { graphErrorCode, graphHeldUntil, GraphError, GraphSession, type GraphErrorCode } from "../microsoft/graph.js";
import { graphLink, graphRefreshToken, graphScope, linkGrants, type GraphLink } from "../microsoft/link.js";
import { attachmentsOf, createDraft, deltaPage, deltaStart, graphMessage, MAIL_FOLDERS, mailFolder, type GraphMailFolder, type GraphMessage } from "../microsoft/mail.js";
import { automatedSender, threadIdOf } from "./parse.js";
import {
  folderFor, graphCounterpart, graphFolder, graphFolderState, graphIdsIn, noteGraphFolder, saveGraphChanges, saveGraphFolderState,
  type EmailFolder, type EmailSource, type GraphChange, type GraphReadRole, type SourceSettings,
} from "./store.js";
import type { SyncProgress } from "./sync.js";

// An Outlook.com or Microsoft 365 mailbox read through Microsoft Graph
// (Capacités → E-mails, 04/10/2026), with the one link to the person's
// Microsoft account that Agenda and Contacts use too (src/microsoft/link.ts,
// permission Mail.ReadWrite) — not over IMAP. Jimmy's own try of 0.13.76:
// Microsoft signed him in, then IMAP refused him; Outlook.com wants IMAP
// switched on by hand, many organisations switch it off, and an account
// whose mail is elsewhere has no Outlook mailbox at all — which Graph says
// plainly (`no_mailbox`).
//
// The person sees and the chat reads the same as over IMAP: Inbox and Sent
// Items copied into the same tables (store.ts), the window they chose, then
// every 10 minutes what changed (src/microsoft/mail.ts: Graph's delta, its
// link kept for the next round), the text, the attachments' names; nothing
// marked read, moved or deleted there; a draft written in Drafts once the
// person allowed it, never sent. A message removed from the folder at
// Microsoft is hidden here as a message flagged deleted is, never purged.

const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_DAYS = 90;
/// Pages of one round, at most: a guard against a round that never ends.
const MAX_PAGES = 2_500;

/// What goes wrong with a mailbox read through Graph: Graph's and its
/// sign-in's codes (graph.ts), the link without the mailbox's permission,
/// or E-mails turned off meanwhile (no failure of the mailbox).
export type GraphMailErrorCode = Exclude<GraphErrorCode, "capability_off"> | "scope_missing" | "email_off";

export class GraphMailError extends Error {
  constructor(public code: GraphMailErrorCode) {
    super(code);
    this.name = "GraphMailError";
  }
}

export function graphMailErrorCode(err: unknown): GraphMailErrorCode {
  if (err instanceof GraphMailError) return err.code;
  const code = graphErrorCode(err);
  return code === "capability_off" ? "email_off" : code;
}

/// The grant the Desktop's main process just got from Microsoft's sign-in,
/// for a mailbox set up now; null: the link kept serves.
export interface GraphGrant {
  refreshToken: string;
  scopes: string[];
}

/// The link a mailbox at this address is read with: kept, for this account,
/// holding the mailbox's permission — or why it cannot be.
export function mailboxLink(userId: string, address: string): { ok: true; link: GraphLink; refreshToken: string } | { ok: false; error: "signin_required" | "scope_missing" } {
  const link = graphLink(userId);
  const refreshToken = link ? graphRefreshToken(userId, link.id) : null;
  if (!link || !refreshToken || link.address.toLowerCase() !== address.toLowerCase()) return { ok: false, error: "signin_required" };
  if (!linkGrants(link, "email")) return { ok: false, error: "scope_missing" };
  return { ok: true, link, refreshToken };
}

/// A session on Graph for this mailbox: with the grant just given (the link
/// is being made, not kept yet), or with the link kept.
function sessionFor(userId: string, address: string, grant: GraphGrant | null): GraphSession {
  if (grant) return new GraphSession(userId, "", grant.refreshToken, graphScope(grant.scopes), true);
  const kept = mailboxLink(userId, address);
  if (!kept.ok) throw new GraphMailError(kept.error);
  return new GraphSession(userId, kept.link.id, kept.refreshToken, graphScope(kept.link.scopes));
}

/// Sent Items and Drafts are only wanted: a mailbox without them (Graph
/// finds no such folder) is read all the same, as over IMAP.
async function optionalFolder(session: GraphSession, role: "sent" | "drafts"): Promise<GraphMailFolder | null> {
  try {
    return await mailFolder(session, role);
  } catch (err) {
    if (err instanceof GraphError && (err.code === "no_mailbox" || err.code === "gone")) return null;
    throw err;
  }
}

export interface GraphTested {
  folders: { inbox: GraphMailFolder; sent: GraphMailFolder | null; drafts: GraphMailFolder | null };
  /// The newest refresh token of a grant being linked, to keep.
  refreshToken: string | null;
}

/// Graph tried once for this mailbox — the person asked: its folders found,
/// nothing read. An account without an Outlook mailbox is `no_mailbox`.
export async function testGraphMailbox(userId: string, settings: SourceSettings, grant: GraphGrant | null): Promise<{ ok: true; tested: GraphTested } | { ok: false; error: GraphMailErrorCode }> {
  try {
    const session = sessionFor(userId, settings.email_address, grant);
    const inbox = await mailFolder(session, "inbox");
    const sent = await optionalFolder(session, "sent");
    const drafts = await optionalFolder(session, "drafts");
    return { ok: true, tested: { folders: { inbox, sent, drafts }, refreshToken: grant ? session.newestRefreshToken : null } };
  } catch (err) {
    return { ok: false, error: graphMailErrorCode(err) };
  }
}

/// The folders found kept for the mailbox, with the names the person sees.
export function keepGraphFolders(sourceId: string, folders: GraphTested["folders"]): void {
  for (const role of ["inbox", "sent", "drafts"] as const) {
    const found = folders[role];
    if (found) graphFolder(sourceId, role, MAIL_FOLDERS[role], found.name);
  }
}

// ── The copy ─────────────────────────────────────────────────────────────

/// Reads what changed in Inbox and Sent Items since the last round, into
/// the copy. `wanted`: E-mails still on and this mailbox still the one set
/// up — asked again before each page is kept.
export async function syncGraphMailbox(userId: string, source: EmailSource, state: SyncProgress, wanted: () => boolean): Promise<void> {
  // E-mails off: not even a token asked.
  if (!wanted()) throw new GraphMailError("email_off");
  // Graph asked to wait past a round: nothing asked before then.
  if (graphHeldUntil(userId) !== null) throw new GraphMailError("throttled");
  const kept = mailboxLink(userId, source.email_address);
  if (!kept.ok) throw new GraphMailError(kept.error);
  const session = new GraphSession(userId, kept.link.id, kept.refreshToken, graphScope(kept.link.scopes));
  // The link changed meanwhile: what this round read is not kept.
  const stillWanted = () => wanted() && graphRefreshToken(userId, kept.link.id) !== null;
  const remote: Record<GraphReadRole, GraphMailFolder | null> = { inbox: await mailFolder(session, "inbox"), sent: await optionalFolder(session, "sent") };
  for (const role of ["inbox", "sent"] as const) {
    const found = remote[role];
    if (!found || !stillWanted()) continue;
    state.folder = role;
    const folder = graphFolder(source.id, role, MAIL_FOLDERS[role], found.name);
    state.imported += await syncGraphFolder(session, userId, source, role, folder, found, state, stillWanted);
  }
}

/// One folder: the round under way carried on, or the next one from where
/// the last ended — a new round from the start of the window when there is
/// none, when the window now starts earlier than the round's, or when Graph
/// can no longer carry on the one kept. Each page kept as it comes, and
/// where the round stands with it.
async function syncGraphFolder(
  session: GraphSession, userId: string, source: EmailSource, role: GraphReadRole, folder: EmailFolder, remote: GraphMailFolder, state: SyncProgress, wanted: () => boolean,
): Promise<number> {
  const since = source.import_after ?? Date.now() - DEFAULT_WINDOW_DAYS * DAY_MS;
  const kept = graphFolderState(source.id, role);
  const resumable = kept && kept.since <= since ? kept.next_link ?? kept.delta_link : null;
  let url = resumable ?? deltaStart(remote.id, since);
  let round = resumable ? kept!.since : since;
  let fresh = !resumable;
  const known = graphIdsIn(folder.id);
  // A link given twice in a round: a round that would never end.
  const seen = new Set<string>();
  let imported = 0;
  for (;;) {
    if (seen.size >= MAX_PAGES || seen.has(url)) throw new GraphError("graph_failed");
    seen.add(url);
    if (!wanted()) return imported;
    let page;
    try {
      page = await deltaPage(session, url);
    } catch (err) {
      // A round Graph can no longer carry on (its state forgotten, the
      // folder renamed under another id): started again, once.
      const stale = err instanceof GraphError && (err.code === "sync_reset" || err.code === "gone" || (err.code === "graph_failed" && err.status === 400));
      if (fresh || !stale) throw err;
      fresh = true;
      url = deltaStart(remote.id, since);
      round = since;
      continue;
    }
    const changes: GraphChange[] = [];
    for (const raw of page.changes) {
      const message = graphMessage(raw);
      if (!message) continue;
      changes.push(await changeOf(session, userId, source, folder, role, message, known));
    }
    // Kept only if still wanted, asked in the same turn as it is written.
    if (!wanted()) return imported;
    imported += saveGraphChanges(folder.id, changes, known);
    state.fetched += page.changes.length;
    if (page.next) {
      saveGraphFolderState(source.id, role, { since: round, next_link: page.next, delta_link: null });
      url = page.next;
      continue;
    }
    saveGraphFolderState(source.id, role, { since: round, next_link: null, delta_link: page.delta });
    noteGraphFolder(folder.id, { synced_after: round, message_count: remote.total, last_synced_at: Date.now() });
    return imported;
  }
}

/// A change as the copy keeps it. A message new here is asked the names of
/// its attachments (never their content) — not one kept already, from IMAP
/// before the mailbox moved to Graph: it has them.
async function changeOf(session: GraphSession, userId: string, source: EmailSource, folder: EmailFolder, role: GraphReadRole, message: GraphMessage, known: Map<string, string>): Promise<GraphChange> {
  const base = { graphId: message.id, removed: message.removed, isRead: message.isRead, flagged: message.flagged };
  if (message.removed) return { ...base, email: null };
  if (known.has(message.id)) return { ...base, email: null };
  let attachments: Awaited<ReturnType<typeof attachmentsOf>> = [];
  if (message.hasAttachments && !graphCounterpart(folder.id, message.messageId)) {
    try {
      attachments = await attachmentsOf(session, message.id);
    } catch (err) {
      // Removed since the page was given: kept without their names.
      if (!(err instanceof GraphError && err.code === "gone")) throw err;
    }
  }
  const to = message.to;
  return {
    ...base,
    email: {
      user_id: userId,
      email_source_id: source.id,
      email_folder_id: folder.id,
      uid: null,
      uid_validity: null,
      provider_message_id: message.messageId,
      // Outlook's own conversation, as a server's thread is over IMAP.
      provider_thread_id: threadIdOf({ serverThreadId: message.conversationId, messageId: message.messageId }),
      direction: role === "sent" ? "outbound" : "inbound",
      status: role,
      subject: message.subject,
      from_name: message.from?.name ?? null,
      from_email: message.from?.address ?? null,
      to_name: to[0]?.name ?? null,
      to_email: to[0]?.address ?? null,
      recipients: { to, cc: message.cc, reply_to: message.replyTo },
      text_body: message.text || null,
      body_format: message.format,
      body_truncated: message.truncated,
      is_read: message.isRead ?? false,
      // Graph does not say it (Outlook keeps it apart): « en attente de
      // réponse » looks for the person's answer in the conversation.
      is_replied: false,
      important: message.flagged ?? false,
      provider_internal_date: message.receivedAt ?? message.sentAt,
      sent_at: message.sentAt,
      // Graph does not give a message's size.
      size: null,
      attachments,
      labels: [],
      metadata: { in_reply_to: null, references: [], graph_id: message.id, ...(automatedSender(message.from?.address) ? { automated: true } : {}) },
      trashed_at: null,
    },
  };
}

// ── The draft ────────────────────────────────────────────────────────────

/// A draft the person allowed, created in the mailbox's Drafts from its
/// MIME text (the same as over IMAP): never sent.
export async function saveGraphDraft(userId: string, source: EmailSource, mime: Buffer): Promise<{ ok: true; folder: string; uid: null } | { ok: false; error: GraphMailErrorCode }> {
  try {
    if (graphHeldUntil(userId) !== null) throw new GraphMailError("throttled");
    const session = sessionFor(userId, source.email_address, null);
    await createDraft(session, mime);
    const drafts = folderFor(source.id, "drafts");
    return { ok: true, folder: drafts?.name ?? drafts?.path ?? "Drafts", uid: null };
  } catch (err) {
    return { ok: false, error: graphMailErrorCode(err) };
  }
}
