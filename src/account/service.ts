import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { deriveCapabilities, readBridgeClientEnv, startBridgeClient, type BridgeClientHandle } from "../bridgeClient.js";
import { serveShareInProcess } from "../shares/serve.js";
import { noteEngineComputeShared } from "../engine.js";
import { isPrivateUrl, LOCAL_ONLY } from "../outbound.js";
import { runningTunnel, startTunnelService, type TunnelService } from "../tunnel/index.js";
import { startApprovalLoop, type ApprovalLoop } from "./approvals.js";
import { backendCall, BackendError } from "./backend.js";
import { linkState, onLinkChanged, unlinkRemoved } from "./link.js";
import { buildStatus } from "./statusSource.js";
import { accountPath, ensureBridgeDeviceId, linkedAccount, type LinkedAccount } from "./store.js";

// What a server linked to an account does, once linked
// (docs/multi-computer-design.md §2):
//
//   - a heartbeat every 30 s, with its status (models, load, speed);
//   - the approval loop every 15 s (account/approvals.ts);
//   - the bridge client, so the account can lend its models (« Partager »);
//   - the tunnel, so the account's devices reach it from outside.
//
// The bridge and the tunnel are started here only when the environment has
// not started them already (TWOODY_BACKEND_URL + TWOODY_USER_TOKEN, the way
// before account.json).

/// The account this server acts for with the backend, whoever set it up:
/// account.json (headless), Twoody Desktop's message (it runs this server),
/// or the environment.
export interface AccountCredentials {
  backendUrl: string;
  userToken: string;
  deviceToken?: string;
  /// This computer's id among the account's computers, when known.
  computerId: string | null;
  computerName: string | null;
}

let fromDesktop: AccountCredentials | null = null;

/// Twoody Desktop hands its account over in the tunnel message
/// ({backendUrl, userToken, deviceToken, computerId, computerName}).
export function setDesktopAccount(creds: AccountCredentials | null): void {
  fromDesktop = creds;
}

export function accountCredentials(): AccountCredentials | null {
  const linked = linkedAccount();
  if (linked) {
    return {
      backendUrl: linked.backend_url,
      userToken: linked.user_token,
      deviceToken: linked.device_token,
      computerId: linked.computer.id,
      computerName: linked.computer.name ?? null,
    };
  }
  if (fromDesktop) return fromDesktop;
  const backendUrl = process.env.TWOODY_BACKEND_URL?.replace(/\/+$/, "");
  const userToken = process.env.TWOODY_USER_TOKEN?.trim();
  if (backendUrl && userToken) {
    return {
      backendUrl,
      userToken,
      deviceToken: process.env.TWOODY_DEVICE_TOKEN?.trim() || undefined,
      computerId: process.env.TWOODY_COMPUTER_ID?.trim() || null,
      computerName: process.env.TWOODY_COMPUTER_NAME?.trim() || null,
    };
  }
  return null;
}

/// Whether the backend said, in its own words, that this computer or its
/// session is no longer in the account: 403 {error:"computer_revoked"}, or
/// 401 {error:"session_revoked"|"session_expired"}. The status and the code
/// must go together (twoody-backend 08c052d8).
export function revokedByAccount(err: unknown): err is BackendError {
  if (!(err instanceof BackendError)) return false;
  return (err.status === 403 && err.code === "computer_revoked") || (err.status === 401 && (err.code === "session_revoked" || err.code === "session_expired"));
}

/// This linked server's own bridge device id (account.json). A file linked
/// before it had one gets it here: the id the account already bound to this
/// computer (its host_id), so a server that worked keeps it, or a fresh one
/// — never the machine's ~/.twoody-server/bridge-device-id as such, which
/// another install on the machine may hold. Null when the account could not
/// be asked (tried again on the next beat).
export async function ownBridgeDeviceId(account: LinkedAccount): Promise<string | null> {
  if (account.bridge_device_id) return account.bridge_device_id;
  let bound: string | null = null;
  try {
    const { body } = await backendCall<{ computers?: Array<{ id?: unknown; host_id?: unknown }> }>(
      { backendUrl: account.backend_url, userToken: account.user_token, deviceToken: account.device_token },
      "account_computers",
      { timeoutMs: 8_000 },
    );
    const own = body?.computers?.find((c) => String(c.id) === account.computer.id);
    bound = typeof own?.host_id === "string" ? own.host_id : null;
  } catch {
    return null;
  }
  return ensureBridgeDeviceId(bound);
}

/// Where the keys of sealed shared turns go for this bridge device: beside
/// account.json, this install's own; the machine-wide file only for the id
/// that file was made with (a server that kept it), so its guests need not
/// verify it again.
export function computeKeysPathFor(deviceId: string): string {
  const legacy = join(homedir(), ".twoody-server");
  try {
    if (readFileSync(join(legacy, "bridge-device-id"), "utf8").trim().toLowerCase() === deviceId.toLowerCase()) return join(legacy, "compute-keys.json");
  } catch {
    // No machine-wide id: nothing to keep.
  }
  return join(dirname(accountPath()), "compute-keys.json");
}

export interface AccountService {
  stop(): void;
  /// One heartbeat now (tests).
  heartbeat(): Promise<void>;
  readonly approvals: ApprovalLoop | null;
}

export function startAccountService(options: {
  localBaseUrl: string;
  log?: (message: string) => void;
  onTunnelError?: (err: unknown) => void;
}): AccountService {
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let approvals: ApprovalLoop | null = null;
  let bridge: BridgeClientHandle | null = null;
  let tunnel: TunnelService | null = null;
  let bridgeDeviceUuid: string | null = null;
  let bridgeWanted: boolean | null = null;
  let bridgeStarting: Promise<void> | null = null;
  let stopped = false;

  // The bridge, under this server's own bridge device id. Started with the
  // loops, or on a later beat when the account could not be asked then.
  const startBridge = (account: LinkedAccount): Promise<void> => {
    if (bridge || stopped) return Promise.resolve();
    bridgeStarting ??= (async () => {
      if (bridgeWanted === null) {
        // In local-only mode the backend has to be on the private network
        // for the bridge (which carries turns out).
        const allowed = !LOCAL_ONLY || (await isPrivateUrl(account.backend_url));
        bridgeWanted = !readBridgeClientEnv() && allowed && process.env.TWOODY_ACCOUNT_BRIDGE !== "0";
      }
      if (!bridgeWanted) return;
      const deviceId = await ownBridgeDeviceId(account);
      if (!deviceId || bridge || stopped || linkedAccount()?.computer.id !== account.computer.id) return;
      bridge = startBridgeClient({
        backendUrl: account.backend_url,
        userToken: account.user_token,
        deviceToken: account.device_token,
        homeAssistantUrl: (process.env.HOME_ASSISTANT_URL ?? "").replace(/\/+$/, ""),
        homeAssistantToken: process.env.HOME_ASSISTANT_TOKEN ?? "",
        deviceNickname: account.computer.name,
        deviceId,
        computeKeysPath: computeKeysPathFor(deviceId),
        capabilities: deriveCapabilities(),
        // Requests on folders shared from this computer, served by this very
        // server, which holds the documents (shares/serve.ts).
        serveShare: serveShareInProcess,
        // Shared with someone or not: this server's runtime's slots (engine.ts).
        onComputeShared: noteEngineComputeShared,
      });
      bridgeDeviceUuid = bridge.deviceId;
    })().finally(() => {
      bridgeStarting = null;
    });
    return bridgeStarting;
  };

  // Two refusals in a row and this server leaves the account on its side
  // too: a single one could be a backend's bad second, and linking again
  // means typing a code. Only the backend's own words count (revokedByAccount):
  // a bare 401/403, or a proxy's HTML page, never unlinks.
  let refusals = 0;
  let credentialRefusalSaid = false;
  let bridgeRefusalSaid: string | null = null;
  const heartbeat = async () => {
    const account = linkedAccount();
    if (!account) return;
    if (!bridge && bridgeWanted !== false) await startBridge(account);
    try {
      const { body } = await backendCall<{ bridge?: unknown } | null>(
        { backendUrl: account.backend_url, userToken: account.user_token, deviceToken: account.device_token, credential: account.computer.credential },
        `account_computers/${encodeURIComponent(account.computer.id)}/heartbeat`,
        { body: { status: await buildStatus(), platform: process.platform === "darwin" ? "macos" : process.platform, ...(bridgeDeviceUuid ? { bridge_device_uuid: bridgeDeviceUuid } : {}) } },
      );
      refusals = 0;
      credentialRefusalSaid = false;
      // The beat counted, but the account did not bind this bridge device
      // (twoody-backend 3f67b510: 200 {bridge: "bridge_device_taken" |
      // "bridge_device_mismatch"}): said once, its bridge polls are refused.
      const bridgeRefusal = typeof body?.bridge === "string" && body.bridge.startsWith("bridge_device_") ? body.bridge : null;
      if (bridgeRefusal && bridgeRefusalSaid !== bridgeRefusal) {
        options.log?.(`The Twoody account keeps this server online but does not let it lend its models under bridge device ${(bridgeDeviceUuid ?? "").slice(0, 8)}… (${bridgeRefusal}): reset it from Twoody's « Appareils », or remove the computer that holds it.`);
      }
      bridgeRefusalSaid = bridgeRefusal;
    } catch (err) {
      if (!revokedByAccount(err)) {
        // Anything else — the backend down, a proxy in the way, an error
        // it did not name — says nothing of this computer: next beat, and
        // the count starts again. A wrong computer credential is worth
        // saying (once), not worth leaving the account for.
        refusals = 0;
        if (err instanceof BackendError && err.status === 403 && err.code === "invalid_computer_credential" && !credentialRefusalSaid) {
          credentialRefusalSaid = true;
          options.log?.("The Twoody account does not recognise this server's computer credential (403 invalid_computer_credential). It stays linked; if this goes on: twoody-server logout, then twoody-server login.");
        }
        // Its bridge device refused (bound to another, or held elsewhere):
        // the heartbeat itself was refused, said once.
        if (err instanceof BackendError && err.status === 409 && err.code?.startsWith("bridge_device_") && bridgeRefusalSaid !== err.code) {
          bridgeRefusalSaid = err.code;
          options.log?.(`The Twoody account refuses this server's bridge device (409 ${err.code}): reset it from Twoody's « Appareils », or remove the computer that holds it.`);
        }
        return;
      }
      credentialRefusalSaid = false;
      refusals += 1;
      if (refusals < 2 || stopped) return;
      refusals = 0;
      const dropped = unlinkRemoved();
      options.log?.(
        `The Twoody account refused this server (${err.status}): it was removed from the account, or its access revoked. ` +
          `Unlinked here${dropped ? `, and the ${dropped} access(es) given through the account withdrawn` : ""}. To add it again: twoody-server login`,
      );
    }
  };

  const startLoops = async (account: LinkedAccount) => {
    if (stopped) return;
    const everyMs = Number(process.env.TWOODY_HEARTBEAT_MS) > 0 ? Number(process.env.TWOODY_HEARTBEAT_MS) : 30_000;
    heartbeatTimer ??= setInterval(() => void heartbeat(), everyMs);
    heartbeatTimer.unref();
    approvals ??= startApprovalLoop({ log: options.log });
    await startBridge(account);
    // The tunnel's frames are sealed: local-only mode does not hold it back.
    if (!tunnel && !runningTunnel() && process.env.TWOODY_ACCOUNT_TUNNEL !== "0") {
      tunnel = startTunnelService({
        backendUrl: account.backend_url,
        userToken: account.user_token,
        deviceToken: account.device_token,
        localBaseUrl: options.localBaseUrl,
        onError: options.onTunnelError,
      });
    }
    void heartbeat();
  };

  const stopLoops = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    approvals?.stop();
    approvals = null;
    bridge?.stop();
    bridge = null;
    bridgeDeviceUuid = null;
    bridgeWanted = null;
    tunnel?.stop();
    tunnel = null;
  };

  const follow = () => {
    const account = linkedAccount();
    if (linkState() === "linked" && account) void startLoops(account);
    else if (linkState() === "unlinked") stopLoops();
  };
  const unsubscribe = onLinkChanged(follow);
  follow();

  return {
    get approvals() {
      return approvals;
    },
    heartbeat,
    stop() {
      stopped = true;
      unsubscribe();
      stopLoops();
    },
  };
}
