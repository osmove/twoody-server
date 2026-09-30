import { networkInterfaces } from "node:os";
import { pairDevice, unpairSession, type PairingRole } from "../pairing.js";
import { backendCall } from "./backend.js";
import { verifyEndorsement } from "./endorsement.js";
import { computerName } from "./link.js";
import { sealPairing } from "./pairingSeal.js";
import { linkedAccount, type LinkedAccount } from "./store.js";
import { deviceAccessValid } from "../vault/contracts.js";
import { fromHex } from "../vault/crypto.js";
import { meshRoster, type Roster } from "../vault/roster.js";

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
//      (`twoody-server approve`);
//   4. another computer of the account asks as a peer, is in the verified
//      vault roster (vault/roster.ts: a computer the person devices
//      enrolled and bound), and asks with the very tunnel key its binding
//      names (docs/mesh-design.md §1);
//   5. a phone asks carrying a device-access-v1 (`device_access`) for the
//      key it asks with, signed by a person device of the verified roster.
//
// Rules 4 and 5 rest on the vault's signatures, never on the account's say
// (its listing, requester_kind or token): the account only carries them.
// Their sessions are « mesh » ones, undone when the computer or phone
// leaves the roster (peers/index.ts).
//
// Anything else stays pending until it expires. What an approval sends
// back is sealed to the requester's key like the Desktop's (pairingSeal.ts):
// {localServerUrl, localServerToken, computerTunnelKey, computerName,
// computerId, kind}.

export interface PendingRequest {
  id: string;
  /// The name shown and logged: the account's name for the requesting
  /// computer when the backend gives it (`requester_name`), else the one the
  /// requester chose.
  name: string;
  public_key: string;
  expires_at: string;
  /// "peer" whenever another computer of the account asked — said by the
  /// request's role or by `requester_kind: "computer"` — so that it only
  /// ever gets a session limited to /api/v1/peer/*.
  role: PairingRole;
  endorsements: Array<{ approver_key: string; endorsement: string }>;
  /// "computer" when the backend says the request came from a session of
  /// one of the account's computers; null when it does not say.
  requester_kind: "computer" | "device" | null;
  /// That computer's id in the account: its session here goes when the
  /// account stops listing it (peers/index.ts).
  requester_computer_id: string | null;
  /// A phone's signed device-access-v1 for its key (rule 5), as the app
  /// sends it with request_access and the account passes it on; null when
  /// there is none or it is not one.
  device_access: DeviceAccessWire | null;
}

export type DeviceAccessWire = { vault_device_id: string; tunnel_public_key: string; signature: string };

export type Verdict =
  | { approve: true; rule: "approver" | "endorsed" }
  | { approve: true; rule: "mesh_computer" | "device_access"; vaultDeviceId?: string }
  | { approve: false; reason: "expired" | "needs_console" | "invalid" };

function readDeviceAccess(raw: unknown): DeviceAccessWire | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const d = value as Record<string, unknown> | null;
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const { vault_device_id: id, tunnel_public_key: key, signature } = d;
  if (typeof id !== "string" || !id || id.length > 64) return null;
  if (typeof key !== "string" || !/^[0-9a-f]{64}$/i.test(key)) return null;
  if (typeof signature !== "string" || !/^[0-9a-f]{128}$/i.test(signature)) return null;
  return { vault_device_id: id.toLowerCase(), tunnel_public_key: key.toLowerCase(), signature: signature.toLowerCase() };
}

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
    // twoody-backend 08c052d8: requester_kind, requester_computer_id,
    // requester_name and requester_computer {id, name, public_key}.
    const computerEntry = r.requester_computer && typeof r.requester_computer === "object" ? (r.requester_computer as Record<string, unknown>) : null;
    const idOf = (value: unknown) => ((typeof value === "string" && value.trim()) || typeof value === "number" ? String(value).trim().slice(0, 64) : null);
    const nameOf = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim().slice(0, 100) : null);
    const requesterKind = r.requester_kind === "computer" ? "computer" : r.requester_kind === "device" ? "device" : null;
    const requesterComputerId = idOf(r.requester_computer_id) ?? idOf(computerEntry?.id);
    const chosen = nameOf(r.name);
    const known = nameOf(computerEntry?.name) ?? nameOf(r.requester_name);
    const computer = r.role === "peer" || requesterKind === "computer" || requesterComputerId !== null;
    return [
      {
        id: String(r.id),
        name: known ?? chosen ?? "Appareil",
        public_key: r.public_key.toLowerCase(),
        expires_at: r.expires_at,
        role: computer ? "peer" : "device",
        endorsements: endorsements.slice(0, 5),
        requester_kind: requesterKind ?? (computer ? "computer" : null),
        requester_computer_id: requesterComputerId,
        device_access: readDeviceAccess(r.device_access),
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

/// Rules 4 and 5, pure, against the verified roster (null: no vault here,
/// so neither applies). Null when neither lets the request in.
export function judgeMesh(request: PendingRequest, roster: Roster | null, options: { selfComputerId?: string | null; now?: number } = {}): Verdict | null {
  const now = options.now ?? Date.now();
  if (!roster || !/^[0-9a-f]{64}$/.test(request.public_key)) return null;
  const expires = Date.parse(request.expires_at);
  if (!Number.isFinite(expires) || expires <= now) return null;
  // Rule 4: a computer of the roster, with its bound tunnel key.
  if (request.role === "peer") {
    const id = request.requester_computer_id;
    if (!id || id === options.selfComputerId) return null;
    const computer = roster.computers.get(id);
    return computer && computer.tunnelPublicKey === request.public_key ? { approve: true, rule: "mesh_computer" } : null;
  }
  // Rule 5: a phone, vouched for by a person device of the roster for the
  // key it asks with. A computer's statement never counts (not in persons).
  const access = request.device_access;
  if (!access || access.tunnel_public_key !== request.public_key || request.requester_computer_id) return null;
  const person = roster.persons.get(access.vault_device_id);
  if (!person) return null;
  const valid = deviceAccessValid({
    userId: roster.userId,
    access: { vault_device_id: access.vault_device_id, tunnel_public_key: access.tunnel_public_key },
    signerSignPublic: fromHex(person.signPublic),
    signature: access.signature,
  });
  return valid ? { approve: true, rule: "device_access", vaultDeviceId: person.vaultDeviceId } : null;
}

/// All five rules: 1 and 2 first (their sessions stay while the account
/// lists the requester), then 4 and 5 on the roster. `roster` is only asked
/// for when 1 and 2 do not settle it.
export async function judgeAll(request: PendingRequest, account: Pick<LinkedAccount, "pairing_key" | "approvers" | "computer">, roster: () => Promise<Roster | null>, now = Date.now()): Promise<Verdict> {
  const verdict = judge(request, account, now);
  if (verdict.approve || verdict.reason !== "needs_console") return verdict;
  const mesh = judgeMesh(request, await roster().catch(() => null), { selfComputerId: account.computer.id, now });
  return mesh ?? verdict;
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
export async function approveRequest(account: LinkedAccount, request: PendingRequest, verdict?: Verdict): Promise<void> {
  // « account »: undone if this computer leaves the account or is removed
  // from it (service.ts), and never taken for the Desktop, whatever name
  // the requester gave itself. « mesh » (rules 4, 5): undone too when the
  // requester leaves the vault roster.
  const mesh = verdict?.approve === true && (verdict.rule === "mesh_computer" || verdict.rule === "device_access");
  const paired = pairDevice({
    deviceName: request.name,
    tunnelPublicKey: request.public_key,
    role: request.role,
    origin: mesh ? "mesh" : "account",
    requesterComputerId: request.requester_computer_id,
    vaultDeviceId: verdict?.approve === true && verdict.rule === "device_access" ? (verdict.vaultDeviceId ?? null) : null,
  });
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

const RULE_LOG: Record<string, string> = {
  approver: "the device that added this server",
  endorsed: "vouched for by a device of the account",
  mesh_computer: "a computer of the encrypted history, with its bound key",
  device_access: "vouched for by a device of the encrypted history",
};

/// Every 15 s (TWOODY_ACCOUNT_POLL_MS for tests): approves what rules 1, 2,
/// 4 and 5 allow, and says once, on the console, what waits for rule 3.
export function startApprovalLoop(options: { everyMs?: number; log?: (message: string) => void; roster?: () => Promise<Roster | null> } = {}): ApprovalLoop {
  const roster = options.roster ?? (() => meshRoster().get());
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
        const verdict = await judgeAll(request, account, roster);
        if (verdict.approve) {
          try {
            await approveRequest(account, request, verdict);
            options.log?.(`Access granted to "${request.name}" (${RULE_LOG[verdict.rule]}).`);
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
