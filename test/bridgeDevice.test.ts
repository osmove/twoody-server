import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The bridge's device id, as twoody-backend 08c052d8 wants it: every bridge
// call carries X-Bridge-Device-Id (tasks/next, the task updates,
// compute_key), and a refusal of the device (400 bridge_device_required,
// 409 bridge_device_mismatch / bridge_device_taken) is said plainly, once,
// and not asked again at every poll.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-bridge-device-"));
const { bridgeDeviceRefusal, startBridgeClient } = await import("../src/bridgeClient.js");

type Handler = (req: IncomingMessage, res: ServerResponse, path: string) => void;

async function backend(handler: Handler) {
  const calls: Array<{ method: string; path: string; device: string | null }> = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    calls.push({ method: req.method ?? "", path, device: (req.headers["x-bridge-device-id"] as string | undefined) ?? null });
    req.resume();
    req.on("end", () => handler(req, res, path));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const json = (res: ServerResponse, status: number, body?: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
};

async function until(check: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function captureWarnings() {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  return { warnings, restore: () => (console.warn = original) };
}

test("bridgeDeviceRefusal reads the backend's words only", () => {
  assert.equal(bridgeDeviceRefusal(409, '{"error":"bridge_device_mismatch"}'), "bridge_device_mismatch");
  assert.equal(bridgeDeviceRefusal(409, '{"error":"bridge_device_taken"}'), "bridge_device_taken");
  assert.equal(bridgeDeviceRefusal(400, '{"error":"bridge_device_required"}'), "bridge_device_required");
  assert.equal(bridgeDeviceRefusal(409, '{"error":"conflict"}'), null);
  assert.equal(bridgeDeviceRefusal(409, "<html>proxy</html>"), null);
  assert.equal(bridgeDeviceRefusal(403, '{"error":"bridge_device_mismatch"}'), null);
});

test("every bridge call carries the device id: tasks/next, the task's update, compute_key", async (t) => {
  let served = false;
  const fake = await backend((_req, res, path) => {
    if (path === "/bridge/tasks/next") {
      if (!served) {
        served = true;
        return json(res, 200, { id: "task-1", kind: "no_such_kind", args: {} });
      }
      return json(res, 204);
    }
    if (path === "/bridge/tasks/task-1") return json(res, 204);
    if (path === "/bridge/compute_key") return json(res, 201, {});
    json(res, 404);
  });
  t.after(() => fake.close());
  const dir = mkdtempSync(join(tmpdir(), "twoody-bridge-id-"));
  const quiet = captureWarnings();
  const client = startBridgeClient({
    backendUrl: fake.url,
    userToken: "server-session",
    homeAssistantUrl: "",
    homeAssistantToken: "",
    deviceIdPath: join(dir, "bridge-device-id"),
    computeKeysPath: join(dir, "compute-keys.json"),
    capabilities: ["local-llm-provider"],
  });
  try {
    await until(() => fake.calls.some((c) => c.path === "/bridge/tasks/task-1") && fake.calls.some((c) => c.path === "/bridge/compute_key"));
  } finally {
    client.stop();
    quiet.restore();
  }
  assert.ok(fake.calls.length >= 3);
  for (const call of fake.calls) assert.equal(call.device, client.deviceId, `${call.method} ${call.path}`);
});

test("409 bridge_device_mismatch on tasks/next: said once, plainly, and not asked again for minutes", async (t) => {
  const fake = await backend((_req, res, path) => {
    if (path === "/bridge/tasks/next") return json(res, 409, { error: "bridge_device_mismatch" });
    json(res, 404);
  });
  t.after(() => fake.close());
  const dir = mkdtempSync(join(tmpdir(), "twoody-bridge-id-"));
  const states: string[] = [];
  const captured = captureWarnings();
  const client = startBridgeClient({
    backendUrl: fake.url,
    userToken: "server-session",
    homeAssistantUrl: "",
    homeAssistantToken: "",
    deviceIdPath: join(dir, "bridge-device-id"),
    onState: (state) => states.push(state),
  });
  try {
    await until(() => states.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  } finally {
    client.stop();
    captured.restore();
  }
  assert.equal(fake.calls.filter((c) => c.path === "/bridge/tasks/next").length, 1, "no retry storm");
  assert.deepEqual(states, ["auth_failed"]);
  const said = captured.warnings.filter((w) => w.includes("bridge_device_mismatch"));
  assert.equal(said.length, 1, captured.warnings.join("\n"));
  assert.match(said[0]!, /another bridge device on record/);
});

test("409 bridge_device_taken on compute_key: not offered again at every poll", async (t) => {
  const fake = await backend((_req, res, path) => {
    if (path === "/bridge/tasks/next") return json(res, 204);
    if (path === "/bridge/compute_key") return json(res, 409, { error: "bridge_device_taken" });
    json(res, 404);
  });
  t.after(() => fake.close());
  const dir = mkdtempSync(join(tmpdir(), "twoody-bridge-id-"));
  const captured = captureWarnings();
  const client = startBridgeClient({
    backendUrl: fake.url,
    userToken: "server-session",
    homeAssistantUrl: "",
    homeAssistantToken: "",
    deviceIdPath: join(dir, "bridge-device-id"),
    computeKeysPath: join(dir, "compute-keys.json"),
    capabilities: ["local-llm-provider"],
  });
  try {
    await until(() => fake.calls.filter((c) => c.path === "/bridge/tasks/next").length >= 5);
  } finally {
    client.stop();
    captured.restore();
  }
  assert.equal(fake.calls.filter((c) => c.path === "/bridge/compute_key").length, 1);
  assert.ok(captured.warnings.some((w) => w.includes("bridge_device_taken") && w.includes("already held")), captured.warnings.join("\n"));
});
