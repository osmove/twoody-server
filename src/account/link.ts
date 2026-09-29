import { hostname } from "node:os";
import { eq } from "drizzle-orm";
import { authSessions, db } from "../db.js";
import { unpairSession } from "../pairing.js";
import { backendCall, BackendError } from "./backend.js";
import {
  backendUrl,
  ensureAccountFile,
  linkedAccount,
  readAccountFile,
  removeAccountFile,
  writeAccountFile,
  type AccountFile,
  type Approver,
  type LinkedAccount,
} from "./store.js";

// Linking this server to a Twoody account without a screen or a keyboard:
// the device-code flow of RFC 8628 against the backend's /computer_logins
// (docs/multi-computer-design.md §2).
//
//   unlinked ──start()──▶ pending ──(approved on twoody.com/appareil,
//                           │        on the Mac or on the phone)──▶ linked
//                           └──(denied, expired)──▶ unlinked
//   linked ──logout()──▶ unlinked
//
// The server prints (or serves on /account/link) a short code; the person
// types it on a device already signed in. Once approved, the backend hands
// over, once, the account's session for this server, its computer
// credential and — when a device of the account approved — that device's
// public key, pinned here as an approver (account/approvals.ts).

export type LinkState = "unlinked" | "pending" | "linked";

export interface PendingLogin {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresAt: Date;
  intervalMs: number;
}

export interface LinkView {
  state: LinkState;
  /// Which account this server is linked to, masked (j***@gmail.com), or
  /// « account 7 » when the backend said no more.
  account?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string | null;
  expires_at?: string;
  account_computer_id?: string;
  /// Why the last attempt ended, when it ended without a link.
  last_error?: "denied" | "expired" | "unreachable" | null;
}

type Listener = (state: LinkState) => void;

let pending: PendingLogin | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let lastError: LinkView["last_error"] = null;
/// When the last code asked for runs out (denied or not), and when a code
/// was last asked for from the network: the network gets a new code only
/// once the last one would have expired, and asks at most every few
/// minutes, so that nobody on the LAN spends the backend's five codes per
/// quarter of an hour (per address) that the console may need.
let lastCodeExpiresAt = 0;
let lastNetworkAttemptAt = 0;
const NETWORK_ATTEMPT_GAP_MS = 3 * 60_000;

export class LinkThrottledError extends Error {
  constructor(readonly retryAt: Date) {
    super("a code was asked for a moment ago; the next one can be asked for later");
    this.name = "LinkThrottledError";
  }
}
const listeners = new Set<Listener>();

export function onLinkChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(): void {
  const state = linkState();
  for (const listener of listeners) {
    try {
      listener(state);
    } catch {
      // a listener's failure is its own
    }
  }
}

export function linkState(): LinkState {
  if (linkedAccount()) return "linked";
  if (pending && pending.expiresAt.getTime() > Date.now()) return "pending";
  return "unlinked";
}

export function linkView(): LinkView {
  const state = linkState();
  if (state === "linked") {
    const account = linkedAccount()!;
    return { state, account_computer_id: account.computer.id, account: account.account_label ?? (account.account_id !== undefined ? `account ${account.account_id}` : undefined) };
  }
  if (state === "pending") {
    return {
      state,
      user_code: pending!.userCode,
      verification_uri: pending!.verificationUri,
      verification_uri_complete: pending!.verificationUriComplete,
      expires_at: pending!.expiresAt.toISOString(),
    };
  }
  return { state, last_error: lastError };
}

/// The name this computer goes by in the account.
export function computerName(): string {
  const configured = process.env.TWOODY_COMPUTER_NAME?.trim();
  if (configured) return configured.slice(0, 100);
  const host = (process.env.HOSTNAME ?? hostname()).split(".")[0] || "Twoody Server";
  return host.slice(0, 100);
}

function platformName(): string {
  switch (process.platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return process.platform;
  }
}

/// Asks the backend for a code, unless one is live: at most one at a time,
/// and a live one is never replaced (the person may be typing it). From
/// the network (`fromNetwork`), a new code only once the last one would
/// have expired, and one attempt every three minutes at most
/// (LinkThrottledError).
export async function startLink(options: { name?: string; fromNetwork?: boolean } = {}): Promise<LinkView> {
  if (linkedAccount()) return linkView();
  if (linkState() === "pending") return linkView();
  if (options.fromNetwork) {
    const now = Date.now();
    const retryAt = Math.max(lastCodeExpiresAt, lastNetworkAttemptAt + NETWORK_ATTEMPT_GAP_MS);
    if (retryAt > now) throw new LinkThrottledError(new Date(retryAt));
    lastNetworkAttemptAt = now;
  }
  stopPolling();
  const file = ensureAccountFile();
  const creds = { backendUrl: backendUrl(file) };
  const { body } = await backendCall<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    expires_in: number;
    interval?: number;
  }>(creds, "computer_logins", {
    body: { name: options.name ?? computerName(), platform: platformName(), public_key: file.pairing_key.pub, device_token: file.device_token },
  });
  if (!body || typeof body.device_code !== "string" || typeof body.user_code !== "string") {
    throw new BackendError(502, "invalid_answer", "the backend's answer to computer_logins is not one");
  }
  pending = {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    verificationUriComplete: body.verification_uri_complete ?? null,
    expiresAt: new Date(Date.now() + Math.max(1, Number(body.expires_in) || 600) * 1000),
    intervalMs: Math.max(1, Number(body.interval) || 5) * 1000,
  };
  lastCodeExpiresAt = pending.expiresAt.getTime();
  lastError = null;
  schedulePoll();
  emit();
  return linkView();
}

function stopPolling(): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

/// The poll interval, as the backend asked; TWOODY_LINK_POLL_MS for tests.
function nextDelay(): number {
  const override = Number(process.env.TWOODY_LINK_POLL_MS);
  return Number.isFinite(override) && override > 0 ? override : pending?.intervalMs ?? 5_000;
}

function schedulePoll(delay = nextDelay()): void {
  stopPolling();
  pollTimer = setTimeout(() => void pollOnce(), delay);
  pollTimer.unref?.();
}

type AccountHint = { email?: unknown; name?: unknown } | null | undefined;

type PollAnswer = {
  state?: string;
  account_id?: string | number;
  /// Who the account is, when the backend says (it may, as `account` or
  /// `user`): only its masked form is kept.
  account?: AccountHint;
  user?: AccountHint;
  email?: unknown;
  name?: unknown;
  user_token?: string;
  computer?: { id?: string | number; name?: string; public_key?: string };
  credential?: string;
  approver?: { kind?: string | null; public_key?: string | null; name?: string | null } | null;
};

/// One poll. Exposed for tests; the timer calls it.
export async function pollOnce(): Promise<LinkState> {
  const current = pending;
  if (!current) return linkState();
  if (current.expiresAt.getTime() <= Date.now()) {
    pending = null;
    lastError = "expired";
    emit();
    return "unlinked";
  }
  const file = readAccountFile() ?? ensureAccountFile();
  try {
    const { body } = await backendCall<PollAnswer>({ backendUrl: backendUrl(file) }, "computer_logins/poll", { body: { device_code: current.deviceCode } });
    if (pending !== current) return linkState();
    if (body?.state === "approved") {
      completeLink(file, body);
      pending = null;
      lastError = null;
      stopPolling();
      emit();
      return "linked";
    }
    schedulePoll();
    return "pending";
  } catch (err) {
    if (pending !== current) return linkState();
    if (err instanceof BackendError && err.status === 429) {
      // slow_down: five seconds more between polls, as RFC 8628 says.
      current.intervalMs += 5_000;
      schedulePoll();
      return "pending";
    }
    if (err instanceof BackendError && (err.status === 403 || err.status === 410)) {
      pending = null;
      lastError = err.status === 403 ? "denied" : "expired";
      stopPolling();
      emit();
      return "unlinked";
    }
    // The network, or the backend having a bad minute: try again.
    lastError = "unreachable";
    schedulePoll();
    return "pending";
  }
}

/// "jimmy@gmail.com" → "j***@gmail.com".
export function maskEmail(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return null;
  return `${email[0]}***${email.slice(at)}`.slice(0, 120);
}

/// What the console says of the account: its e-mail or its name, masked,
/// else its id.
export function accountLabel(answer: PollAnswer): string | null {
  const hints = [answer.account, answer.user, { email: answer.email, name: answer.name }];
  for (const hint of hints) {
    if (hint && typeof hint.email === "string" && hint.email.includes("@")) {
      const masked = maskEmail(hint.email.trim());
      if (masked) return masked;
    }
  }
  for (const hint of hints) {
    if (hint && typeof hint.name === "string" && hint.name.trim()) return `${Array.from(hint.name.trim())[0]}***`;
  }
  return answer.account_id !== undefined && answer.account_id !== null ? `account ${answer.account_id}` : null;
}

function completeLink(file: AccountFile, answer: PollAnswer): void {
  const computerId = answer.computer?.id;
  if (!answer.user_token || !answer.credential || (typeof computerId !== "string" && typeof computerId !== "number")) {
    throw new BackendError(502, "invalid_answer", "the approved login lacks its credentials");
  }
  const approvers: Approver[] = [];
  const key = answer.approver?.public_key;
  if (typeof key === "string" && /^[0-9a-f]{64}$/.test(key)) {
    const kind = answer.approver?.kind === "computer" || answer.approver?.kind === "phone" ? answer.approver.kind : null;
    approvers.push({ public_key: key, kind, name: typeof answer.approver?.name === "string" ? answer.approver.name.slice(0, 100) : null });
  }
  writeAccountFile({
    ...file,
    backend_url: backendUrl(file),
    ...(answer.account_id !== undefined ? { account_id: answer.account_id } : {}),
    ...(accountLabel(answer) ? { account_label: accountLabel(answer)! } : {}),
    user_token: answer.user_token,
    computer: { id: String(computerId), credential: answer.credential, ...(answer.computer?.name ? { name: answer.computer.name } : {}) },
    approvers,
    linked_at: new Date().toISOString(),
  });
}

/// The backend did not say it forgot this computer: account.json is kept.
export class LeaveUnconfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaveUnconfirmedError";
  }
}

/// Undoes, on this computer, what the account gave: the sessions approved
/// through it (devices and peers, account/approvals.ts) with their tunnel
/// keys. Returns how many went.
export function dropAccountSessions(): number {
  const granted = db.select({ id: authSessions.id }).from(authSessions).where(eq(authSessions.origin, "account")).all();
  for (const session of granted) unpairSession(session.id);
  return granted.length;
}

/// Leaves the account: the backend forgets this computer (and the sessions
/// it gave out through it), then account.json goes, with the sessions the
/// account approved here. When the backend does not confirm (unreachable,
/// or an error), nothing is dropped and LeaveUnconfirmedError is thrown —
/// unless `force`, which leaves here anyway. A backend that no longer
/// knows the computer or its session (401, 403, 404, 410) confirms it.
export async function logout(options: { force?: boolean } = {}): Promise<{ confirmed: boolean; sessionsDropped: number }> {
  const account = linkedAccount();
  let confirmed = true;
  if (account) {
    try {
      await backendCall({ backendUrl: account.backend_url, userToken: account.user_token, deviceToken: account.device_token }, `account_computers/${encodeURIComponent(account.computer.id)}`, {
        method: "DELETE",
      });
    } catch (err) {
      const gone = err instanceof BackendError && [401, 403, 404, 410].includes(err.status);
      if (!gone) {
        confirmed = false;
        if (!options.force) throw new LeaveUnconfirmedError(err instanceof Error ? err.message : String(err));
      }
    }
  }
  stopPolling();
  pending = null;
  const sessionsDropped = dropAccountSessions();
  removeAccountFile();
  lastError = null;
  emit();
  return { confirmed, sessionsDropped };
}

/// Only for tests.
export function resetLinkForTests(): void {
  stopPolling();
  pending = null;
  lastError = null;
  lastCodeExpiresAt = 0;
  lastNetworkAttemptAt = 0;
  listeners.clear();
}

export type { LinkedAccount };
