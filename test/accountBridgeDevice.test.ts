import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startFakeBackend } from "./helpers/fakeBackend.js";

// A server linked to an account lends its models under its own bridge
// device id (account.json bridge_device_id), never the machine's
// ~/.twoody-server/bridge-device-id: a second install on the same Pi sent
// the first one's id, the account refused it (bridge_device_taken), and,
// until twoody-backend 3f67b510, refused the whole heartbeat with it.

const home = mkdtempSync(join(tmpdir(), "twoody-bridge-home-"));
process.env.HOME = home;
const dataDir = mkdtempSync(join(tmpdir(), "twoody-account-bridge-"));
process.env.TWOODY_DATA_DIR = dataDir;
process.env.TWOODY_ACCOUNT_TUNNEL = "0";
process.env.TWOODY_HEARTBEAT_MS = "3600000";
process.env.TWOODY_ACCOUNT_POLL_MS = "3600000";
process.env.TWOODY_LINK_POLL_MS = "20";
delete process.env.TWOODY_ACCOUNT_BRIDGE;
delete process.env.TWOODY_USER_TOKEN;
delete process.env.TWOODY_DEVICE_TOKEN;
delete process.env.TWOODY_BRIDGE_CAPABILITIES;
delete process.env.BRIDGE_LOCAL_LLM_ENDPOINT;
delete process.env.BRIDGE_LOCAL_LLM_ENDPOINTS;

// The machine-wide id, as the other install on this machine made it.
const machineId = "e0bf9908-1111-4222-8333-444455556666";
mkdirSync(join(home, ".twoody-server"), { recursive: true });
writeFileSync(join(home, ".twoody-server", "bridge-device-id"), `${machineId}\n`);

const backend = await startFakeBackend();
process.env.TWOODY_BACKEND_URL = backend.url;

const { linkState, resetLinkForTests, startLink } = await import("../src/account/link.js");
const { computeKeysPathFor, startAccountService } = await import("../src/account/service.js");
const { accountPath, readAccountFile, removeAccountFile, writeAccountFile } = await import("../src/account/store.js");
const { newPairingKey } = await import("../src/account/keys.js");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test.after(async () => {
  resetLinkForTests();
  await backend.close();
});

async function until(check: () => boolean, ms = 3_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/// account.json as a server linked before bridge_device_id existed wrote it.
function linkedBefore(name: string) {
  const key = newPairingKey();
  const computer = backend.addComputer({ name, public_key: key.pub, kind: "server" });
  writeAccountFile({
    backend_url: backend.url,
    user_token: backend.userToken,
    device_token: `device-token-${computer.id}`,
    computer: { id: String(computer.id), credential: computer.credential, name },
    pairing_key: key,
    approvers: [],
  });
  return computer;
}

test("linking by code gives the server its own bridge device id, in account.json (0600)", async () => {
  removeAccountFile();
  const view = await startLink({ name: "Raspberry Pi" });
  const login = backend.logins.find((l) => l.user_code === view.user_code)!;
  backend.approveLogin(login.user_code, null);
  await until(() => linkState() === "linked");
  const file = readAccountFile()!;
  assert.match(file.bridge_device_id ?? "", UUID);
  assert.notEqual(file.bridge_device_id, machineId);
  assert.equal(statSync(accountPath()).mode & 0o777, 0o600);
  resetLinkForTests();
});

test("a second install on the machine, linked before: a fresh id on start, bound by its heartbeat, sent by its bridge", async () => {
  // The first install holds the machine's id in the account.
  const first = backend.addComputer({ name: "Pi (ancien)", public_key: "12".repeat(32), kind: "server" });
  first.bridge_device_uuid = machineId;
  const computer = linkedBefore("Pi");
  const logs: string[] = [];
  const service = startAccountService({ localBaseUrl: "http://127.0.0.1:1", log: (m) => logs.push(m) });
  try {
    await service.heartbeat();
    const own = readAccountFile()!.bridge_device_id!;
    assert.match(own, UUID);
    assert.notEqual(own, machineId);
    assert.equal(statSync(accountPath()).mode & 0o777, 0o600);
    assert.equal(computer.bridge_device_uuid, own, "its heartbeat bound its own id");
    assert.equal(first.bridge_device_uuid, machineId, "the other install keeps its own");
    assert.equal(computeKeysPathFor(own), join(dataDir, "compute-keys.json"), "its own sealed-turn keys, not the machine's");
    await until(() => backend.calls.some((c) => c.startsWith("GET /bridge/tasks/next")));
    const bridgeIds = backend.calls.flatMap((c, i) => (c.includes("/bridge/") ? [backend.bridgeDeviceIds[i]] : []));
    assert.ok(bridgeIds.length > 0 && bridgeIds.every((id) => id === own), bridgeIds.join(","));
    assert.ok(!logs.some((l) => l.includes("bridge_device_")), logs.join("\n"));

    // The same id on the next start.
    await service.heartbeat();
    assert.equal(readAccountFile()!.bridge_device_id, own);
  } finally {
    service.stop();
  }
});

test("a server that worked keeps the id the account bound to it, and its sealed-turn keys", async () => {
  resetLinkForTests();
  const computer = linkedBefore("NAS");
  computer.bridge_device_uuid = machineId;
  const service = startAccountService({ localBaseUrl: "http://127.0.0.1:1" });
  try {
    await service.heartbeat();
    assert.equal(readAccountFile()!.bridge_device_id, machineId);
    assert.equal(computer.bridge_device_uuid, machineId);
    assert.equal(computeKeysPathFor(machineId), join(home, ".twoody-server", "compute-keys.json"));
  } finally {
    service.stop();
  }
});

test("a heartbeat kept but its bridge id refused: stays linked, said once", async () => {
  resetLinkForTests();
  const computer = linkedBefore("Pi 2");
  const logs: string[] = [];
  const service = startAccountService({ localBaseUrl: "http://127.0.0.1:1", log: (m) => logs.push(m) });
  try {
    backend.forced.set(`POST /account_computers/${computer.id}/heartbeat`, { status: 200, body: { bridge: "bridge_device_taken" } });
    for (let i = 0; i < 3; i += 1) await service.heartbeat();
    backend.forced.delete(`POST /account_computers/${computer.id}/heartbeat`);
    assert.equal(linkState(), "linked");
    const said = logs.filter((l) => l.includes("bridge_device_taken"));
    assert.equal(said.length, 1, logs.join("\n"));
    assert.match(said[0]!, /keeps this server online/);
  } finally {
    service.stop();
  }
});
