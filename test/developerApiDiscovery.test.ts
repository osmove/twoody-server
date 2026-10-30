import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// ~/.twoody/local-server.json (docs/developer-api-design.md §2): where the
// `twoody` command finds this server; the Desktop's wins over `twoody serve`.

const { clearDiscovery, readDiscovery, writeDiscovery } = await import("../src/developerApi/discovery.js");

test("written 0600 with the API address, removed only by the process that wrote it", () => {
  const path = join(mkdtempSync(join(tmpdir(), "twoody-discovery-")), "sub", "local-server.json");
  assert.equal(writeDiscovery(47821, "desktop", "0.2.0", path), true);
  const value = readDiscovery(path)!;
  assert.equal(value.url, "http://127.0.0.1:47821");
  assert.equal(value.api, "http://127.0.0.1:47821/v1");
  assert.equal(value.kind, "desktop");
  assert.equal(value.pid, process.pid);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  writeFileSync(path, JSON.stringify({ ...value, pid: 1 }));
  clearDiscovery(path);
  assert.ok(existsSync(path), "another process's file stays");
  writeFileSync(path, JSON.stringify(value));
  clearDiscovery(path);
  assert.ok(!existsSync(path));
});

test("`twoody serve` leaves the file to a live Desktop, and takes it from a dead one", () => {
  const path = join(mkdtempSync(join(tmpdir(), "twoody-discovery-")), "local-server.json");
  // A live Desktop: this test's parent process.
  writeFileSync(path, JSON.stringify({ url: "http://127.0.0.1:47821", api: "http://127.0.0.1:47821/v1", kind: "desktop", pid: process.ppid, version: "x", started_at: "x" }));
  assert.equal(writeDiscovery(3000, "server", "0.2.0", path), false);
  assert.equal(readDiscovery(path)!.kind, "desktop");
  writeFileSync(path, JSON.stringify({ url: "http://127.0.0.1:47821", api: "x", kind: "desktop", pid: 2 ** 22 + 12345, version: "x", started_at: "x" }));
  assert.equal(writeDiscovery(3000, "server", "0.2.0", path), true);
  assert.equal(readDiscovery(path)!.url, "http://127.0.0.1:3000");
});

test("TWOODY_DISCOVERY_FILE=off writes nothing", () => {
  process.env.TWOODY_DISCOVERY_FILE = "off";
  try {
    assert.equal(writeDiscovery(3000, "server", "0.2.0"), false);
  } finally {
    delete process.env.TWOODY_DISCOVERY_FILE;
  }
});
