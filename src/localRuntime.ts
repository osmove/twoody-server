import { LocalOnlyError, outboundFetch } from "./outbound.js";
import { runtimeAuthHeaders } from "./runtimeAuth.js";

// What a local runtime — mlx-lm, Ollama, LM Studio, the one Twoody
// Desktop ships — says about itself through its OpenAI-compatible
// `GET /v1/models`: whether it answers, and which chat models it offers.
//
// /providers asks, so a phone paired with this computer can offer every
// model the runtime holds, not only the one a provider names. /queries
// asks, to send a model picked on the phone to the runtime that holds it,
// and to know the runtime is there before it opens the reply.
//
// An answer is kept for a short while, so a conversation does not ask
// before every turn; a failure for a few seconds only — long enough to
// be reused within one request, short enough that a runtime just started
// is found at once.

export interface RuntimeProbe {
  /// Something answered at that address, even with an error: the runtime
  /// is up. Only a refused connection or a timeout says it is not.
  reachable: boolean;
  /// Its list of models was read.
  ok: boolean;
  /// The chat models it offers, in its own order; null when unknown.
  models: string[] | null;
  /// Those it holds in memory now, when its list says so (llama.cpp's
  /// router gives each model a `status`); null when it does not say.
  loaded?: string[] | null;
  latency_ms: number | null;
  checked_at: string;
}

const KEEP_ANSWER_MS = 30_000;
const KEEP_FAILURE_MS = 3_000;
const PROBE_TIMEOUT_MS = 2_500;

// Ids of models that cannot hold a conversation: the filter Twoody
// Desktop applies to the same lists (src/renderer/modelChoice.ts).
const NOT_A_CHAT_MODEL = /embed|bge-|(^|[\/_-])e5-|rerank|whisper|clip|tts|vision-encoder|(^|[\/_.-])ocr|ocr([\/_.-]|$)/i;

export function isChatModel(id: string): boolean {
  return !NOT_A_CHAT_MODEL.test(id);
}

const probes = new Map<string, { at: number; probe: RuntimeProbe }>();

function normalize(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

/// What the runtime at `baseUrl` (its `/v1` address) answers. `fresh`
/// asks again even when a recent answer is kept.
///
/// In local-only mode, an address outside this computer and its network
/// is not asked at all: the LocalOnlyError is thrown, not read as a
/// runtime that is down, because it is a setting the person must see.
export async function probeRuntime(baseUrl: string, { fresh = false }: { fresh?: boolean } = {}): Promise<RuntimeProbe> {
  const base = normalize(baseUrl);
  const kept = probes.get(base);
  if (!fresh && kept && Date.now() - kept.at < (kept.probe.ok ? KEEP_ANSWER_MS : KEEP_FAILURE_MS)) {
    return kept.probe;
  }
  const probe = await ask(base);
  probes.set(base, { at: Date.now(), probe });
  return probe;
}

async function ask(base: string): Promise<RuntimeProbe> {
  const started = Date.now();
  const checked_at = new Date().toISOString();
  let response: Response;
  try {
    response = await outboundFetch(`${base}/models`, {
      headers: runtimeAuthHeaders(base),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof LocalOnlyError) throw err;
    return { reachable: false, ok: false, models: null, latency_ms: null, checked_at };
  }
  const latency_ms = Date.now() - started;
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { reachable: true, ok: false, models: null, latency_ms, checked_at };
  }
  const body = (await response.json().catch(() => null)) as { data?: Array<{ id?: unknown; status?: unknown }> } | null;
  if (!body) return { reachable: true, ok: false, models: null, latency_ms, checked_at };
  const rows = Array.isArray(body.data) ? body.data : [];
  const ids = rows
    .map((row) => row?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return { reachable: true, ok: true, models: ids.filter(isChatModel), loaded: loadedOf(rows), latency_ms, checked_at };
}

/// The models a list says are in memory: llama.cpp's router gives each a
/// `status`, a string or `{value}` depending on its version ("loaded",
/// "loading", "unloaded", "sleeping"). Null when no row says anything.
function loadedOf(rows: Array<{ id?: unknown; status?: unknown }>): string[] | null {
  let said = false;
  const loaded: string[] = [];
  for (const row of rows) {
    const status = row?.status;
    const value = typeof status === "string" ? status : status && typeof status === "object" ? (status as { value?: unknown }).value : null;
    if (typeof value !== "string") continue;
    said = true;
    if (value === "loaded" && typeof row.id === "string" && row.id) loaded.push(row.id);
  }
  return said ? loaded : null;
}

/// The models to offer for a provider: the one it names first, then the
/// others its runtime holds.
export function offeredModels(providerModel: string | null, probe: RuntimeProbe): string[] {
  const offered = providerModel ? [providerModel] : [];
  for (const model of probe.models ?? []) {
    if (!offered.includes(model)) offered.push(model);
  }
  return offered;
}

/// Forgets every answer: for tests.
export function forgetRuntimeProbes(): void {
  probes.clear();
}
