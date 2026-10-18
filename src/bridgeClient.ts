// Long-poll bridge client: the door through which a Twoody account hands
// this computer the sealed requests of the people it is shared with.
//
// What it runs (11/10/2026, end to end everywhere): another person's turn
// on a computer shared with them (llm_infer sealed with computeSeal, a
// compute grant's principal) — or their warm, the same sealed task, read
// ahead only for the model the runtime holds (compute/guestWarm.ts,
// 18/10/2026) — and a request on a folder shared from here (share_request,
// sealed the same way). Nothing else. The account is taken
// as possibly malicious (AGENTS.md rule 12): a task in clear — a completion
// of the person's own (llm_infer without a seal), a document search or
// read, a folder listing, a transcription, an OCR, a Home Assistant call
// (smart_home_proxy, « Path C ») — is refused before anything runs, so the
// account can neither read nor steer the person's content through it.
// The person's own devices reach this computer through the sealed tunnel
// instead (src/tunnel/). This client no longer pushes Home Assistant's
// states to the account either (the « catalog prewarm »).
//
// Contract (twoody-backend BridgeTasksController):
//   GET  /bridge/tasks/next?wait=25   →  204 or 200 {id, kind, args}
//   PATCH /bridge/tasks/:id            ←  {status: "done"|"error", result|error_message}
//   PATCH /bridge/tasks/:id            ←  {status: "streaming", delta}   (sealed lines, repeated)
//
// Auth: X-User-Token bearer (same token the chat clients use). The managed
// backend binds a session to the device that signed in: a token minted
// for an app is only accepted together with that app's X-Device-Token,
// so a worker that borrows an app's session must send both.
// Identity: X-Bridge-Device-Id (a stable UUID persisted under
// ~/.twoody-server/bridge-device-id so a restart keeps the same row in
// the backend's devices table). A server linked to an account passes its
// own instead (account.json bridge_device_id, account/store.ts), so two
// installs on one machine never send the same id.
// Heartbeat: a worker that serves shared turns also sends
// X-Bridge-Heartbeat on every poll — the models its runtimes hold, the
// one in use, the machine's memory. That list is what lets the apps
// offer each model of a shared computer by name.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { createComputeHost, isSealedTurn, type ComputeKeyStore, type ServeShare } from "./compute/computeHost.js";
import { createGuestWarmer } from "./compute/guestWarm.js";
import { createDeltaRelay } from "./executors/completionStream.js";
import { executeBridgeTask } from "./executors/index.js";
import { configuredDefaultModel, downloadedModels, modelHeldNow } from "./executors/localModels.js";
import { outboundFetch } from "./outbound.js";
import { registerShareHostIdentity } from "./shares/hostIdentity.js";

/// What a worker that serves requests on shared folders declares.
export const FOLDER_SHARE_CAPABILITY = "folder-share-provider";

const POLL_WAIT_SECONDS = 25;
const POLL_BUDGET_MS = (POLL_WAIT_SECONDS + 10) * 1000;
// A long poll only answers when a task arrives or the wait runs out, so
// the first one after a start (or after a failure) is kept short: it is
// how the worker learns, within a second, whether the backend accepts it.
const PROBE_WAIT_SECONDS = 1;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
// A refused token does not fix itself in seconds: asking again that often
// only fills the backend's logs with 401s.
const AUTH_FAILED_BACKOFF_MS = 5 * 60_000;
/// The backend refuses this bridge device for this computer (400
/// bridge_device_required, 409 bridge_device_mismatch / bridge_device_taken,
/// twoody-backend 08c052d8): asking again soon changes nothing, so the loop
/// waits as long as for a refused session, and a compute key is not offered
/// again for an hour.
const DEVICE_REFUSED_BACKOFF_MS = 5 * 60_000;
const COMPUTE_KEY_REFUSED_MS = 60 * 60_000;
const DEVICE_REFUSALS = new Set(["bridge_device_required", "bridge_device_mismatch", "bridge_device_taken"]);

/// The backend's reason for refusing this bridge device, from its answer.
export function bridgeDeviceRefusal(status: number, body: string): string | null {
  if (status !== 400 && status !== 409) return null;
  try {
    const code = (JSON.parse(body) as { error?: unknown }).error;
    return typeof code === "string" && DEVICE_REFUSALS.has(code) ? code : null;
  } catch {
    return null;
  }
}

function explainDeviceRefusal(code: string, deviceId: string): string {
  switch (code) {
    case "bridge_device_mismatch":
      return `the account has another bridge device on record for this computer (this one is ${deviceId.slice(0, 8)}…). Reset it from Twoody's « Appareils » (reset_bridge_device), or restore the old bridge device id.`;
    case "bridge_device_taken":
      return `bridge device ${deviceId.slice(0, 8)}… is already held by another computer or another account. Remove the other computer from the account, or give this one a new bridge-device-id.`;
    default:
      return "the request carried no X-Bridge-Device-Id.";
  }
}

type Task = {
  id: string;
  kind: string;
  args: Record<string, unknown>;
};

// Bounded history of the last upstream-claimed bridge tasks. The
// in-memory `taskMap` in routes/bridge.ts only tracks tasks enqueued
// LOCALLY on this server (smart_home / search / read called by a
// LAN client), so without this ring buffer the /admin dashboard
// has no way to surface "the Pi just claimed a smart_home_proxy
// task from api.twoody.com". Kept here in the same module that
// emits the `claimed task …` log line.
export interface BridgeClientHistoryEntry {
  id:           string;
  kind:         string;
  status:       "claimed" | "completed" | "failed";
  claimed_at:   string;
  completed_at?: string;
  elapsed_ms?:  number;
  error_message?: string;
}

const HISTORY_CAP = 50;
const history: BridgeClientHistoryEntry[] = [];

function recordHistory(entry: BridgeClientHistoryEntry) {
  history.unshift(entry);
  if (history.length > HISTORY_CAP) history.length = HISTORY_CAP;
}

export function bridgeClientHistory(): BridgeClientHistoryEntry[] {
  return history.slice();
}

function updateHistory(id: string, patch: Partial<BridgeClientHistoryEntry>) {
  const entry = history.find((h) => h.id === id);
  if (entry) Object.assign(entry, patch);
}

export interface BridgeClientOptions {
  backendUrl: string;
  userToken: string;
  /// The device token of the app whose session `userToken` belongs to,
  /// when that session is device-bound.
  deviceToken?: string;
  /// Unused since 11/10/2026: Home Assistant is no longer reached on the
  /// account's behalf (smart_home_proxy refused, no catalog pushed). Kept
  /// so that callers written before still type-check.
  homeAssistantUrl?: string;
  homeAssistantToken?: string;
  deviceNickname?: string;
  deviceIdPath?: string;
  /// The bridge device id to use, instead of the one kept at deviceIdPath
  /// (a linked server's own, from account.json).
  deviceId?: string;
  /// Where the keys of sealed shared turns are kept (default: next to the
  /// device id, compute-keys.json).
  computeKeysPath?: string;
  /// Keeps those keys instead of computeKeysPath, which then holds their
  /// public half only (Twoody Desktop: sealed by safeStorage).
  computeKeyStore?: ComputeKeyStore;
  capabilities?: string[];
  /// Called when the link to the backend changes state, so a host
  /// process can tell its user whether this machine is reachable.
  onState?: (state: BridgeClientState) => void;
  /// Called after each completion with the model that ran, so a host
  /// process can show which model this machine last served.
  onServed?: (model: string) => void;
  /// Serves a request on a folder shared from this computer, once opened
  /// (docs/sharing-contracts.md §3): in-process when this server runs the
  /// bridge client itself (a Pi, shares/serve.ts), through the parent
  /// process in the Desktop's worker (bridgeWorker.ts). Without it, share
  /// requests are refused.
  serveShare?: ServeShare;
}

export type BridgeClientState = "online" | "auth_failed" | "unreachable";

export interface BridgeClientHandle {
  stop(): void;
  deviceId: string;
}

export function readBridgeClientEnv(): BridgeClientOptions | null {
  const backendUrl = process.env.TWOODY_BACKEND_URL;
  const userToken = process.env.TWOODY_USER_TOKEN;
  if (!backendUrl || !userToken) return null;

  return {
    backendUrl: backendUrl.replace(/\/+$/, ""),
    userToken,
    deviceToken: process.env.TWOODY_DEVICE_TOKEN?.trim() || undefined,
    deviceNickname: process.env.TWOODY_BRIDGE_DEVICE_NICKNAME,
    capabilities: deriveCapabilities(),
  };
}

/** The task classes this worker takes, sent to the account as
 * `X-Bridge-Capabilities` so it hands each task to a worker that serves
 * it:
 *
 *   local-llm-provider    →  llm_infer, sealed (another person's turn on
 *                            a computer shared with them)
 *   folder-share-provider →  share_request, sealed (added by
 *                            startBridgeClient when a serveShare hook is
 *                            given, not here)
 *
 * The classes of tasks in clear (document-provider, smart-home-proxy,
 * audio-transcribe-provider, ocr-provider) are never declared any more:
 * this client refuses those tasks (11/10/2026), and a worker that says it
 * takes them would only make the account wait for a refusal.
 *
 * `TWOODY_BRIDGE_CAPABILITIES` (comma-separated) still pins the set, but
 * only within what this client serves. */
export const SERVED_CAPABILITIES = ["local-llm-provider", FOLDER_SHARE_CAPABILITY] as const;

export function deriveCapabilities(): string[] {
  const override = process.env.TWOODY_BRIDGE_CAPABILITIES;
  if (override && override.trim().length > 0) {
    return override
      .split(",")
      .map((token) => token.trim())
      .filter((token) => (SERVED_CAPABILITIES as readonly string[]).includes(token));
  }
  const caps: string[] = [];
  if (`${process.env.BRIDGE_LOCAL_LLM_ENDPOINT ?? ""}${process.env.BRIDGE_LOCAL_LLM_ENDPOINTS ?? ""}`.trim().length > 0) {
    caps.push("local-llm-provider");
  }
  return caps;
}

/// The system this worker runs, as the account's device list shows it.
/// Said nothing, a Raspberry Pi was listed there as a Mac.
export function deviceOsName(platform: string = process.platform): string {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    case "win32":
      return "Windows";
    default:
      return platform;
  }
}

export function startBridgeClient(opts: BridgeClientOptions): BridgeClientHandle {
  const deviceId = opts.deviceId ?? resolveDeviceId(opts.deviceIdPath);
  const nickname = asciiHeaderValue(opts.deviceNickname ?? "twoody-server") || "twoody-server";
  const servesLlm = opts.capabilities?.includes("local-llm-provider") ?? false;
  let stopped = false;
  // The account hands a share_request only to a worker that says it can
  // serve one (twoody-backend 6484738a): said only when it can.
  const capabilities = [
    ...(opts.capabilities ?? []),
    ...(opts.serveShare && !opts.capabilities?.includes(FOLDER_SHARE_CAPABILITY) ? [FOLDER_SHARE_CAPABILITY] : []),
  ];
  /// Sent with every request to the backend.
  const authHeaders: Record<string, string> = {
    "X-User-Token": opts.userToken,
    "X-Bridge-Device-Id": deviceId,
    ...(opts.deviceToken ? { "X-Device-Token": opts.deviceToken } : {}),
  };
  // The keys of sealed turns for the people this computer is shared with
  // (compute/computeHost.ts), next to the device id; published to the
  // account at start and when the daily prekey changes.
  // Shared folders' requests are sealed to the same keys: one identity, one
  // safety number for this computer, whatever is shared on it.
  const computeHost = servesLlm || opts.serveShare
    ? createComputeHost({
      path: opts.computeKeysPath ?? join(dirname(opts.deviceIdPath ?? join(homedir(), ".twoody-server", "bridge-device-id")), "compute-keys.json"),
      store: opts.computeKeyStore,
    })
    : null;
  // The safety numbers of the grantees' devices are computed with this
  // identity (GET /local_shares), when the server runs in this process.
  if (computeHost && opts.serveShare) registerShareHostIdentity(() => {
    const { identity } = computeHost.publicKeys();
    return { encPublic: identity.enc_public, signPublic: identity.sign_public };
  });
  let computeKeysPublished = false;
  let computeKeysCheckedAt = 0;
  let computeKeysRefusedUntil = 0;
  let deviceRefusalSaid: string | null = null;
  // What the last completions looked like, for the heartbeat.
  let lastModel: string | null = null;
  let tokensPerSecond: number | null = null;
  // A guest's warm (compute/guestWarm.ts): read for the model the runtime
  // holds only, rarely, one at a time; its answer is not this worker's to
  // report (no onServed, no heartbeat figures).
  const guestWarmer = createGuestWarmer({
    run: (body) => executeBridgeTask("llm_infer", { openai_body_json: JSON.stringify(body) }, { onlyIfLoaded: true }),
    held: modelHeldNow,
    log: (_grantId, outcome) => console.log(`[bridge-client] guest warm: ${outcome}`),
  });

  void pollLoop();

  return {
    stop() {
      stopped = true;
    },
    deviceId,
  };

  async function pollLoop() {
    let consecutiveFailures = 0;
    let state: BridgeClientState | null = null;
    const report = (next: BridgeClientState) => {
      if (next !== state) opts.onState?.(next);
      state = next;
    };
    while (!stopped) {
      try {
        const task = await pollOnce(state === "online" ? POLL_WAIT_SECONDS : PROBE_WAIT_SECONDS);
        consecutiveFailures = 0;
        deviceRefusalSaid = null;
        report("online");
        if (task) {
          console.log(
            `[bridge-client] claimed task ${task.id} kind=${task.kind} args=${isSharedTask(task) || isFolderShareTask(task) ? "<another person's turn>" : argsPreview(task.args)}`,
          );
          recordHistory({
            id:         task.id,
            kind:       task.kind,
            status:     "claimed",
            claimed_at: new Date().toISOString(),
          });
          // A completion can run for a minute or more. Presence on the
          // backend only lives 90 s and is renewed by polling, so the
          // loop keeps polling while the model writes.
          // A share request waits on the server (and, in the Desktop, on its
          // main process): not on the poll either.
          if (task.kind === "llm_infer" || task.kind === "share_request") void handleTask(task);
          else await handleTask(task);
        }
      } catch (error) {
        consecutiveFailures += 1;
        const message = error instanceof Error ? error.message : String(error);
        const authFailed = message.startsWith("auth_failed");
        const deviceRefused = message.startsWith("device_refused ") ? message.slice("device_refused ".length) : null;
        const backoff = deviceRefused
          ? DEVICE_REFUSED_BACKOFF_MS
          : authFailed
            ? AUTH_FAILED_BACKOFF_MS
            : Math.min(BACKOFF_MIN_MS * 2 ** Math.min(consecutiveFailures - 1, 5), BACKOFF_MAX_MS);
        report(authFailed || deviceRefused ? "auth_failed" : "unreachable");
        if (deviceRefused) {
          // Said once, plainly: the same refusal every five minutes is noise.
          if (deviceRefusalSaid !== deviceRefused) {
            deviceRefusalSaid = deviceRefused;
            console.warn(`[bridge-client] the account refuses this bridge device (${deviceRefused}): ${explainDeviceRefusal(deviceRefused, deviceId)} Trying again every ${DEVICE_REFUSED_BACKOFF_MS / 60_000} min.`);
          }
        } else {
          console.warn(
            `[bridge-client] poll failed (attempt ${consecutiveFailures}, backoff ${backoff}ms): ${message}`,
          );
        }
        await sleep(backoff, () => stopped);
      }
    }
  }

  async function pollOnce(waitSeconds: number): Promise<Task | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POLL_BUDGET_MS);
    try {
      const headers: Record<string, string> = {
        ...authHeaders,
        "X-Bridge-Device-Nickname": nickname,
        "X-Bridge-Device-OS": deviceOsName(),
        Accept: "application/json",
      };
      if (capabilities.length > 0) {
        headers["X-Bridge-Capabilities"] = capabilities.join(",");
      }
      if (computeHost && Date.now() >= computeKeysRefusedUntil && (!computeKeysPublished || Date.now() - computeKeysCheckedAt > 60 * 60 * 1000)) {
        computeKeysCheckedAt = Date.now();
        if (computeHost.rotate() || !computeKeysPublished) void publishComputeKeys();
      }
      if (servesLlm) {
        headers["X-Bridge-Heartbeat"] = heartbeatHeader({
          loadedModel: lastModel ?? configuredDefaultModel(),
          tokensPerSecond,
          downloadedModels: await downloadedModels(),
        });
      }
      const res = await outboundFetch(
        `${opts.backendUrl}/bridge/tasks/next?wait=${waitSeconds}`,
        { method: "GET", headers, signal: controller.signal },
      );

      if (res.status === 204) return null;
      if (res.status === 400 || res.status === 409) {
        const body = await res.text().catch(() => "");
        const refusal = bridgeDeviceRefusal(res.status, body);
        if (refusal) throw new Error(`device_refused ${refusal}`);
        throw new Error(`status=${res.status} body=${body.slice(0, 200)}`);
      }
      if (res.status === 401 || res.status === 403) {
        const reason = await res.text().catch(() => "");
        throw new Error(`auth_failed status=${res.status} ${reason.slice(0, 120)}`.trim());
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`status=${res.status} body=${body.slice(0, 200)}`);
      }

      const task = (await res.json()) as Task;
      return task;
    } finally {
      clearTimeout(timer);
    }
  }

  async function handleTask(task: Task) {
    const started = Date.now();
    try {
      const result = await runTask(task);
      await patchTask(task.id, { status: "done", result });
      const elapsed = Date.now() - started;
      console.log(
        `[bridge-client] completed task ${task.id} kind=${task.kind} elapsed=${elapsed}ms`,
      );
      updateHistory(task.id, {
        status: "completed",
        completed_at: new Date().toISOString(),
        elapsed_ms: elapsed,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const elapsed = Date.now() - started;
      console.warn(
        `[bridge-client] failed task ${task.id} kind=${task.kind} elapsed=${elapsed}ms error=${message}`,
      );
      updateHistory(task.id, {
        status: "failed",
        completed_at: new Date().toISOString(),
        elapsed_ms: elapsed,
        error_message: message,
      });
      await patchTask(task.id, { status: "error", error_message: message }).catch((err) => {
        console.warn(
          `[bridge-client] could not PATCH error for task ${task.id}: ${err instanceof Error ? err.message : err}`,
        );
      });
    }
  }

  async function runTask(task: Task): Promise<unknown> {
    // Another person's request on a folder shared from this computer: a
    // sealed share_request and nothing else, whatever the task says.
    if (isFolderShareTask(task)) {
      assertSealedShareTask(task);
      return runSealedShareRequest(task);
    }
    // A share request is only ever a folder share's.
    if (task.kind === "share_request") throw new Error("shared_task_refused");
    // Another person's turn on this computer (a compute grant on the
    // account): a sealed completion and nothing else, whatever the task says.
    if (isSharedTask(task)) {
      assertSealedSharedTask(task);
      return runSealedInference(task);
    }
    // Anything else is a task in clear: the account would read what this
    // computer answers (and could forge what it asks). Refused, whatever
    // its kind, before anything runs.
    throw new Error(plaintextRefusal(task.kind));
  }

  /// Another person's turn, sealed from their device to this computer: the
  /// account relays blocks it cannot read (compute/computeHost.ts).
  async function runSealedInference(task: Task): Promise<unknown> {
    if (!computeHost) throw new Error("shared_task_refused");
    const grantId = String((task.args.principal as { grant_id?: unknown } | undefined)?.grant_id ?? "");
    return computeHost.runSealedTurn({
      args: task.args,
      send: (line) =>
        patchTask(task.id, { status: "streaming", delta: line }).catch((err) => {
          console.warn(`[bridge-client] sealed piece not delivered for task ${task.id}: ${err instanceof Error ? err.message : err}`);
        }),
      runModel: async (body, onPiece) => {
        const ended = guestWarmer.turnStarted(grantId);
        try {
          const result = (await executeBridgeTask("llm_infer", { openai_body_json: JSON.stringify(body) }, {
            onDelta: onPiece,
            onStats: ({ model, completionTokens, latencyMs }) => {
              lastModel = model;
              opts.onServed?.(model);
              if (completionTokens > 0 && latencyMs > 0) {
                const measured = completionTokens / (latencyMs / 1000);
                tokensPerSecond = tokensPerSecond === null ? measured : tokensPerSecond * 0.7 + measured * 0.3;
              }
            },
          })) as { model_used?: string };
          return { model: result?.model_used };
        } finally {
          ended();
        }
      },
      // Answered at once by computeHost; read here when allowed, never
      // awaited by the task.
      warm: (body, warmGrant) => void guestWarmer.request(warmGrant, body),
    });
  }

  /// A grantee's request on a shared folder: opened with this computer's
  /// keys, served by the server, answered sealed (compute/computeHost.ts
  /// runSealedShare).
  async function runSealedShareRequest(task: Task): Promise<unknown> {
    if (!computeHost || !opts.serveShare) throw new Error("shared_task_refused");
    return computeHost.runSealedShare({
      args: task.args,
      serve: opts.serveShare,
      send: (line) =>
        patchTask(task.id, { status: "streaming", delta: line }).catch((err) => {
          console.warn(`[bridge-client] sealed piece not delivered for task ${task.id}: ${err instanceof Error ? err.message : err}`);
        }),
    });
  }

  async function publishComputeKeys(): Promise<void> {
    if (!computeHost) return;
    try {
      const res = await outboundFetch(`${opts.backendUrl}/bridge/compute_key`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(computeHost.publicKeys()),
      });
      computeKeysPublished = res.ok;
      if (!res.ok) {
        const refusal = bridgeDeviceRefusal(res.status, await res.text().catch(() => ""));
        if (refusal) {
          // Not offered again at every poll: in an hour, or after a restart.
          computeKeysRefusedUntil = Date.now() + COMPUTE_KEY_REFUSED_MS;
          console.warn(`[bridge-client] compute keys not published: the account refuses this bridge device (${refusal}): ${explainDeviceRefusal(refusal, deviceId)}`);
        } else {
          console.warn(`[bridge-client] compute keys not published: HTTP ${res.status}`);
        }
      }
    } catch (err) {
      console.warn(`[bridge-client] compute keys not published: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function patchTask(
    id: string,
    body:
      | { status: "done"; result: unknown }
      | { status: "error"; error_message: string }
      | { status: "streaming"; delta: string },
  ) {
    const res = await outboundFetch(`${opts.backendUrl}/bridge/tasks/${id}`, {
      method: "PATCH",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const refusal = bridgeDeviceRefusal(res.status, text);
      if (refusal) throw new Error(`patch_failed: the account refuses this bridge device (${refusal}): ${explainDeviceRefusal(refusal, deviceId)}`);
      throw new Error(`patch_failed status=${res.status} body=${text.slice(0, 200)}`);
    }
  }
}

// ── Tasks in clear ────────────────────────────────────────────────────

/// What the account is told when it hands this computer a task in clear
/// (its error_message, shown to whoever asked): the kind and the way out,
/// never anything of the task. `bridge_plaintext_refused` is the code the
/// account maps to its message.
export function plaintextRefusal(kind: string): string {
  const safe = /^[a-z_]{1,40}$/.test(kind) ? kind : "unknown";
  return `bridge_plaintext_refused:${safe}: this computer answers only sealed requests; ask it from Twoody on a device connected to it (its own encrypted channel), or update the app that asked`;
}

// ── Heartbeat ─────────────────────────────────────────────────────────

const HEARTBEAT_MAX_MODELS = 60;

/// One-line JSON for the X-Bridge-Heartbeat header. A value that could
/// not be measured is left out rather than sent as a misleading zero.
export function heartbeatHeader(input: {
  loadedModel: string | null;
  tokensPerSecond: number | null;
  downloadedModels: string[];
}): string {
  const payload: Record<string, unknown> = {};
  if (input.loadedModel) payload.loaded_model = input.loadedModel;
  payload.ram_total_gb = Math.round((totalmem() / 2 ** 30) * 10) / 10;
  if (input.tokensPerSecond !== null) payload.tok_per_sec_recent = Math.round(input.tokensPerSecond * 10) / 10;
  if (input.downloadedModels.length > 0) payload.downloaded_models = input.downloadedModels.slice(0, HEARTBEAT_MAX_MODELS);
  // Header values must be ASCII; JSON can spell anything else as \uXXXX.
  return JSON.stringify(payload).replace(/[^\x20-\x7e]/g, (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
}

/// A computer name goes into a header as is, and macOS names contain
/// typographic apostrophes and accents ("Jimmy’s MacBook Pro") that an
/// HTTP client refuses there.
export function asciiHeaderValue(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Stable device identity ────────────────────────────────────────────

function resolveDeviceId(explicitPath?: string): string {
  const path = explicitPath ?? join(homedir(), ".twoody-server", "bridge-device-id");
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf-8").trim();
    if (existing) return existing;
  }
  const fresh = randomUUID();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, fresh + "\n", { mode: 0o600 });
  } catch (error) {
    // Best-effort persistence; if the disk write fails we still return
    // the freshly-minted id for this process, accepting that a restart
    // will look like a new device.
    console.warn(
      `[bridge-client] could not persist device id to ${path}: ${error instanceof Error ? error.message : error}`,
    );
  }
  return fresh;
}

/** Compact one-line preview of task args for log lines. Keeps the
 * filename + entity_id visible without dumping multi-kilobyte
 * payloads (PDF reads, LLM prompts) into journalctl. */
/// A turn the account runs on this computer for someone it is shared with.
export function isSharedTask(task: { args?: Record<string, unknown> }): boolean {
  const principal = task.args?.principal as { kind?: unknown } | undefined;
  return principal?.kind === "shared";
}

/// The only thing another person's turn may do here: a completion sealed
/// end to end on their device, run without tools (computeHost's
/// bareCompletion). Anything else — another kind of task, or a question
/// in clear from an app too old to seal it — is refused.
export function assertSealedSharedTask(task: { kind: string; args: Record<string, unknown> }): void {
  if (task.kind !== "llm_infer" || !isSealedTurn(task.args)) throw new Error("shared_task_refused");
}

/// A request of someone a folder of this computer is shared with
/// (docs/sharing-contracts.md §1: principal {kind: "folder_share",
/// share_uuid, revision, grantee_id}).
export function isFolderShareTask(task: { args?: Record<string, unknown> }): boolean {
  const principal = task.args?.principal as { kind?: unknown } | undefined;
  return principal?.kind === "folder_share";
}

/// The only thing a share's principal may do here: a share_request sealed
/// on the grantee's device, with the device's keys beside it. Anything else
/// — another kind (a completion, a search, a read…), or a request in clear —
/// is refused before anything is asked of the server.
export function assertSealedShareTask(task: { kind: string; args: Record<string, unknown> }): void {
  const guest = task.args.guest_key as { enc_public?: unknown; sign_public?: unknown } | undefined;
  if (task.kind !== "share_request" || !isSealedTurn(task.args) || typeof guest?.enc_public !== "string" || typeof guest?.sign_public !== "string") {
    throw new Error("shared_task_refused");
  }
}

function argsPreview(args: Record<string, unknown>): string {
  try {
    const preview: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (typeof v === "string") {
        preview[k] = v.length > 80 ? v.slice(0, 77) + "…" : v;
      } else if (typeof v === "number" || typeof v === "boolean" || v === null) {
        preview[k] = v;
      } else {
        preview[k] = `<${Array.isArray(v) ? "array" : typeof v}>`;
      }
    }
    return JSON.stringify(preview);
  } catch {
    return "<unprintable>";
  }
}

async function sleep(ms: number, shouldStop: () => boolean) {
  const steps = Math.max(1, Math.ceil(ms / 200));
  const stepMs = ms / steps;
  for (let i = 0; i < steps; i += 1) {
    if (shouldStop()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}
