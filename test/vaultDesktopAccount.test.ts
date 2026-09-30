import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Jimmy's mesh on 30/09/2026: the iPhone founded the vault, approved the
// MacBook Air (a Twoody Desktop: a person device) and bound the Pi, whose
// only anchor is the iPhone. The Pi verified the Air as a person, yet never
// counted it as a computer of the mesh: the Air had no desktop-binding.
// Its embedded server runs local-only (the Desktop starts it with
// TWOODY_LOCAL_ONLY=1), so every call it made to the account — GET /vault,
// publishing the desktop-binding, the memories — was refused before it
// left: its own roster stayed empty and nothing was ever published.
//
// Now the vault's account calls go through the Desktop's main process by
// message (src/vault/desktopAccount.ts); the server itself still calls
// nothing outside.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-vault-desktop-account-"));
process.env.TWOODY_LOCAL_ONLY = "1";
process.env.LOG_LEVEL ??= "warn";

const { LOCAL_ONLY } = await import("../src/outbound.js");
const { setDesktopAccount } = await import("../src/account/service.js");
const { tunnelIdentity } = await import("../src/tunnel/identity.js");
const { buildRoster, createRosterCache, meshRoster, setRosterSource } = await import("../src/vault/roster.js");
const { resetVaultForTests, setDesktopVault, ensureDesktopBinding } = await import("../src/vault/service.js");
const { desktopVaultAccount, VAULT_ACCOUNT_REQUEST, VAULT_ACCOUNT_RESULT } = await import("../src/vault/desktopAccount.js");
const { isTrustedComputer } = await import("../src/peerDocuments/trust.js");
const { toHex } = await import("../src/vault/crypto.js");
const { meshVault } = await import("./helpers/meshVault.js");

const USER_ID = "1";
const MAC = "d3ee2e80-1111-4a2b-8c3d-4e5f60718293";
const PI = "19c2f908-2a9a-4fa6-92f8-3264a9085b95";

// The account the Desktop hands its server: on the internet, where a
// local-only server may not go.
setDesktopAccount({ backendUrl: "https://api.twoody.invalid", userToken: "desktop-session", computerId: MAC, computerName: "MacBook Air de Jimmy" });
const macTunnelKey = tunnelIdentity().publicKey.toString("hex");
const macPairing = randomBytes(32).toString("hex");

const vault = meshVault(USER_ID);
const iphone = vault.person("iPhone");
const mac = vault.person("MacBook Air de Jimmy", iphone);
const pi = vault.computer("twoody-pi-trixie", PI, iphone);

/// What the Desktop hands its server: its keys, the iPhone as the start of
/// its trust (pinned when the iPhone approved it), its account computer.
const handOver = {
  type: "vault", deviceId: mac.id, userId: USER_ID,
  keys: { encPrivate: toHex(mac.keys.encPrivate), encPublic: toHex(mac.keys.encPublic), signPrivate: toHex(mac.keys.signPrivate), signPublic: toHex(mac.keys.signPublic) },
  epochs: { 1: toHex(randomBytes(32)) }, anchors: [vault.anchorOf(iphone)],
  computer: { id: MAC, pairing_public_key: macPairing },
};

/// The Desktop's main process, as the server sees it: a port it posts to
/// and hears from. `answer` plays the main process.
type Request = { type: string; id: string; op: string; args: Record<string, unknown> };
function fakeDesktop(answer: (request: Request) => Promise<{ result?: unknown; error?: unknown }>) {
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const asked: Request[] = [];
  const port = {
    on: (_event: "message", listener: (event: { data: unknown }) => void) => void listeners.push(listener),
    postMessage: (message: unknown) => {
      const request = message as Request;
      assert.equal(request.type, VAULT_ACCOUNT_REQUEST);
      asked.push(request);
      void answer(request).then((reply) => {
        for (const listener of listeners) listener({ data: { type: VAULT_ACCOUNT_RESULT, id: request.id, ...reply } });
      });
    },
  };
  return { port, asked };
}

/// The Pi's roster: walked from its one anchor, the iPhone.
const piRoster = () => buildRoster(vault.input([iphone]));

test.after(() => {
  setRosterSource(null);
  resetVaultForTests();
});

test("as it was: the Pi verifies the Air as a person, but no computer; the Air's local-only server reaches nothing", async () => {
  assert.equal(LOCAL_ONLY, true);
  const before = piRoster();
  assert.ok(before.persons.has(mac.id), "the iPhone approved the Air: a verified person device");
  assert.deepEqual([...before.computers.keys()], [PI], "no desktop-binding: the Air is no computer of the Pi's mesh");

  // The hand-over alone: the server asks the account itself, and local-only refuses.
  setDesktopVault(handOver);
  setRosterSource(null);
  assert.equal(await meshRoster().refresh(), null, "no roster: GET /vault never left");
  assert.equal(mac.desktop_binding ?? null, null, "nothing published");
});

test("through the Desktop: the Air's server builds its roster, publishes its desktop-binding, and the Pi then counts the Air", async () => {
  const desktop = fakeDesktop(async ({ op, args }) => {
    if (op === "state") return { result: { devices: vault.input([]).devices, epoch: 1 } };
    if (op === "publishDesktopBinding") {
      assert.equal(args.deviceId, mac.id);
      mac.desktop_binding = String(args.desktopBinding);
      return { result: { device: { id: mac.id } } };
    }
    if (op === "events") return { result: { events: [], next_after: null } };
    if (op === "postEvents") return { result: { stored: (args.events as unknown[]).length } };
    return { error: { status: 422, code: "unknown_op" } };
  });
  setDesktopVault(handOver, desktopVaultAccount(desktop.port));
  setRosterSource(null);

  const first = await meshRoster().refresh();
  assert.deepEqual([...first!.computers.keys()], [PI], "the Air's own roster (from the iPhone) counts the Pi");
  for (let i = 0; i < 100 && !mac.desktop_binding; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(mac.desktop_binding, "published through the Desktop");
  assert.ok(desktop.asked.some((r) => r.op === "state") && desktop.asked.some((r) => r.op === "publishDesktopBinding"));

  // The Pi, anchored on the iPhone only, now counts the Air, under the
  // Air's server's own tunnel key.
  const after = piRoster();
  assert.deepEqual([...after.computers.keys()].sort(), [MAC, PI].sort());
  const air = after.computers.get(MAC)!;
  assert.equal(air.via, "desktop");
  assert.equal(air.tunnelPublicKey, macTunnelKey);
  assert.equal(air.pairingPublicKey, macPairing);

  // Mesh document search both ways: the Pi's roster gives the Air's key
  // (it serves the Air, over that key only), the Air's gives the Pi's.
  const piView = createRosterCache({ source: async () => vault.input([iphone]) });
  assert.equal(await piView.tunnelKeyOf(MAC), macTunnelKey);
  assert.equal(await piView.tunnelKeyOf("another-computer"), null);
  await meshRoster().refresh();
  assert.equal(await isTrustedComputer(PI, { tunnelKey: pi.tunnelKey }), true, "the Air serves the Pi its documents");
  assert.equal(await isTrustedComputer(PI, { tunnelKey: randomBytes(32).toString("hex") }), false, "over the Pi's bound key only");
  assert.equal(await isTrustedComputer(MAC), true, "and counts itself");

  // Said once: not published again.
  assert.equal(await ensureDesktopBinding(vault.input([]).devices), "current");
  assert.equal(desktop.asked.filter((r) => r.op === "publishDesktopBinding").length, 1);
});

test("the Desktop's refusals keep the account's meaning: 401 empties the roster, anything else keeps the last one", async () => {
  let reply: { result?: unknown; error?: unknown } = { result: { devices: vault.input([]).devices, epoch: 1 } };
  const desktop = fakeDesktop(async () => reply);
  const account = desktopVaultAccount(desktop.port);
  setDesktopVault(handOver, account);
  setRosterSource(null);
  assert.ok((await meshRoster().refresh())?.computers.has(PI));

  reply = { error: { status: 500, code: "http_500" } };
  assert.ok((await meshRoster().refresh())?.computers.has(PI), "account out of reach: the last verified roster stays");
  await assert.rejects(account.state(), (err: Error & { status?: number }) => err.status === 502);

  reply = { error: { status: 401, code: "session_expired" } };
  assert.equal(await meshRoster().refresh(), null, "session refused: nobody");

  // The batch answers pass as results; the events call carries its page.
  reply = { result: { conflicts: ["x"] } };
  assert.deepEqual(await account.api.postEvents([]), { conflicts: ["x"] });
  reply = { result: { events: [], next_after: null } };
  await account.api.events({ after: 5, limit: 10, stream: "memories" });
  assert.deepEqual(desktop.asked.at(-1)!.args, { after: 5, limit: 10, stream: "memories" });
});

test("an answer for no request, or from another kind of message, changes nothing", async () => {
  const listeners: Array<(event: { data: unknown }) => void> = [];
  let posted: Request | null = null;
  const account = desktopVaultAccount({ on: (_e, l) => void listeners.push(l), postMessage: (m) => void (posted = m as Request) });
  const pending = account.state();
  const say = (data: unknown) => listeners.forEach((l) => l({ data }));
  say({ type: VAULT_ACCOUNT_RESULT, id: "not-asked", result: { devices: [] } });
  say({ type: "mobile-agent-result", id: posted!.id, result: { devices: [] } });
  say({ type: VAULT_ACCOUNT_RESULT, id: posted!.id, result: { epoch: 3 } });
  assert.deepEqual(await pending, { epoch: 3 });
});
