import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROBE_TIMEOUT_MS, retryOnCpu, selectRuntimeEngine, START_TIMEOUT_MS, type RuntimeEngine } from "../src/builtin/acceleration.js";
import { failureOf } from "../src/builtin/failure.js";

const metal: RuntimeEngine = { binary: "/r/llama-server", backend: "metal", devices: 1 };
const vulkan: RuntimeEngine = { binary: "C:\\r\\vulkan\\llama-server.exe", backend: "vulkan", devices: 1 };
const cpu: RuntimeEngine = { binary: "/r/llama-server", backend: "cpu", devices: 0 };

test("a first GPU compile is waited for: minutes, not the 15 and 20 s that cut a Mac's Metal compile short", () => {
  // An M5 with an empty shader cache took 37 to 40 s under load (10/10/2026).
  assert.ok(PROBE_TIMEOUT_MS >= 120_000 && PROBE_TIMEOUT_MS <= 300_000);
  assert.ok(START_TIMEOUT_MS >= 120_000 && START_TIMEOUT_MS <= 300_000);
});

test("the CPU is tried after a GPU that failed, not after one that was only slow on a Mac", () => {
  const exited = failureOf(1, "darwin");
  const crashed = failureOf(null, "darwin", "SIGABRT");
  const silent = failureOf(null, "darwin");
  assert.equal(retryOnCpu(metal, exited, false), true);
  assert.equal(retryOnCpu(metal, crashed, false), true);
  // Same program on the CPU: it would prepare the same Metal code first.
  assert.equal(retryOnCpu(metal, silent, false), false);
  // Windows: the CPU build is another program, without Vulkan's shaders.
  assert.equal(retryOnCpu(vulkan, failureOf(null, "win32"), false), true);
  assert.equal(retryOnCpu(vulkan, failureOf(0xc0000135, "win32"), false), true);
  // Once.
  assert.equal(retryOnCpu(vulkan, exited, true), false);
  assert.equal(retryOnCpu(cpu, exited, false), false);
});

test("a GPU check that answers late still finds the GPU", async () => {
  const dir = mkdtempSync(join(tmpdir(), "twoody-acceleration-"));
  writeFileSync(join(dir, "llama-server"), "");
  const slow = async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return "Available devices:\n  MTL0: Apple M5 (18186 MiB, 18185 MiB free)\n";
  };
  assert.equal((await selectRuntimeEngine(dir, "darwin", {}, false, slow)).backend, "metal");
  assert.equal((await selectRuntimeEngine(dir, "darwin", {}, true, slow)).backend, "cpu");
});
