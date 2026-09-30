import { join } from "node:path";
import { accountCredentials } from "../account/service.js";
import { linkedAccount, readAccountFile } from "../account/store.js";
import { DATA_DIR, db, users } from "../db.js";
import { tunnelIdentity } from "../tunnel/identity.js";
import { accountVaultApi, createComputerVaultClient, fileKeyStore, type Anchor, type ComputerVaultApi, type ComputerVaultClient, type ComputerVaultStatus, type EventsApi, type LocalVault, type VaultState } from "./client.js";
import { fingerprint, fromHex, toHex, VaultError } from "./crypto.js";
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
//             the epoch keys.
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
  | { kind: "desktop"; local: LocalVault; api: EventsApi; state: () => Promise<VaultState>; sync: VaultSync; bridge: ConversationBridge | null; userId: string };

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

/// Reads the Desktop's hand-over; null when it is not one (or says « none »).
export function readVaultMessage(data: unknown): LocalVault | null {
  const m = (data ?? {}) as Record<string, unknown>;
  if (m.type !== "vault" || !m.keys || typeof m.deviceId !== "string" || !m.deviceId) return null;
  const k = m.keys as Record<string, unknown>;
  const keys = { encPrivate: bytesOf(k.encPrivate), encPublic: bytesOf(k.encPublic), signPrivate: bytesOf(k.signPrivate), signPublic: bytesOf(k.signPublic) };
  if (!keys.encPrivate || !keys.encPublic || !keys.signPrivate || !keys.signPublic) return null;
  const epochs = new Map<number, Uint8Array>();
  const rawEpochs = m.epochs instanceof Map ? Object.fromEntries(m.epochs) : (m.epochs ?? {});
  for (const [epoch, key] of Object.entries(rawEpochs as Record<string, unknown>)) {
    const bytes = bytesOf(key);
    if (Number.isInteger(Number(epoch)) && Number(epoch) > 0 && bytes) epochs.set(Number(epoch), bytes);
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
  return { userId, accountComputerId: null, deviceId: m.deviceId, keys: keys as LocalVault["keys"], epochs, anchors };
}

/// The Desktop hands its vault over (or takes it back with keys: null).
/// Memory only. Returns whether this server now holds it.
export function setDesktopVault(data: unknown, options: { api?: EventsApi; state?: () => Promise<VaultState>; history?: (userId: string) => LocalHistory } = {}): boolean {
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
  mode = { kind: "desktop", local, api, state, sync, bridge: bridgeFor(sync, () => local.epochs.size > 0, options.history), userId: local.userId };
  notifyVaultChange();
  return true;
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
  return mode.client.pinAnchor(anchor);
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
export async function vaultRosterInput(): Promise<{ userId: string; devices: NonNullable<VaultState["devices"]>; anchors: Anchor[] } | null> {
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
    return { userId: mode.userId, devices: state.devices ?? [], anchors: [...self, ...local.anchors.filter((a) => a.id !== local.deviceId)] };
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
}
