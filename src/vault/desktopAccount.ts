import { randomUUID } from "node:crypto";
import { BackendError } from "../account/backend.js";
import type { TunnelParentPort } from "../tunnel/index.js";
import type { EventsApi, VaultState } from "./client.js";
import type { PublishDesktopBinding } from "./service.js";

// Inside Twoody Desktop, the vault's calls to the account go through the
// Desktop's main process, by message — never out of this server.
//
// The Desktop starts its embedded server with TWOODY_LOCAL_ONLY=1: every
// call to the internet is refused (outbound.ts), the account's included.
// The vault here needs the account for three things: GET /vault (the mesh
// roster, vault/roster.ts), publishing this Mac's desktop-binding (without
// it, no other computer counts this Mac as one of the mesh) and the events
// (catch-up, memories). Asked directly, each was refused, silently: the
// roster stayed empty, the desktop-binding was never published — the Pi
// did not count Jimmy's MacBook Air — and the memories said « Blocked by
// local-only mode » every minute (30/09/2026).
//
// The main process already speaks to the account for the vault, with this
// installation's session and device token (twoody-desktop
// src/shared/vaultAccountApi.ts), and holds the same keys. So the server
// asks it: {type:"vault-account", id, op, args}, answered
// {type:"vault-account-result", id, result} or {…, error: {status, code}}.
// The main process answers only these four operations, for the device it
// handed over, and checks the desktop-binding is signed by that device's
// own key and names its own computer before sending it
// (twoody-desktop src/shared/vaultServerAccount.ts). What travels is what
// the Desktop sends anyway: signed public statements, sealed events.
//
// A refusal keeps the account's status (401 for an expired session, 403,
// 404, 410 as the account said them: the roster then counts nobody);
// anything else — no answer in time, no vault handed, the account out of
// reach — is a 502, « unreachable »: the last verified roster stays.

export const VAULT_ACCOUNT_REQUEST = "vault-account";
export const VAULT_ACCOUNT_RESULT = "vault-account-result";
export type VaultAccountOp = "state" | "events" | "postEvents" | "publishDesktopBinding";

/// Requests waiting for their answer, at most.
const MAX_PENDING = 64;
const TIMEOUTS: Record<VaultAccountOp, number> = { state: 20_000, events: 20_000, postEvents: 35_000, publishDesktopBinding: 20_000 };

export type DesktopVaultAccount = { api: EventsApi; state: () => Promise<VaultState>; publish: PublishDesktopBinding };

export function desktopVaultAccount(port: TunnelParentPort): DesktopVaultAccount {
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  port.on("message", ({ data }) => {
    const message = data as { type?: unknown; id?: unknown; result?: unknown; error?: unknown } | null;
    if (message?.type !== VAULT_ACCOUNT_RESULT || typeof message.id !== "string") return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error !== undefined && message.error !== null) {
      const error = (typeof message.error === "object" ? message.error : {}) as { status?: unknown; code?: unknown };
      const said = typeof error.status === "number" && [401, 403, 404, 409, 410, 422].includes(error.status) ? error.status : 502;
      const code = typeof error.code === "string" ? error.code.slice(0, 64) : null;
      request.reject(new BackendError(said, code, `the Desktop answered ${said}${code ? ` (${code})` : ""} for the account`));
    } else request.resolve(message.result);
  });

  function ask<T>(op: VaultAccountOp, args: Record<string, unknown> = {}): Promise<T> {
    if (pending.size >= MAX_PENDING) return Promise.reject(new BackendError(502, "desktop_busy", "the Desktop has too many vault calls waiting"));
    return new Promise<T>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new BackendError(502, "desktop_timeout", "the Desktop did not answer for the account in time"));
      }, TIMEOUTS[op]);
      timer.unref?.();
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        port.postMessage({ type: VAULT_ACCOUNT_REQUEST, id, op, args });
      } catch {
        pending.delete(id);
        clearTimeout(timer);
        reject(new BackendError(502, "desktop_unreachable", "the Desktop could not be asked"));
      }
    });
  }

  const object = <T>(value: unknown, fallback: T): T => (value && typeof value === "object" && !Array.isArray(value) ? (value as T) : fallback);

  return {
    state: async () => object<VaultState>(await ask("state"), {}),
    publish: (deviceId, desktopBinding) => ask("publishDesktopBinding", { deviceId, desktopBinding }),
    api: {
      // 409 (some ids clash) and 422 invalid_event are answers about the
      // batch: the Desktop returns their body as a result, as the account
      // said it (client.ts accountVaultApi).
      postEvents: async (events) => object(await ask("postEvents", { events }), {}),
      events: async ({ after = 0, limit = 200, stream, conversationId }) =>
        object(await ask("events", { after, limit, ...(stream ? { stream } : {}), ...(conversationId ? { conversationId } : {}) }), {}),
    },
  };
}
