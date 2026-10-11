import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createComputeHost } from "../src/compute/computeHost.js";
import { identityFromKeyFile } from "../src/shares/hostIdentity.js";

// Inside Twoody Desktop, this computer's sealed-turn keys (identity private
// keys, prekeys, ML-KEM secrets) are kept by its main process, sealed by
// safeStorage, instead of in compute-keys.json in clear (cryptography audit
// of 11/10/2026). The file then holds the public identity only, which the
// embedded server reads for safety numbers. A headless server keeps its
// file.

const NOW = 1_790_600_000_000;

function keyPath() {
  return join(mkdtempSync(join(tmpdir(), "twoody-compute-store-")), "compute-keys.json");
}

function memoryStore(initial: string | null = null) {
  const saved: string[] = [];
  return { saved, store: { initial, save: (json: string) => void saved.push(json) } };
}

test("with a store, no private key is written to the file, which holds the public identity", () => {
  const path = keyPath();
  const { saved, store } = memoryStore();
  const host = createComputeHost({ path, now: () => NOW, store });
  host.rotate();

  const file = readFileSync(path, "utf8");
  assert.doesNotMatch(file, /private|mlkem|prekeys/);
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  const keys = host.publicKeys();
  assert.deepEqual(JSON.parse(file), { v: 1, identity: keys.identity });
  assert.deepEqual(identityFromKeyFile(path), { encPublic: keys.identity.enc_public, signPublic: keys.identity.sign_public });

  const last = JSON.parse(saved.at(-1)!);
  assert.ok(last.identity.enc_private && last.identity.sign_private);
  assert.equal(last.prekeys.length, 1);
  assert.ok(last.prekeys[0].mlkem_secret);
});

test("new keys are handed to the store at once, before any prekey", () => {
  const path = keyPath();
  const { saved, store } = memoryStore();
  createComputeHost({ path, now: () => NOW, store });
  assert.equal(saved.length, 1);
  assert.ok(existsSync(path));
});

test("the keys handed back are this computer's: same identity, same prekey, nothing new saved", () => {
  const first = memoryStore();
  const path = keyPath();
  const host = createComputeHost({ path, now: () => NOW, store: first.store });
  host.rotate();
  const before = host.publicKeys();

  const again = memoryStore(first.saved.at(-1)!);
  const restored = createComputeHost({ path: keyPath(), now: () => NOW + 1_000, store: again.store });
  assert.equal(restored.rotate(), false);
  assert.deepEqual(restored.publicKeys(), before);
  assert.equal(again.saved.length, 0);
});

test("unreadable keys from the store are replaced, as an unreadable file was", () => {
  const { saved, store } = memoryStore("{not json");
  const host = createComputeHost({ path: keyPath(), now: () => NOW, store });
  assert.equal(saved.length, 1);
  assert.equal(JSON.parse(saved[0]!).identity.enc_private.length, 64);
  assert.ok(host.publicKeys().fingerprint);
});

test("without a store (a Pi), the keys stay in the file, readable by this user only", () => {
  const path = keyPath();
  const host = createComputeHost({ path, now: () => NOW });
  host.rotate();
  const stored = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(stored.identity.enc_private);
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(identityFromKeyFile(path), { encPublic: host.publicKeys().identity.enc_public, signPublic: host.publicKeys().identity.sign_public });
});
