// A server without the Desktop (a Pi) loads its default model when it
// starts, in the background, and keeps it in memory when there is room —
// against the fake llama-server of test/fixtures.
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createPrefsStore, parsePrefs } from "../src/builtin/prefs.js";
import { runtimeArgs } from "../src/builtin/manager.js";
import { effectiveBuiltin, initEngine, preloadBuiltin, resetEngine } from "../src/engine.js";
import { parseAssignments } from "../src/cli/runtime.js";

const fake = fileURLToPath(new URL("./fixtures/fake-llama-server.mjs", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "twoody-preload-"));
after(() => rmSync(work, { recursive: true, force: true }));
afterEach(async () => {
  await resetEngine();
});

const GIB = 1024 ** 3;
let nextPort = 49_100 + Math.floor(Math.random() * 300) * 10;

function setup({ prefs = { engine: "builtin" } as Record<string, unknown>, modelBytes = 1000, desktop = false } = {}) {
  const dataDir = mkdtempSync(join(work, "case-"));
  const binaryDir = join(dataDir, "runtime-bin");
  const modelsDir = join(dataDir, "models");
  mkdirSync(binaryDir);
  mkdirSync(modelsDir);
  copyFileSync(fake, join(binaryDir, "fake-llama-server.mjs"));
  writeFileSync(join(binaryDir, "llama-server"), `#!/bin/sh\nexec "${process.execPath}" "${join(binaryDir, "fake-llama-server.mjs")}" "$@"\n`);
  chmodSync(join(binaryDir, "llama-server"), 0o755);
  writeFileSync(join(modelsDir, "Qwen3.5-4B-Q4_K_M.gguf"), Buffer.alloc(modelBytes));
  writeFileSync(join(dataDir, "runtime.json"), JSON.stringify({ v: 2, ...prefs }));
  const lines: string[] = [];
  initEngine({
    env: { TWOODY_DATA_DIR: dataDir, HOME: dataDir, TMPDIR: dataDir, ...(desktop ? { TWOODY_RUNTIME_OWNER: "desktop" } : {}) },
    log: (line) => lines.push(line),
    manager: {
      binaryDir,
      modelsDir,
      stateDir: dataDir,
      platform: "linux",
      arch: "arm64",
      cpuCount: () => 4,
      totalMemory: () => 8 * GIB,
      availableMemory: async () => 6 * GIB,
      firstPort: (nextPort += 10),
    },
  });
  const records = () =>
    readdirSync(binaryDir).filter((name) => name.startsWith("record-")).map((name) => JSON.parse(readFileSync(join(binaryDir, name), "utf8")) as { argv: string[] });
  const requests = () =>
    readdirSync(binaryDir).filter((name) => name.startsWith("request-")).map((name) => JSON.parse(readFileSync(join(binaryDir, name), "utf8")) as { url: string; body: { model?: string; max_tokens?: number } });
  return { dataDir, lines, records, requests };
}

test("at startup, the default model is loaded and kept in memory when the free memory holds it twice over", async () => {
  const { records, requests, lines } = setup({ modelBytes: 1000 });
  const result = await preloadBuiltin({ availableMemory: async () => 6 * GIB, log: (line) => lines.push(line) });
  assert.deepEqual(result, { loaded: "Qwen3.5-4B-Q4_K_M", keepLoaded: true });
  const argv = records()[0].argv;
  assert.equal(argv.includes("--sleep-idle-seconds"), false, "never released while the server runs");
  const load = requests().find((r) => r.url === "/v1/chat/completions");
  assert.equal(load?.body.model, "Qwen3.5-4B-Q4_K_M");
  assert.equal(load?.body.max_tokens, 1);
  assert.match(lines.join("\n"), /loaded at startup; kept in memory/);
});

test("without room for it twice, it is loaded but released after half an hour, as before", async () => {
  const { records } = setup({ modelBytes: 1000 });
  const result = await preloadBuiltin({ availableMemory: async () => 1500 });
  assert.deepEqual(result, { loaded: "Qwen3.5-4B-Q4_K_M", keepLoaded: false });
  const argv = records()[0].argv;
  assert.equal(argv[argv.indexOf("--sleep-idle-seconds") + 1], "1800");
});

test("idle_minutes chosen wins; preload off, another engine or the Desktop: nothing is started", async () => {
  const chosen = setup({ prefs: { engine: "builtin", builtin: { idle_minutes: 10 } } });
  assert.deepEqual(await preloadBuiltin({ availableMemory: async () => 6 * GIB }), { loaded: "Qwen3.5-4B-Q4_K_M", keepLoaded: false });
  const argv = chosen.records()[0].argv;
  assert.equal(argv[argv.indexOf("--sleep-idle-seconds") + 1], "600");
  await resetEngine();

  const off = setup({ prefs: { engine: "builtin", builtin: { preload: false } } });
  assert.deepEqual(await preloadBuiltin(), { loaded: null, reason: "off", keepLoaded: false });
  assert.equal(off.records().length, 0);
  await resetEngine();

  const desktop = setup({ desktop: true });
  assert.deepEqual(await preloadBuiltin(), { loaded: null, reason: "desktop", keepLoaded: false });
  assert.equal(desktop.records().length, 0);
  await resetEngine();

  const ollama = setup({ prefs: { engine: "ollama" } });
  assert.equal((await preloadBuiltin()).loaded, null);
  assert.equal(ollama.records().length, 0);
});

test("idle_minutes: optional, 0 for never; a file from before keeps no forced default; config set takes preload and never", () => {
  assert.deepEqual(parsePrefs(null), { engine: "auto", builtin: {} });
  // Written at the first start by an older server: the default, not a choice.
  assert.deepEqual(parsePrefs({ engine: "builtin", builtin: { idle_minutes: 30 } }).builtin, {});
  assert.deepEqual(parsePrefs({ v: 2, engine: "builtin", builtin: { idle_minutes: 30, preload: false } }).builtin, { idle_minutes: 30, preload: false });
  assert.deepEqual(parsePrefs({ v: 2, builtin: { idle_minutes: 0 } }).builtin, { idle_minutes: 0 });
  assert.equal(effectiveBuiltin({}, true).idle_minutes, 0);
  assert.equal(effectiveBuiltin({}, false).idle_minutes, 30);
  assert.equal(effectiveBuiltin({ idle_minutes: 5 }, true).idle_minutes, 5);
  const args = runtimeArgs({ backend: "cpu", port: 1, modelsDir: "/m", ctx: 8192, threads: null, idleSeconds: 0 });
  assert.equal(args.includes("--sleep-idle-seconds"), false);

  assert.deepEqual(parseAssignments(["preload=off", "idle_minutes=never"]).builtin, { preload: false, idle_minutes: 0 });
  assert.deepEqual(parseAssignments(["builtin.preload=on", "idle_minutes=default"]).builtin, { preload: true, idle_minutes: null });
  assert.throws(() => parseAssignments(["preload=maybe"]), /on or off/);

  const dir = mkdtempSync(join(work, "store-"));
  const store = createPrefsStore({ dataDir: dir, env: {} });
  store.write({ engine: "builtin", builtin: { preload: false, idle_minutes: 30 } });
  assert.deepEqual(store.read().prefs.builtin, { preload: false, idle_minutes: 30 }, "an idle time chosen now stays chosen");
  assert.equal(JSON.parse(readFileSync(store.path, "utf8")).v, 2);
});
