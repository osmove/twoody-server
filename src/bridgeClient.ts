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

const POLL_WAIT_SECONDS = 25;
const POLL_BUDGET_MS = (POLL_WAIT_SECONDS + 10) * 1000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

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
}

export interface BridgeClientHandle {
  stop(): void;
  deviceId: string;
}

export function readBridgeClientEnv(): BridgeClientOptions | null {
  const backendUrl = process.env.TWOODY_BACKEND_URL;
  const userToken = process.env.TWOODY_USER_TOKEN;
  const homeAssistantUrl = process.env.HOME_ASSISTANT_URL;
  const homeAssistantToken = process.env.HOME_ASSISTANT_TOKEN;

  if (!backendUrl || !userToken) return null;
  if (!homeAssistantUrl || !homeAssistantToken) return null;

  return {
    backendUrl: backendUrl.replace(/\/+$/, ""),
    userToken,
    homeAssistantUrl: homeAssistantUrl.replace(/\/+$/, ""),
    homeAssistantToken,
    deviceNickname: process.env.TWOODY_BRIDGE_DEVICE_NICKNAME,
  };
}

export function startBridgeClient(opts: BridgeClientOptions): BridgeClientHandle {
  const deviceId = resolveDeviceId(opts.deviceIdPath);
  const nickname = opts.deviceNickname ?? "twoody-server";
  let stopped = false;

  void pollLoop();

  return {
    stop() {
      stopped = true;
    },
    deviceId,
  };

  async function pollLoop() {
    let consecutiveFailures = 0;
    while (!stopped) {
      try {
        const task = await pollOnce();
        consecutiveFailures = 0;
        if (task) {
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
      const res = await fetch(
        `${opts.backendUrl}/bridge/tasks/next?wait=${POLL_WAIT_SECONDS}`,
        {
          method: "GET",
          headers: {
            "X-User-Token": opts.userToken,
            "X-Bridge-Device-Id": deviceId,
            "X-Bridge-Device-Nickname": nickname,
            Accept: "application/json",
          },
          signal: controller.signal,
        },
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
    try {
      const result = await runTask(task);
      await patchTask(task.id, { status: "done", result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await patchTask(task.id, { status: "error", error_message: message }).catch((err) => {
        console.warn(
          `[bridge-client] failed to PATCH error for task ${task.id}: ${err instanceof Error ? err.message : err}`,
        );
      });
    }
  }

  async function runTask(task: Task): Promise<unknown> {
    switch (task.kind) {
      case "smart_home_proxy":
        return runSmartHomeProxy(task.args, opts);
      default:
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

async function sleep(ms: number, shouldStop: () => boolean) {
  const steps = Math.max(1, Math.ceil(ms / 200));
  const stepMs = ms / steps;
  for (let i = 0; i < steps; i += 1) {
    if (shouldStop()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}
