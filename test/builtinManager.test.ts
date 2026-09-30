// The manager against a fake llama-server (fixtures/fake-llama-server.mjs):
// how it is started, where it listens, the key, idle, leftovers, memory.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RuntimeError,
  createRuntimeManager,
  defaultContextSize,
  loadedFromModels,
  memoryNeeded,
  type RuntimeManager,
  type RuntimeManagerOptions,
} from "../src/builtin/manager.js";

const fake = fileURLToPath(new URL("./fixtures/fake-llama-server.mjs", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "twoody-manager-"));
const managers: RuntimeManager[] = [];
const strays: number[] = [];
after(async () => {
  await Promise.all(managers.map((manager) => manager.stop()));
  for (const pid of strays) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
  rmSync(work, { recursive: true, force: true });
});

let nextPort = 48_100 + Math.floor(Math.random() * 400) * 10;
const GIB = 1024 ** 3;

function setup(models: Record<string, number> = { "Tiny-Q8_0": 1000 }) {
  const root = mkdtempSync(join(work, "case-"));
  const binaryDir = join(root, "runtime");
  const modelsDir = join(root, "models");
  const stateDir = join(root, "state");
  mkdirSync(binaryDir);
  mkdirSync(modelsDir);
  copyFileSync(fake, join(binaryDir, "fake-llama-server.mjs"));
  writeFileSync(join(binaryDir, "llama-server"), `#!/bin/sh\nexec "${process.execPath}" "${join(binaryDir, "fake-llama-server.mjs")}" "$@"\n`);
  chmodSync(join(binaryDir, "llama-server"), 0o755);
  for (const [id, bytes] of Object.entries(models)) writeFileSync(join(modelsDir, `${id}.gguf`), Buffer.alloc(bytes));
  const records = () =>
    readdirSync(binaryDir)
      .filter((name) => name.startsWith("record-"))
      .map((name) => JSON.parse(readFileSync(join(binaryDir, name), "utf8")) as { argv: string[]; env: Record<string, string>; pid: number });
  const lines: string[] = [];
  const make = (extra: Partial<RuntimeManagerOptions> = {}) => {
    const manager = createRuntimeManager({
      binaryDir,
      modelsDir,
      stateDir,
      log: (line) => lines.push(line),
      env: { HOME: root, TMPDIR: root, SECRET_OF_THE_SERVER: "x" },
      platform: "linux",
      arch: "arm64",
      cpuCount: () => 4,
      totalMemory: () => 16 * GIB,
      availableMemory: async () => 12 * GIB,
      firstPort: (nextPort += 10),
      restartBackoffMs: [50, 50, 50],
      ...extra,
    });
    managers.push(manager);
    return manager;
  };
  return { root, binaryDir, modelsDir, stateDir, records, lines, make };
}

const flag = (argv: string[], name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const waitFor = async (check: () => boolean | Promise<boolean>, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out");
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("started in router mode on loopback, with the Pi's defaults and a minimal environment", async () => {
  const { make, records, modelsDir, stateDir } = setup();
  const manager = make();
  assert.equal(manager.status().running, false);
  const { baseUrl, key } = await manager.ensure();
  assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  assert.match(key, /^[0-9a-f]{64}$/);
  const [record] = records();
  const argv = record.argv;
  assert.equal(flag(argv, "--host"), "127.0.0.1");
  assert.equal(flag(argv, "--models-dir"), modelsDir);
  assert.equal(flag(argv, "--models-max"), "1");
  assert.equal(flag(argv, "--parallel"), "1");
  assert.equal(flag(argv, "--cors-origins"), "http://twoody.invalid");
  assert.equal(flag(argv, "--ctx-size"), "8192");
  // The Pi 5's measured best (30/09/2026): 3 threads writing, 4 reading, batches of 128, no mmap.
  assert.equal(flag(argv, "--threads"), "3");
  assert.equal(flag(argv, "--threads-batch"), "4");
  assert.equal(flag(argv, "--ubatch-size"), "128");
  assert.equal(flag(argv, "--load-mode"), "none");
  assert.equal(flag(argv, "--sleep-idle-seconds"), "1800");
  assert.ok(argv.includes("--offline") && argv.includes("--no-webui"));
  assert.deepEqual(argv.slice(0, 5), ["--device", "none", "--gpu-layers", "0", "--no-op-offload"]);
  assert.ok(!argv.includes("--no-mmap"));
  // The key is in the environment, never on the command line; nothing else of the server's environment is.
  assert.ok(!argv.join(" ").includes(key));
  assert.equal(record.env.LLAMA_API_KEY, key);
  assert.equal(record.env.SECRET_OF_THE_SERVER, undefined);
  assert.equal(record.env.PATH, "/usr/bin:/bin");
  assert.equal(readFileSync(join(stateDir, "runtime.pid"), "utf8"), String(record.pid));
  const status = manager.status();
  assert.equal(status.running, true);
  assert.equal(status.pid, record.pid);
  assert.equal(status.managedBy, "server");
  // A second ensure is the same process.
  assert.equal((await manager.ensure()).baseUrl, baseUrl);
  assert.equal(records().length, 1);
  await manager.stop();
  assert.equal(manager.status().running, false);
  assert.equal(manager.auth(), null);
  assert.ok(!existsSync(join(stateDir, "runtime.pid")));
  await waitFor(() => !alive(record.pid));
});

test("the key is required, and never written to the log", async () => {
  const { make, stateDir } = setup();
  const manager = make();
  const { baseUrl, key } = await manager.ensure();
  const bare = await fetch(`${baseUrl}/models`);
  assert.equal(bare.status, 401);
  const wrong = await fetch(`${baseUrl}/models`, { headers: { Authorization: "Bearer nope" } });
  assert.equal(wrong.status, 401);
  const right = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(right.status, 200);
  assert.deepEqual(manager.auth(), { baseUrl, key });
  await waitFor(() => existsSync(join(stateDir, "runtime.log")) && readFileSync(join(stateDir, "runtime.log"), "utf8").includes("request headers"));
  const log = readFileSync(join(stateDir, "runtime.log"), "utf8");
  assert.ok(!log.includes(key));
  assert.match(log, /acceleration=cpu/);
  await manager.stop();
});

test("the loaded model is asked of the runtime, and status never starts it", async () => {
  const { make, records } = setup({ "Tiny-Q8_0": 1000, "Other-Q4_K_M": 2000 });
  const manager = make();
  manager.status();
  assert.equal(await manager.loadedModel(), null);
  assert.deepEqual((await manager.installedModels()).sort(), ["Other-Q4_K_M", "Tiny-Q8_0"]);
  assert.ok((await manager.address())?.baseUrl.startsWith("http://127.0.0.1:"));
  assert.equal(records().length, 0, "status, loadedModel, address: nothing started");
  const { baseUrl, key } = await manager.ensure({ model: "Tiny-Q8_0" });
  assert.equal(await manager.loadedModel(), null);
  await fetch(`${baseUrl}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: JSON.stringify({ model: "Tiny-Q8_0" }) });
  assert.equal(await manager.loadedModel(), "Tiny-Q8_0");
  await manager.stop();
});

test("idle unload and context follow the preference; elsewhere than ARM Linux, the Desktop's context rule", async () => {
  const { make, records } = setup();
  const manager = make({ settings: () => ({ idle_minutes: 5, ctx: 4096, threads: 2 }) });
  await manager.ensure();
  const argv = records()[0].argv;
  assert.equal(flag(argv, "--sleep-idle-seconds"), "300");
  assert.equal(flag(argv, "--ctx-size"), "4096");
  assert.equal(flag(argv, "--threads"), "2");
  assert.equal(flag(argv, "--threads-batch"), "4");
  await manager.stop();

  const x64 = setup();
  const other = x64.make({ arch: "x64", totalMemory: () => 32 * GIB });
  await other.ensure();
  const argv2 = x64.records()[0].argv;
  assert.equal(flag(argv2, "--ctx-size"), "16384");
  assert.equal(flag(argv2, "--threads"), undefined, "llama.cpp picks threads off a Pi");
  assert.equal(flag(argv2, "--threads-batch"), undefined);
  assert.equal(flag(argv2, "--ubatch-size"), undefined, "the Pi's batch size is the Pi's");
  assert.equal(flag(argv2, "--load-mode"), undefined, "mmap stays on elsewhere");
  await other.stop();
  assert.equal(defaultContextSize("linux", "x64", 8 * GIB), 8192);
  assert.equal(defaultContextSize("darwin", "arm64", 24 * GIB), 16384);
  assert.equal(defaultContextSize("linux", "arm64", 16 * GIB), 8192);
});

test("a model that would not fit is refused before anything starts", async () => {
  const { make, records } = setup({ "Big-Q4_K_M": 4096 });
  const manager = make({ availableMemory: async () => memoryNeeded(4096, 8192) - 1 });
  await assert.rejects(manager.ensure({ model: "Big-Q4_K_M" }), (err) => {
    assert.ok(err instanceof RuntimeError);
    assert.equal(err.code, "insufficient_memory");
    assert.equal(err.status, 507);
    assert.equal(err.details.model, "Big-Q4_K_M");
    return true;
  });
  assert.equal(records().length, 0);
  await assert.rejects(manager.ensure({ model: "Missing" }), (err) => err instanceof RuntimeError && err.code === "unknown_model");

  const roomy = make({ availableMemory: async () => memoryNeeded(4096, 8192) });
  await roomy.ensure({ model: "Big-Q4_K_M" });
  await roomy.stop();
  // A Pi's numbers: Qwen3.5 4B needs ~3.7 GB at 8k (3.78 GB measured anon on 29/09/2026).
  assert.ok(memoryNeeded(2_783_446_880, 8192) > 3.7e9);
});

test("a runtime left by a previous run is stopped; a process that is not ours is left alone", async () => {
  const { make, binaryDir, modelsDir, stateDir, records } = setup();
  mkdirSync(stateDir, { recursive: true });
  // Ours: a llama-server on our models folder, killed -9 with its server.
  const leftover = spawn(join(binaryDir, "llama-server"), ["--host", "127.0.0.1", "--port", String(nextPort + 9), "--models-dir", modelsDir], { stdio: "ignore", detached: true });
  strays.push(leftover.pid!);
  await waitFor(() => records().some((record) => record.pid === leftover.pid || record.argv.includes(String(nextPort + 9))));
  writeFileSync(join(stateDir, "runtime.pid"), String(leftover.pid));
  const manager = make();
  await manager.ensure();
  await waitFor(() => leftover.exitCode !== null || leftover.signalCode !== null);
  assert.ok(manager.status().running);
  await manager.stop();

  // Not ours: the pid now belongs to something else.
  const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  strays.push(other.pid!);
  writeFileSync(join(stateDir, "runtime.pid"), String(other.pid));
  const again = make();
  await again.ensure();
  assert.ok(alive(other.pid!), "an unrelated process is never killed");
  await again.stop();
  other.kill("SIGKILL");
});

test("a crashed runtime is restarted, at most three times; a failed start says why", async () => {
  const { make, binaryDir, records, lines } = setup();
  const manager = make();
  let { baseUrl, key } = await manager.ensure();
  for (let crash = 1; crash <= 3; crash += 1) {
    const before = manager.status().pid;
    await fetch(baseUrl.replace(/\/v1$/, "/crash"), { headers: { Authorization: `Bearer ${key}` } }).catch(() => undefined);
    await waitFor(() => manager.status().running && manager.status().pid !== before);
    assert.equal(manager.status().crashRestarts, crash);
    ({ baseUrl, key } = manager.auth()!);
  }
  await fetch(baseUrl.replace(/\/v1$/, "/crash"), { headers: { Authorization: `Bearer ${key}` } }).catch(() => undefined);
  await waitFor(() => !manager.status().running);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(manager.status().running, false, "not restarted a fourth time");
  assert.equal(manager.status().failure?.reason, "exited");
  assert.ok(lines.some((line) => /after 3 crashes/.test(line)));
  assert.equal(records().length, 4);

  // A binary missing a library: the loader's 127, told apart.
  writeFileSync(join(binaryDir, "exit-127"), "");
  const broken = make({ startTimeoutMs: 2_000 });
  await assert.rejects(broken.ensure(), (err) => err instanceof RuntimeError && err.code === "start_failed");
  assert.equal(broken.status().failure?.reason, "missing-library");
});

test("nothing is started when the Desktop owns the runtime, when none is installed, or without a model", async () => {
  const desktop = setup();
  const owned = desktop.make({ env: { TWOODY_RUNTIME_OWNER: "desktop" } });
  await assert.rejects(owned.ensure(), (err) => err instanceof RuntimeError && err.code === "managed_by_desktop" && err.status === 409);
  assert.equal(owned.available(), false);
  assert.equal(owned.status().managedBy, "desktop");
  assert.equal(desktop.records().length, 0);

  const empty = setup({});
  await assert.rejects(empty.make().ensure(), (err) => err instanceof RuntimeError && err.code === "no_models");

  const none = setup();
  rmSync(join(none.binaryDir, "llama-server"));
  await assert.rejects(none.make().ensure(), (err) => err instanceof RuntimeError && err.code === "not_installed");
});

test("the router's model list is read whichever form its status takes", () => {
  assert.equal(loadedFromModels({ data: [{ id: "a", status: { value: "unloaded" } }, { id: "b", status: { value: "loaded" } }] }), "b");
  assert.equal(loadedFromModels({ data: [{ id: "a", status: "loaded" }] }), "a");
  assert.equal(loadedFromModels({ data: [{ id: "a", status: { value: "loading" } }] }), null);
  assert.equal(loadedFromModels(null), null);
});
