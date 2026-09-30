import { backendCall, BackendError, type BackendCredentials } from "../account/backend.js";
import { approvedKind, bindingValid, desktopBindingValid, type ApprovedKind, type ComputerBinding, type DesktopBinding } from "./contracts.js";
import {
  createDeviceKeys, fingerprint, fromHex, toHex, unwrapEpochKey, VaultError,
  type DeviceKeys, type EpochEnvelope, type Random, type SealedEvent,
} from "./crypto.js";
import { readJsonFile, writePrivateFile } from "./store.js";
import { rmSync } from "node:fs";

// This computer as a member of the person's encrypted history
// (docs/mesh-design.md §1, lot S1): a port of twoody-desktop
// src/shared/vaultClient.ts (itself twoody-app utils/vaultClient.js),
// reduced to what a computer nobody sits at may do, and stricter on whom it
// takes keys from.
//
//   - It enrols as a vault device of kind "computer", bound to this
//     server's account computer (twoody-backend 693ac548): it never founds
//     a vault, never approves, never gives keys, never revokes. A person
//     device (the iPhone, a Desktop with someone at the screen) approves it
//     after reading its keys over the pinned tunnel
//     (GET /api/v1/peer/vault/identity) and wraps the epoch keys for it.
//   - Its trust starts from the person device(s) pinned over the tunnel
//     (pinAnchor, POST /api/v1/peer/vault/anchor, next to the identity the
//     approving device reads there) and walks strictly forward through
//     signed approvals (verifiedIds). It takes an epoch key only from a
//     member reached that way, never from a device whose binding says
//     can_approve=false, or a computer without a binding saying it may
//     (mayApprove). Without an anchor it takes no key at all.
//   - What a device is (person or computer) comes only from its signed
//     approval (approval/v2, src/vault/contracts.ts approvedKind; a v1
//     approval makes a person-device), never from the kind the account
//     lists: a computer stripped of its kind and binding is not a person.
//
// Keys live in `store` (DATA_DIR/vault.json, 0600) before the account hears
// of the device, as on the Desktop.

export const COMPUTER_KIND = "computer";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/// A binding as the account returns it (docs of test/fixtures/computer-binding-v1.json, « Wire form »).
export type WireBinding = ComputerBinding & { approver_id: string; signature: string };
/// A Desktop's own desktop-binding as the account returns it (test/fixtures/desktop-binding-v1.json).
export type WireDesktopBinding = DesktopBinding & { signature: string };

export type VaultDevice = {
  id: string; label: string; enc_public: string; sign_public: string; status: "pending" | "trusted" | "revoked";
  approved_by_id?: string | null; approved_at?: string | null; revoked_at?: string | null; created_at?: string;
  approval?: { approver_id: string; signature: string } | null;
  invite_proof?: string | null;
  /// Since twoody-backend 693ac548; absent from an older account (then "person").
  kind?: "person" | "computer" | null;
  account_computer_id?: string | null;
  /// The signed computer-binding-v1, as stored: a JSON string (or already parsed).
  binding?: string | WireBinding | null;
  /// A person-device's own desktop-binding-v1 (a Twoody Desktop), as stored.
  desktop_binding?: string | WireDesktopBinding | null;
};

export type VaultState = { devices?: VaultDevice[]; epoch?: number; needs_rotation?: boolean };

/// What a computer calls on the account's vault (twoody-backend
/// VaultController); the person-only calls (approve, envelopes out, revoke)
/// are left out on purpose.
export type ComputerVaultApi = {
  state(): Promise<VaultState>;
  createDevice(body: { label: string; enc_public: string; sign_public: string; kind: "computer"; account_computer_id: string }): Promise<{ device: VaultDevice; founding?: boolean }>;
  envelopes(deviceId: string): Promise<{ envelopes?: EpochEnvelope[] }>;
};

/// A Desktop publishes its own desktop-binding-v1 (POST
/// /vault/devices/:id/desktop_binding, the JSON of its wire form).
export type DesktopBindingApi = {
  publishDesktopBinding(deviceId: string, desktopBinding: string): Promise<unknown>;
};

export type EventsPage = { events?: Array<SealedEvent & { seq: number; stream?: string }>; next_after?: number | null };
export type EventsApi = {
  postEvents(events: Array<SealedEvent & { stream?: string }>): Promise<{ stored?: number; duplicates?: number; conflicts?: string[]; error?: string; event_id?: string }>;
  events(page: { after?: number; limit?: number; stream?: string; conversationId?: string }): Promise<EventsPage>;
};

// ── the roster rules (pure; S2's roster builds on them) ──────────────────

/// The binding a device carries, read; null when it has none or it is not
/// one (a malformed binding counts as none — and so as no right to approve).
export function readBinding(device: Pick<VaultDevice, "binding"> | null | undefined): WireBinding | null {
  let raw: unknown = device?.binding;
  if (raw == null || raw === "") return null;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  const str = (key: string) => (typeof b[key] === "string" ? (b[key] as string) : null);
  const fields = ["vault_device_id", "account_computer_id", "tunnel_public_key", "pairing_public_key", "approver_id", "signature"].map(str);
  if (fields.some((value) => value === null) || typeof b.can_approve !== "boolean") return null;
  const [vault_device_id, account_computer_id, tunnel_public_key, pairing_public_key, approver_id, signature] = fields as string[];
  return { vault_device_id: vault_device_id!, account_computer_id: account_computer_id!, tunnel_public_key: tunnel_public_key!, pairing_public_key: pairing_public_key!, can_approve: b.can_approve, approver_id: approver_id!, signature: signature! };
}

/// Whether `binding`, carried by `device`, is signed by its approver as it
/// says, for this account. The approver's key comes from the roster, never
/// from the binding; a device never binds itself.
export function bindingChecks(userId: string | number, device: VaultDevice, binding: WireBinding, byId: Map<string, VaultDevice>): boolean {
  if (binding.vault_device_id !== device.id || binding.approver_id === device.id) return false;
  if (device.account_computer_id && binding.account_computer_id !== device.account_computer_id) return false;
  const approver = byId.get(binding.approver_id);
  if (!approver || approver.status === "revoked") return false;
  const { approver_id: _approver, signature, ...bound } = binding;
  try {
    return bindingValid({ userId, binding: bound, signerSignPublic: fromHex(approver.sign_public), signature });
  } catch {
    return false;
  }
}

/// A Desktop's desktop-binding, read; null when it has none or it is not
/// one (exactly its five fields, keys and signature as lowercase hex).
export function readDesktopBinding(device: Pick<VaultDevice, "desktop_binding"> | null | undefined): WireDesktopBinding | null {
  let raw: unknown = device?.desktop_binding;
  if (raw == null || raw === "") return null;
  if (typeof raw === "string") {
    if (raw.length > 1024) return null;
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  const keys = ["account_computer_id", "pairing_public_key", "signature", "tunnel_public_key", "vault_device_id"];
  if (Object.keys(b).sort().join(",") !== keys.join(",") || keys.some((key) => typeof b[key] !== "string")) return null;
  const [account_computer_id, pairing_public_key, signature, tunnel_public_key, vault_device_id] = keys.map((key) => b[key] as string);
  if (!/^[0-9a-f]{64}$/.test(tunnel_public_key!) || !/^[0-9a-f]{64}$/.test(pairing_public_key!) || !/^[0-9a-f]{128}$/.test(signature!)) return null;
  if (!vault_device_id || vault_device_id.length > 200 || !account_computer_id || account_computer_id.length > 200) return null;
  return { vault_device_id: vault_device_id!, account_computer_id: account_computer_id!, tunnel_public_key: tunnel_public_key!, pairing_public_key: pairing_public_key!, signature: signature! };
}

/// The account computer a Desktop says it is (desktop-binding-v1, signed
/// by its own vault key), or null. Only for a live person-device by its
/// signed approval that the account does not mark as a computer (a Pi
/// cannot promote itself), naming that very device, whose own key checks
/// the signature. Whether the device is verified is the caller's walk
/// (verifiedIds): the binding adds nothing to who the device is, only
/// which computer of the account it runs as.
export function desktopBindingOf(userId: string | number, device: VaultDevice | undefined, byId: Map<string, VaultDevice>): WireDesktopBinding | null {
  if (!device || device.status !== "trusted" || isComputer(device)) return null;
  const binding = readDesktopBinding(device);
  if (!binding || binding.vault_device_id !== device.id) return null;
  if (deviceKind(userId, device, byId)?.kind !== "person") return null;
  const { signature, ...bound } = binding;
  try {
    return desktopBindingValid({ userId, binding: bound, deviceSignPublic: fromHex(device.sign_public), signature }) ? binding : null;
  } catch {
    return null;
  }
}

/// Whether the account says this device is a computer (a kind, an account
/// computer, or a binding). Never enough to make it one (only a v2
/// approval of kind computer does, deviceKind); enough to refuse it as a
/// person-device: the account can only take rights away with it.
export function isComputer(device: VaultDevice | undefined): boolean {
  return !!device && (device.kind === COMPUTER_KIND || !!device.account_computer_id || (device.binding != null && device.binding !== ""));
}

/// What `device` is, as its approver signed it (twoody/vault/approval/v2;
/// a v1 approval makes a person-device), or null: no approval, an approver
/// the roster does not have, a signature that is none of these, or a
/// device the account marks as a computer whose approval says person (a
/// computer is never demoted to a person-device, which may approve). The
/// kind the account gives is never read.
export function deviceKind(userId: string | number, device: VaultDevice | undefined, byId: Map<string, VaultDevice>): ApprovedKind | null {
  if (!device?.approval) return null;
  const approver = byId.get(device.approval.approver_id);
  if (!approver) return null;
  let approverSignPublic: Uint8Array;
  try {
    approverSignPublic = fromHex(approver.sign_public);
  } catch {
    return null;
  }
  const signed = approvedKind({
    userId, device, approverId: approver.id, approverSignPublic, signature: device.approval.signature,
    accountComputerIds: [device.account_computer_id, readBinding(device)?.account_computer_id],
  });
  if (!signed || (signed.kind === "person" && isComputer(device))) return null;
  return signed;
}

/// Whether this device may vouch for another or give it keys: a
/// person-device by its signed approval, or a computer (v2 approval of kind
/// computer) whose binding — for the same account computer, signed by a
/// device that itself may, and that is in `verified` when given — says
/// can_approve=true. A binding that says false settles it, whatever else is
/// true. (fixture rules, P0 and approval/v2)
export function mayApprove(userId: string | number, device: VaultDevice | undefined, byId: Map<string, VaultDevice>, verified?: Set<string>, seen: Set<string> = new Set()): boolean {
  if (!device || device.status === "revoked" || seen.has(device.id)) return false;
  const kind = deviceKind(userId, device, byId);
  if (!kind) return false;
  if (kind.kind === "person") return true;
  const binding = readBinding(device);
  if (!binding || binding.can_approve !== true || binding.account_computer_id !== kind.account_computer_id) return false;
  if (verified && !verified.has(binding.approver_id)) return false;
  if (!bindingChecks(userId, device, binding, byId)) return false;
  return mayApprove(userId, byId.get(binding.approver_id), byId, verified, new Set([...seen, device.id]));
}

/// A person device pinned over the tunnel (POST /api/v1/peer/vault/anchor):
/// the one place this computer's trust starts from.
export type Anchor = { id: string; sign_public: string };

/// Members this computer can vouch for, walked strictly FORWARD from its
/// anchors: a device is reached only through an approval signed by a
/// device already reached that may approve, and is what that approval
/// says (approval/v2; v1 = a person-device). A computer is reached only
/// with a v2 approval of kind computer and a valid binding for the same
/// account computer, signed by a reached device that may approve. Trust
/// never flows back from a device to whoever the account says approved it
/// — the account could name an approver it invented. An anchor counts only
/// while the roster gives it the key it was pinned with, and never as a
/// computer.
export function verifiedIds(userId: string | number, devices: VaultDevice[], anchors: Anchor[]): Set<string> {
  const byId = new Map(devices.map((d) => [d.id, d]));
  const verified = new Set(
    anchors
      .filter((a) => {
        const d = byId.get(a.id);
        return !!d && d.status !== "revoked" && d.sign_public === a.sign_public && !isComputer(d) && deviceKind(userId, d, byId)?.kind !== "computer";
      })
      .map((a) => a.id),
  );
  for (let changed = true; changed; ) {
    changed = false;
    for (const device of devices) {
      if (verified.has(device.id) || device.status === "revoked" || !device.approval) continue;
      const approver = byId.get(device.approval.approver_id);
      if (!approver || approver.id === device.id || !verified.has(approver.id)) continue;
      if (!mayApprove(userId, approver, byId, verified)) continue;
      const kind = deviceKind(userId, device, byId);
      if (!kind) continue;
      if (kind.kind === "computer") {
        const binding = readBinding(device);
        if (!binding || binding.account_computer_id !== kind.account_computer_id || !verified.has(binding.approver_id)) continue;
        if (!bindingChecks(userId, device, binding, byId) || !mayApprove(userId, byId.get(binding.approver_id), byId, verified)) continue;
      }
      verified.add(device.id);
      changed = true;
    }
  }
  return verified;
}

/// Whom this computer takes epoch keys from: verified from its anchors,
/// trusted, and allowed to approve.
export function trustedSigners(userId: string | number, devices: VaultDevice[], anchors: Anchor[]): Map<string, Uint8Array> {
  const byId = new Map(devices.map((d) => [d.id, d]));
  const verified = verifiedIds(userId, devices, anchors);
  return new Map(
    devices
      .filter((d) => d.status === "trusted" && verified.has(d.id) && mayApprove(userId, d, byId, verified))
      .map((d) => [d.id, fromHex(d.sign_public)]),
  );
}

// ── the local keys ───────────────────────────────────────────────────────

export interface LocalVault {
  /// The account's user id (the vault's user_id).
  userId: string;
  /// This server's account computer id, the device is bound to.
  accountComputerId: string | null;
  deviceId: string | null;
  keys: DeviceKeys;
  epochs: Map<number, Uint8Array>;
  /// The person devices pinned over the tunnel (POST /api/v1/peer/vault/anchor).
  anchors: Anchor[];
}

export interface KeyStore {
  read(): LocalVault | null;
  write(local: LocalVault): void;
  clear(): void;
  /// false for the Desktop's hand-over: nothing is written.
  readonly persistent: boolean;
}

function serialise(local: LocalVault) {
  return {
    v: 1,
    userId: local.userId,
    accountComputerId: local.accountComputerId,
    deviceId: local.deviceId,
    encPrivate: toHex(local.keys.encPrivate), signPrivate: toHex(local.keys.signPrivate),
    encPublic: toHex(local.keys.encPublic), signPublic: toHex(local.keys.signPublic),
    epochs: Object.fromEntries([...local.epochs].map(([epoch, value]) => [epoch, toHex(value)])),
    anchors: local.anchors,
  };
}

function deserialise(raw: unknown): LocalVault | null {
  try {
    const saved = raw as Record<string, unknown>;
    if (!saved || typeof saved !== "object" || typeof saved.userId !== "string") return null;
    return {
      userId: saved.userId,
      accountComputerId: typeof saved.accountComputerId === "string" ? saved.accountComputerId : null,
      deviceId: typeof saved.deviceId === "string" ? saved.deviceId : null,
      keys: {
        encPrivate: fromHex(saved.encPrivate as string), signPrivate: fromHex(saved.signPrivate as string),
        encPublic: fromHex(saved.encPublic as string), signPublic: fromHex(saved.signPublic as string),
      },
      epochs: new Map(Object.entries((saved.epochs as Record<string, string>) || {}).map(([epoch, hex]) => [Number(epoch), fromHex(hex)])),
      anchors: Array.isArray(saved.anchors)
        ? (saved.anchors as unknown[]).flatMap((a) => {
            const x = a as Record<string, unknown> | null;
            return x && typeof x.id === "string" && typeof x.sign_public === "string" && /^[0-9a-f]{64}$/.test(x.sign_public) ? [{ id: x.id, sign_public: x.sign_public }] : [];
          })
        : [],
    };
  } catch {
    return null;
  }
}

/// DATA_DIR/vault.json, 0600.
export function fileKeyStore(path: string): KeyStore {
  return {
    persistent: true,
    read: () => deserialise(readJsonFile(path)),
    write(local) {
      writePrivateFile(path, `${JSON.stringify(serialise(local), null, 2)}\n`);
      if (!deserialise(readJsonFile(path))) throw new VaultError("secure_storage_failed");
    },
    clear: () => rmSync(path, { force: true }),
  };
}

/// Memory only (the Desktop's hand-over, tests).
export function memoryKeyStore(initial: LocalVault | null = null): KeyStore {
  let held = initial;
  return {
    persistent: false,
    read: () => (held ? { ...held, epochs: new Map(held.epochs), anchors: [...held.anchors] } : null),
    write(local) {
      held = { ...local, epochs: new Map(local.epochs), anchors: [...local.anchors] };
    },
    clear() {
      held = null;
    },
  };
}

// ── the account's vault, as this computer calls it ───────────────────────

/// twoody-desktop's accountApi, over this server's backendCall (the
/// headless computer's own session, or the Desktop's). 409 (some event ids
/// clash) and 422 invalid_event are answers about a batch, not failures.
export function accountVaultApi(creds: () => BackendCredentials | null): ComputerVaultApi & EventsApi & DesktopBindingApi {
  const call = async <T>(path: string, body?: unknown, timeoutMs = 15_000): Promise<T> => {
    const c = creds();
    if (!c) throw new VaultError("not_linked");
    return (await backendCall<T>(c, path, { body, timeoutMs })).body;
  };
  return {
    state: () => call("vault"),
    createDevice: (body) => call("vault/devices", body),
    envelopes: (deviceId) => call(`vault/envelopes?device_id=${encodeURIComponent(deviceId)}`),
    publishDesktopBinding: (deviceId, desktopBinding) => call(`vault/devices/${encodeURIComponent(deviceId)}/desktop_binding`, { desktop_binding: desktopBinding }),
    postEvents: async (events) => {
      try {
        return await call("vault/events", { events }, 30_000);
      } catch (err) {
        if (err instanceof BackendError && (err.status === 409 || err.code === "invalid_event")) return (err.body ?? { error: err.code ?? undefined }) as { conflicts?: string[] };
        throw err;
      }
    },
    events: ({ after = 0, limit = 200, stream, conversationId }) => {
      const query = new URLSearchParams({ after: String(after), limit: String(limit) });
      if (stream) query.set("stream", stream);
      if (conversationId) query.set("conversation_id", conversationId);
      return call(`vault/events?${query.toString()}`);
    },
  };
}

// ── enrolment ────────────────────────────────────────────────────────────

export type ComputerVaultStatus = "none" | "unregistered" | "pending" | "trusted" | "revoked";

export function createComputerVaultClient({ api, store, userId, accountComputerId, label = "Twoody Server", random, bindingKeys }: {
  api: ComputerVaultApi;
  store: KeyStore;
  /// The account's user id.
  userId: string | number;
  /// This server's account computer id (account.json computer.id).
  accountComputerId: string;
  label?: string;
  random?: Random;
  /// This computer's tunnel and pairing public keys: its binding must name them.
  bindingKeys?: () => { tunnel_public_key: string; pairing_public_key: string } | null;
}) {
  const user = String(userId);

  /// The local keys, when they are this account's and this computer's.
  function readLocal(): LocalVault | null {
    const local = store.read();
    if (!local || local.userId !== user || local.accountComputerId !== accountComputerId) return null;
    return local;
  }

  const mineIn = (devices: VaultDevice[], local: LocalVault | null) =>
    local ? devices.find((d) => d.sign_public === toHex(local.keys.signPublic) && d.enc_public === toHex(local.keys.encPublic)) : undefined;

  /// What this computer's binding says, as the other devices will read it.
  function ownBinding(mine: VaultDevice | undefined, devices: VaultDevice[]): "missing" | "valid" | "invalid" {
    if (!mine) return "missing";
    const binding = readBinding(mine);
    if (!binding) return mine.binding ? "invalid" : "missing";
    const byId = new Map(devices.map((d) => [d.id, d]));
    const keys = bindingKeys?.() ?? null;
    const ours = binding.account_computer_id === accountComputerId && binding.can_approve === false
      && (!keys || (binding.tunnel_public_key === keys.tunnel_public_key && binding.pairing_public_key === keys.pairing_public_key));
    const signed = deviceKind(user, mine, byId);
    const approvedAsThis = signed?.kind === "computer" && signed.account_computer_id === accountComputerId;
    const verified = verifiedIds(user, devices, readLocal()?.anchors ?? []);
    return ours && approvedAsThis && verified.has(binding.approver_id) && bindingChecks(user, mine, binding, byId) && mayApprove(user, byId.get(binding.approver_id), byId, verified) ? "valid" : "invalid";
  }

  async function status() {
    const state = await api.state();
    const local = readLocal();
    const devices = state.devices || [];
    const mine = mineIn(devices, local);
    let current: ComputerVaultStatus;
    if (!devices.some((d) => d.status === "trusted")) current = "none";
    else if (!mine) current = "unregistered";
    else if (mine.status === "revoked") current = "revoked";
    else if (mine.status === "trusted" && local!.epochs.size > 0) current = "trusted";
    else current = "pending";
    return {
      status: current,
      epoch: state.epoch || 0,
      needs_rotation: state.needs_rotation === true,
      device: mine || null,
      binding: ownBinding(mine, devices),
      fingerprint: local ? fingerprint(local.keys.encPublic, local.keys.signPublic) : null,
      anchored: !!local && verifiedIds(user, devices, local.anchors).size > 0,
      devices,
    };
  }

  /// Registers this computer (again, with new keys, when its device was
  /// revoked or its keys lost). The keys are on disk before the account
  /// hears of them.
  async function requestAccess() {
    let local = readLocal();
    const state = await api.state();
    const known = local && mineIn(state.devices || [], local);
    if (!known || known.status === "revoked" || !local) {
      local = { userId: user, accountComputerId, deviceId: null, keys: createDeviceKeys(random), epochs: new Map(), anchors: [] };
      store.write(local);
      const body = await api.createDevice({ label, enc_public: toHex(local.keys.encPublic), sign_public: toHex(local.keys.signPublic), kind: COMPUTER_KIND, account_computer_id: accountComputerId });
      local.deviceId = body.device.id;
      store.write(local);
    } else if (local.deviceId !== known.id) {
      local.deviceId = known.id;
      store.write(local);
    }
    return { deviceId: local.deviceId as string, fingerprint: fingerprint(local.keys.encPublic, local.keys.signPublic) };
  }

  /// Takes the epoch keys wrapped for this computer by a signer it trusts
  /// (trustedSigners); any other envelope is left, counted in `refused`.
  async function checkApproval(devicesKnown?: VaultDevice[]) {
    const local = readLocal();
    if (!local?.deviceId) throw new VaultError("not_registered");
    const devices = devicesKnown ?? (await api.state()).devices ?? [];
    const signers = trustedSigners(user, devices, local.anchors);
    const { envelopes } = await api.envelopes(local.deviceId);
    const epochs = new Map(local.epochs);
    let approver: VaultDevice | null = null;
    let refused = 0;
    for (const envelope of envelopes || []) {
      if (!signers.has(envelope.from_device)) {
        refused += 1;
        continue;
      }
      try {
        epochs.set(envelope.epoch, unwrapEpochKey(envelope, { userId: user, device: { deviceId: local.deviceId, ...local.keys }, signers }));
        approver = approver || devices.find((d) => d.id === envelope.from_device) || null;
      } catch {
        refused += 1;
      }
    }
    const gained = [...epochs.keys()].filter((epoch) => !local.epochs.has(epoch));
    if (epochs.size === 0) return { approved: false as const, refused, gained };
    if (gained.length > 0) {
      local.epochs = epochs;
      store.write(local);
    }
    return { approved: true as const, refused, gained, approver: approver ? { id: approver.id, label: approver.label, fingerprint: fingerprint(fromHex(approver.enc_public), fromHex(approver.sign_public)) } : null };
  }

  /// What the service does every minute, with nothing asked of anyone: no
  /// vault yet → waits (only a person founds one); not registered, or
  /// revoked → registers (pending: nothing is given until a person
  /// approves it); pending → picks up its keys; trusted → picks up the keys
  /// of a newer epoch.
  async function ensureEnrolled(): Promise<{ status: ComputerVaultStatus; revoked?: boolean }> {
    const current = await status();
    if (current.status === "none") return { status: "none" };
    if (current.status === "unregistered" || current.status === "revoked") {
      if (current.status === "revoked") store.clear();
      await requestAccess();
      return { status: "pending", revoked: current.status === "revoked" };
    }
    if (current.status === "pending") {
      const result = await checkApproval(current.devices);
      return { status: result.approved ? "trusted" : "pending" };
    }
    const local = readLocal();
    if (local && current.epoch > Math.max(0, ...local.epochs.keys())) await checkApproval(current.devices);
    return { status: "trusted" };
  }

  /// The person device approving this computer says who it is, over the
  /// tunnel (never the account): its vault device id and signing key. Kept
  /// with the keys; at most 8, the latest first.
  function pinAnchor(anchor: Anchor) {
    const local = readLocal();
    if (!local?.deviceId) throw new VaultError("not_registered");
    if (!UUID.test(anchor.id) || !/^[0-9a-f]{64}$/.test(anchor.sign_public)) throw new VaultError("bad_anchor");
    if (anchor.id === local.deviceId) throw new VaultError("bad_anchor");
    local.anchors = [anchor, ...local.anchors.filter((a) => a.id !== anchor.id)].slice(0, 8);
    store.write(local);
    return { anchors: local.anchors.length };
  }

  function epochKeys(): Map<number, Uint8Array> {
    const local = readLocal();
    return local ? new Map(local.epochs) : new Map();
  }

  /// This computer's vault public keys, for the person device that will
  /// approve it (GET /api/v1/peer/vault/identity).
  function identity() {
    const local = readLocal();
    if (!local?.deviceId || !UUID.test(local.deviceId)) return null;
    return {
      vault_device_id: local.deviceId,
      enc_public: toHex(local.keys.encPublic),
      sign_public: toHex(local.keys.signPublic),
      fingerprint: fingerprint(local.keys.encPublic, local.keys.signPublic),
    };
  }

  return { status, requestAccess, checkApproval, ensureEnrolled, pinAnchor, epochKeys, identity, readLocal };
}

export type ComputerVaultClient = ReturnType<typeof createComputerVaultClient>;
