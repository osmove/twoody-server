import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writePrivateFile } from "../src/vault/store.js";

// The vault's keys are written through a temporary file (src/vault/store.ts):
// a random name, created exclusively, never through a link someone put there.

test("writePrivateFile: 0600, whole, through a random temporary name that no planted link can catch", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "twoody-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "vault.json");
  const elsewhere = join(dir, "elsewhere.txt");
  writeFileSync(elsewhere, "untouched");
  // The name the old code used (pid-based, predictable), planted as a link.
  symlinkSync(elsewhere, `${path}.${process.pid}.tmp`);

  writePrivateFile(path, '{"keys":1}');
  writePrivateFile(path, '{"keys":2}');

  assert.equal(readFileSync(path, "utf8"), '{"keys":2}');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.ok(!lstatSync(path).isSymbolicLink());
  assert.equal(readFileSync(elsewhere, "utf8"), "untouched", "the planted link was not followed");
  const left = readdirSync(dir).filter((name) => name.endsWith(".tmp") && name !== `vault.json.${process.pid}.tmp`);
  assert.deepEqual(left, [], "no temporary file left behind");
});

test("writePrivateFile: a failed write leaves the previous file as it was", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "twoody-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "vault.json");
  writePrivateFile(path, "first");
  assert.throws(() => writePrivateFile(join(dir, "missing", "vault.json"), "second"));
  assert.equal(readFileSync(path, "utf8"), "first");
});
