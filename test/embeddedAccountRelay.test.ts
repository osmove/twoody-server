import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startFakeBackend } from "./helpers/fakeBackend.js";

// Twoody Desktop's embedded server runs local-only (TWOODY_LOCAL_ONLY=1):
// it may not reach the account on the internet. The vault's calls already
// went through the Desktop's main process (vault/desktopAccount.ts); the
// mesh's did not: the account's computers, request_access, its sealed answer
// and its consume were each refused before they left, so POST /api/v1/peers
// answered 409 « no such computer in the account » and the Mac never linked
// to the Pi (30/09/2026).
//
// Here the server is embedded (a parent port, local-only, the account on
// the internet) and every call its mesh makes to the account must go
// through that port — none may try the network itself.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-embedded-account-relay-"));
process.env.TWOODY_LOCAL_ONLY = "1";
process.env.TWOODY_BONJOUR_DISABLED = "1";
process.env.TWOODY_PEER_POLL_MS = "3600000";
process.env.LOG_LEVEL ??= "warn";
delete process.env.TWOODY_USER_TOKEN;
delete process.env.TWOODY_BACKEND_URL;

const backend = await startFakeBackend();

const { LOCAL_ONLY, LocalOnlyError, outboundFetch } = await import("../src/outbound.js");
const { setBackendFetch, BackendError } = await import("../src/account/backend.js");
const { setDesktopAccount } = await import("../src/account/service.js");
const { sealPairing } = await import("../src/account/pairingSeal.js");
const { newPairingKey } = await import("../src/account/keys.js");
const { ACCOUNT_CALL_REQUEST, ACCOUNT_CALL_RESULT, isRelayedCall, RELAYED_CALLS, relayAccountThroughDesktop } = await import("../src/account/desktopRelay.js");
const { accountComputers: accountPeers, authSessions, db } = await import("../src/db.js");
const { ensureLocalUser } = await import("../src/pairing.js");
const { accountComputers, checkPeerRequest, closeAllPeerLinks, forgetAccountComputers, peerById, requestPeer, setPeerHandshakeTimeouts, syncPeersWithAccount, PeerUnavailableError } = await import("../src/peers/index.js");
const { listComputers } = await import("../src/router/index.js");
const { tunnelIdentity } = await import("../src/tunnel/identity.js");
const { eq } = await import("drizzle-orm");

// The Pi is not there: the status asked of it once linked gives up fast.
setPeerHandshakeTimeouts({ lan: 100, relay: 100 });

const hex = () => randomBytes(32).toString("hex");
const user = ensureLocalUser();
const ownKey = tunnelIdentity().publicKey.toString("hex");

// The account: this Mac (a Desktop, whose credential only the main process
// holds) and the Pi.
const mac = backend.addComputer({ name: "MacBook Air de Jimmy", public_key: hex(), kind: "desktop" });
const piPairing = newPairingKey();
const pi = backend.addComputer({ name: "twoody-pi-trixie", public_key: piPairing.pub, kind: "server" });
const MAC = String(mac.id);
const PI = String(pi.id);

// What the Desktop hands its server: an account on the internet.
setDesktopAccount({ backendUrl: "https://api.twoody.invalid", userToken: "desktop-session", deviceToken: "installation", computerId: MAC, computerName: "MacBook Air de Jimmy" });

/// Every call backendCall would send out itself: through the real gate,
/// which local-only mode shuts for the internet.
const direct: string[] = [];
setBackendFetch(((url: string | URL | Request, init?: RequestInit) => {
  direct.push(String(url));
  return outboundFetch(url, init);
}) as typeof fetch);

/// The Desktop's main process, as the server sees it: it makes the call
/// with its own session, and adds this Mac's credential to a
/// request_access that names this Mac (twoody-desktop serverAccountCalls.ts).
type Call = { type: string; id: string; method: string; path: string; body?: Record<string, unknown> };
function fakeDesktop() {
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const asked: Call[] = [];
  const port = {
    on: (_event: "message", listener: (event: { data: unknown }) => void) => void listeners.push(listener),
    postMessage: (message: unknown) => {
      const call = message as Call;
      assert.equal(call.type, ACCOUNT_CALL_REQUEST);
      asked.push(call);
      void (async () => {
        const requester = call.body?.requester_computer_id === MAC ? { "X-Requester-Computer-Credential": mac.credential } : {};
        const response = await fetch(`${backend.url}/api/v1/${call.path}`, {
          method: call.method,
          headers: { Accept: "application/json", "Content-Type": "application/json", "X-User-Token": backend.userToken, "X-Device-Token": "installation", ...requester },
          ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}),
        });
        const json = (await response.json().catch(() => null)) as { error?: string } | null;
        const reply = response.ok ? { status: response.status, result: json } : { error: { status: response.status, code: json?.error ?? null } };
        for (const listener of listeners) listener({ data: { type: ACCOUNT_CALL_RESULT, id: call.id, ...reply } });
      })();
    },
  };
  return { port, asked };
}

test.after(async () => {
  setBackendFetch(null);
  await new Promise((resolve) => setTimeout(resolve, 500));
  closeAllPeerLinks();
  await backend.close();
});

test("the server is embedded: local-only, its account on the internet", () => {
  assert.equal(LOCAL_ONLY, true);
});

test("without the Desktop's relay, the mesh's account calls are refused before they leave", async () => {
  forgetAccountComputers();
  direct.length = 0;
  assert.equal(await accountComputers({ fresh: true, strict: true }), null);
  await assert.rejects(
    requestPeer(user.id, PI, { origin: "mesh", requester: { computerId: MAC, credential: mac.credential } }),
    (err: unknown) => err instanceof PeerUnavailableError && err.code === "not_linked",
  );
  assert.ok(direct.length >= 2 && direct.every((url) => url.startsWith("https://api.twoody.invalid/api/v1/account_computers")), direct.join(", "));
  // Each refused by the local-only gate, not by the account.
  await assert.rejects(outboundFetch(direct[0]!), (err: unknown) => err instanceof LocalOnlyError);
  assert.equal(backend.authorizations.length, 0, "nothing reached the account");
});

test("with it, every mesh call goes through the Desktop and none tries the network", async () => {
  const desktop = fakeDesktop();
  const undo = relayAccountThroughDesktop(desktop.port);
  direct.length = 0;
  try {
    forgetAccountComputers();
    // The account's computers: /providers, the router.
    const listed = await accountComputers({ fresh: true, strict: true });
    assert.deepEqual(listed?.map((c) => c.id).sort(), [MAC, PI].sort());
    const computers = await listComputers(user.id);
    assert.ok(computers?.some((c) => c.id === PI && !c.self), "the Pi is one of this Mac's computers");

    // A link to the Pi, as this Mac's computer (the Desktop's POST /peers).
    const asked = await requestPeer(user.id, PI, { origin: "mesh", requester: { computerId: MAC, credential: mac.credential } });
    const authorization = backend.authorizations.find((a) => String(a.id) === asked.request_id);
    assert.ok(authorization, "request_access reached the account");
    assert.equal(authorization.requester_computer_id, mac.id, "named after this Mac: the Desktop added its credential");
    assert.equal(authorization.public_key, ownKey, "with this server's own tunnel key");
    assert.equal(peerById(user.id, PI)?.state, "requested");

    // Still waiting, then the Pi's sealed answer: picked up and consumed.
    assert.equal(await checkPeerRequest(user.id, PI), "pending");
    const piTunnel = hex();
    authorization.state = "approved";
    authorization.sealed_response = sealPairing(piPairing.priv, ownKey, asked.request_id, {
      localServerUrl: "http://192.168.1.142:47821", localServerToken: "peer-token", computerTunnelKey: piTunnel, computerName: "twoody-pi-trixie", kind: "server",
    });
    assert.equal(await checkPeerRequest(user.id, PI), "linked");
    assert.equal(authorization.state, "consumed");
    const linked = peerById(user.id, PI)!;
    assert.deepEqual([linked.state, linked.tunnelKey, linked.token], ["linked", piTunnel, "peer-token"]);

    // The account no longer lists the Pi: set aside here, and the sessions
    // given to it go.
    const now = new Date();
    db.insert(authSessions).values({ id: "pi-session", userId: user.id, tokenDigest: randomBytes(32).toString("hex"), clientKind: "peer", origin: "account", requesterComputerId: PI, createdAt: now }).run();
    backend.computers.splice(backend.computers.indexOf(pi), 1);
    assert.deepEqual(await syncPeersWithAccount(user.id), [PI]);
    assert.equal(peerById(user.id, PI)?.state, "removed");
    assert.equal(db.select().from(authSessions).where(eq(authSessions.id, "pi-session")).all().length, 0);

    // Nothing tried the network; the Desktop was asked for the four calls only.
    assert.deepEqual(direct, [], "no mesh call tried the network itself");
    for (const call of desktop.asked) assert.ok(isRelayedCall(call.method, call.path), `${call.method} ${call.path}`);
    const used = new Set(desktop.asked.map((c) => RELAYED_CALLS.findIndex((r) => r.method === c.method && r.path.test(c.path))));
    assert.equal(used.size, RELAYED_CALLS.length, "all four went through the Desktop");
    // No credential of this server in any message.
    const said = JSON.stringify(desktop.asked);
    for (const secret of [mac.credential, "desktop-session", "installation"]) assert.ok(!said.includes(secret), "no credential travels to the Desktop");
  } finally {
    undo();
    backend.computers.push(pi);
    db.delete(accountPeers).where(eq(accountPeers.computerId, PI)).run();
  }
});

test("the account's refusals keep their status through the Desktop, and other calls stay refused", async () => {
  const desktop = fakeDesktop();
  const undo = relayAccountThroughDesktop(desktop.port);
  direct.length = 0;
  try {
    // Another computer named as the requester: the Desktop vouches only
    // for its own, so the account refuses it — 403, as it said it.
    await assert.rejects(
      requestPeer(user.id, PI, { requester: { computerId: "9999", credential: "x".repeat(32) } }),
      (err: unknown) => err instanceof BackendError && err.status === 403 && err.code === "invalid_requester_credential",
    );
    assert.deepEqual(direct, []);
    // Not one of the mesh's calls (the heartbeat of a linked computer):
    // never handed to the Desktop, and refused by the gate as before.
    const { backendCall } = await import("../src/account/backend.js");
    const before = desktop.asked.length;
    await assert.rejects(
      backendCall({ backendUrl: "https://api.twoody.invalid", userToken: "t" }, `account_computers/${MAC}/heartbeat`, { body: {} }),
      (err: unknown) => err instanceof LocalOnlyError,
    );
    await assert.rejects(backendCall({ backendUrl: "https://api.twoody.invalid", userToken: "t" }, "vault/devices/x/revoke", { body: {} }), (err: unknown) => err instanceof LocalOnlyError);
    assert.equal(desktop.asked.length, before);
    assert.equal(direct.length, 2);
  } finally {
    undo();
  }
});

test("a Desktop that does not answer is « unreachable », not a hang", async () => {
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const undo = relayAccountThroughDesktop({ on: (_e, l) => void listeners.push(l), postMessage: () => undefined });
  try {
    const { backendCall } = await import("../src/account/backend.js");
    await assert.rejects(
      backendCall({ backendUrl: "https://api.twoody.invalid", userToken: "t" }, "account_computers", { timeoutMs: 10 }),
      (err: unknown) => err instanceof BackendError && err.status === 502,
    );
  } finally {
    undo();
  }
});
