import { deriveCapabilities, readBridgeClientEnv, startBridgeClient, type BridgeClientHandle } from "../bridgeClient.js";
import { isPrivateUrl, LOCAL_ONLY } from "../outbound.js";
import { runningTunnel, startTunnelService, type TunnelService } from "../tunnel/index.js";
import { startApprovalLoop, type ApprovalLoop } from "./approvals.js";
import { backendCall, BackendError } from "./backend.js";
import { linkState, onLinkChanged, unlinkRemoved } from "./link.js";
import { buildStatus } from "./statusSource.js";
import { linkedAccount, type LinkedAccount } from "./store.js";

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
  let stopped = false;

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
    try {
      await backendCall(
        { backendUrl: account.backend_url, userToken: account.user_token, deviceToken: account.device_token, credential: account.computer.credential },
        `account_computers/${encodeURIComponent(account.computer.id)}/heartbeat`,
        { body: { status: await buildStatus(), platform: process.platform === "darwin" ? "macos" : process.platform, ...(bridgeDeviceUuid ? { bridge_device_uuid: bridgeDeviceUuid } : {}) } },
      );
      refusals = 0;
      credentialRefusalSaid = false;
      bridgeRefusalSaid = null;
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

    // In local-only mode the backend has to be on the private network for
    // the bridge (which carries turns out); the tunnel's frames are sealed.
    const allowed = !LOCAL_ONLY || (await isPrivateUrl(account.backend_url));
    if (!bridge && !readBridgeClientEnv() && allowed && process.env.TWOODY_ACCOUNT_BRIDGE !== "0") {
      const capabilities = deriveCapabilities();
      bridge = startBridgeClient({
        backendUrl: account.backend_url,
        userToken: account.user_token,
        deviceToken: account.device_token,
        homeAssistantUrl: (process.env.HOME_ASSISTANT_URL ?? "").replace(/\/+$/, ""),
        homeAssistantToken: process.env.HOME_ASSISTANT_TOKEN ?? "",
        deviceNickname: account.computer.name,
        capabilities,
      });
      bridgeDeviceUuid = bridge.deviceId;
    }
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
