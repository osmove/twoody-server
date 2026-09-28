// Long-poll bridge client that turns this twoody-server into a Mac Bridge
// for an upstream Twoody backend (api.twoody.com or self-hosted Rails).
//
// Why it exists: the backend's `SmartHomeProcessor` enqueues
// `smart_home_proxy` bridge tasks (Home Assistant REST calls). Without a
// client on the user's LAN, those tasks sit in the queue forever — the
// backend can't reach the user's HA directly. This module long-polls the
// backend's `/bridge/tasks/next`, runs each task locally against the
// twoody-server's `HOME_ASSISTANT_URL`, and PATCHes the result back.
//
// Contract mirrors `twoody-mac/apps/macos/TwoodyMac/Bridge/BridgeService.swift`:
//   GET  /bridge/tasks/next?wait=25   →  204 or 200 {id, kind, args}
//   PATCH /bridge/tasks/:id            ←  {status: "done"|"error", result|error_message}
//   PATCH /bridge/tasks/:id            ←  {status: "streaming", delta}   (llm_infer, repeated)
//
// Auth: X-User-Token bearer (same token the chat clients use). The managed
// backend binds a session to the device that signed in: a token minted
// for an app is only accepted together with that app's X-Device-Token,
// so a worker that borrows an app's session must send both.
// Identity: X-Bridge-Device-Id (a stable UUID persisted under
// ~/.twoody-server/bridge-device-id so a restart keeps the same row in
// the backend's devices table).
// Heartbeat: a worker that serves `llm_infer` also sends
// X-Bridge-Heartbeat on every poll — the models its runtimes hold, the
// one in use, the machine's memory. That list is what lets the apps
// offer each local model by name.
//
// Only the kinds this client knows how to run get claimed; everything
// else is reported as an error so the backend's waiter unblocks.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { createDeltaRelay } from "./executors/completionStream.js";
import { executeBridgeTask, isSelfBridgeKind, tesseractReady, whisperReady } from "./executors/index.js";
import { configuredDefaultModel, downloadedModels } from "./executors/localModels.js";
import { outboundFetch } from "./outbound.js";

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

// Catalog prewarm cadence. Backend caches with a 5-min TTL; we
// refresh every 4 min so there's no measurable window where the LLM
// would fall back to home_search_entities on a cold cache. First push
// fires ~5s after boot so the bridge has time to register presence
// before any state arrives.
const CATALOG_PREWARM_INITIAL_DELAY_MS = 5_000;
const CATALOG_PREWARM_INTERVAL_MS = 4 * 60 * 1000;

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
  homeAssistantUrl: string;
  homeAssistantToken: string;
  deviceNickname?: string;
  deviceIdPath?: string;
  capabilities?: string[];
  /// Called when the link to the backend changes state, so a host
  /// process can tell its user whether this machine is reachable.
  onState?: (state: BridgeClientState) => void;
  /// Called after each completion with the model that ran, so a host
  /// process can show which model this machine last served.
  onServed?: (model: string) => void;
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

  // HA env vars stay required only when the Pi is expected to serve
  // smart_home_proxy tasks. The Linux executor kinds (`search` / `read`
  // / `llm_infer` / `list_*`) work without HA — so the bridge client
  // can run with empty HA creds and still cover the document and LLM
  // surfaces. Keep the smart_home_proxy handler honest: it'll error
  // back to the backend if HA isn't configured.
  const homeAssistantUrl = process.env.HOME_ASSISTANT_URL ?? "";
  const homeAssistantToken = process.env.HOME_ASSISTANT_TOKEN ?? "";

  return {
    backendUrl: backendUrl.replace(/\/+$/, ""),
    userToken,
    deviceToken: process.env.TWOODY_DEVICE_TOKEN?.trim() || undefined,
    homeAssistantUrl: homeAssistantUrl.replace(/\/+$/, ""),
    homeAssistantToken,
    deviceNickname: process.env.TWOODY_BRIDGE_DEVICE_NICKNAME,
    capabilities: deriveCapabilities(),
  };
}

/** Compute the list of task classes this worker can handle, based on
 * the env that's actually configured at boot. Sent to the upstream as
 * `X-Bridge-Capabilities` so the backend can avoid routing a task to
 * a worker that can't fulfil it (multi-host case: Pi-1 with HA, Pi-2
 * with files only, Mac with macOS-specific tasks).
 *
 *   document-provider    →  search, read, list_folders, list_dir
 *   local-llm-provider   →  llm_infer
 *   smart-home-proxy     →  smart_home_proxy
 *
 * Override with `TWOODY_BRIDGE_CAPABILITIES` (comma-separated) to pin
 * the advertised set explicitly. */
function deriveCapabilities(): string[] {
  const override = process.env.TWOODY_BRIDGE_CAPABILITIES;
  if (override && override.trim().length > 0) {
    return override
      .split(",")
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
  }
  const caps: string[] = [];
  const selfBridge = process.env.TWOODY_SELF_BRIDGE === "1";
  const hasFolders = (process.env.TWOODY_BRIDGE_FOLDERS ?? "").trim().length > 0;
  if (selfBridge && hasFolders) caps.push("document-provider");
  if (`${process.env.BRIDGE_LOCAL_LLM_ENDPOINT ?? ""}${process.env.BRIDGE_LOCAL_LLM_ENDPOINTS ?? ""}`.trim().length > 0) {
    caps.push("local-llm-provider");
  }
  if (
    (process.env.HOME_ASSISTANT_URL ?? "").trim().length > 0 &&
    (process.env.HOME_ASSISTANT_TOKEN ?? "").trim().length > 0
  ) {
    caps.push("smart-home-proxy");
  }
  // Advertised only when the whisper.cpp binary + model exist on
  // disk. Same probe as the in-process executor, so the cap string
  // never lies about what the worker can actually run.
  if (whisperReady()) caps.push("audio-transcribe-provider");
  // OCR is the cheapest port from twoody-mac (Vision.framework →
  // tesseract). Advertise only when tesseract is present so a host
  // without it (default install) doesn't claim ocr_image tasks.
  if (tesseractReady()) caps.push("ocr-provider");
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
  const deviceId = resolveDeviceId(opts.deviceIdPath);
  const nickname = asciiHeaderValue(opts.deviceNickname ?? "twoody-server") || "twoody-server";
  const servesLlm = opts.capabilities?.includes("local-llm-provider") ?? false;
  let stopped = false;
  /// Sent with every request to the backend.
  const authHeaders: Record<string, string> = {
    "X-User-Token": opts.userToken,
    "X-Bridge-Device-Id": deviceId,
    ...(opts.deviceToken ? { "X-Device-Token": opts.deviceToken } : {}),
  };
  // What the last completions looked like, for the heartbeat.
  let lastModel: string | null = null;
  let tokensPerSecond: number | null = null;

  void pollLoop();
  void catalogPrewarmLoop();

  return {
    stop() {
      stopped = true;
    },
    deviceId,
  };

  // Periodically push the household's HA entity list to the backend
  // so the LLM's prompt_guidance always carries the catalog and the
  // first command after a Pi reboot doesn't pay for a cold-cache
  // home_search_entities round-trip. No-op when HA isn't configured
  // — that just means this Pi isn't the smart-home worker and the
  // backend's cache will populate the legacy way (on the first
  // home_search_entities tool call).
  async function catalogPrewarmLoop() {
    if (!opts.homeAssistantUrl || !opts.homeAssistantToken) return;

    await sleep(CATALOG_PREWARM_INITIAL_DELAY_MS, () => stopped);
    while (!stopped) {
      try {
        await prewarmCatalogOnce();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[bridge-client] catalog prewarm failed: ${message}`);
      }
      await sleep(CATALOG_PREWARM_INTERVAL_MS, () => stopped);
    }
  }

  async function prewarmCatalogOnce() {
    const haRes = await outboundFetch(`${opts.homeAssistantUrl}/api/states`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${opts.homeAssistantToken}`,
        Accept: "application/json",
      },
    });
    if (!haRes.ok) {
      throw new Error(`HA /api/states status=${haRes.status}`);
    }
    const states = await haRes.json();
    if (!Array.isArray(states)) {
      throw new Error("HA /api/states returned non-array");
    }

    const pushRes = await outboundFetch(`${opts.backendUrl}/smart_home/catalog.json`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ states }),
    });
    if (!pushRes.ok) {
      const body = await pushRes.text().catch(() => "");
      throw new Error(`backend /smart_home/catalog status=${pushRes.status} body=${body.slice(0, 200)}`);
    }
    const payload = (await pushRes.json().catch(() => ({}))) as {
      entities?: number;
      cached?: number;
      received?: number;
    };
    const cached = payload.cached ?? payload.entities ?? "?";
    console.log(
      `[bridge-client] catalog prewarm pushed ${states.length} HA states (${cached} controllable cached)`,
    );
  }

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
        report("online");
        if (task) {
          console.log(
            `[bridge-client] claimed task ${task.id} kind=${task.kind} args=${isSharedTask(task) ? "<another person's turn>" : argsPreview(task.args)}`,
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
          if (task.kind === "llm_infer") void handleTask(task);
          else await handleTask(task);
        }
      } catch (error) {
        consecutiveFailures += 1;
        const message = error instanceof Error ? error.message : String(error);
        const authFailed = message.startsWith("auth_failed");
        const backoff = authFailed
          ? AUTH_FAILED_BACKOFF_MS
          : Math.min(BACKOFF_MIN_MS * 2 ** Math.min(consecutiveFailures - 1, 5), BACKOFF_MAX_MS);
        report(authFailed ? "auth_failed" : "unreachable");
        console.warn(
          `[bridge-client] poll failed (attempt ${consecutiveFailures}, backoff ${backoff}ms): ${message}`,
        );
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
      if (opts.capabilities && opts.capabilities.length > 0) {
        headers["X-Bridge-Capabilities"] = opts.capabilities.join(",");
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
    // Another person's turn on this computer (a compute grant on the
    // account): inference and nothing else, whatever the task says.
    if (isSharedTask(task)) return runStreamedInference({ ...task, args: sharedInferenceArgs(task) });
    switch (task.kind) {
      case "smart_home_proxy":
        return runSmartHomeProxy(task.args, opts);
      default:
        if (isSelfBridgeKind(task.kind)) {
          // Pi-as-worker for an upstream Twoody backend: the cloud's
          // LocalFilesProcessor and LocalLlmService enqueue `search` /
          // `read` / `list_folders` / `list_dir` / `llm_infer` tasks
          // that the legacy Mac Bridge used to claim. The Pi reuses
          // the same in-process executors here.
          if (task.kind === "llm_infer") return runStreamedInference(task);
          return executeBridgeTask(task.kind, task.args);
        }
        throw new Error(`unsupported_kind:${task.kind}`);
    }
  }

  // Relays the text to the backend while the model writes it. The pieces
  // land in order (the backend appends them to a list and replays it),
  // and the stream from the runtime never waits for a request: a slow
  // uplink must not slow the model down.
  async function runStreamedInference(task: Task): Promise<unknown> {
    const relay = createDeltaRelay((delta) =>
      patchTask(task.id, { status: "streaming", delta }).catch((err) => {
        console.warn(`[bridge-client] delta not delivered for task ${task.id}: ${err instanceof Error ? err.message : err}`);
      }),
    );

    try {
      return await executeBridgeTask("llm_infer", task.args, {
        onDelta: relay.push,
        onStats: ({ model, completionTokens, latencyMs }) => {
          lastModel = model;
          opts.onServed?.(model);
          if (completionTokens > 0 && latencyMs > 0) {
            const measured = completionTokens / (latencyMs / 1000);
            tokensPerSecond = tokensPerSecond === null ? measured : tokensPerSecond * 0.7 + measured * 0.3;
          }
        },
      });
    } finally {
      // Every piece must be in before the task is reported as over.
      await relay.drain();
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
      throw new Error(`patch_failed status=${res.status} body=${text.slice(0, 200)}`);
    }
  }
}

// ── Smart Home proxy ──────────────────────────────────────────────────

async function runSmartHomeProxy(
  args: Record<string, unknown>,
  opts: BridgeClientOptions,
): Promise<{ status: number; body: unknown }> {
  if (!opts.homeAssistantUrl || !opts.homeAssistantToken) {
    throw new Error("home_assistant_not_configured");
  }
  const method = String(args.method ?? "GET").toUpperCase();
  const path = String(args.path ?? "");
  if (!path.startsWith("/")) {
    throw new Error(`smart_home_proxy.path must start with '/'; got ${JSON.stringify(args.path)}`);
  }
  if (method !== "GET" && method !== "POST") {
    throw new Error(`smart_home_proxy.method must be GET or POST; got ${method}`);
  }

  const url = `${opts.homeAssistantUrl}${path}`;
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${opts.homeAssistantToken}`,
      Accept: "application/json",
    },
  };
  if (method === "POST" && args.body !== undefined && args.body !== null) {
    init.body = JSON.stringify(args.body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }

  const res = await outboundFetch(url, init);
  const text = await res.text();
  let parsed: unknown = text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // keep raw text; HA error pages aren't always JSON
    }
  }
  return { status: res.status, body: parsed };
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

/// The only thing another person's turn may do here: a completion, without
/// tools (a tool would act on this computer or its owner's data) and
/// without the account's routing details. Anything else is refused.
export function sharedInferenceArgs(task: { kind: string; args: Record<string, unknown> }): Record<string, unknown> {
  if (task.kind !== "llm_infer") throw new Error("shared_task_refused");
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(String(task.args.openai_body_json ?? ""));
  } catch {
    throw new Error("shared_task_refused");
  }
  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) throw new Error("shared_task_refused");
  const { tools: _tools, tool_choice: _choice, functions: _functions, function_call: _call, ...rest } = body;
  return { openai_body_json: JSON.stringify(rest) };
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
