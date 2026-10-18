import { outboundFetch } from "../outbound.js";
import { runtimeAuthHeaders } from "../runtimeAuth.js";

// Which local runtimes this worker can use, which models they hold, and
// which runtime serves a given model.
//
// One machine often runs more than one OpenAI-compatible runtime (LM
// Studio next to Ollama, say). The backend only names a model, so the
// worker keeps a map from model id to the runtime that lists it.
//
//   BRIDGE_LOCAL_LLM_ENDPOINTS  comma-separated `/v1` roots, in order of
//                               preference
//   BRIDGE_LOCAL_LLM_ENDPOINT   a single root (kept for existing setups)
//   BRIDGE_LOCAL_LLM_MODEL      the model to run when the backend sends
//                               a placeholder ("local", "auto", blank)

const DEFAULT_ENDPOINT = "http://127.0.0.1:11434/v1";
const MODELS_CACHE_MS = 30_000;
const PROBE_TIMEOUT_MS = 4_000;

export interface RuntimeModels {
  endpoint: string;
  models: string[];
}

let endpointsOverride: string[] | null = null;
let defaultModelOverride: string | null = null;
let cache: { at: number; runtimes: RuntimeModels[] } | null = null;

/// Lets a host process (the desktop app) hand over what it detected
/// instead of going through the environment.
export function configureLocalModels(config: { endpoints?: string[]; defaultModel?: string | null }) {
  if (config.endpoints) {
    endpointsOverride = config.endpoints.map(normalizeEndpoint).filter(Boolean);
    cache = null;
  }
  if (config.defaultModel !== undefined) defaultModelOverride = config.defaultModel?.trim() || null;
}

export function configuredEndpoints(): string[] {
  if (endpointsOverride && endpointsOverride.length > 0) return endpointsOverride;
  const list = (process.env.BRIDGE_LOCAL_LLM_ENDPOINTS ?? "")
    .split(",")
    .map(normalizeEndpoint)
    .filter(Boolean);
  if (list.length > 0) return list;
  return [normalizeEndpoint(process.env.BRIDGE_LOCAL_LLM_ENDPOINT ?? "") || DEFAULT_ENDPOINT];
}

export function configuredDefaultModel(): string | null {
  return defaultModelOverride ?? (process.env.BRIDGE_LOCAL_LLM_MODEL?.trim() || null);
}

function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/// "local" and "auto" are what clients send when the user picked the
/// machine rather than a model.
export function isPlaceholderModel(model: unknown): boolean {
  const value = typeof model === "string" ? model.trim().toLowerCase() : "";
  return value === "" || value === "local" || value === "auto";
}

/// Runtimes list everything they hold; only text generation models are
/// worth offering in a chat.
export function isChatModelId(id: string): boolean {
  return !/(embed|bge-|e5-|minilm|rerank|whisper|tts|speech|clip|vision-encoder|(^|[\/_.-])ocr|ocr([\/_.-]|$))/i.test(id);
}

export async function listRuntimeModels(options: { fresh?: boolean } = {}): Promise<RuntimeModels[]> {
  if (!options.fresh && cache && Date.now() - cache.at < MODELS_CACHE_MS) return cache.runtimes;

  const runtimes = await Promise.all(
    configuredEndpoints().map(async (endpoint): Promise<RuntimeModels> => {
      try {
        const res = await outboundFetch(`${endpoint}/models`, {
          headers: runtimeAuthHeaders(endpoint),
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (!res.ok) return { endpoint, models: [] };
        const payload = (await res.json()) as { data?: Array<{ id?: unknown }> };
        const models = (payload.data ?? [])
          .map((entry) => (typeof entry.id === "string" ? entry.id : ""))
          .filter((id) => id && isChatModelId(id));
        return { endpoint, models };
      } catch {
        return { endpoint, models: [] }; // runtime not started: not an error
      }
    }),
  );
  cache = { at: Date.now(), runtimes };
  return runtimes;
}

export async function downloadedModels(): Promise<string[]> {
  const seen = new Set<string>();
  for (const runtime of await listRuntimeModels()) for (const id of runtime.models) seen.add(id);
  return [...seen];
}

/// What the runtime serving `model` says of it now: llama.cpp's router
/// (Twoody Desktop's engine, and the server's own, builtin/manager.ts)
/// lists each model with a status — « loaded », « sleeping » (its process
/// let the weights go after --sleep-idle-seconds and loads them again at
/// the next request), « loading », « unloaded », « failed ». Null when the
/// runtime says nothing of it (Ollama, LM Studio, a single-model server) or
/// cannot be reached. Never cached: it changes from one request to the next.
export async function runtimeModelStatus(endpoint: string, model: string): Promise<string | null> {
  try {
    const res = await outboundFetch(`${endpoint}/models`, {
      headers: runtimeAuthHeaders(endpoint),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    const payload = (await res.json()) as { data?: Array<{ id?: unknown; status?: unknown }> };
    const row = (payload.data ?? []).find((entry) => entry.id === model);
    const status = typeof row?.status === "string" ? row.status : (row?.status as { value?: unknown } | null | undefined)?.value;
    return typeof status === "string" ? status : null;
  } catch {
    return null;
  }
}

/// Whether the runtime holds this model now, awake or asleep: what a
/// guest's warm may read for (compute/guestWarm.ts). Never a model the
/// runtime would have to load — another one than the one in memory, one
/// not installed, or any model of a runtime that cannot say which it holds.
export async function modelHeldNow(requested: unknown): Promise<boolean> {
  let target: { endpoint: string; model: string };
  try {
    target = await resolveTarget(requested);
  } catch {
    return false;
  }
  const status = await runtimeModelStatus(target.endpoint, target.model);
  return status === "loaded" || status === "sleeping";
}

export class ModelNotInstalledError extends Error {
  constructor(model: string) {
    super(`model_not_installed: ${model}`);
  }
}

/// The runtime and model to use for a request.
///
/// A model no runtime lists is refused. mlx-lm would otherwise fetch any
/// Hugging Face repository it is asked for, and a request coming from the
/// backend must not be able to start a multi-gigabyte download on
/// someone's computer. Only when no runtime reports a list at all (an
/// older server without /v1/models) is the request passed on as asked.
export async function resolveTarget(requested: unknown): Promise<{ endpoint: string; model: string }> {
  const placeholder = isPlaceholderModel(requested);
  const wanted = placeholder ? configuredDefaultModel() : String(requested).trim();

  let runtimes = await listRuntimeModels();
  if (wanted && !runtimes.some((runtime) => runtime.models.includes(wanted))) {
    runtimes = await listRuntimeModels({ fresh: true }); // just installed, maybe
  }

  if (wanted) {
    const host = runtimes.find((runtime) => runtime.models.includes(wanted));
    if (host) return { endpoint: host.endpoint, model: wanted };
    if (runtimes.some((runtime) => runtime.models.length > 0)) {
      // A default that was uninstalled falls through to what is there;
      // a model someone asked for by name does not.
      if (!placeholder) throw new ModelNotInstalledError(wanted);
    } else {
      return { endpoint: runtimes[0].endpoint, model: wanted };
    }
  }

  // A placeholder and no configured default: the first model any
  // runtime reports beats sending the literal word "local".
  const host = runtimes.find((runtime) => runtime.models.length > 0);
  if (host) return { endpoint: host.endpoint, model: host.models[0] };
  return { endpoint: runtimes[0].endpoint, model: placeholder ? "local" : String(requested) };
}
