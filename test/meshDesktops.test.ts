import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { startFakeRuntime } from "./helpers/fakeBackend.js";

// Two Twoody Desktops and a Raspberry Pi of one account in the mesh
// (docs/mesh-design.md §1-§2): Jimmy's MacBook Air and Mac mini, each a
// person device of the vault (someone sits at them: they approve), and the
// Pi, a computer the iPhone bound. A Desktop has no computer binding, so
// until it says which computer of the account it is, the roster never
// counts it: the other Desktop and the Pi refuse it their documents, and
// the Pi cannot search it. Here it says so itself, desktop-binding-v1
// signed by its own vault key (src/vault/contracts.ts).
//
//   this process   the MacBook Air: an embedded server in « desktop » mode
//                  (the Desktop handed it its vault keys and account
//                  computer), which signs and publishes its own
//                  desktop-binding, builds its roster from the vault and
//                  fans a question out to the two others;
//   child 1        the Mac mini: another Desktop's embedded server, with a
//                  document of its own, its roster from the same vault;
//   child 2        the Pi, the same with the real roster.
//
// Each child decides with the real roster (vault/roster.ts →
// peerDocuments/trust.ts): the session's tunnel key must be the one the
// computer's binding — desktop or computer — names.

const root = fileURLToPath(new URL("..", import.meta.url));
const AIR = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const MINI = "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60";
const PI = "3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6071";
const USER_ID = "7";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

async function until<T>(check: () => T | Promise<T>, ms = 10_000, what = "condition"): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-mesh-desktops-air-"));
delete process.env.TWOODY_USER_TOKEN;
process.env.LOG_LEVEL ??= "warn";
delete process.env.TWOODY_DEVICE_TOKEN;
delete process.env.TWOODY_BACKEND_URL;

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { accountPeers, db } = await import("../src/db.js");
const { ensureLocalUser } = await import("../src/pairing.js");
const { setDesktopAccount } = await import("../src/account/service.js");
const { folderRisk } = await import("../src/documents/folderRisk.js");
const { closeAllPeerLinks, peerById, refreshPeerStatus, setPeerHandshakeTimeouts } = await import("../src/peers/index.js");
const { setFanOutDeadlines } = await import("../src/documents/remote.js");
const { tunnelIdentity } = await import("../src/tunnel/identity.js");
const { meshRoster, setRosterSource } = await import("../src/vault/roster.js");
const { ensureDesktopBinding, resetVaultForTests, setDesktopVault } = await import("../src/vault/service.js");
const { desktopBindingValid } = await import("../src/vault/contracts.js");
const { fromHex, toHex } = await import("../src/vault/crypto.js");
const { meshVault } = await import("./helpers/meshVault.js");

setDesktopAccount({ backendUrl: "http://127.0.0.1:9", userToken: "unused", computerId: AIR, computerName: "MacBook Air" });
setPeerHandshakeTimeouts({ lan: 15_000, relay: 1_000 });
const airTunnelKey = tunnelIdentity().publicKey.toString("hex");

const home = realpathSync(homedir());
const tmpBase = realpathSync(tmpdir());
const base = folderRisk(join(tmpBase, "x"), home) === null ? tmpBase : home;
const docsRoot = realpathSync(mkdtempSync(join(base, "twoody-mesh-desktops-test-")));

const runtime = await startFakeRuntime({ models: ["gemma3:4b"], reply: () => "D'après vos documents [1] [2]." });
const app = await buildApp();
await app.listen({ port: 0, host: "127.0.0.1" });

// ── the Mac mini and the Pi, each in its own process ────────────────────
type Ready = { url: string; token: string; tunnelKey: string };
function start(name: string, self: string, env: Record<string, string>) {
  return (async () => {
    const port = await freePort();
    const child: ChildProcess = fork(join(root, "test", "helpers", "meshPeerServer.ts"), [], {
      cwd: root,
      execArgv: ["--import", "tsx"],
      env: {
        ...process.env,
        TWOODY_DATA_DIR: mkdtempSync(join(tmpdir(), `twoody-mesh-desktops-${name}-`)),
        PORT: String(port),
        LOG_LEVEL: "warn",
        TWOODY_BONJOUR_DISABLED: "1",
        MESH_SELF_ID: self,
        MESH_PEER_ID: AIR,
        MESH_PEER_KEY: airTunnelKey,
        MESH_DOCS_DIR: join(docsRoot, name),
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let output = "";
    child.stdout!.on("data", (chunk) => (output += chunk));
    child.stderr!.on("data", (chunk) => (output += chunk));
    const ready = await new Promise<Ready>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${name} did not start: ${output}`)), 30_000);
      child.on("message", (m: Ready & { type: string }) => {
        if (m.type === "ready") {
          clearTimeout(timer);
          resolve(m);
        }
      });
      child.on("exit", (code) => reject(new Error(`${name} exited (${code}): ${output}`)));
    });
    const ask = <T>(message: Record<string, unknown>, reply: string): Promise<T> =>
      new Promise((resolve) => {
        const on = (m: { type: string }) => {
          if (m.type !== reply) return;
          child.off("message", on);
          resolve(m as T);
        };
        child.on("message", on);
        child.send(message);
      });
    return { child, ready, ask };
  })();
}
const [mini, pi] = await Promise.all([
  start("mini", MINI, {
    MESH_SELF_NAME: "Mac mini",
    MESH_DOC_ID: "mini-facture",
    MESH_DOC_FILE: "facture-electricite.txt",
    MESH_DOC_TEXT: "Facture d'électricité de septembre : la facture s'élève à 84 euros.",
  }),
  start("pi", PI, { MESH_SELF_NAME: "Raspberry Pi" }),
]);

test.after(async () => {
  setRosterSource(null);
  resetVaultForTests();
  closeAllPeerLinks();
  for (const { child } of [mini, pi]) if (child.exitCode === null) child.kill("SIGTERM");
  await app.close();
  await runtime.close();
  if (process.platform === "darwin") {
    const trash = join(homedir(), ".Trash");
    mkdirSync(trash, { recursive: true });
    renameSync(docsRoot, join(trash, basename(docsRoot)));
  } else rmSync(docsRoot, { recursive: true, force: true });
});

// ── the vault: the iPhone founds it; both Desktops are person devices it
// approved; the Mac mini already named itself; the Pi is bound by the iPhone.
const vault = meshVault(USER_ID);
const iphone = vault.person("iPhone");
const air = vault.person("MacBook Air", iphone);
const miniDevice = vault.desktop("Mac mini", MINI, iphone, { tunnelKey: mini.ready.tunnelKey });
vault.computer("Raspberry Pi", PI, iphone, { tunnelKey: pi.ready.tunnelKey });
const airPairing = randomBytes(32).toString("hex");
const input = () => vault.input([iphone]);
const tellRoster = async (target: typeof mini, rosterInput = input()) =>
  (await target.ask<{ computers: string[] }>({ type: "roster", input: rosterInput }, "roster")).computers;

// The MacBook Air's Desktop hands its keys and its account computer over.
const published: string[] = [];
const epochOne = randomBytes(32);
setDesktopVault(
  {
    type: "vault", deviceId: air.id, userId: USER_ID,
    keys: { encPrivate: toHex(air.keys.encPrivate), encPublic: toHex(air.keys.encPublic), signPrivate: toHex(air.keys.signPrivate), signPublic: toHex(air.keys.signPublic) },
    epochs: { 1: toHex(epochOne) }, anchors: [vault.anchorOf(iphone)],
    computer: { id: AIR, pairing_public_key: airPairing },
  },
  {
    api: { postEvents: async () => ({ stored: 0 }), events: async () => ({ events: [] }) },
    state: async () => ({ devices: input().devices, epoch: 1 }),
    publish: async (deviceId, binding) => {
      assert.equal(deviceId, air.id);
      published.push(binding);
      air.desktop_binding = binding;
    },
  },
);
setRosterSource(null);

// The Air's person, its model; the other two as its mesh links.
const desktopSession = (await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } })).json();
const auth = { "x-user-token": desktopSession.token };
await app.inject({ method: "POST", url: "/providers/local", headers: auth, payload: { url: runtime.url, model: "gemma3:4b" } });
await app.inject({ method: "PATCH", url: "/me", headers: auth, payload: { user: { memory_enabled: false } } });
const user = ensureLocalUser();
const now = new Date();
for (const [id, name, peer] of [[MINI, "Mac mini", mini], [PI, "Raspberry Pi", pi]] as const) {
  db.insert(accountPeers)
    .values({ computerId: id, userId: user.id, name, state: "linked", enabled: true, url: peer.ready.url, token: peer.ready.token, tunnelKey: peer.ready.tunnelKey, origin: "mesh", createdAt: now, updatedAt: now })
    .run();
}

/// A search as the tunnel serves it: from this machine, with its marker and
/// the key of the device at the other end (tunnel/host.ts), the Air's
/// unless said. `plain`: as plain HTTP would carry it.
const search = (target: typeof mini, token: string, key: string | null = airTunnelKey) =>
  fetch(`${target.ready.url}/api/v1/peer/documents/search`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(key ? { "x-twoody-via-tunnel": "direct", "x-twoody-tunnel-peer": key } : {}) },
    body: JSON.stringify({ q: "facture électricité contrat location voiture", scope: { mode: "all" } }),
  });

test("before it names itself, the MacBook Air is no computer of the mesh: the Mac mini and the Pi refuse it", async () => {
  assert.ok(!air.desktop_binding);
  assert.deepEqual(await tellRoster(mini), [MINI, PI], "the Mac mini counts itself and the Pi, not the Air");
  assert.deepEqual(await tellRoster(pi), [MINI, PI]);
  assert.equal((await search(mini, mini.ready.token)).status, 403);
  assert.equal((await search(pi, pi.ready.token)).status, 403);
});

test("the Air's embedded server signs and publishes its own desktop-binding, once, and its roster counts the three computers", async () => {
  await meshRoster().refresh();
  await until(() => published.length === 1, 5_000, "the desktop-binding");
  const wire = JSON.parse(published[0]!);
  assert.deepEqual(Object.keys(wire).sort(), ["account_computer_id", "pairing_public_key", "signature", "tunnel_public_key", "vault_device_id"]);
  const { signature, ...bound } = wire;
  assert.deepEqual(bound, { vault_device_id: air.id, account_computer_id: AIR, tunnel_public_key: airTunnelKey, pairing_public_key: airPairing });
  assert.ok(desktopBindingValid({ userId: USER_ID, binding: bound, deviceSignPublic: fromHex(air.sign_public), signature }), "signed by the Air's own vault key");
  const roster = await meshRoster().refresh();
  assert.deepEqual([...roster!.computers.keys()].sort(), [AIR, MINI, PI].sort());
  assert.equal(roster!.computers.get(MINI)!.via, "desktop");
  assert.equal(roster!.computers.get(AIR)!.tunnelPublicKey, airTunnelKey);
  assert.ok(roster!.persons.has(air.id) && roster!.persons.has(miniDevice.id), "both Desktops still person devices");
  // Already said: not published again.
  assert.equal(await ensureDesktopBinding(input().devices), "current");
  assert.equal(published.length, 1);
});

test("the Mac mini (a Desktop) and the Pi now serve the Air their documents, over the Air's bound key only", async () => {
  assert.deepEqual(await tellRoster(mini), [AIR, MINI, PI].sort());
  assert.deepEqual(await tellRoster(pi), [AIR, MINI, PI].sort());
  const fromMini = await search(mini, mini.ready.token);
  assert.equal(fromMini.status, 200, await fromMini.clone().text());
  const body = await fromMini.json();
  assert.equal(body.computer_id, MINI);
  assert.ok(body.passages.some((p: { document_id: string }) => p.document_id === "mini-facture"));
  assert.equal((await search(pi, pi.ready.token)).status, 200);
  // The same token over plain HTTP, or through the tunnel of another key: nothing.
  assert.equal((await search(mini, mini.ready.token, null)).status, 403);
  assert.equal((await search(mini, mini.ready.token, randomBytes(32).toString("hex"))).status, 403);
  // The Air's id under another tunnel key: not the Air.
  const otherKey = randomBytes(32).toString("hex");
  const other = await mini.ask<{ token: string }>({ type: "session", computerId: AIR, key: otherKey }, "session");
  assert.equal((await search(mini, other.token, otherKey)).status, 403);
});

test("the Pi searches the Mac mini (a Desktop) with its own bound key; a forged or moved desktop-binding counts for nothing", async () => {
  const piOnMini = await mini.ask<{ token: string }>({ type: "session", computerId: PI, key: pi.ready.tunnelKey }, "session");
  const answer = await search(mini, piOnMini.token, pi.ready.tunnelKey);
  assert.equal(answer.status, 200, await answer.clone().text());
  assert.ok((await answer.json()).passages.some((p: { document_id: string }) => p.document_id === "mini-facture"));
  // The account forges the Air's binding (another tunnel key), or moves it
  // onto the iPhone's device: the Mac mini no longer counts the Air.
  const forged = input();
  const airRow = forged.devices.find((d) => d.id === air.id)!;
  airRow.desktop_binding = JSON.stringify({ ...JSON.parse(published[0]!), tunnel_public_key: randomBytes(32).toString("hex") });
  assert.deepEqual(await tellRoster(mini, forged), [MINI, PI]);
  assert.equal((await search(mini, mini.ready.token)).status, 403);
  const moved = input();
  moved.devices.find((d) => d.id === air.id)!.desktop_binding = null;
  moved.devices.find((d) => d.id === iphone.id)!.desktop_binding = published[0]!;
  assert.deepEqual(await tellRoster(mini, moved), [MINI, PI]);
  assert.equal((await search(mini, mini.ready.token)).status, 403);
  assert.deepEqual(await tellRoster(mini), [AIR, MINI, PI].sort());
});

test("one question on the Air cites the Mac mini's document and the Pi's, each under its computer", async () => {
  setFanOutDeadlines({ direct: 10_000, relay: 10_000 });
  for (const id of [MINI, PI]) assert.ok(await refreshPeerStatus(peerById(user.id, id)!).then(() => true));
  const response = await app.inject({
    method: "POST", url: "/queries", headers: auth,
    payload: { content: "Combien coûte la facture d'électricité et jusqu'à quand court le contrat de location de la voiture ?" },
  });
  const block = response.payload.split("\n\n").find((b) => b.startsWith("event: final"));
  assert.ok(block, response.payload.slice(-800));
  const answer = JSON.parse(block!.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
  const cited = new Map<string, { document_id: string; url: string; computer_name: string }>(answer.sources.map((s: { computer_id: string }) => [s.computer_id, s]));
  assert.equal(cited.get(MINI)?.document_id, "mini-facture", JSON.stringify(answer.sources));
  assert.equal(cited.get(MINI)?.url, `twoody://doc/${MINI}/mini-facture`);
  assert.equal(cited.get(MINI)?.computer_name, "Mac mini");
  assert.equal(cited.get(PI)?.document_id, "pi-voiture");
  assert.deepEqual(
    answer.documents.computers.filter((c: { computer_id: string }) => c.computer_id !== AIR).map((c: { computer_id: string; status: string }) => [c.computer_id, c.status]).sort(),
    [[MINI, "answered"], [PI, "answered"]].sort(),
  );
  assert.ok(!JSON.stringify(answer.sources).includes(docsRoot), "no absolute path");
});

// « Faire confiance » from a Desktop: its embedded server asks the Pi as
// the Desktop's own computer of the account, and must be able to name the
// Desktop's person device as the Pi's vault anchor. So it carries a
// device-access/v2 by the Desktop's vault key, for its tunnel key and that
// computer, which the Pi checks against the Desktop's desktop-binding
// (sessionTrust.ts peerSessionIsDesktop). An account that refuses it (an
// older one, or before the binding is published) gets the plain request.
test("the Air's embedded server asks a computer as the Air, with a device-access its person device signed", async () => {
  const { setBackendFetch } = await import("../src/account/backend.js");
  const { requestPeer, removePeer } = await import("../src/peers/index.js");
  const { claimedDeviceAccess, readPending } = await import("../src/account/approvals.js");
  const { deviceAccessV2Valid } = await import("../src/vault/contracts.js");
  const { pairDevice } = await import("../src/pairing.js");
  const { peerSessionIsDesktop, sessionRow } = await import("../src/sessionTrust.js");
  const NEW_PI = "5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f607182";
  const asked: Array<Record<string, any>> = [];
  let refuseAccess = false;
  setBackendFetch((async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url.pathname.endsWith("/account_computers")) return reply(200, { account_id: Number(USER_ID), computers: [{ id: NEW_PI, name: "Pi du bureau", public_key: "cd".repeat(32), online: true, kind: "server" }] });
    if (url.pathname.endsWith("/request_access")) {
      const body = JSON.parse(String(init?.body));
      asked.push({ body, credential: new Headers(init?.headers).get("X-Requester-Computer-Credential") });
      if (refuseAccess && body.device_access) return reply(422, { error: "invalid_device_access" });
      return reply(201, { id: `r${asked.length}`, expires_at: new Date(Date.now() + 300_000).toISOString() });
    }
    return reply(200, { state: "pending" });
  }) as typeof fetch);
  try {
    await requestPeer(user.id, NEW_PI, { requester: { computerId: AIR, credential: "air-credential-0123456789" } });
    const { body, credential } = asked.at(-1)!;
    assert.equal(credential, "air-credential-0123456789");
    assert.deepEqual([body.role, body.requester_computer_id, body.public_key], ["peer", AIR, airTunnelKey]);
    const access = body.device_access;
    assert.deepEqual([access.vault_device_id, access.tunnel_public_key, access.account_computer_id], [air.id, airTunnelKey, NEW_PI]);
    const now = Math.floor(Date.now() / 1000);
    assert.ok(access.exp > now && access.exp <= now + 12 * 3600, "12 h at most");
    const { signature, ...stated } = access;
    assert.ok(deviceAccessV2Valid({ userId: USER_ID, access: stated, signerSignPublic: fromHex(air.sign_public), signature }), "signed by the Air's own vault key");

    // What the Pi then does with it (its approval keeps it; its anchor
    // route checks it against the Air's published desktop-binding): the
    // Air may pin itself; the same session naming the Mac mini's computer
    // may not, nor may the Mac mini's device be pinned through it.
    const request = readPending({ requests: [{ id: "r1", name: "x", public_key: body.public_key, expires_at: new Date(Date.now() + 60_000).toISOString(), role: "peer", requester_computer_id: AIR, device_access: access }] })[0]!;
    const kept = claimedDeviceAccess(request, NEW_PI);
    assert.ok(kept);
    const session = (requester: string) => sessionRow(pairDevice({ deviceName: "MacBook Air", tunnelPublicKey: airTunnelKey, role: "peer", origin: "account", requesterComputerId: requester, approvalRule: "endorsed", vaultDeviceId: kept!.vault_device_id, deviceAccessJson: JSON.stringify(kept) }).sessionId);
    const devices = input().devices;
    const check = (requester: string, anchor: { id: string; sign_public: string }) => peerSessionIsDesktop(session(requester), { userId: USER_ID, selfComputerId: NEW_PI, anchor, devices });
    assert.equal(check(AIR, { id: air.id, sign_public: air.sign_public }), true);
    assert.equal(check(MINI, { id: air.id, sign_public: air.sign_public }), false, "the Air's statement under the Mac mini's computer");
    assert.equal(check(AIR, { id: miniDevice.id, sign_public: miniDevice.sign_public }), false, "the Mac mini's device through the Air's session");
    assert.equal(check(PI, { id: air.id, sign_public: air.sign_public }), false, "under the Pi's computer");

    // Not for another computer asking, nor refused by the account.
    await requestPeer(user.id, NEW_PI, { requester: { computerId: MINI, credential: "mini-credential-0123456789" } });
    assert.equal(asked.at(-1)!.body.device_access, undefined, "the handed computer only");
    refuseAccess = true;
    const before = asked.length;
    await requestPeer(user.id, NEW_PI, { requester: { computerId: AIR, credential: "air-credential-0123456789" } });
    assert.equal(asked.length, before + 2);
    assert.ok(asked[before]!.body.device_access);
    assert.equal(asked[before + 1]!.body.device_access, undefined, "asked again without it");
    assert.equal(asked[before + 1]!.body.requester_computer_id, AIR);
  } finally {
    await removePeer(user.id, NEW_PI);
    setBackendFetch(null);
  }
});
