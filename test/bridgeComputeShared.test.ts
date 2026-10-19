// Whether this computer is shared with someone, as the bridge client asks the
// account (19/10/2026, builtin/slots.ts sharedFromGrants): what `twoody
// serve` and a Pi decide their runtime's slots with (engine.ts). Shared
// while one of the owner's active grants is for this computer's bridge
// device; asked again when the first one with an end runs out; nothing said
// when the account answers nothing usable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-compute-shared-"));
const { startBridgeClient } = await import("../src/bridgeClient.js");

const DEVICE = "0b6f3c2e-2a7d-4c1b-9e8f-7a6b5c4d3e2f";

async function until(check: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("the bridge client says shared while a grant of this computer is active, and no longer once it ran out", async (t) => {
  let given: unknown = { given: [{ id: 4, expires_at: new Date(Date.now() + 1_200).toISOString(), computer: { id: 2, host_id: DEVICE.toUpperCase(), name: "Mac" }, grantee: { id: 9, first_name: "Claire" } }], received: [] };
  const asked: Array<{ path: string; token: string | undefined; device: string | undefined }> = [];
  const account = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/api/v1/compute_grants") {
      asked.push({ path, token: req.headers["x-user-token"] as string | undefined, device: req.headers["x-device-token"] as string | undefined });
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify(given));
    }
    if (path.endsWith("/bridge/tasks/next")) return void setTimeout(() => res.writeHead(204).end(), 20);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => account.listen(0, "127.0.0.1", resolve));
  const said: boolean[] = [];
  const original = { warn: console.warn, log: console.log };
  console.warn = () => undefined;
  console.log = () => undefined;
  const client = startBridgeClient({
    backendUrl: `http://127.0.0.1:${(account.address() as AddressInfo).port}/api/v1`,
    userToken: "host-session",
    deviceToken: "host-device",
    deviceId: DEVICE,
    computeKeysPath: join(process.env.TWOODY_DATA_DIR!, "compute-keys.json"),
    capabilities: ["local-llm-provider"],
    onComputeShared: (shared) => said.push(shared),
  });
  t.after(async () => {
    client.stop();
    Object.assign(console, original);
    await new Promise<void>((resolve) => account.close(() => resolve()));
  });
  await until(() => said.length === 1);
  assert.deepEqual(said, [true]);
  assert.deepEqual(asked[0], { path: "/api/v1/compute_grants", token: "host-session", device: "host-device" });
  // The grant runs out: asked again a second after, no longer shared.
  given = { given: [], received: [] };
  await until(() => said.length === 2, 6_000);
  assert.deepEqual(said, [true, false]);
});

test("without a callback the account is not asked; an answer it cannot read says nothing", async (t) => {
  let answers = 0;
  const account = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/api/v1/compute_grants") {
      answers += 1;
      res.writeHead(200, { "content-type": "text/html" });
      return void res.end("<html>maintenance</html>");
    }
    if (path.endsWith("/bridge/tasks/next")) return void setTimeout(() => res.writeHead(204).end(), 20);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => account.listen(0, "127.0.0.1", resolve));
  const backendUrl = `http://127.0.0.1:${(account.address() as AddressInfo).port}`;
  const original = { warn: console.warn, log: console.log };
  console.warn = () => undefined;
  console.log = () => undefined;
  const silent = startBridgeClient({ backendUrl, userToken: "s", deviceId: DEVICE, computeKeysPath: join(process.env.TWOODY_DATA_DIR!, "keys-2.json"), capabilities: ["local-llm-provider"] });
  const said: boolean[] = [];
  const reading = startBridgeClient({ backendUrl, userToken: "s", deviceId: DEVICE, computeKeysPath: join(process.env.TWOODY_DATA_DIR!, "keys-3.json"), capabilities: ["local-llm-provider"], onComputeShared: (shared) => said.push(shared) });
  t.after(async () => {
    silent.stop();
    reading.stop();
    Object.assign(console, original);
    await new Promise<void>((resolve) => account.close(() => resolve()));
  });
  await until(() => answers === 1);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(answers, 1, "asked by the one with a callback only");
  assert.deepEqual(said, [], "what was known stands");
});
