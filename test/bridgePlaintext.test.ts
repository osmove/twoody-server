import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Attack tests (11/10/2026, AGENTS.md rule 12: the account is taken as
// possibly malicious). The account hands this computer tasks through the
// bridge. Before, a task in clear ran: a completion of the person's own
// (llm_infer without a seal, its answer streamed back in clear), a search
// or a read of the person's documents, a folder listing, a transcription,
// an OCR, a Home Assistant call (smart_home_proxy), and the worker pushed
// Home Assistant's states to the account every four minutes. Now only
// sealed requests run (another person's turn under a compute grant, a
// request on a shared folder); everything in clear is refused before it
// runs, and nothing of the house goes to the account.

const dataDir = mkdtempSync(join(tmpdir(), "twoody-bridge-plain-"));
process.env.TWOODY_DATA_DIR = dataDir;
const { deriveCapabilities, plaintextRefusal, startBridgeClient } = await import("../src/bridgeClient.js");

type Handler = (req: IncomingMessage, res: ServerResponse, path: string, body: string) => void;

async function server(handler: Handler) {
  const calls: Array<{ method: string; path: string; body: string; capabilities: string | null }> = [];
  const http = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      calls.push({ method: req.method ?? "", path, body, capabilities: (req.headers["x-bridge-capabilities"] as string | undefined) ?? null });
      handler(req, res, path, body);
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    calls,
    close: () => {
      const closed = new Promise<void>((resolve) => http.close(() => resolve()));
      http.closeAllConnections();
      return closed;
    },
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

function quiet() {
  const original = { warn: console.warn, log: console.log };
  console.warn = () => undefined;
  console.log = () => undefined;
  return () => Object.assign(console, original);
}

const PLAINTEXT_TASKS: Array<{ kind: string; args: Record<string, unknown> }> = [
  { kind: "llm_infer", args: { openai_body_json: JSON.stringify({ model: "local", messages: [{ role: "user", content: "Mon diagnostic médical ?" }] }) } },
  { kind: "search", args: { query: "contrat de travail" } },
  { kind: "read", args: { path: "/Users/someone/Documents/secret.pdf" } },
  { kind: "list_folders", args: {} },
  { kind: "list_dir", args: { path: "/Users/someone" } },
  { kind: "transcribe", args: { audio_base64: "AAAA", language: "fr" } },
  { kind: "ocr_image", args: { document_id: "1" } },
  { kind: "smart_home_proxy", args: { method: "GET", path: "/api/states" } },
  { kind: "smart_home_proxy", args: { method: "POST", path: "/api/services/lock/unlock", body: { entity_id: "lock.front_door" } } },
  // A principal that says « shared » without the seal: another person's turn in clear.
  { kind: "llm_infer", args: { principal: { kind: "shared", grant_id: 7 }, openai_body_json: "{}" } },
  { kind: "no_such_kind", args: {} },
];

test("every task in clear is refused before it runs: no runtime, no Home Assistant, no document, the refusal says nothing of it", async (t) => {
  // The house: any request to it would be a failure of this test.
  const house = await server((_req, res) => json(res, 200, [{ entity_id: "lock.front_door", state: "locked" }]));
  // A model runtime, idem.
  const runtime = await server((_req, res) => json(res, 500, {}));
  const folder = mkdtempSync(join(tmpdir(), "twoody-bridge-plain-docs-"));
  writeFileSync(join(folder, "secret.txt"), "Le code de la porte est 1234");
  const saved = { ...process.env };
  Object.assign(process.env, {
    HOME_ASSISTANT_URL: house.url,
    HOME_ASSISTANT_TOKEN: "ha-token",
    TWOODY_SELF_BRIDGE: "1",
    TWOODY_BRIDGE_FOLDERS: folder,
    BRIDGE_LOCAL_LLM_ENDPOINT: runtime.url,
  });
  let handed = 0;
  const reports = new Map<string, { status: string; error_message?: string; result?: unknown; delta?: string }[]>();
  const account = await server((_req, res, path, body) => {
    if (path === "/bridge/tasks/next") {
      if (handed < PLAINTEXT_TASKS.length) {
        const task = PLAINTEXT_TASKS[handed];
        handed += 1;
        return json(res, 200, { id: `task-${handed}`, ...task });
      }
      return setTimeout(() => json(res, 204), 20);
    }
    const match = /^\/bridge\/tasks\/(task-\d+)$/.exec(path);
    if (match) {
      const list = reports.get(match[1]) ?? [];
      list.push(JSON.parse(body));
      reports.set(match[1], list);
      return json(res, 204);
    }
    if (path === "/bridge/compute_key") return json(res, 201, {});
    json(res, 404);
  });
  const restore = quiet();
  const client = startBridgeClient({
    backendUrl: account.url,
    userToken: "server-session",
    // What the Pi's environment gives a bridge client.
    homeAssistantUrl: house.url,
    homeAssistantToken: "ha-token",
    deviceIdPath: join(dataDir, "bridge-device-id"),
    computeKeysPath: join(dataDir, "compute-keys.json"),
    capabilities: deriveCapabilities(),
  });
  t.after(async () => {
    client.stop();
    restore();
    process.env = saved;
    await Promise.all([account.close(), house.close(), runtime.close()]);
  });
  await until(() => reports.size === PLAINTEXT_TASKS.length && [...reports.values()].every((list) => list.some((r) => r.status === "error")));
  // Long enough for the old catalog push (5 s after start) not to be the
  // reason it is absent: the loop is gone, so wait a little and look.
  await new Promise((resolve) => setTimeout(resolve, 200));

  for (const [index, task] of PLAINTEXT_TASKS.entries()) {
    const list = reports.get(`task-${index + 1}`)!;
    assert.equal(list.length, 1, `${task.kind}: one report, no piece streamed`);
    assert.equal(list[0].status, "error", task.kind);
    assert.match(list[0].error_message!, task.args.principal ? /^shared_task_refused$/ : /^bridge_plaintext_refused:/, task.kind);
    for (const secret of ["médical", "contrat", "secret", "lock.front_door", "someone"]) {
      assert.ok(!list[0].error_message!.includes(secret), `${task.kind}: nothing of the task in the refusal`);
    }
    assert.equal(list[0].result, undefined);
  }
  assert.equal(house.calls.length, 0, "Home Assistant was never asked");
  // The heartbeat lists the runtime's models (GET …/models); no completion was asked.
  assert.deepEqual(runtime.calls.filter((call) => !call.path.endsWith("/models")), [], "the model was never asked");
  assert.ok(!account.calls.some((call) => call.path.startsWith("/smart_home")), "no Home Assistant state pushed to the account");
  assert.ok(account.calls.every((call) => !call.body.includes("1234")), "no document text reached the account");
  // What the worker says it takes: sealed shared turns only, whatever the environment.
  const said = account.calls.find((call) => call.path === "/bridge/tasks/next")!.capabilities ?? "";
  assert.deepEqual(said.split(",").filter(Boolean), ["local-llm-provider"]);
  readdirSync(folder); // still there, untouched
});

test("capabilities: never a class of tasks in clear, even pinned by TWOODY_BRIDGE_CAPABILITIES", (t) => {
  const saved = { ...process.env };
  t.after(() => (process.env = saved));
  Object.assign(process.env, {
    HOME_ASSISTANT_URL: "http://ha.local:8123",
    HOME_ASSISTANT_TOKEN: "x",
    TWOODY_SELF_BRIDGE: "1",
    TWOODY_BRIDGE_FOLDERS: "/tmp",
  });
  delete process.env.BRIDGE_LOCAL_LLM_ENDPOINT;
  delete process.env.BRIDGE_LOCAL_LLM_ENDPOINTS;
  delete process.env.TWOODY_BRIDGE_CAPABILITIES;
  assert.deepEqual(deriveCapabilities(), []);
  process.env.TWOODY_BRIDGE_CAPABILITIES = "document-provider,smart-home-proxy,local-llm-provider,ocr-provider,audio-transcribe-provider,mac-automation,folder-share-provider";
  assert.deepEqual(deriveCapabilities(), ["local-llm-provider", "folder-share-provider"]);
});

test("the refusal names the kind only when it is a plain word", () => {
  assert.match(plaintextRefusal("search"), /^bridge_plaintext_refused:search: /);
  assert.match(plaintextRefusal("evil\nkind <script>"), /^bridge_plaintext_refused:unknown: /);
});
