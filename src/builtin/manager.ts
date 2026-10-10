import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, promises as fs, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { cpus, homedir, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";

import { outboundFetch } from "../outbound.js";
import { accelerationArgs, retryOnCpu, selectRuntimeEngine, START_TIMEOUT_MS, type RuntimeEngine } from "./acceleration.js";
import { failureOf, type RuntimeFailure } from "./failure.js";
import { serverBinaryName } from "./runtimeManifest.js";

// llama.cpp's server, run by twoody-server itself on a computer without the
// Desktop app: a Pi, a Linux server, a Docker container. Ported from
// twoody-desktop/src/main/builtinRuntime.ts, without Electron, as one
// manager per call of createRuntimeManager().
//
// Router mode, like the Desktop: one process that lists the GGUF files of
// the models folder and loads the one a request names.
//   - loopback only, with an API key drawn for each manager: a loopback
//     port is reachable by any program on the computer, a web page
//     included. The key travels in the environment (LLAMA_API_KEY), never
//     on a command line; CORS is pinned to an origin that does not exist;
//   - `--offline`: the runtime can fetch models by itself, and must not;
//   - one model in memory at a time, released after half an hour of
//     silence (the « Moteur » preference's idle_minutes; 0 keeps it, and on
//     a computer without the Desktop the server may, engine.ts);
//   - started on demand, by ensure() on a chat to the built-in engine.
//     status() and loadedModel() never start it;
//   - a model is not loaded where it would not fit: MemAvailable must hold
//     its file × 1.15 plus the context's KV cache, else insufficient_memory;
//   - on a Pi: 3 threads writing, 4 reading, batches of 128 tokens, the
//     model read into memory (defaultThreads, platformArgs);
//   - never left behind: stop() on SIGTERM/SIGINT (the caller's), its pid
//     kept in runtime.pid so that a runtime that survived a crash of the
//     server is stopped by the next start — only when its command line is
//     a llama-server with our models folder, since pids are reused;
//   - restarted after a crash, at most three times in ten minutes, with a
//     growing wait between tries.

const FIRST_PORT = 47831;
const PORTS_TRIED = 10;
const LOG_LIMIT = 1024 * 1024;
const CRASH_WINDOW_MS = 10 * 60 * 1000;
const MAX_CRASH_RESTARTS = 3;
const DEFAULT_BACKOFF_MS = [1_000, 5_000, 15_000];
/// The share of a model's file it takes in memory, mapped and running.
const MODEL_OVERHEAD = 1.15;
/// A conservative allowance for the KV cache, per token of context.
const KV_BYTES_PER_TOKEN = 64 * 1024;

export type RuntimeErrorCode = "managed_by_desktop" | "not_installed" | "no_models" | "unknown_model" | "insufficient_memory" | "start_failed";

/// What a route answers for each refusal.
export const RUNTIME_ERROR_STATUS: Readonly<Record<RuntimeErrorCode, number>> = Object.freeze({
  managed_by_desktop: 409,
  not_installed: 404,
  no_models: 404,
  unknown_model: 404,
  insufficient_memory: 507,
  start_failed: 503,
});

export class RuntimeError extends Error {
  constructor(
    public code: RuntimeErrorCode,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RuntimeError";
  }

  get status(): number {
    return RUNTIME_ERROR_STATUS[this.code];
  }
}

/// The part of the « Moteur » preference the runtime reads (prefs.ts, builtin).
export interface RuntimeSettings {
  idle_minutes?: number;
  ctx?: number;
  threads?: number;
}

export interface RuntimeManagerOptions {
  /// The folder holding llama-server and its libraries.
  binaryDir: string;
  /// The GGUF files, DATA_DIR/models.
  modelsDir: string;
  /// runtime.pid and runtime.log.
  stateDir: string;
  log?: (line: string) => void;
  /// The server's environment: HOME and TMPDIR for the runtime, TWOODY_RUNTIME_OWNER.
  env?: NodeJS.ProcessEnv;
  /// Read at each start, so a changed preference applies at the next one.
  settings?: () => RuntimeSettings;
  platform?: NodeJS.Platform;
  arch?: string;
  totalMemory?: () => number;
  /// Bytes the kernel can give without swapping; null when it cannot be told.
  availableMemory?: () => Promise<number | null>;
  cpuCount?: () => number;
  firstPort?: number;
  startTimeoutMs?: number;
  restartBackoffMs?: number[];
  /// Tests: the GPU probe of acceleration.ts.
  probe?: (binary: string) => Promise<string>;
}

export interface RuntimeStatus {
  installed: boolean;
  running: boolean;
  starting: boolean;
  baseUrl: string | null;
  pid: number | null;
  acceleration: string;
  failure: RuntimeFailure | null;
  managedBy: "server" | "desktop";
  crashRestarts: number;
  ctx: number;
  threads: number | null;
  threadsBatch: number | null;
  idleSeconds: number;
}

export interface RuntimeManager {
  /// Starts the runtime if needed and returns its address and key. With a
  /// model, also checks that it is installed and fits in memory.
  ensure(options?: { model?: string }): Promise<{ baseUrl: string; key: string }>;
  stop(): Promise<void>;
  /// After an install or a removal: the router reads its folder at start.
  restart(): Promise<{ baseUrl: string; key: string } | null>;
  /// A GPU failure: start again on the CPU for the rest of this process's life.
  fallbackToCpu(): Promise<{ baseUrl: string; key: string } | null>;
  status(): RuntimeStatus;
  /// The model in memory, asked of the runtime when it runs; never starts it.
  loadedModel(): Promise<string | null>;
  /// The address and key while it runs; null otherwise.
  auth(): { baseUrl: string; key: string } | null;
  /// The address it has or will have, reserved without starting it.
  address(): Promise<{ baseUrl: string; key: string } | null>;
  available(): boolean;
  installedModels(): Promise<string[]>;
}

/// The context the model gets: 8k on ARM Linux (a Pi's memory and speed),
/// elsewhere the Desktop's rule — 16k from 15 GiB, else 8k.
export function defaultContextSize(platform: string, arch: string, totalBytes: number): number {
  if (platform === "linux" && arch === "arm64") return 8_192;
  return totalBytes >= 15 * 1024 ** 3 ? 16_384 : 8_192;
}

/// Threads for writing: on ARM Linux one core fewer than there are (a Pi 5:
/// 3 of 4), which leaves one to the server and the system and wrote 7 %
/// faster on a Pi 5 than all four (30/09/2026); elsewhere llama.cpp decides.
export function defaultThreads(platform: string, arch: string, cores: number): number | null {
  return platform === "linux" && arch === "arm64" ? Math.max(1, cores - 1) : null;
}

/// Threads for reading the prompt: every core on ARM Linux, where reading
/// is all arithmetic; elsewhere llama.cpp decides.
export function defaultThreadsBatch(platform: string, arch: string, cores: number): number | null {
  return platform === "linux" && arch === "arm64" ? Math.max(1, cores) : null;
}

/// What else the runtime is given by platform. On ARM Linux (a Pi):
/// batches of 128 tokens (-ub 128) and the model read into memory rather
/// than mapped (--load-mode none) — on a Pi 5 with Qwen3.5 4B, 5 % faster
/// on prompts and 3.8–4.1 GB of memory instead of 6.1 (30/09/2026).
export function platformArgs(platform: string, arch: string): string[] {
  return platform === "linux" && arch === "arm64" ? ["--ubatch-size", "128", "--load-mode", "none"] : [];
}

/// Memory a model needs to load: its file × 1.15, plus the KV cache of the context.
export function memoryNeeded(fileBytes: number, ctx: number): number {
  return Math.ceil(fileBytes * MODEL_OVERHEAD + ctx * KV_BYTES_PER_TOKEN);
}

/// MemAvailable of /proc/meminfo, in bytes; null elsewhere than Linux.
export async function memAvailable(): Promise<number | null> {
  if (process.platform !== "linux") return null;
  try {
    const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(await fs.readFile("/proc/meminfo", "utf8"));
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

/// The command line of llama-server, as a pure function for the tests.
export function runtimeArgs(options: {
  backend: RuntimeEngine["backend"];
  port: number;
  modelsDir: string;
  ctx: number;
  threads: number | null;
  threadsBatch?: number | null;
  idleSeconds: number;
  extra?: string[];
}): string[] {
  return [
    ...accelerationArgs(options.backend),
    "--host", "127.0.0.1",
    "--port", String(options.port),
    "--models-dir", options.modelsDir,
    "--models-max", "1",
    "--offline",
    "--no-webui",
    "--cors-origins", "http://twoody.invalid",
    "--parallel", "1",
    "--ctx-size", String(options.ctx),
    ...(options.threads ? ["--threads", String(options.threads)] : []),
    ...(options.threadsBatch ? ["--threads-batch", String(options.threadsBatch)] : []),
    ...(options.extra ?? []),
    // 0: the model stays in memory as long as the runtime runs (llama.cpp's
    // default when the flag is absent).
    ...(options.idleSeconds > 0 ? ["--sleep-idle-seconds", String(options.idleSeconds)] : []),
  ];
}

/// What the router's `GET /v1/models` says is loaded. Status is a string or
/// `{value}` depending on the llama.cpp version.
export function loadedFromModels(body: unknown): string | null {
  const data = body && typeof body === "object" ? (body as { data?: unknown }).data : null;
  if (!Array.isArray(data)) return null;
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const { id, status } = row as { id?: unknown; status?: unknown };
    const value = typeof status === "string" ? status : status && typeof status === "object" ? (status as { value?: unknown }).value : null;
    if (typeof id === "string" && value === "loaded") return id;
  }
  return null;
}

/// runtime.log: appended across restarts, one rotation at 1 MiB, the key never written.
function runtimeLog(path: string, secret: string): Writable {
  let size: number | null = null;
  return new Writable({
    write(chunk: Buffer, _encoding, done) {
      const text = chunk.toString("utf8").split(secret).join("[redacted]").replace(/Bearer\s+[\w.+/=-]+/gi, "Bearer [redacted]");
      (async () => {
        if (size === null) size = await fs.stat(path).then((s) => s.size, () => 0);
        if (size + Buffer.byteLength(text) > LOG_LIMIT) {
          await fs.rename(path, `${path}.1`).catch(() => undefined);
          size = 0;
        }
        await fs.appendFile(path, text, { mode: 0o600 });
        size += Buffer.byteLength(text);
      })().then(() => done(), () => done());
    },
  });
}

export function createRuntimeManager(options: RuntimeManagerOptions): RuntimeManager {
  const { binaryDir, modelsDir, stateDir } = options;
  const log = options.log ?? (() => undefined);
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const totalMemory = options.totalMemory ?? totalmem;
  const availableMemory = options.availableMemory ?? memAvailable;
  const cpuCount = options.cpuCount ?? (() => cpus().length);
  const firstPort = options.firstPort ?? FIRST_PORT;
  const startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
  const backoff = options.restartBackoffMs ?? DEFAULT_BACKOFF_MS;
  const managedByDesktop = env.TWOODY_RUNTIME_OWNER?.trim().toLowerCase() === "desktop";
  const pidFile = join(stateDir, "runtime.pid");
  const apiKey = randomBytes(32).toString("hex");

  let child: ChildProcess | null = null;
  let baseUrl: string | null = null;
  let starting: Promise<string | null> | null = null;
  let lastFailure: RuntimeFailure | null = null;
  let cpuOnly = false;
  let engine: RuntimeEngine | null = null;
  let reservedPort: number | null = null;
  let crashes: number[] = [];
  let restartTimer: NodeJS.Timeout | null = null;
  let stopping = false;

  const binaryPath = () => join(binaryDir, serverBinaryName(platform));
  const available = () => !managedByDesktop && existsSync(binaryPath());

  function settings() {
    const chosen = options.settings?.() ?? {};
    const cores = cpuCount();
    const threads = chosen.threads ?? defaultThreads(platform, arch, cores);
    const batch = defaultThreadsBatch(platform, arch, cores);
    return {
      ctx: chosen.ctx ?? defaultContextSize(platform, arch, totalMemory()),
      threads,
      threadsBatch: batch !== null && threads !== null ? Math.max(batch, threads) : batch,
      idleSeconds: Math.round((chosen.idle_minutes ?? 30) * 60),
    };
  }

  function runtimeEnvironment(): NodeJS.ProcessEnv {
    if (platform === "win32") {
      const root = env.SystemRoot ?? "C:\\Windows";
      const temp = env.TEMP ?? tmpdir();
      return { PATH: `${root}\\System32;${root}`, SystemRoot: root, TEMP: temp, TMP: temp, USERPROFILE: env.USERPROFILE ?? homedir(), LLAMA_API_KEY: apiKey };
    }
    return { PATH: "/usr/bin:/bin", HOME: env.HOME ?? homedir(), TMPDIR: env.TMPDIR ?? tmpdir(), LLAMA_API_KEY: apiKey };
  }

  async function installedModels(): Promise<string[]> {
    try {
      const entries = await fs.readdir(modelsDir);
      return entries.filter((name) => name.endsWith(".gguf")).map((name) => name.slice(0, -".gguf".length));
    } catch {
      return [];
    }
  }

  async function reservePort(): Promise<number> {
    if (reservedPort !== null) return reservedPort;
    for (let port = firstPort; port < firstPort + PORTS_TRIED; port += 1) {
      const free = await new Promise<boolean>((resolve) => {
        const probe = createServer();
        probe.once("error", () => resolve(false));
        probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
      });
      if (free) {
        reservedPort = port;
        return port;
      }
    }
    throw new Error(`no free port between ${firstPort} and ${firstPort + PORTS_TRIED - 1}`);
  }

  /// What a process with this pid runs. Empty when it cannot be told, which
  /// means the leftover is left alone.
  async function commandOf(pid: number): Promise<string> {
    if (process.platform === "linux") {
      try {
        return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
      } catch {
        return "";
      }
    }
    const [file, args] =
      process.platform === "win32"
        ? ["tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]]
        : ["/bin/ps", ["-o", "command=", "-p", String(pid)]];
    return new Promise<string>((resolve) => {
      execFile(file, args, { windowsHide: true }, (_error, stdout) => resolve(stdout ?? ""));
    });
  }

  function killTree(pid: number, force = false): void {
    if (process.platform === "win32") {
      execFile("taskkill", ["/pid", String(pid), "/T", ...(force ? ["/F"] : [])], { windowsHide: true }, () => undefined);
      return;
    }
    try {
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    } catch {
      // already gone
    }
  }

  /// A runtime left by a previous run that did not get to stop it (crash,
  /// kill -9). Only a process that still is our runtime is touched.
  async function stopLeftover(): Promise<void> {
    try {
      const pid = Number((await fs.readFile(pidFile, "utf8")).trim());
      if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
      const command = await commandOf(pid);
      if (!command.includes("llama-server")) return;
      if (process.platform !== "win32" && !command.includes(modelsDir)) return;
      log(`[runtime] stopping a runtime left by a previous run (pid ${pid})`);
      killTree(pid);
      for (let i = 0; i < 30; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        try {
          process.kill(pid, 0);
        } catch {
          return;
        }
      }
      killTree(pid, true);
    } catch {
      // no leftover
    } finally {
      await fs.rm(pidFile, { force: true }).catch(() => undefined);
    }
  }

  async function checkMemory(model: string): Promise<void> {
    let size: number;
    try {
      size = (await fs.stat(join(modelsDir, `${model}.gguf`))).size;
    } catch {
      throw new RuntimeError("unknown_model", `${model} is not installed`, { model });
    }
    const loaded = baseUrl ? await loadedModel() : null;
    if (loaded === model) return;
    const { ctx } = settings();
    const needed = memoryNeeded(size, ctx);
    let free = await availableMemory().catch(() => null);
    if (free === null) {
      // No MemAvailable (macOS): the computer's memory, less a quarter for the rest.
      free = Math.floor(totalMemory() * 0.75);
    } else if (loaded) {
      // With one model at a time, the one in memory makes room for the next.
      free += await fs.stat(join(modelsDir, `${loaded}.gguf`)).then((s) => s.size, () => 0);
    }
    if (free < needed) {
      throw new RuntimeError("insufficient_memory", `${model} needs ${needed} bytes of memory, ${free} are available`, { model, needed, available: free });
    }
  }

  function scheduleCrashRestart(proc: ChildProcess): void {
    const now = Date.now();
    crashes = crashes.filter((at) => now - at < CRASH_WINDOW_MS);
    lastFailure = failureOf(proc.exitCode, platform, proc.signalCode);
    if (crashes.length >= MAX_CRASH_RESTARTS) {
      log(`[runtime] stopped after ${MAX_CRASH_RESTARTS} crashes in ten minutes (${lastFailure.reason}, exit ${proc.exitCode}); see runtime.log`);
      return;
    }
    const wait = backoff[Math.min(crashes.length, backoff.length - 1)] ?? 1_000;
    crashes.push(now);
    log(`[runtime] exited unexpectedly (${lastFailure.reason}, exit ${proc.exitCode}); restarting in ${wait} ms`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!stopping && !child) void ensureRunning().catch(() => undefined);
    }, wait);
    restartTimer.unref();
  }

  async function start(): Promise<string | null> {
    if (!available()) return null;
    if ((await installedModels()).length === 0) return null;
    await stopLeftover();
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });

    const port = await reservePort();
    const url = `http://127.0.0.1:${port}/v1`;
    const { ctx, threads, threadsBatch, idleSeconds } = settings();
    const childEnv = runtimeEnvironment();

    engine = await selectRuntimeEngine(binaryDir, platform, childEnv, cpuOnly, options.probe);
    const selected = engine;
    const output = runtimeLog(join(stateDir, "runtime.log"), apiKey);
    output.write(`[twoody] acceleration=${selected.backend} devices=${selected.devices} cpu-fallback=${cpuOnly} ctx=${ctx} threads=${threads ?? "auto"}/${threadsBatch ?? "auto"}\n`);
    const extra = platformArgs(platform, arch);
    const proc = spawn(selected.binary, runtimeArgs({ backend: selected.backend, port, modelsDir, ctx, threads, threadsBatch, idleSeconds, extra }), {
      cwd: dirname(selected.binary),
      stdio: ["ignore", "pipe", "pipe"],
      // Nothing of the server's environment is the runtime's business.
      env: childEnv,
      windowsHide: true,
    });
    proc.stdout?.pipe(output, { end: false });
    proc.stderr?.pipe(output, { end: false });
    proc.on("error", () => output.end());
    proc.on("close", () => output.end());
    let wasRunning = false;
    proc.on("exit", () => {
      if (child !== proc) return;
      child = null;
      baseUrl = null;
      void fs.rm(pidFile, { force: true }).catch(() => undefined);
      if (wasRunning && !stopping) scheduleCrashRestart(proc);
    });
    child = proc;
    if (proc.pid) await fs.writeFile(pidFile, String(proc.pid), { mode: 0o600 }).catch(() => undefined);

    const deadline = Date.now() + startTimeoutMs;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null || proc.signalCode !== null) break;
      try {
        const res = await outboundFetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) });
        await res.body?.cancel().catch(() => undefined);
        if (res.ok && child === proc) {
          baseUrl = url;
          lastFailure = null;
          wasRunning = true;
          log(`[runtime] llama-server running on 127.0.0.1:${port} (${selected.backend}, ctx ${ctx})`);
          return url;
        }
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    lastFailure = failureOf(proc.exitCode, platform, proc.signalCode);
    log(`[runtime] llama-server did not start (${lastFailure.reason}, exit ${proc.exitCode}); see runtime.log`);
    await stopProcess();
    // On the CPU when the GPU failed, not when it was only slow (acceleration.ts).
    if (retryOnCpu(selected, lastFailure, cpuOnly)) {
      cpuOnly = true;
      return start();
    }
    return null;
  }

  function ensureRunning(): Promise<string | null> {
    if (child && baseUrl) return Promise.resolve(baseUrl);
    starting ??= start().finally(() => {
      starting = null;
    });
    return starting;
  }

  async function stopProcess(): Promise<void> {
    const proc = child;
    child = null;
    baseUrl = null;
    await fs.rm(pidFile, { force: true }).catch(() => undefined);
    if (!proc || proc.exitCode !== null || proc.signalCode !== null || proc.pid === undefined) return;
    const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    // The router stops the model's process with it.
    killTree(proc.pid);
    const force = setTimeout(() => {
      if (proc.exitCode === null && proc.pid !== undefined) killTree(proc.pid, true);
    }, 3_000);
    force.unref();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 4_000).unref())]);
    clearTimeout(force);
  }

  async function loadedModel(): Promise<string | null> {
    const base = baseUrl;
    if (!base) return null;
    try {
      const res = await outboundFetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(2_000),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return null;
      }
      return loadedFromModels(await res.json().catch(() => null));
    } catch {
      return null;
    }
  }

  const manager: RuntimeManager = {
    async ensure({ model } = {}) {
      if (managedByDesktop) throw new RuntimeError("managed_by_desktop", "the Desktop app runs this computer's runtime");
      if (!existsSync(binaryPath())) throw new RuntimeError("not_installed", "the built-in runtime is not installed");
      if ((await installedModels()).length === 0) throw new RuntimeError("no_models", "no model is installed");
      if (model) await checkMemory(model);
      stopping = false;
      const url = await ensureRunning();
      if (!url) {
        throw new RuntimeError("start_failed", "the built-in runtime did not start", { failure: lastFailure });
      }
      return { baseUrl: url, key: apiKey };
    },
    async stop() {
      stopping = true;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      if (starting) await starting.catch(() => null);
      await stopProcess();
    },
    async restart() {
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      stopping = true;
      if (starting) await starting.catch(() => null);
      await stopProcess();
      stopping = false;
      const url = await ensureRunning();
      return url ? { baseUrl: url, key: apiKey } : null;
    },
    async fallbackToCpu() {
      if (cpuOnly || !engine || engine.backend === "cpu") return null;
      cpuOnly = true;
      return manager.restart();
    },
    status() {
      const { ctx, threads, threadsBatch, idleSeconds } = settings();
      return {
        installed: existsSync(binaryPath()),
        running: Boolean(child && baseUrl),
        starting: Boolean(starting),
        baseUrl,
        pid: child?.pid ?? null,
        acceleration: engine ? `${engine.backend}; ${engine.devices} GPU device(s); CPU fallback: ${cpuOnly}` : "not started",
        failure: lastFailure,
        managedBy: managedByDesktop ? "desktop" : "server",
        crashRestarts: crashes.filter((at) => Date.now() - at < CRASH_WINDOW_MS).length,
        ctx,
        threads,
        threadsBatch,
        idleSeconds,
      };
    },
    loadedModel,
    auth() {
      return baseUrl ? { baseUrl, key: apiKey } : null;
    },
    async address() {
      if (!available()) return null;
      try {
        return { baseUrl: `http://127.0.0.1:${await reservePort()}/v1`, key: apiKey };
      } catch {
        return null;
      }
    },
    available,
    installedModels,
  };
  return manager;
}
