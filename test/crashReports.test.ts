// The server's crash reports (src/crashReports.ts): written down where
// Twoody Desktop gathers them, in the shape it reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crashDir, recordServerCrash } from "../src/crashReports.js";

test("an uncaught exception is written down as one report, in the desktop's folder", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "twoody-crash-")), "pending");
  const path = recordServerCrash(new TypeError("boom"), "uncaughtException", dir);
  assert.ok(path);
  assert.deepEqual(readdirSync(dir).length, 1);
  const report = JSON.parse(readFileSync(path!, "utf8"));
  assert.equal(report.kind, "server_exception");
  assert.equal(report.process, "server");
  assert.equal(report.error.name, "TypeError");
  assert.equal(report.error.message, "boom");
  assert.match(report.id, /^[0-9a-f-]{36}$/);
  assert.equal(report.details.origin, "uncaughtException");
});

test("the folder: the desktop's when it says so, else the data folder's", () => {
  assert.equal(crashDir({ TWOODY_CRASH_DIR: "/x/pending" }), "/x/pending");
  assert.equal(crashDir({ TWOODY_DATA_DIR: "/data" }), join("/data", "crash-reports", "pending"));
});
