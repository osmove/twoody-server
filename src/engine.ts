import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_IDLE_MINUTES,
  ENGINE_NAMES,
  createPrefsStore,
  memAvailable,
  createRuntimeManager,
  resolveEngine,
  runtimeDir,
  surveyEngines,
  type BuiltinPrefs,
  type BuiltinSource,
  type EngineId,
  type EngineSurvey,
  type PrefsStore,
  type ResolvedEngine,
  type RuntimeManager,
  type RuntimeManagerOptions,
} from "./builtin/index.js";
import { isChatModel, probeRuntime } from "./localRuntime.js";
import { outboundFetch } from "./outbound.js";
import { addRuntimeKey } from "./runtimeAuth.js";

// The engine this computer answers with (« Moteur »,
// docs/builtin-runtime-design.md §3-4): the built-in llama.cpp runtime that
// twoody-server runs by itself, and the preference in DATA_DIR/runtime.json
// that picks it, Ollama, LM Studio, mlx-lm or another address.
//
// One manager per process, made at startup (index.ts) on
//   DATA_DIR/runtime/b11146-<platform>-<arch>   llama-server and its libraries
//                                                (TWOODY_RUNTIME_DIR moves DATA_DIR/runtime: a Docker
//                                                image carries its runtime outside the volume)
//   DATA_DIR/models                             the GGUF files (TWOODY_MODELS_DIR moves it)
//   DATA_DIR                                    runtime.pid, runtime.log, runtime.json
//
// Twoody Desktop runs its own runtime: its embedded server is started with
// TWOODY_RUNTIME_OWNER=desktop (or is the Desktop's utility process), and
// then never starts one — the routes answer 409 managed_by_desktop, and the
// chat keeps to the providers the Desktop stored.

export interface EnginePaths {
  dataDir: string;
  runtimeRoot: string;
  binaryDir: string;
  modelsDir: string;
  stateDir: string;
}

export function enginePaths(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, arch: string = process.arch): EnginePaths {
  const dataDir = env.TWOODY_DATA_DIR?.trim() || join(homedir(), ".twoody", "data");
  const runtimeRoot = env.TWOODY_RUNTIME_DIR?.trim() || join(dataDir, "runtime");
  return {
    dataDir,
    runtimeRoot,
    binaryDir: runtimeDir(runtimeRoot, platform, arch),
    modelsDir: env.TWOODY_MODELS_DIR?.trim() || join(dataDir, "models"),
    stateDir: dataDir,
  };
}

export interface Engine {
  paths: EnginePaths;
  manager: RuntimeManager;
  prefs: PrefsStore;
  /// The Desktop runs this computer's runtime and chooses its providers.
  managedByDesktop: boolean;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  arch: string;
}

export interface InitEngineOptions {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /// The Desktop's utility process, whatever the environment says.
  desktop?: boolean;
  /// Tests: a fake runtime, another platform.
  manager?: Partial<RuntimeManagerOptions>;
}

let current: Engine | null = null;
let builtinBase: string | null = null;
/// Set by preloadBuiltin: the model stays in memory while the server runs,
/// unless the preference says how long (idle_minutes).
let keepLoaded = false;

/// What the runtime is started with: the preference, and when it does not
/// say how long a model stays in memory, as long as the server runs if the
/// startup decided so (preloadBuiltin), else half an hour.
export function effectiveBuiltin(prefs: BuiltinPrefs, keep: boolean): BuiltinPrefs & { idle_minutes: number } {
  return { ...prefs, idle_minutes: prefs.idle_minutes ?? (keep ? 0 : DEFAULT_IDLE_MINUTES) };
}

const normalize = (url: string) => url.trim().replace(/\/+$/, "");

export function initEngine(options: InitEngineOptions = {}): Engine {
  const env = options.env ?? process.env;
  const desktop = options.desktop || env.TWOODY_RUNTIME_OWNER?.trim().toLowerCase() === "desktop";
  const platform = (options.manager?.platform ?? process.platform) as NodeJS.Platform;
  const arch = options.manager?.arch ?? process.arch;
  const paths = enginePaths(env, platform, arch);
  const prefs = createPrefsStore({ dataDir: paths.dataDir, env });
  const manager = createRuntimeManager({
    binaryDir: paths.binaryDir,
    modelsDir: paths.modelsDir,
    stateDir: paths.stateDir,
    log: options.log,
    env: desktop ? { ...env, TWOODY_RUNTIME_OWNER: "desktop" } : env,
    settings: () => effectiveBuiltin(prefs.read().prefs.builtin, keepLoaded),
    ...options.manager,
  });
  current = { paths, manager, prefs, managedByDesktop: desktop, env, platform, arch };
  builtinBase = null;
  keepLoaded = false;
  // Its key is known before anything asks the runtime.
  void builtinAddress().catch(() => undefined);
  return current;
}

export function engine(): Engine {
  return current ?? initEngine();
}

/// SIGTERM, SIGINT: the runtime goes with the server.
export async function stopEngine(): Promise<void> {
  await current?.manager.stop().catch(() => undefined);
}

/// Tests: forget the engine (after stopping it).
export async function resetEngine(): Promise<void> {
  await stopEngine();
  current = null;
  builtinBase = null;
}

/// The built-in runtime's address, reserved without starting it, and its
/// key registered for the calls made to it. Null while not installed, or
/// when the Desktop runs the runtime.
export async function builtinAddress(): Promise<{ baseUrl: string; key: string } | null> {
  const { manager } = engine();
  const address = await manager.address();
  if (!address) return null;
  addRuntimeKey(address.baseUrl, address.key);
  builtinBase = normalize(address.baseUrl);
  return address;
}

/// Whether a provider address is the built-in runtime's.
export function isBuiltinUrl(baseUrl: string | null | undefined): boolean {
  return Boolean(baseUrl && builtinBase && normalize(baseUrl) === builtinBase);
}

/// Starts the built-in runtime if needed (a RuntimeError says why not).
export async function ensureBuiltin(model?: string | null): Promise<{ baseUrl: string; key: string }> {
  const running = await engine().manager.ensure(model ? { model } : {});
  addRuntimeKey(running.baseUrl, running.key);
  builtinBase = normalize(running.baseUrl);
  return running;
}

/// Before a call to a local runtime: the built-in one is started (and a
/// model that is not there, or would not fit, refused with a RuntimeError);
/// another one is asked whether it answers.
export async function localRuntimeReady(baseUrl: string, model?: string | null): Promise<boolean> {
  if (isBuiltinUrl(baseUrl)) {
    await ensureBuiltin(model && model !== "local" ? model : null);
    return true;
  }
  return (await probeRuntime(baseUrl)).reachable;
}

function builtinSource(): BuiltinSource {
  const { manager } = engine();
  return {
    available: () => manager.available(),
    installedModels: async () => (await manager.installedModels()).filter(isChatModel),
    address: () => builtinAddress(),
  };
}

/// The engine the preference resolves to, and why (never starts the built-in one).
export async function activeEngine(): Promise<ResolvedEngine> {
  const e = engine();
  return resolveEngine({ prefs: e.prefs.read().prefs, env: e.env, platform: e.platform, builtin: builtinSource() });
}

/// Every engine this computer could use (GET /runtime).
export async function engineSurvey(): Promise<EngineSurvey[]> {
  const e = engine();
  return surveyEngines({ prefs: e.prefs.read().prefs, env: e.env, platform: e.platform, builtin: builtinSource() });
}

export function engineName(id: EngineId | null): string | null {
  return id ? ENGINE_NAMES[id] : null;
}

/// The engine's default model: the built-in one's `default_model` when it
/// is installed, else its first model.
export function engineDefaultModel(resolved: Pick<ResolvedEngine, "id" | "models">): string | null {
  if (resolved.id === "builtin") {
    const chosen = engine().prefs.read().prefs.builtin.default_model;
    if (chosen && resolved.models.includes(chosen)) return chosen;
  }
  return resolved.models[0] ?? null;
}

export interface EngineRoute {
  engine: EngineId;
  baseUrl: string;
  model: string;
}

/// Where the chat goes on this computer's engine, for this model: the
/// model when the engine holds it, else the engine's default one. Null
/// when the Desktop decides (its stored providers), or when no engine is
/// resolved.
export async function engineRoute(requestedModel?: string | null): Promise<EngineRoute | null> {
  if (engine().managedByDesktop) return null;
  const resolved = await activeEngine();
  if (!resolved.id || !resolved.baseUrl) return null;
  const wanted = requestedModel && requestedModel !== "local" && requestedModel !== "auto" ? requestedModel : null;
  if (wanted && resolved.models.includes(wanted)) return { engine: resolved.id, baseUrl: resolved.baseUrl, model: wanted };
  const fallback = engineDefaultModel(resolved);
  // The built-in runtime is given only a model it has: a name it does not
  // hold would be refused, and there is nothing to answer with.
  if (resolved.id === "builtin" && !fallback) return null;
  return { engine: resolved.id, baseUrl: resolved.baseUrl, model: fallback ?? wanted ?? "local" };
}

/// What the status says of the engine: its models, and which is in memory.
/// The built-in runtime is judged by its folder and, only while it runs, by
/// what it says it holds — asking never starts it.
export async function engineModels(): Promise<{ engine: EngineId; baseUrl: string; models: string[]; loaded: Set<string> | null } | null> {
  if (engine().managedByDesktop) return null;
  const resolved = await activeEngine();
  if (!resolved.id || !resolved.baseUrl || resolved.models.length === 0) return null;
  if (resolved.id === "builtin") {
    const loaded = await engine().manager.loadedModel();
    return { engine: "builtin", baseUrl: resolved.baseUrl, models: resolved.models, loaded: new Set(loaded ? [loaded] : []) };
  }
  return { engine: resolved.id, baseUrl: resolved.baseUrl, models: resolved.models, loaded: null };
}

export interface PreloadOptions {
  log?: (line: string) => void;
  /// Bytes the kernel can give without swapping (MemAvailable); null when it
  /// cannot be told (not Linux).
  availableMemory?: () => Promise<number | null>;
  /// How long the model gets to load (a 4B read from a Pi's card: a minute).
  loadTimeoutMs?: number;
}

export type PreloadResult =
  | { loaded: string; keepLoaded: boolean }
  | { loaded: null; reason: "desktop" | "off" | "not_builtin" | "no_model" | "failed"; keepLoaded: boolean };

/// On a computer without the Desktop (a Pi, a server), once the HTTP server
/// listens: the built-in engine's default model is loaded in the
/// background, so that the first question does not wait for it (a 4B on a
/// Pi: tens of seconds). It is then kept in memory while the server runs
/// when the preference does not say how long (idle_minutes) and the free
/// memory holds it twice over; elsewhere it goes after half an hour of
/// silence, as before. `builtin.preload: false` turns this off. Never throws.
export async function preloadBuiltin(options: PreloadOptions = {}): Promise<PreloadResult> {
  const log = options.log ?? (() => undefined);
  const e = engine();
  if (e.managedByDesktop) return { loaded: null, reason: "desktop", keepLoaded: false };
  const builtin = e.prefs.read().prefs.builtin;
  if (builtin.preload === false) return { loaded: null, reason: "off", keepLoaded: false };
  try {
    const resolved = await activeEngine();
    if (resolved.id !== "builtin" || !resolved.baseUrl) return { loaded: null, reason: "not_builtin", keepLoaded: false };
    const model = engineDefaultModel(resolved);
    if (!model) return { loaded: null, reason: "no_model", keepLoaded: false };
    // Measured before the model is in memory: what the rest of the
    // computer has, the model not counted.
    const size = await fs.stat(join(e.paths.modelsDir, `${model}.gguf`)).then((s) => s.size, () => null);
    const free = await (options.availableMemory ?? memAvailable)().catch(() => null);
    keepLoaded = builtin.idle_minutes === undefined && size !== null && free !== null && free >= 2 * size;
    const running = await ensureBuiltin(model);
    // The router loads the model a request names: one token asked of it.
    const res = await outboundFetch(`${running.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${running.key}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Hi" }], max_tokens: 1, stream: false }),
      signal: AbortSignal.timeout(options.loadTimeoutMs ?? 10 * 60_000),
    });
    await res.body?.cancel().catch(() => undefined);
    if (!res.ok) throw new Error(`the runtime answered ${res.status}`);
    const idle = effectiveBuiltin(builtin, keepLoaded).idle_minutes;
    log(`[runtime] ${model} loaded at startup; ${idle === 0 ? "kept in memory while the server runs" : `released after ${idle} min without a question`}`);
    return { loaded: model, keepLoaded };
  } catch (err) {
    log(`[runtime] the default model was not loaded at startup: ${err instanceof Error ? err.message : String(err)}; it loads on the first question`);
    return { loaded: null, reason: "failed", keepLoaded };
  }
}
