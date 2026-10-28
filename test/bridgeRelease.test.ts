import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// 28/10/2026: Twoody on Jimmy's Mac quit to update itself 4 s after its
// bridge picked Claire-Sophie's question. Nobody answered it, and it held her
// grant's only place on the account for 90 s: « L'ordinateur partagé répond
// déjà à une de vos questions ». Each run of the bridge now names itself
// (`X-Bridge-Worker`), so that the account knows a later run will never
// answer what an earlier one left; and a run that stops gives back what it
// holds (`released`), rather than reporting on it later or never.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-bridge-release-"));
const { startBridgeClient, RELEASE_BUDGET_MS } = await import("../src/bridgeClient.js");
const { createComputeIdentity, publicIdentity, sealComputeRequest } = await import("../src/compute/computeSeal.js");

const SHARE = "3f0f5a3e-6c1b-4f7a-9d2e-1b2c3d4e5f60";

function quiet() {
  const original = { warn: console.warn, log: console.log };
  console.warn = () => undefined;
  console.log = () => undefined;
  return () => Object.assign(console, original);
}

async function until(check: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/// An account that hands one sealed share request, then nothing.
async function account() {
  const workers: string[] = [];
  const patches: Array<{ id: string; body: Record<string, unknown> }> = [];
  let published: { identity: { enc_public: string; sign_public: string }; prekeys: Array<Parameters<typeof sealComputeRequest>[0]["prekey"]> } | null = null;
  let handed = false;
  const guest = createComputeIdentity();
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const json = (status: number, body?: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(body === undefined ? "" : JSON.stringify(body));
      };
      if (path === "/bridge/compute_key") {
        published = JSON.parse(raw);
        return json(200, {});
      }
      if (path === "/bridge/tasks/next") {
        workers.push(String(req.headers["x-bridge-worker"] ?? ""));
        if (published && !handed) {
          handed = true;
          const sealed = sealComputeRequest({
            guest,
            host: { encPublic: published.identity.enc_public, signPublic: published.identity.sign_public },
            prekey: published.prekeys[0]!,
            grantId: `share:${SHARE}`,
            requestId: "held-1",
            now: Date.now(),
            body: { op: "search", query: "bail" },
          });
          const key = publicIdentity(guest);
          return json(200, {
            id: "held",
            kind: "share_request",
            args: {
              principal: { kind: "folder_share", share_uuid: SHARE, revision: 1, grantee_id: 42 },
              sealed_request: sealed.request,
              guest_key: { enc_public: key.encPublic, sign_public: key.signPublic },
            },
          });
        }
        return setTimeout(() => json(204), 30);
      }
      const patched = /^\/bridge\/tasks\/([\w-]+)$/.exec(path);
      if (patched && req.method === "PATCH") {
        patches.push({ id: patched[1]!, body: JSON.parse(raw) });
        return json(200, {});
      }
      json(404);
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    workers,
    patches,
    close: () => {
      const closed = new Promise<void>((resolve) => http.close(() => resolve()));
      http.closeAllConnections();
      return closed;
    },
  };
}

test("a run that stops gives back the request it holds, and never reports on it after", async (t) => {
  const restore = quiet();
  t.after(restore);
  const fake = await account();
  t.after(() => fake.close());
  const dir = mkdtempSync(join(tmpdir(), "twoody-bridge-release-run-"));
  let served = 0;
  let finish: (() => void) | null = null;
  const client = startBridgeClient({
    backendUrl: fake.url,
    userToken: "session",
    deviceIdPath: join(dir, "bridge-device-id"),
    computeKeysPath: join(dir, "compute-keys.json"),
    capabilities: [],
    // The folder's answer takes long: the request is still held when the run stops.
    serveShare: () => {
      served += 1;
      return new Promise((resolve) => { finish = () => resolve({ ok: true, passages: [] }); });
    },
  });
  await until(() => served === 1);

  const started = Date.now();
  await client.stop();
  assert.ok(Date.now() - started <= RELEASE_BUDGET_MS + 200, "stopping waits for the account a short while at most");
  assert.deepEqual(fake.patches.filter((p) => p.id === "held").map((p) => p.body), [{ status: "released" }]);

  // The folder answers after all: the next run will answer instead, and
  // this one says nothing more of it.
  (finish as (() => void) | null)?.();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(fake.patches.filter((p) => p.id === "held").map((p) => p.body.status), ["released"]);
});

test("each run names itself afresh, the same name on every poll", async (t) => {
  const restore = quiet();
  t.after(restore);
  const fake = await account();
  t.after(() => fake.close());
  const dir = mkdtempSync(join(tmpdir(), "twoody-bridge-release-names-"));
  const options = { backendUrl: fake.url, userToken: "session", deviceIdPath: join(dir, "bridge-device-id"), computeKeysPath: join(dir, "compute-keys.json"), capabilities: [] };

  const first = startBridgeClient(options);
  await until(() => fake.workers.length >= 2);
  await first.stop();
  const firstRun = new Set(fake.workers);
  assert.equal(firstRun.size, 1);
  const [name] = [...firstRun];
  assert.match(name!, /^[0-9a-f]{32}$/);

  const seen = fake.workers.length;
  const second = startBridgeClient(options);
  await until(() => fake.workers.length >= seen + 1);
  await second.stop();
  const later = fake.workers.slice(seen);
  assert.ok(later.every((worker) => worker !== name && /^[0-9a-f]{32}$/.test(worker)), "the next run has a name of its own");
});
