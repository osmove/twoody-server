import { outboundFetch } from "../outbound.js";

// Calls to the account's backend (twoody-backend, /api/v1), for the
// computer's own business: linking, heartbeat, approvals, peers. Every one
// goes through outboundFetch, so local-only mode refuses a backend on the
// internet like any other call out.

export class BackendError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
    /// The answer's JSON, for callers to whom a refusal is an answer
    /// (the vault's 409 on a batch of events, src/vault/client.ts).
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = "BackendError";
  }
}

export interface BackendCredentials {
  backendUrl: string;
  userToken?: string;
  deviceToken?: string;
  /// The computer credential: only the host's own calls carry it.
  credential?: string;
  /// The asking computer's credential, on request_access only, when the
  /// session is its person's (Twoody Desktop): X-Requester-Computer-Credential.
  requesterCredential?: string;
}

let fetchOverride: typeof fetch | null = null;

/// A call made for this server by another process, which holds the
/// account's session (inside Twoody Desktop: its main process, by message,
/// account/desktopRelay.ts). It answers null for a call it does not make:
/// that one goes through outboundFetch as usual — and local-only mode
/// refuses it there.
export type BackendRelay = (call: { method: string; path: string; body?: unknown; timeoutMs: number }) => Promise<{ status: number; body: unknown }> | null;
let relay: BackendRelay | null = null;

export function setBackendRelay(next: BackendRelay | null): void {
  relay = next;
}

/// Tests stand in for the backend's network with this.
export function setBackendFetch(fetchImpl: typeof fetch | null): void {
  fetchOverride = fetchImpl;
}

export async function backendCall<T = unknown>(
  creds: BackendCredentials,
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<{ status: number; body: T }> {
  const method = init.method ?? (init.body !== undefined ? "POST" : "GET");
  // The relay makes the call with its own session and credential: none of
  // this server's credentials go with it.
  const relayed = relay?.({ method, path: path.replace(/^\//, ""), body: init.body, timeoutMs: init.timeoutMs ?? 15_000 }) ?? null;
  if (relayed) return (await relayed) as { status: number; body: T };
  const url = `${creds.backendUrl.replace(/\/+$/, "").replace(/\/api\/v1$/, "")}/api/v1/${path.replace(/^\//, "")}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (creds.userToken) headers["X-User-Token"] = creds.userToken;
  if (creds.deviceToken) headers["X-Device-Token"] = creds.deviceToken;
  if (creds.credential) headers["X-Computer-Credential"] = creds.credential;
  if (creds.requesterCredential) headers["X-Requester-Computer-Credential"] = creds.requesterCredential;
  const doFetch = fetchOverride ?? outboundFetch;
  const response = await doFetch(url, {
    method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
  });
  const text = await response.text().catch(() => "");
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!response.ok) {
    const code = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : null;
    throw new BackendError(response.status, code, `backend answered ${response.status}${code ? ` (${code})` : ""} to ${path}`, body);
  }
  return { status: response.status, body: body as T };
}
