import { join } from "node:path";
import { accountCredentials } from "../account/service.js";
import { linkedAccount, readAccountFile } from "../account/store.js";
import { DATA_DIR, db, users } from "../db.js";
import { tunnelIdentity } from "../tunnel/identity.js";
import { accountVaultApi, createComputerVaultClient, desktopBindingOf, deviceKind, fileKeyStore, isComputer, type Anchor, type ComputerVaultApi, type ComputerVaultClient, type ComputerVaultStatus, type EventsApi, type LocalVault, type VaultDevice, type VaultState } from "./client.js";
import { DEVICE_ACCESS_MAX_TTL_S, signDesktopBinding, signDeviceAccessV2, type DesktopBinding } from "./contracts.js";
import { fingerprint, fromHex, isEpoch, toHex, VaultError } from "./crypto.js";
import { jsonFileStore, memoryStore, type VaultStore } from "./store.js";
import { createConversationBridge, createVaultSync, type ConversationBridge, type LocalHistory, type VaultSync } from "./sync.js";
import { sqliteHistory } from "./localHistory.js";

// The vault inside twoody-server (docs/mesh-design.md §1, §3, lot S1), in
// one of two modes:
//
//   headless  a Pi, a NAS, a Mac mini with nobody at the screen, linked to
//             the account (account.json): it enrols itself as a vault
//             device of kind "computer" (pending until a person device
//             approves it), keeps its keys in DATA_DIR/vault.json (0600),
//             and every minute pushes its sealed turns, pulls the others'
//             and brings them into its discussions.
//   desktop   inside Twoody Desktop: the Desktop keeps custody of the keys
//             (safeStorage) and hands them over by message,
//             {type:"vault", deviceId, keys, epochs, userId}; they are held
//             in memory, never written, and this server never enrols
//             itself. The Desktop's main process already syncs and imports
//             (twoody-desktop src/shared/vaultConversations.ts), so here the
//             vault only answers catch-up (ensureConversation) and gives S5
//             the epoch keys. With the hand-over comes this Mac's account
//             computer ({id, pairing_public_key}): the server signs, with
//             the handed vault key, the Desktop's own desktop-binding-v1
//             (that account computer, reached by this server's tunnel key)
//             and publishes it when the account has none or another one —
//             the mesh then counts this Desktop as one of its computers
//             (vault/roster.ts), and it stays a person-device.
//
// What other lots use: vaultIdentity() (GET /api/v1/peer/vault/identity),
// pinVaultAnchor() (POST /api/v1/peer/vault/anchor),
// vaultEpochKeys() and vaultContext() (S5 memories), ensureConversation()
// (S4 catch-up), sealAnsweredTurn() (called after an answer is written).

const TICK_MS = 60_000;
const FIRST_TICK_MS = 5_000;

type Mode =
  | { kind: "off" }
  | { kind: "headless"; client: ComputerVaultClient; api: ComputerVaultApi & EventsApi; sync: VaultSync; syncStore: VaultStore & { clear(): void }; bridge: ConversationBridge | null; userId: string; accountComputerId: string; status: ComputerVaultStatus | null }
  | { kind: "desktop"; local: DesktopVault; api: EventsApi; state: () => Promise<VaultState>; sync: VaultSync; bridge: ConversationBridge | null; userId: string; computer: DesktopComputer | null; publish: PublishDesktopBinding };

/// This Mac as the account knows it, handed by the Desktop with its keys.
export type DesktopComputer = { id: string; pairingPublicKey: string };
export type PublishDesktopBinding = (deviceId: string, desktopBinding: string) => Promise<unknown>;

let mode: Mode = { kind: "off" };

export const vaultKeysPath = () => join(process.env.TWOODY_DATA_DIR ?? DATA_DIR, "vault.json");
export const vaultHistoryPath = () => join(process.env.TWOODY_DATA_DIR ?? DATA_DIR, "vault-history.json");

/// The owner of this server (single-user: the first user), whose discussions the vault feeds.
function ownerId(): string | null {
  return db.select({ id: users.id }).from(users).limit(1).all()[0]?.id ?? null;
}

function selfOf(): { id: string | null; name: string | null } {
  const creds = accountCredentials();
  return { id: creds?.computerId ?? null, name: creds?.computerName ?? null };
}

function bridgeFor(sync: VaultSync, trusted: () => boolean, history?: (userId: string) => LocalHistory): ConversationBridge | null {
  const owner = ownerId();
  if (!owner) return null;
  return createConversationBridge({ sync, local: (history ?? sqliteHistory)(owner), userId: owner, trusted, self: selfOf });
}

// ── desktop mode ─────────────────────────────────────────────────────────

const HEX32 = /^[0-9a-f]{64}$/;
const bytesOf = (value: unknown): Uint8Array | null => {
  if (typeof value === "string" && HEX32.test(value)) return fromHex(value);
  if (value instanceof Uint8Array && value.length === 32) return Uint8Array.from(value);
  if (Array.isArray(value) && value.length === 32 && value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) return Uint8Array.from(value as number[]);
  return null;
};

/// The Desktop's hand-over as held here: with the vault devices it revoked
/// (its append-only list), which stay revoked here whatever the account
/// says (vault/roster.ts buildRoster).
export type DesktopVault = LocalVault & { revoked: string[] };
/// The revoked devices kept, at most (the Desktop hands its latest 256).
const MAX_REVOKED = 256;

/// Reads the Desktop's hand-over; null when it is not one (or says « none »).
export function readVaultMessage(data: unknown): DesktopVault | null {
  const m = (data ?? {}) as Record<string, unknown>;
  if (m.type !== "vault" || !m.keys || typeof m.deviceId !== "string" || !m.deviceId) return null;
  const k = m.keys as Record<string, unknown>;
  const keys = { encPrivate: bytesOf(k.encPrivate), encPublic: bytesOf(k.encPublic), signPrivate: bytesOf(k.signPrivate), signPublic: bytesOf(k.signPublic) };
  if (!keys.encPrivate || !keys.encPublic || !keys.signPrivate || !keys.signPublic) return null;
  const epochs = new Map<number, Uint8Array>();
  const rawEpochs = m.epochs instanceof Map ? Object.fromEntries(m.epochs) : (m.epochs ?? {});
  for (const [epoch, key] of Object.entries(rawEpochs as Record<string, unknown>)) {
    const bytes = bytesOf(key);
    const n = Number(epoch);
    // Written as a plain number, safe and far from 2**53 (crypto.ts isEpoch).
    if (/^[1-9][0-9]{0,9}$/.test(epoch) && isEpoch(n) && bytes) epochs.set(n, bytes);
  }
  const userId = typeof m.userId === "string" || typeof m.userId === "number" ? String(m.userId) : readAccountFile()?.account_id !== undefined ? String(readAccountFile()!.account_id) : null;
  if (!userId) return null;
  // The person devices the Desktop verified (its own walk), to start this
  // server's roster from (vault/roster.ts): up to 8, like pinned anchors.
  const anchors: Anchor[] = Array.isArray(m.anchors)
    ? (m.anchors as unknown[]).flatMap((a) => {
        const x = a as Record<string, unknown> | null;
        return x && typeof x.id === "string" && x.id.length <= 64 && typeof x.sign_public === "string" && HEX32.test(x.sign_public) ? [{ id: x.id, sign_public: x.sign_public }] : [];
      }).slice(0, 8)
    : [];
  const revoked = Array.isArray(m.revoked)
    ? [...new Set((m.revoked as unknown[]).filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 64))].slice(-MAX_REVOKED)
    : [];
  return { userId, accountComputerId: null, deviceId: m.deviceId, keys: keys as LocalVault["keys"], epochs, anchors, revoked };
}

/// The account computer the Desktop says this Mac is, with its pairing key
/// ({computer: {id, pairing_public_key}} in the hand-over); null without one.
export function readDesktopComputer(data: unknown): DesktopComputer | null {
  const c = ((data ?? {}) as Record<string, unknown>).computer as Record<string, unknown> | null | undefined;
  if (!c || typeof c !== "object") return null;
  const id = typeof c.id === "string" || typeof c.id === "number" ? String(c.id) : "";
  const pairing = typeof c.pairing_public_key === "string" ? c.pairing_public_key.toLowerCase() : "";
  if (!id || id.length > 64 || !/^[A-Za-z0-9-]+$/.test(id) || !HEX32.test(pairing)) return null;
  return { id, pairingPublicKey: pairing };
}

/// The Desktop hands its vault over (or takes it back with keys: null).
/// Memory only. Returns whether this server now holds it.
export function setDesktopVault(data: unknown, options: { api?: EventsApi; state?: () => Promise<VaultState>; history?: (userId: string) => LocalHistory; publish?: PublishDesktopBinding } = {}): boolean {
  const local = readVaultMessage(data);
  if (mode.kind === "headless") stopTimer();
  if (!local) {
    mode = { kind: "off" };
    notifyVaultChange();
    return false;
  }
  const account = accountVaultApi(() => {
    const creds = accountCredentials();
    return creds ? { backendUrl: creds.backendUrl, userToken: creds.userToken, deviceToken: creds.deviceToken } : null;
  });
  const api = options.api ?? account;
  const state = options.state ?? (() => account.state());
  const epochKeys = () => new Map(local.epochs);
  const sync = createVaultSync({ api, epochKeys, userId: local.userId, store: memoryStore() });
  const publish = options.publish ?? ((deviceId: string, binding: string) => account.publishDesktopBinding(deviceId, binding));
  mode = { kind: "desktop", local, api, state, sync, bridge: bridgeFor(sync, () => local.epochs.size > 0, options.history), userId: local.userId, computer: readDesktopComputer(data), publish };
  desktopBindingTried = null;
  notifyVaultChange();
  return true;
}

// ── the Desktop's desktop-binding ────────────────────────────────────────

/// The last binding asked for and when it failed: not asked again for 5 min.
let desktopBindingTried: { key: string; at: number } | null = null;
let desktopBindingRunning: Promise<unknown> | null = null;
const DESKTOP_BINDING_RETRY_MS = 5 * 60_000;

/// This Desktop's own binding, as it must read: its vault device, its
/// account computer and pairing key (handed), this server's tunnel key.
function wantedDesktopBinding(): DesktopBinding | null {
  if (mode.kind !== "desktop" || !mode.computer || !mode.local.deviceId) return null;
  // The account message names another computer for this server: neither is said.
  const named = accountCredentials()?.computerId;
  if (named && named !== mode.computer.id) return null;
  let tunnel: string;
  try {
    tunnel = tunnelIdentity().publicKey.toString("hex");
  } catch {
    return null;
  }
  return { vault_device_id: mode.local.deviceId, account_computer_id: mode.computer.id, tunnel_public_key: tunnel, pairing_public_key: mode.computer.pairingPublicKey };
}

/// Inside Twoody Desktop: signs (with the handed vault key) and publishes
/// this Desktop's desktop-binding when the account shows none, or one that
/// says something else (new tunnel key, another account computer) — only
/// once this device is a trusted person-device holding epoch keys. Called
/// with the devices each time the roster looks (every minute at most).
export async function ensureDesktopBinding(devices: VaultDevice[], now = Date.now()): Promise<"published" | "current" | "skipped" | "failed"> {
  if (mode.kind !== "desktop" || mode.local.epochs.size === 0) return "skipped";
  const wanted = wantedDesktopBinding();
  if (!wanted) return "skipped";
  const { local, userId, publish } = mode;
  const byId = new Map(devices.map((d) => [d.id, d]));
  const mine = byId.get(wanted.vault_device_id);
  if (!mine || mine.status !== "trusted" || mine.sign_public !== toHex(local.keys.signPublic) || isComputer(mine)) return "skipped";
  if (deviceKind(userId, mine, byId)?.kind !== "person") return "skipped";
  const current = desktopBindingOf(userId, mine, byId);
  if (current && current.account_computer_id === wanted.account_computer_id && current.tunnel_public_key === wanted.tunnel_public_key && current.pairing_public_key === wanted.pairing_public_key) return "current";
  const key = JSON.stringify(wanted);
  if (desktopBindingRunning) return "skipped";
  if (desktopBindingTried?.key === key && now - desktopBindingTried.at < DESKTOP_BINDING_RETRY_MS) return "skipped";
  const wire = { ...wanted, signature: signDesktopBinding({ userId, binding: wanted, signPrivate: local.keys.signPrivate }) };
  desktopBindingRunning = publish(wanted.vault_device_id, JSON.stringify(wire));
  try {
    await desktopBindingRunning;
    desktopBindingTried = null;
    notifyVaultChange();
    return "published";
  } catch {
    desktopBindingTried = { key, at: now };
    return "failed";
  } finally {
    desktopBindingRunning = null;
  }
}

// ── the Desktop asking another computer as its own ───────────────────────

/// How long the device-access this server signs for a peer request holds:
/// half the most a computer takes (DEVICE_ACCESS_MAX_TTL_S), so that a
/// clock a few hours ahead here is not refused there.
export const PEER_DEVICE_ACCESS_TTL_S = DEVICE_ACCESS_MAX_TTL_S / 2;

/// Inside Twoody Desktop, when this server asks computer `targetComputerId`
/// for a peer session as the Desktop's own computer of the account
/// (`requesterComputerId`, the one the Desktop handed over): a
/// device-access/v2 signed with the Desktop's vault key, for this server's
/// tunnel key and that computer, expiring within 12 h. The computer asked
/// then knows which person device the session is — once it checks the
/// signature and that device's desktop-binding names this very computer
/// and key (sessionTrust.ts peerSessionIsDesktop) — and lets it name
/// itself as its vault anchor (« Faire confiance »). Null otherwise: no
/// Desktop vault, no device yet, another computer asking, or the account
/// naming another computer for this server.
export function peerDeviceAccess(targetComputerId: string, requesterComputerId: string, now = Date.now()) {
  if (mode.kind !== "desktop" || !mode.local.deviceId || !mode.computer || mode.computer.id !== requesterComputerId) return null;
  const named = accountCredentials()?.computerId;
  if (named && named !== mode.computer.id) return null;
  if (!targetComputerId || targetComputerId === requesterComputerId) return null;
  let tunnel: string;
  try {
    tunnel = tunnelIdentity().publicKey.toString("hex");
  } catch {
    return null;
  }
  const access = { vault_device_id: mode.local.deviceId, tunnel_public_key: tunnel, account_computer_id: targetComputerId, exp: Math.floor(now / 1000) + PEER_DEVICE_ACCESS_TTL_S };
  try {
    return { ...access, signature: signDeviceAccessV2({ userId: mode.userId, access, signPrivate: mode.local.keys.signPrivate }) };
  } catch {
    return null;
  }
}

// ── headless mode ────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
function stopTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
}

/// This computer's tunnel and pairing public keys, as its binding must name them.
function bindingKeys() {
  const file = readAccountFile();
  if (!file) return null;
  try {
    const tunnel = tunnelIdentity().publicKey;
    return { tunnel_public_key: Buffer.from(tunnel).toString("hex"), pairing_public_key: file.pairing_key.pub };
  } catch {
    return null;
  }
}

/// Starts the headless vault when this server is linked (account.json) and
/// no Desktop runs it. `api` and `intervalMs` for tests.
export function startVaultService(options: { log?: (message: string) => void; api?: ComputerVaultApi & EventsApi; intervalMs?: number; history?: (userId: string) => LocalHistory; firstTickMs?: number } = {}) {
  const log = options.log ?? (() => undefined);
  const schedule = (ms: number) => {
    stopTimer();
    timer = setTimeout(() => void tick().finally(() => schedule(options.intervalMs ?? TICK_MS)), ms);
    timer.unref?.();
  };

  function ensureHeadless(): Extract<Mode, { kind: "headless" }> | null {
    if (mode.kind === "desktop") return null;
    const account = linkedAccount();
    const userId = account?.account_id !== undefined ? String(account.account_id) : null;
    if (!account || !userId) {
      mode = { kind: "off" };
      return null;
    }
    if (mode.kind === "headless" && mode.userId === userId && mode.accountComputerId === account.computer.id) {
      if (!mode.bridge) mode.bridge = bridgeFor(mode.sync, () => mode.kind === "headless" && mode.status === "trusted", options.history);
      return mode;
    }
    const api = options.api ?? accountVaultApi(() => {
      const linked = linkedAccount();
      return linked ? { backendUrl: linked.backend_url, userToken: linked.user_token, deviceToken: linked.device_token } : null;
    });
    const client = createComputerVaultClient({ api, store: fileKeyStore(vaultKeysPath()), userId, accountComputerId: account.computer.id, label: account.computer.name || "Twoody Server", bindingKeys });
    const syncStore = jsonFileStore(vaultHistoryPath());
    const sync = createVaultSync({ api, epochKeys: () => client.epochKeys(), userId, store: syncStore });
    const next: Extract<Mode, { kind: "headless" }> = { kind: "headless", client, api, sync, syncStore, bridge: null, userId, accountComputerId: account.computer.id, status: null };
    next.bridge = bridgeFor(sync, () => next.status === "trusted", options.history);
    mode = next;
    return next;
  }

  async function tick() {
    const current = ensureHeadless();
    if (!current) return { status: "off" as const };
    try {
      const enrolled = await current.client.ensureEnrolled();
      if (enrolled.revoked) {
        // Made untrusted: what it opened goes; it can read nothing new.
        await current.sync.forget().catch(() => null);
        current.syncStore.clear();
        log("Vault: this computer was removed from the encrypted history; registered again, waiting for approval.");
      }
      if (enrolled.pruned?.length) log(`Vault: ${enrolled.pruned.length} pinned device(s) revoked in the encrypted history, no longer trusted here.`);
      if (enrolled.status !== current.status) log(`Vault: ${enrolled.status}.`);
      current.status = enrolled.status;
      const synced = enrolled.status === "trusted" && current.bridge ? await current.bridge.run() : null;
      notifyVaultChange();
      return { status: enrolled.status, synced };
    } catch (err) {
      log(`Vault: ${err instanceof Error ? err.message : String(err)}`);
      return { status: current.status ?? ("error" as const), error: err instanceof Error ? err.message : String(err) };
    }
  }

  schedule(options.firstTickMs ?? FIRST_TICK_MS);
  return {
    tick,
    stop() {
      stopTimer();
    },
  };
}

// ── what the other lots call ─────────────────────────────────────────────

export function vaultMode(): "off" | "headless" | "desktop" {
  return mode.kind;
}

/// This computer's vault public keys (never a private one), for the person
/// device that approves it; null before it is registered.
export function vaultIdentity() {
  if (mode.kind === "desktop") {
    const { local } = mode;
    return {
      custody: "desktop" as const,
      vault_device_id: local.deviceId,
      enc_public: toHex(local.keys.encPublic),
      sign_public: toHex(local.keys.signPublic),
      fingerprint: fingerprint(local.keys.encPublic, local.keys.signPublic),
      status: local.epochs.size > 0 ? "trusted" : "pending",
    };
  }
  if (mode.kind !== "headless") return null;
  const id = mode.client.identity();
  if (!id) return null;
  return { custody: "server" as const, ...id, kind: "computer" as const, account_computer_id: mode.accountComputerId, can_approve: false as const, status: mode.status ?? "pending", ...bindingKeys() };
}

/// The person device approving this computer pins itself, over the tunnel
/// (POST /api/v1/peer/vault/anchor): headless only.
export function pinVaultAnchor(anchor: { id: string; sign_public: string }) {
  if (mode.kind !== "headless") throw new VaultError(mode.kind === "desktop" ? "desktop_custody" : "not_enrolled");
  const result = mode.client.pinAnchor(anchor);
  // The roster walks from the anchors: it looks again at once.
  if (result.pinned) notifyVaultChange();
  return result;
}

/// The person devices this headless computer pinned, read now; null inside
/// Twoody Desktop or without vault keys here (routes/peerVault.ts, the
/// first anchor).
export function vaultAnchorsHeld(): Anchor[] | null {
  if (mode.kind !== "headless") return null;
  return mode.client.readLocal()?.anchors ?? null;
}

/// The epoch keys this computer holds now (S5).
export function vaultEpochKeys(): Map<number, Uint8Array> {
  if (mode.kind === "desktop") return new Map(mode.local.epochs);
  if (mode.kind === "headless") return mode.client.epochKeys();
  return new Map();
}

/// What S5 needs to read and write another stream: the account's events
/// API, the vault's user id and this device's id.
export function vaultContext(): { api: EventsApi; userId: string; deviceId: string | null } | null {
  if (mode.kind === "desktop") return { api: mode.api, userId: mode.userId, deviceId: mode.local.deviceId };
  if (mode.kind === "headless") return { api: mode.api, userId: mode.userId, deviceId: mode.client.readLocal()?.deviceId ?? null };
  return null;
}

/// Catch-up for a question on vault conversation `vaultConversationId`
/// (S4): see ConversationBridge.ensureConversation.
export async function ensureConversation(vaultConversationId: string, knownRefs: string[], timeoutMs = 1000) {
  const bridge = mode.kind === "off" ? null : mode.bridge ?? (mode.bridge = bridgeFor(mode.sync, () => vaultEpochKeys().size > 0));
  if (!bridge) return { status: "unavailable" as const, discussionId: null, missing: [...knownRefs] };
  return bridge.ensureConversation(vaultConversationId, knownRefs, timeoutMs);
}

/// Called once an answer is written: a headless computer seals its turn of
/// a synchronised conversation. Inside Twoody Desktop the Desktop does
/// (recordLocalTurn), so nothing is sealed twice.
export async function sealAnsweredTurn(discussionId: string, ref: string | null) {
  if (!ref || mode.kind !== "headless" || mode.status !== "trusted" || !mode.bridge) return { sealed: false as const };
  return mode.bridge.sealOwnTurn(discussionId, ref).catch((err) => ({ sealed: false as const, reason: err instanceof VaultError ? err.code : "error" }));
}

/// What the mesh roster is built from (vault/roster.ts): the account's
/// vault devices and the person devices this computer's trust starts from —
/// headless, those pinned over the tunnel; inside Twoody Desktop, the
/// Desktop's own device and the ones it handed over. Null without a vault
/// here. Throws what the account answered (roster.ts reads 401/404/410).
export async function vaultRosterInput(): Promise<{ userId: string; devices: NonNullable<VaultState["devices"]>; anchors: Anchor[]; revoked?: string[] } | null> {
  if (mode.kind === "headless") {
    const local = mode.client.readLocal();
    if (!local) return null;
    const state = await mode.api.state();
    return { userId: mode.userId, devices: state.devices ?? [], anchors: local.anchors };
  }
  if (mode.kind === "desktop") {
    const { local } = mode;
    const self = local.deviceId ? [{ id: local.deviceId, sign_public: toHex(local.keys.signPublic) }] : [];
    const state = await mode.state();
    // This Desktop's own binding follows what the vault shows (the roster
    // looks again once it is published).
    void ensureDesktopBinding(state.devices ?? []).catch(() => undefined);
    // What the Desktop revoked stays revoked here, whatever the account says.
    return { userId: mode.userId, devices: state.devices ?? [], anchors: [...self, ...local.anchors.filter((a) => a.id !== local.deviceId)], revoked: local.revoked };
  }
  return null;
}

const changeListeners = new Set<() => void>();
function notifyVaultChange() {
  for (const listener of changeListeners) {
    try {
      listener();
    } catch {
      // the listener's own
    }
  }
}
/// Called after each vault tick, and when the Desktop hands its vault over
/// or takes it back: the roster looks again.
export function onVaultChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

/// Tests: back to nothing.
export function resetVaultForTests(): void {
  stopTimer();
  mode = { kind: "off" };
  desktopBindingTried = null;
}
