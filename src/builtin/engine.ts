import { LocalOnlyError } from "../outbound.js";
import { probeRuntime } from "../localRuntime.js";
import type { EnginePreference, RuntimePrefs } from "./prefs.js";

// Which engine answers on this computer, from its « Moteur » preference.
//
// An explicit preference is that engine, reachable or not: the screen says
// it is down rather than quietly answering with another one. `auto` takes
// the first engine that offers a chat model, in this order:
//
//   built-in llama.cpp → Ollama :11434 (or TWOODY_OLLAMA_URL)
//   → LM Studio :1234 → mlx-lm :8080 (macOS only)
//
// The built-in engine is judged by the models on disk: resolving never
// starts it (status and heartbeat must not load 3 GB into memory).

export type EngineId = Exclude<EnginePreference, "auto">;

export type EngineReason =
  /// The preferred engine, and it offers a chat model.
  | "preference"
  /// The first engine of the auto order that offers a chat model.
  | "auto"
  /// Preferred, but nothing answers at its address.
  | "unreachable"
  /// Preferred and there, but without a chat model.
  | "no_models"
  /// The built-in engine is preferred, and not installed on this computer.
  | "not_installed"
  /// `custom` without a URL.
  | "custom_url_missing"
  /// Auto, and no engine offers a chat model.
  | "none_available";

export interface ResolvedEngine {
  id: EngineId | null;
  baseUrl: string | null;
  models: string[];
  reason: EngineReason;
}

export interface EngineProbe {
  reachable: boolean;
  /// Chat models, null when unknown.
  models: string[] | null;
}

/// What the resolution needs of the built-in runtime (manager.ts has it).
export interface BuiltinSource {
  available(): boolean;
  installedModels(): Promise<string[]>;
  /// Its address, reserved without starting it.
  address(): Promise<{ baseUrl: string } | null>;
}

export interface EngineCandidate {
  id: EngineId;
  name: string;
  baseUrl: string | null;
}

export interface EngineSurvey extends EngineCandidate {
  reachable: boolean;
  models: string[];
}

export interface ResolveEngineOptions {
  prefs: RuntimePrefs;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  builtin?: BuiltinSource | null;
  probe?: (baseUrl: string) => Promise<EngineProbe>;
}

export const ENGINE_NAMES: Readonly<Record<EngineId, string>> = Object.freeze({
  builtin: "Twoody (llama.cpp)",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  mlx: "mlx-lm",
  custom: "Custom",
});

const OLLAMA_PORT = "11434";
const DEFAULT_OLLAMA = "http://127.0.0.1:11434/v1";
const LMSTUDIO = "http://127.0.0.1:1234/v1";
const MLX = "http://127.0.0.1:8080/v1";

function parseUrl(value: string | undefined): URL | null {
  const text = value?.trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/// An OpenAI-compatible base: the address without a trailing slash, with `/v1`.
export function openAiBase(value: string): string {
  const base = value.trim().replace(/\/+$/, "");
  return /\/v1$/.test(base) ? base : `${base}/v1`;
}

function port(url: URL): string {
  return url.port || (url.protocol === "https:" ? "443" : "80");
}

/// Where Ollama is: TWOODY_OLLAMA_URL, else the bridge's endpoint when it
/// is an Ollama (port 11434, possibly on another box), else this computer.
export function ollamaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = parseUrl(env.TWOODY_OLLAMA_URL);
  if (explicit) return openAiBase(explicit.toString());
  const bridge = parseUrl(env.BRIDGE_LOCAL_LLM_ENDPOINT);
  if (bridge && port(bridge) === OLLAMA_PORT) return openAiBase(bridge.toString());
  return DEFAULT_OLLAMA;
}

/// The preference a computer has before anyone chose one (no runtime.json):
/// a server already pointed at Ollama keeps Ollama (a Pi set up before the
/// built-in engine answers as before), one pointed elsewhere keeps that
/// address as `custom`, and a fresh one is `auto`.
export function migratedPreference(env: NodeJS.ProcessEnv = process.env): { engine: EnginePreference; custom_url?: string } {
  const bridge = parseUrl(env.BRIDGE_LOCAL_LLM_ENDPOINT);
  if (!bridge) return { engine: "auto" };
  if (port(bridge) === OLLAMA_PORT) return { engine: "ollama" };
  return { engine: "custom", custom_url: bridge.toString().replace(/\/+$/, "") };
}

/// The engines of the auto order, for this computer, then `custom` when it has a URL.
export async function engineCandidates(options: Omit<ResolveEngineOptions, "probe">): Promise<EngineCandidate[]> {
  const { prefs, env = process.env, platform = process.platform, builtin } = options;
  const candidates: EngineCandidate[] = [];
  if (builtin?.available()) {
    candidates.push({ id: "builtin", name: ENGINE_NAMES.builtin, baseUrl: (await builtin.address().catch(() => null))?.baseUrl ?? null });
  }
  candidates.push({ id: "ollama", name: ENGINE_NAMES.ollama, baseUrl: ollamaBaseUrl(env) });
  candidates.push({ id: "lmstudio", name: ENGINE_NAMES.lmstudio, baseUrl: LMSTUDIO });
  if (platform === "darwin") candidates.push({ id: "mlx", name: ENGINE_NAMES.mlx, baseUrl: MLX });
  if (prefs.custom_url) candidates.push({ id: "custom", name: ENGINE_NAMES.custom, baseUrl: openAiBase(prefs.custom_url) });
  return candidates;
}

async function defaultProbe(baseUrl: string): Promise<EngineProbe> {
  try {
    const probe = await probeRuntime(baseUrl);
    return { reachable: probe.reachable, models: probe.models };
  } catch (err) {
    if (err instanceof LocalOnlyError) return { reachable: false, models: null };
    throw err;
  }
}

async function look(candidate: EngineCandidate, options: ResolveEngineOptions): Promise<EngineSurvey> {
  if (candidate.id === "builtin") {
    // On disk, not asked: the runtime may well be stopped, and must stay so.
    const models = options.builtin ? await options.builtin.installedModels().catch(() => []) : [];
    return { ...candidate, reachable: Boolean(options.builtin?.available()), models };
  }
  if (!candidate.baseUrl) return { ...candidate, reachable: false, models: [] };
  const probe = await (options.probe ?? defaultProbe)(candidate.baseUrl).catch(() => ({ reachable: false, models: null }));
  return { ...candidate, reachable: probe.reachable, models: probe.models ?? [] };
}

/// Every engine this computer could use, and what each offers (`GET /runtime`).
export async function surveyEngines(options: ResolveEngineOptions): Promise<EngineSurvey[]> {
  const candidates = await engineCandidates(options);
  return Promise.all(candidates.map((candidate) => look(candidate, options)));
}

/// The engine this computer answers with, and why.
export async function resolveEngine(options: ResolveEngineOptions): Promise<ResolvedEngine> {
  const { prefs } = options;
  if (prefs.engine === "auto") {
    for (const candidate of await engineCandidates(options)) {
      if (candidate.id === "custom") continue;
      const seen = await look(candidate, options);
      if (seen.models.length > 0) return { id: seen.id, baseUrl: seen.baseUrl, models: seen.models, reason: "auto" };
    }
    return { id: null, baseUrl: null, models: [], reason: "none_available" };
  }

  const id = prefs.engine;
  if (id === "builtin") {
    if (!options.builtin?.available()) return { id, baseUrl: null, models: [], reason: "not_installed" };
    const baseUrl = (await options.builtin.address().catch(() => null))?.baseUrl ?? null;
    const seen = await look({ id, name: ENGINE_NAMES.builtin, baseUrl }, options);
    return { id, baseUrl, models: seen.models, reason: seen.models.length ? "preference" : "no_models" };
  }
  if (id === "custom" && !prefs.custom_url) return { id, baseUrl: null, models: [], reason: "custom_url_missing" };
  const baseUrl =
    id === "ollama" ? ollamaBaseUrl(options.env) : id === "lmstudio" ? LMSTUDIO : id === "mlx" ? MLX : openAiBase(prefs.custom_url!);
  const seen = await look({ id, name: ENGINE_NAMES[id], baseUrl }, options);
  return { id, baseUrl, models: seen.models, reason: !seen.reachable ? "unreachable" : seen.models.length ? "preference" : "no_models" };
}
