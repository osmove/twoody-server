import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Inside Twoody Desktop the tunnel key is sealed by safeStorage in the
// Desktop's main process and handed over by message at start; this process
// then never writes it to a file (cryptography review of 11/10/2026: until
// then DATA_DIR/tunnel-identity held it in clear, 0600). The key itself
// never changes on the way: every paired device pins it.
process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-tunnel-key-store-"));

const { tunnelIdentity, useTunnelKeyStore, tunnelKeyKeeping, TunnelKeyLockedError, thisSecurityCode } = await import("../src/tunnel/identity.js");
const { tunnelKeyFromDesktop, desktopKeepsTunnelKey } = await import("../src/tunnel/desktopKeyStore.js");
const { createIdentity, Channel, startHandshake } = await import("../src/tunnel/channel.js");

const FILE = join(process.env.TWOODY_DATA_DIR!, "tunnel-identity");
const KEPT = "5f".repeat(32);

/// A stand-in for Electron's process.parentPort, the Desktop at the other end.
function desktop(answer: ((request: unknown) => unknown) | null) {
  const toServer = new EventEmitter();
  const posted: unknown[] = [];
  const port = {
    on: (event: "message", listener: (event: { data: unknown }) => void) => void toServer.on(event, listener),
    removeListener: (event: "message", listener: (event: { data: unknown }) => void) => void toServer.removeListener(event, listener),
    postMessage: (message: unknown) => {
      posted.push(message);
      const reply = answer?.(message);
      if (reply) queueMicrotask(() => toServer.emit("message", { data: reply }));
    },
  };
  return { port, posted };
}

test("the key handed over by the Desktop is the one used, and nothing is written to a file", async () => {
  const { port } = desktop((m) => ((m as { type: string }).type === "tunnel-key-request" ? { type: "tunnel-key", state: "ok", hex: KEPT } : null));
  assert.equal(await tunnelKeyFromDesktop(port), "ok");
  const identity = tunnelIdentity();
  // The same key as the file held before: the private half rebuilt gives the same public half.
  assert.equal(Buffer.from(identity.privateKey.export({ type: "pkcs8", format: "der" })).subarray(-32).toString("hex"), KEPT);
  assert.equal(existsSync(FILE), false);
  assert.equal(tunnelKeyKeeping(), "store");
  assert.match(thisSecurityCode() ?? "", /\S/);
});

test("with nothing kept yet, a key is made here and handed back to be sealed, once", async () => {
  const { port, posted } = desktop((m) => ((m as { type: string }).type === "tunnel-key-request" ? { type: "tunnel-key", state: "none" } : null));
  assert.equal(await tunnelKeyFromDesktop(port), "none");
  const first = tunnelIdentity().publicKey.toString("hex");
  assert.equal(tunnelIdentity().publicKey.toString("hex"), first);
  const saves = posted.filter((m) => (m as { type: string }).type === "tunnel-key-save") as Array<{ hex: string }>;
  assert.equal(saves.length, 1);
  assert.match(saves[0]!.hex, /^[0-9a-f]{64}$/);
  assert.equal(existsSync(FILE), false);
});

test("a sealed key that cannot be opened now is never replaced: everything that needs it fails", async () => {
  const { port, posted } = desktop((m) => ((m as { type: string }).type === "tunnel-key-request" ? { type: "tunnel-key", state: "locked" } : null));
  assert.equal(await tunnelKeyFromDesktop(port), "locked");
  assert.throws(() => tunnelIdentity(), TunnelKeyLockedError);
  assert.equal(thisSecurityCode(), null);
  assert.equal(existsSync(FILE), false);
  assert.equal(posted.some((m) => (m as { type: string }).type === "tunnel-key-save"), false);
});

test("attack: a malformed or missing answer is taken as locked, never as a reason to make a new key", async () => {
  for (const reply of [{ type: "tunnel-key", state: "ok", hex: "zz" }, { type: "tunnel-key", state: "ok" }, { type: "tunnel-key", state: "other" }]) {
    const { port } = desktop(() => reply);
    assert.equal(await tunnelKeyFromDesktop(port), "locked");
    assert.throws(() => tunnelIdentity(), TunnelKeyLockedError);
  }
  const silent = desktop(null);
  assert.equal(await tunnelKeyFromDesktop(silent.port, { timeoutMs: 20 }), "locked");
  assert.equal(existsSync(FILE), false);
});

test("without protected storage the Desktop says so, and the 0600 file is kept as before", async () => {
  const { port } = desktop(() => ({ type: "tunnel-key", state: "file" }));
  assert.equal(await tunnelKeyFromDesktop(port), "file");
  const key = tunnelIdentity().publicKey.toString("hex");
  assert.equal(existsSync(FILE), true);
  useTunnelKeyStore(null);
  assert.equal(tunnelIdentity().publicKey.toString("hex"), key);
  assert.match(readFileSync(FILE, "utf8"), /^[0-9a-f]{64}\n$/);
});

test("a key made by the store works in the tunnel like any other", async () => {
  const { port } = desktop(() => ({ type: "tunnel-key", state: "ok", hex: KEPT }));
  await tunnelKeyFromDesktop(port);
  const computer = tunnelIdentity();
  const phone = createIdentity();
  const a = startHandshake();
  const b = startHandshake();
  const phoneSide = new Channel({ role: "initiator", handshake: a, identity: phone, peerEphemeral: b.ephemeralPublicKey, peerStatic: computer.publicKey });
  const computerSide = new Channel({ role: "responder", handshake: b, identity: computer, peerEphemeral: a.ephemeralPublicKey, peerStatic: phone.publicKey });
  assert.equal(computerSide.open(phoneSide.seal("hello")).toString(), "hello");
});

test("only a Desktop that says it keeps the key is asked for it", () => {
  assert.equal(desktopKeepsTunnelKey({ TWOODY_TUNNEL_KEY_STORE: "desktop" }), true);
  assert.equal(desktopKeepsTunnelKey({}), false);
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  // Before buildApp: nothing can ask for the key before it is there.
  assert.ok(source.indexOf("tunnelKeyFromDesktop(") < source.indexOf("await buildApp()"));
});
