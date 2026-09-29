import { networkInterfaces } from "node:os";
import { pairDevice, unpairSession, type PairingRole } from "../pairing.js";
import { backendCall } from "./backend.js";
import { verifyEndorsement } from "./endorsement.js";
import { computerName } from "./link.js";
import { sealPairing } from "./pairingSeal.js";
import { linkedAccount, type LinkedAccount } from "./store.js";

// Who may use this computer, when it has no screen to ask on
// (docs/multi-computer-design.md §2). Never approved automatically for
// being the same account — a leaked session, or someone else of the
// household signed in to it, would get this computer's local data. A
// request is approved only when:
//
//   1. the requester's key is a pinned approver key: the device that typed
//      this computer's code on its own screen is the one asking now (and
//      the sealed answer only opens with that key's private half);
//   2. it carries a valid endorsement from a pinned approver (the Mac's
//      « Appareils » said yes to « iPhone de Claire veut accéder au
//      Raspberry Pi »), endorsement v1 (account/endorsement.ts);
//   3. someone approves it on this computer's console
//      (`twoody-server approve`).
//
// Anything else stays pending until it expires. What an approval sends
// back is sealed to the requester's key like the Desktop's (pairingSeal.ts):
// {localServerUrl, localServerToken, computerTunnelKey, computerName,
// computerId, kind}.

export interface PendingRequest {
  id: string;
  name: string;
  public_key: string;
  expires_at: string;
  role: PairingRole;
  endorsements: Array<{ approver_key: string; endorsement: string }>;
}

export type Verdict = { approve: true; rule: "approver" | "endorsed" } | { approve: false; reason: "expired" | "needs_console" | "invalid" };

export function readPending(raw: unknown): PendingRequest[] {
  const list = (raw as { requests?: unknown } | null)?.requests;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry): PendingRequest[] => {
    const r = entry as Record<string, unknown> | null;
    if (!r || (typeof r.id !== "string" && typeof r.id !== "number")) return [];
    if (typeof r.public_key !== "string" || typeof r.expires_at !== "string") return [];
    const endorsements = Array.isArray(r.endorsements)
      ? (r.endorsements as unknown[]).flatMap((e) => {
          const x = e as Record<string, unknown> | null;
          return x && typeof x.approver_key === "string" && typeof x.endorsement === "string" ? [{ approver_key: x.approver_key, endorsement: x.endorsement }] : [];
        })
      : [];
    return [
      {
        id: String(r.id),
        name: typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 100) : "Appareil",
        public_key: r.public_key.toLowerCase(),
        expires_at: r.expires_at,
        role: r.role === "peer" ? "peer" : "device",
        endorsements: endorsements.slice(0, 5),
      },
    ];
  });
}

/// Rules 1 and 2, pure. Rule 3 is a person at the console.
export function judge(
  request: PendingRequest,
  account: Pick<LinkedAccount, "pairing_key" | "approvers" | "computer">,
  now = Date.now(),
): Verdict {
  if (!/^[0-9a-f]{64}$/.test(request.public_key)) return { approve: false, reason: "invalid" };
  const expires = Date.parse(request.expires_at);
  if (!Number.isFinite(expires) || expires <= now) return { approve: false, reason: "expired" };
  const pinned = account.approvers.map((a) => a.public_key);
  if (pinned.includes(request.public_key)) return { approve: true, rule: "approver" };
  for (const e of request.endorsements) {
    if (!pinned.includes(e.approver_key)) continue;
    const ok = verifyEndorsement(
      account.pairing_key.priv,
      e.approver_key,
      { hostId: account.computer.id, rid: request.id, requesterKey: request.public_key, expiresAt: request.expires_at },
      e.endorsement,
    );
    if (ok) return { approve: true, rule: "endorsed" };
  }
  return { approve: false, reason: "needs_console" };
}

let localPort = Number(process.env.PORT ?? 3000);

export function setLocalPort(port: number): void {
  localPort = port;
}

/// Where a device on the network reaches this server: TWOODY_PUBLIC_URL,
/// else the first private IPv4 address of this machine.
export function lanUrl(): string {
  const configured = process.env.TWOODY_PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.)/.test(address.address)) {
        return `http://${address.address}:${localPort}`;
      }
    }
  }
  return `http://127.0.0.1:${localPort}`;
}

function hostCreds(account: LinkedAccount) {
  return { backendUrl: account.backend_url, userToken: account.user_token, deviceToken: account.device_token, credential: account.computer.credential };
}

export async function fetchPending(account: LinkedAccount): Promise<PendingRequest[]> {
  const { body } = await backendCall(hostCreds(account), `account_computers/${encodeURIComponent(account.computer.id)}/pending`);
  return readPending(body);
}

/// Pairs the requester with this computer and sends it, sealed, what it
/// needs to reach it. A session made for a decision the backend then
/// refuses is undone.
export async function approveRequest(account: LinkedAccount, request: PendingRequest): Promise<void> {
  const paired = pairDevice({ deviceName: request.name, tunnelPublicKey: request.public_key, role: request.role });
  const payload = {
    localServerUrl: lanUrl(),
    localServerToken: paired.token,
    computerTunnelKey: paired.tunnelPublicKey,
    computerName: account.computer.name ?? computerName(),
    computerId: account.computer.id,
    kind: "server",
  };
  try {
    await backendCall(hostCreds(account), `account_computers/${encodeURIComponent(account.computer.id)}/authorizations/${encodeURIComponent(request.id)}/decide`, {
      body: { state: "approved", sealed_response: sealPairing(account.pairing_key.priv, request.public_key, request.id, payload) },
    });
  } catch (err) {
    unpairSession(paired.sessionId);
    throw err;
  }
}

export async function denyRequest(account: LinkedAccount, request: Pick<PendingRequest, "id">): Promise<void> {
  await backendCall(hostCreds(account), `account_computers/${encodeURIComponent(account.computer.id)}/authorizations/${encodeURIComponent(request.id)}/decide`, {
    body: { state: "denied" },
  });
}

export interface ApprovalLoop {
  /// One pass, now. Resolves with what was done to each request.
  tick(): Promise<Array<{ request: PendingRequest; verdict: Verdict; error?: string }>>;
  stop(): void;
}

/// Every 15 s (TWOODY_ACCOUNT_POLL_MS for tests): approves what rules 1–2
/// allow, and says once, on the console, what waits for rule 3.
export function startApprovalLoop(options: { everyMs?: number; log?: (message: string) => void } = {}): ApprovalLoop {
  const override = Number(process.env.TWOODY_ACCOUNT_POLL_MS);
  const everyMs = options.everyMs ?? (Number.isFinite(override) && override > 0 ? override : 15_000);
  const announced = new Set<string>();
  let running: ReturnType<ApprovalLoop["tick"]> | null = null;
  let stopped = false;

  const pass = async () => {
    const done: Array<{ request: PendingRequest; verdict: Verdict; error?: string }> = [];
    const account = linkedAccount();
    if (!account || stopped) return done;
    try {
      for (const request of await fetchPending(account)) {
        const verdict = judge(request, account);
        if (verdict.approve) {
          try {
            await approveRequest(account, request);
            options.log?.(`Access granted to "${request.name}" (${verdict.rule === "approver" ? "the device that added this server" : "vouched for by a device of the account"}).`);
            done.push({ request, verdict });
          } catch (err) {
            done.push({ request, verdict, error: err instanceof Error ? err.message : String(err) });
          }
          continue;
        }
        if (verdict.reason === "needs_console" && !announced.has(request.id)) {
          announced.add(request.id);
          options.log?.(`"${request.name}" asks to use this server${request.role === "peer" ? " (a computer of the account)" : ""}. To allow it from here: twoody-server approve`);
        }
        done.push({ request, verdict });
      }
    } catch {
      // Offline, or the backend refusing the credential: next time.
    }
    return done;
  };

  // One pass at a time: a call while one runs gets that one's result.
  const tick: ApprovalLoop["tick"] = () => {
    running ??= pass().finally(() => {
      running = null;
    });
    return running;
  };

  const timer = setInterval(() => void tick(), everyMs);
  timer.unref();
  void tick();
  return {
    tick,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
