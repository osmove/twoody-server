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
//
// Auth: X-User-Token bearer (same token the chat clients use).
// Identity: X-Bridge-Device-Id (a stable UUID persisted under
// ~/.twoody-server/bridge-device-id so a restart keeps the same row in
// the backend's devices table).
//
// Only the kinds this client knows how to run get claimed; everything
// else is reported as an error so the backend's waiter unblocks.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { executeBridgeTask, isSelfBridgeKind, whisperReady } from "./executors/index.js";

const POLL_WAIT_SECONDS = 25;
const POLL_BUDGET_MS = (POLL_WAIT_SECONDS + 10) * 1000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

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

export interface BridgeClientOptions {
  backendUrl: string;
  userToken: string;
  homeAssistantUrl: string;
  homeAssistantToken: string;
  deviceNickname?: string;
  deviceIdPath?: string;
  capabilities?: string[];
}

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
  if ((process.env.BRIDGE_LOCAL_LLM_ENDPOINT ?? "").trim().length > 0) {
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
  return caps;
}

export function startBridgeClient(opts: BridgeClientOptions): BridgeClientHandle {
  const deviceId = resolveDeviceId(opts.deviceIdPath);
  const nickname = opts.deviceNickname ?? "twoody-server";
  let stopped = false;

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
    const haRes = await fetch(`${opts.homeAssistantUrl}/api/states`, {
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

    const pushRes = await fetch(`${opts.backendUrl}/smart_home/catalog.json`, {
      method: "POST",
      headers: {
        "X-User-Token": opts.userToken,
        "X-Bridge-Device-Id": deviceId,
        "Content-Type": "application/json",
      },
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
    while (!stopped) {
      try {
        const task = await pollOnce();
        consecutiveFailures = 0;
        if (task) {
          console.log(
            `[bridge-client] claimed task ${task.id} kind=${task.kind} args=${argsPreview(task.args)}`,
          );
          await handleTask(task);
        }
      } catch (error) {
        consecutiveFailures += 1;
        const backoff = Math.min(
          BACKOFF_MIN_MS * 2 ** Math.min(consecutiveFailures - 1, 5),
          BACKOFF_MAX_MS,
        );
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[bridge-client] poll failed (attempt ${consecutiveFailures}, backoff ${backoff}ms): ${message}`,
        );
        await sleep(backoff, () => stopped);
      }
    }
  }

  async function pollOnce(): Promise<Task | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POLL_BUDGET_MS);
    try {
      const headers: Record<string, string> = {
        "X-User-Token": opts.userToken,
        "X-Bridge-Device-Id": deviceId,
        "X-Bridge-Device-Nickname": nickname,
        Accept: "application/json",
      };
      if (opts.capabilities && opts.capabilities.length > 0) {
        headers["X-Bridge-Capabilities"] = opts.capabilities.join(",");
      }
      const res = await fetch(
        `${opts.backendUrl}/bridge/tasks/next?wait=${POLL_WAIT_SECONDS}`,
        { method: "GET", headers, signal: controller.signal },
      );

      if (res.status === 204) return null;
      if (res.status === 401 || res.status === 403) {
        throw new Error(`auth_failed status=${res.status}`);
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
      console.log(
        `[bridge-client] completed task ${task.id} kind=${task.kind} elapsed=${Date.now() - started}ms`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[bridge-client] failed task ${task.id} kind=${task.kind} elapsed=${Date.now() - started}ms error=${message}`,
      );
      await patchTask(task.id, { status: "error", error_message: message }).catch((err) => {
        console.warn(
          `[bridge-client] could not PATCH error for task ${task.id}: ${err instanceof Error ? err.message : err}`,
        );
      });
    }
  }

  async function runTask(task: Task): Promise<unknown> {
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
          return executeBridgeTask(task.kind, task.args);
        }
        throw new Error(`unsupported_kind:${task.kind}`);
    }
  }

  async function patchTask(
    id: string,
    body: { status: "done"; result: unknown } | { status: "error"; error_message: string },
  ) {
    const res = await fetch(`${opts.backendUrl}/bridge/tasks/${id}`, {
      method: "PATCH",
      headers: {
        "X-User-Token": opts.userToken,
        "X-Bridge-Device-Id": deviceId,
        "Content-Type": "application/json",
      },
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

  const res = await fetch(url, init);
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
