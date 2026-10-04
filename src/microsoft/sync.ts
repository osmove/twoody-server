import { cleanAddress } from "../email/parse.js";
import { capabilityOn } from "../localCapabilities.js";
import type { GraphCapability } from "../outbound.js";
import { copySize, InvalidCopy, readContacts, readEvents, replaceContacts, replaceEvents } from "../personalSync.js";
import { graphErrorCode, graphHeldUntil, GraphSession, readOutlookContacts, readOutlookEvents, type GraphErrorCode } from "./graph.js";
import {
  forgetGraphLink, GRAPH_CAPABILITIES, graphLink, graphPermissions, graphRefreshToken, graphScope, keepGraphLink, linkGrants, noteGraphSync, resetGraphSync, usersWithGraphLinks,
  type GraphLink,
} from "./link.js";

// Outlook's or Microsoft 365's calendar and contacts, copied into the same
// tables as the Mac's (src/personalSync.ts, source « microsoft »), with the
// link to the person's Microsoft account (link.ts) — made from the Agenda or
// the Contacts page of this computer's app after Microsoft's sign-in, in the
// app's main process, and shared by every capability that reads Graph. Read
// every 15 minutes while Agenda or Contacts is on — each copy only while its
// own capability is — and when the person asks; each copy replaces the
// last, never the Mac's rows nor the person's. A capability turned off
// removes its copy, as the Mac's switch does; unlinking forgets the sign-in
// and removes both. Nothing is written at Microsoft.

export const GRAPH_SYNC_INTERVAL_MS = 15 * 60_000;

/// The copies made here: Agenda's and Contacts'.
export type CopyKind = Extract<GraphCapability, "calendar" | "contacts">;
export const COPY_KINDS: readonly CopyKind[] = ["calendar", "contacts"];
const REFRESH_TOKEN_MAX_CHARS = 16_384;

/// What only the person can mend: a sign-in to do again or an approval it
/// waits for, Graph refusing this account's calendar or contacts, an
/// account without a mailbox for them. Asked again and again, nothing would
/// change: the copy waits until they sign in again or ask.
const PERSON_ERRORS = new Set<string>(["signin_required", "admin_consent_required", "graph_refused", "no_mailbox"]);
/// The sign-in itself refused: the same for both copies.
const SIGNIN_ERRORS = new Set<string>(["signin_required", "admin_consent_required", "signin_failed", "signin_unreachable"]);
/// No failure: the capability turned off, or the link removed, meanwhile.
const STOPPED = new Set<string>(["capability_off", "not_linked"]);

export function needsThePerson(error: string | null | undefined): boolean {
  return !!error && PERSON_ERRORS.has(error);
}

export type GraphSyncOutcome = { ok: true; rows: Partial<Record<CopyKind, number>> } | { ok: false; error: GraphErrorCode | "not_linked" };

/// The sync under way, by link, and the copies it reads.
const running = new Map<string, { job: Promise<GraphSyncOutcome>; kinds: readonly CopyKind[] }>();

export function graphSyncRunning(linkId: string): boolean {
  return running.has(linkId);
}

/// Wanted still: the capability on, and this link the one kept — asked in
/// the same turn as the copy is written.
function wanted(userId: string, linkId: string, kind: CopyKind): boolean {
  return capabilityOn(userId, kind) && graphRefreshToken(userId, linkId) !== null;
}

/// Reads Outlook's calendar and contacts — those of `kinds` that are on and
/// that the link grants — and keeps them. One sync at a time per link:
/// asked again while one runs, the same one is answered — or, for a copy
/// it does not read (a capability just turned on), another right after it.
export function syncMicrosoftGraph(userId: string, options: { kinds?: readonly CopyKind[] } = {}): Promise<GraphSyncOutcome> {
  const link = graphLink(userId);
  if (!link) return Promise.resolve({ ok: false, error: "not_linked" });
  const kinds = options.kinds ?? COPY_KINDS;
  const current = running.get(link.id);
  if (current) {
    const missing = kinds.filter((kind) => !current.kinds.includes(kind));
    return missing.length ? current.job.then(() => syncMicrosoftGraph(userId, { kinds: missing })) : current.job;
  }
  const job = runSync(userId, link, kinds).finally(() => running.delete(link.id));
  running.set(link.id, { job, kinds });
  return job;
}

async function runSync(userId: string, link: GraphLink, kinds: readonly CopyKind[]): Promise<GraphSyncOutcome> {
  const refreshToken = graphRefreshToken(userId, link.id);
  if (!refreshToken) return { ok: false, error: "not_linked" };
  const session = new GraphSession(userId, link.id, refreshToken, graphScope(link.scopes));
  const rows: Partial<Record<CopyKind, number>> = {};
  let failure: GraphErrorCode | null = null;
  for (const kind of kinds) {
    if (!capabilityOn(userId, kind) || !linkGrants(link, kind)) continue;
    const now = Date.now();
    // Graph asked to wait past a round, or the sign-in was just refused.
    const held = graphHeldUntil(userId, now);
    if (held !== null || (failure && SIGNIN_ERRORS.has(failure))) {
      const error: GraphErrorCode = held !== null ? "throttled" : failure!;
      noteGraphSync(userId, link.id, kind, { last_attempt_at: now, last_error: error });
      failure ??= error;
      continue;
    }
    try {
      // Kept only if still wanted, asked in the same turn as it is written:
      // a capability turned off, or the link removed, while Graph was read
      // leaves nothing behind.
      if (kind === "calendar") {
        const read = readEvents(await readOutlookEvents(session));
        if (!wanted(userId, link.id, kind)) continue;
        rows.calendar = replaceEvents(userId, "microsoft", read);
      } else {
        const read = readContacts(await readOutlookContacts(session));
        if (!wanted(userId, link.id, kind)) continue;
        rows.contacts = replaceContacts(userId, "microsoft", read);
      }
      noteGraphSync(userId, link.id, kind, { last_synced_at: Date.now(), last_attempt_at: now, last_error: null });
    } catch (err) {
      const code = err instanceof InvalidCopy && err.message === "too_many" ? "too_many" : graphErrorCode(err);
      if (STOPPED.has(code)) continue;
      // The copy kept stays as it was.
      noteGraphSync(userId, link.id, kind, { last_attempt_at: now, last_error: code });
      failure ??= code;
    }
  }
  return failure ? { ok: false, error: failure } : { ok: true, rows };
}

/// A copy of Outlook's, removed.
function removeCopy(userId: string, kind: CopyKind): void {
  if (kind === "calendar") replaceEvents(userId, "microsoft", []);
  else replaceContacts(userId, "microsoft", []);
}

/// Agenda or Contacts switched (routes/localCapabilities.ts): off, its copy
/// of Outlook's goes, as the Mac's switch removes the Mac's; back on, it is
/// read at once.
export function graphCapabilityChanged(userId: string, kind: CopyKind, enabled: boolean): void {
  if (!enabled) {
    removeCopy(userId, kind);
    resetGraphSync(userId, kind);
    return;
  }
  if (graphLink(userId)) void syncMicrosoftGraph(userId, { kinds: [kind] }).catch(() => undefined);
}

export type LinkError = GraphErrorCode | "address_required" | "invalid_address" | "scope_missing";

/// The link the app's main process hands over after Microsoft's sign-in:
/// the account's address, the refresh token, the permissions Microsoft
/// granted (those of every capability that asked: the union). Tried once —
/// at the person's request, through the door: an access token for these
/// permissions — then kept in place of the one before, and read at once.
/// Copies of another account, or of what the new link does not grant, are
/// removed.
export async function linkMicrosoftGraph(userId: string, body: unknown): Promise<{ ok: true; link: GraphLink } | { ok: false; error: LinkError }> {
  const given = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const typed = typeof given.address === "string" ? given.address.trim() : "";
  if (!typed) return { ok: false, error: "address_required" };
  const address = cleanAddress(typed);
  if (!address) return { ok: false, error: "invalid_address" };
  const refreshToken = typeof given.refresh_token === "string" ? given.refresh_token.trim() : "";
  if (!refreshToken || refreshToken.length > REFRESH_TOKEN_MAX_CHARS) return { ok: false, error: "signin_required" };
  const scopes = graphPermissions(given.scopes);
  if (scopes.length === 0) return { ok: false, error: "scope_missing" };
  if (!GRAPH_CAPABILITIES.some((capability) => capabilityOn(userId, capability))) return { ok: false, error: "capability_off" };
  const session = new GraphSession(userId, "", refreshToken, graphScope(scopes), true);
  try {
    await session.accessToken();
  } catch (err) {
    return { ok: false, error: graphErrorCode(err) };
  }
  const before = graphLink(userId);
  const link = keepGraphLink(userId, { address, scopes, refreshToken: session.newestRefreshToken });
  for (const kind of COPY_KINDS) {
    if ((before && before.address.toLowerCase() !== address.toLowerCase()) || !linkGrants(link, kind)) removeCopy(userId, kind);
  }
  void syncMicrosoftGraph(userId).catch(() => undefined);
  return { ok: true, link };
}

/// The link removed: its sign-in forgotten, both copies removed.
export function unlinkMicrosoftGraph(userId: string): boolean {
  const had = forgetGraphLink(userId);
  for (const kind of COPY_KINDS) removeCopy(userId, kind);
  return had;
}

/// What the Agenda and Contacts pages show: never a token.
export function microsoftGraphStatus(userId: string) {
  const link = graphLink(userId);
  const size = copySize(userId, "microsoft");
  const copy = (kind: CopyKind) => {
    const enabled = capabilityOn(userId, kind);
    const state = link?.sync[kind];
    const on = !!link && enabled && linkGrants(link, kind);
    return {
      enabled,
      granted: !!link && linkGrants(link, kind),
      count: kind === "calendar" ? size.events : size.contacts,
      last_synced_at: state?.last_synced_at ?? null,
      last_error: state?.last_error ?? null,
      next_at: on && state?.last_attempt_at && !needsThePerson(state.last_error) ? state.last_attempt_at + GRAPH_SYNC_INTERVAL_MS : null,
    };
  };
  return {
    linked: !!link,
    account: link ? { address: link.address, scopes: link.scopes, linked_at: link.linked_at } : null,
    running: !!link && graphSyncRunning(link.id),
    calendar: copy("calendar"),
    contacts: copy("contacts"),
  };
}

/// Whether a copy is due: granted, never tried or tried more than an
/// interval ago — not after a refusal only the person can mend.
export function graphSyncDue(link: GraphLink, kind: CopyKind, now = Date.now(), intervalMs = GRAPH_SYNC_INTERVAL_MS): boolean {
  if (!linkGrants(link, kind)) return false;
  const state = link.sync[kind];
  if (needsThePerson(state.last_error)) return false;
  return state.last_attempt_at === null || now - state.last_attempt_at >= intervalMs;
}

/// Checks every minute which copies are due (their capability on) and
/// reads them; started with the server (index.ts), never in the tests.
export function startMicrosoftGraphSync(options: { checkEveryMs?: number; intervalMs?: number } = {}) {
  let stopped = false;
  const check = async () => {
    for (const userId of usersWithGraphLinks()) {
      if (stopped) return;
      const link = graphLink(userId);
      if (!link || graphHeldUntil(userId) !== null) continue;
      const kinds = COPY_KINDS.filter((kind) => capabilityOn(userId, kind) && graphSyncDue(link, kind, Date.now(), options.intervalMs));
      if (kinds.length) await syncMicrosoftGraph(userId, { kinds }).catch(() => undefined);
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
