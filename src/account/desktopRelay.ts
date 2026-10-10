import { randomUUID } from "node:crypto";
import type { TunnelParentPort } from "../tunnel/index.js";
import { BackendError, setBackendRelay, type BackendRelay } from "./backend.js";
import { readShareLabel, setShareCaller, type ShareCallOutcome } from "../shares/guest.js";

// Inside Twoody Desktop, the mesh's calls to the account go through the
// Desktop's main process, by message — never out of this server.
//
// The Desktop starts its embedded server with TWOODY_LOCAL_ONLY=1: every
// call to the internet is refused (outbound.ts), the account's included.
// The vault's calls already go through the Desktop (vault/desktopAccount.ts);
// the mesh's links needed four more, each refused until now, silently:
//
//   GET  account_computers                                   the account's computers (peers/index.ts
//                                                            accountComputers: /providers, the router,
//                                                            requestPeer's target, the removed-computer sweep)
//   POST account_computers/:id/request_access                a link to another computer (requestPeer)
//   GET  account_computers/:id/authorizations/:rid           its sealed answer (checkPeerRequest)
//   POST account_computers/:id/authorizations/:rid/consume   that answer taken (checkPeerRequest)
//
// Without them, POST /api/v1/peers answered 409 « no such computer in the
// account »: the Desktop's mesh links (twoody-desktop meshLinks.ts) and
// « Appareils » never linked this Mac to the Pi, and a computer removed
// from the account kept its sessions here.
//
// The main process speaks to the account anyway, with this installation's
// session, and holds this Mac's computer credential: {type:"account-call",
// id, method, path, body} → {type:"account-call-result", id, status,
// result} or {…, error: {status, code}}. It makes these four calls only,
// checks their bodies, and adds its own credential to a request_access
// that names this Mac's own computer as the requester
// (twoody-desktop src/shared/serverAccountCalls.ts). No credential of this
// server travels in the message: the one the Desktop gave for
// request_access (X-Requester-Computer-Credential) is left out.
//
// The tunnel is not here: its frames already have their door in local-only
// mode (outbound.ts relayFetch), sealed end to end.

export const ACCOUNT_CALL_REQUEST = "account-call";
export const ACCOUNT_CALL_RESULT = "account-call-result";

const ID = "[A-Za-z0-9-]{1,64}";
/// The calls the Desktop makes for this server, and nothing else. The
/// Desktop checks the same list; this one keeps the others on the
/// ordinary gate, where local-only mode refuses them.
export const RELAYED_CALLS: ReadonlyArray<{ method: "GET" | "POST"; path: RegExp }> = [
  { method: "GET", path: /^account_computers$/ },
  { method: "POST", path: new RegExp(`^account_computers/${ID}/request_access$`) },
  { method: "GET", path: new RegExp(`^account_computers/${ID}/authorizations/${ID}$`) },
  { method: "POST", path: new RegExp(`^account_computers/${ID}/authorizations/${ID}/consume$`) },
];

export function isRelayedCall(method: string, path: string): boolean {
  return RELAYED_CALLS.some((call) => call.method === method && call.path.test(path));
}

/// Requests waiting for their answer, at most.
const MAX_PENDING = 64;
/// The Desktop's own call has 15 s; a little more for the message itself.
const SLACK_MS = 5_000;

/// Installs the relay on the Desktop's port (index.ts). Returns what undoes it.
export function relayAccountThroughDesktop(port: TunnelParentPort): () => void {
  const pending = new Map<string, { resolve: (value: { status: number; body: unknown }) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  port.on("message", ({ data }) => {
    const message = data as { type?: unknown; id?: unknown; status?: unknown; result?: unknown; error?: unknown } | null;
    if (message?.type !== ACCOUNT_CALL_RESULT || typeof message.id !== "string") return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error !== undefined && message.error !== null) {
      const error = (typeof message.error === "object" ? message.error : {}) as { status?: unknown; code?: unknown };
      // The account's refusals as it said them; anything else — the
      // account out of reach, the Desktop unable to ask — is a 502.
      const status = typeof error.status === "number" && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 502;
      const code = typeof error.code === "string" && error.code ? error.code.slice(0, 64) : null;
      request.reject(new BackendError(status, code, `the Desktop answered ${status}${code ? ` (${code})` : ""} for the account`));
    } else {
      const status = typeof message.status === "number" && message.status >= 200 && message.status < 300 ? message.status : 200;
      request.resolve({ status, body: message.result ?? null });
    }
  });

  const relay: BackendRelay = ({ method, path, body, timeoutMs }) => {
    if (!isRelayedCall(method, path)) return null;
    if (pending.size >= MAX_PENDING) return Promise.reject(new BackendError(502, "desktop_busy", "the Desktop has too many account calls waiting"));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new BackendError(502, "desktop_timeout", "the Desktop did not answer for the account in time"));
      }, timeoutMs + SLACK_MS);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      try {
        port.postMessage({ type: ACCOUNT_CALL_REQUEST, id, method, path, ...(body !== undefined ? { body } : {}) });
      } catch {
        pending.delete(id);
        clearTimeout(timer);
        reject(new BackendError(502, "desktop_unreachable", "the Desktop could not be asked"));
      }
    });
  };
  setBackendRelay(relay);
  return () => {
    setBackendRelay(null);
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      request.reject(new BackendError(502, "desktop_unreachable", "the Desktop is gone"));
      pending.delete(id);
    }
  };
}

// Folders someone else shares with the person (docs/sharing-contracts.md §3
// « Grantee side »): the Desktop's main process holds the person's device
// keys, seals each request to the owner's computer, sends it through the
// account and opens the answer. Same port and shape as the account's calls:
// {type: "share-call", id, share_uuid, op} → {type: "share-call-result", id,
// result} or {…, error: {code}}, each with `share: {label, owner_name}`
// when the Desktop knows the share (the account's « received » list). Only
// the operation — a search's query, never the conversation — goes out.

export const SHARE_CALL_REQUEST = "share-call";
export const SHARE_CALL_RESULT = "share-call-result";
const MAX_SHARE_PENDING = 32;

/// Installs the share calls on the Desktop's port (index.ts). Returns what undoes it.
export function relayShareCallsThroughDesktop(port: TunnelParentPort): () => void {
  const pending = new Map<string, { resolve: (value: ShareCallOutcome) => void; timer: ReturnType<typeof setTimeout> }>();
  port.on("message", ({ data }) => {
    const message = data as { type?: unknown; id?: unknown; result?: unknown; error?: unknown; share?: unknown } | null;
    if (message?.type !== SHARE_CALL_RESULT || typeof message.id !== "string") return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    const result = message.result as { share?: unknown } | null | undefined;
    const share = readShareLabel(result?.share ?? message.share);
    if (message.error !== undefined && message.error !== null) {
      const code = (message.error as { code?: unknown }).code;
      request.resolve({ ok: false, code: typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : "unreachable", share });
    } else {
      request.resolve({ ok: true, result: message.result ?? null, share });
    }
  });
  setShareCaller((shareUuid, op, timeoutMs) => {
    if (pending.size >= MAX_SHARE_PENDING) return Promise.resolve({ ok: false, code: "desktop_busy", share: null });
    return new Promise((resolve) => {
      const id = randomUUID();
      // Never waited for past the turn's budget: a late answer is dropped.
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, code: "timeout", share: null });
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, timer });
      try {
        port.postMessage({ type: SHARE_CALL_REQUEST, id, share_uuid: shareUuid, op });
      } catch {
        pending.delete(id);
        clearTimeout(timer);
        resolve({ ok: false, code: "desktop_unreachable", share: null });
      }
    });
  });
  return () => {
    setShareCaller(null);
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      request.resolve({ ok: false, code: "desktop_unreachable", share: null });
      pending.delete(id);
    }
  };
}
