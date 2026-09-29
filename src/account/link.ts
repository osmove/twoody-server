import { hostname } from "node:os";
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
  if (state === "linked") return { state, account_computer_id: linkedAccount()!.computer.id };
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

/// Asks the backend for a new code. The previous one, if any, is dropped.
export async function startLink(options: { name?: string } = {}): Promise<LinkView> {
  if (linkedAccount()) return linkView();
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

type PollAnswer = {
  state?: string;
  account_id?: string | number;
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
    user_token: answer.user_token,
    computer: { id: String(computerId), credential: answer.credential, ...(answer.computer?.name ? { name: answer.computer.name } : {}) },
    approvers,
    linked_at: new Date().toISOString(),
  });
}

/// Leaves the account: the backend forgets this computer (and the sessions
/// it gave out through it), and account.json goes.
export async function logout(): Promise<void> {
  stopPolling();
  pending = null;
  const account = linkedAccount();
  if (account) {
    await backendCall({ backendUrl: account.backend_url, userToken: account.user_token, deviceToken: account.device_token }, `account_computers/${encodeURIComponent(account.computer.id)}`, {
      method: "DELETE",
    }).catch(() => undefined);
  }
  removeAccountFile();
  lastError = null;
  emit();
}

/// Only for tests.
export function resetLinkForTests(): void {
  stopPolling();
  pending = null;
  lastError = null;
  listeners.clear();
}

export type { LinkedAccount };
