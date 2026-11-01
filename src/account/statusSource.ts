import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { db, llmEndpoints, modelCalls, users } from "../db.js";
import { isChatModel, probeRuntime } from "../localRuntime.js";
import { outboundFetch } from "../outbound.js";
import { recentLoad, type LoadSample } from "../machineSampler.js";
import { samplesSince, generationTps } from "../usageStore.js";
import { inflight } from "./inflight.js";
import { boundStatus, type ComputerStatus, type Purpose } from "./status.js";
import { activeEngine, engine, engineModels } from "../engine.js";

// What this computer says of itself in its heartbeat and on
// /api/v1/peer/status: its models (and which are in memory), its load, how
// fast each model writes here, how many generations run now.

let version: string | null = null;
function appVersion(): string {
  if (version) return version;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const candidate of [join(here, "..", "..", "package.json"), join(here, "..", "package.json")]) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf8"));
        if (pkg.name === "twoody-server" && typeof pkg.version === "string") return (version = pkg.version);
      } catch {
        // next
      }
    }
  } catch {
    // unknown
  }
  return (version = "0.0.0");
}

/// The runtimes this computer answers with: its enabled local providers,
/// the default first, then BRIDGE_LOCAL_LLM_ENDPOINT. The engine of its
/// « Moteur » preference comes before them all (localModels).
export function localRuntimes(userId?: string | null): Array<{ baseUrl: string; model: string | null }> {
  const rows = db
    .select()
    .from(llmEndpoints)
    .where(userId ? eq(llmEndpoints.userId, userId) : undefined)
    .all()
    .filter((p) => p.enabled && p.kind === "local_openai" && p.baseUrl)
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  const out: Array<{ baseUrl: string; model: string | null }> = [];
  for (const row of rows) {
    const base = row.baseUrl!.replace(/\/+$/, "");
    if (!out.some((r) => r.baseUrl === base && r.model === row.model)) out.push({ baseUrl: base, model: row.model });
  }
  const env = process.env.BRIDGE_LOCAL_LLM_ENDPOINT?.replace(/\/+$/, "");
  if (env && !out.some((r) => r.baseUrl === env)) out.push({ baseUrl: env, model: null });
  return out;
}

/// The models on the Desktop's disk, by its runtime's address (the message
/// `builtin-models`, index.ts): listed while that runtime does not answer —
/// not started yet, or stopped once its last model was removed — instead of
/// the model its provider was set up with.
const desktopModels = new Map<string, string[]>();
export function noteDesktopModels(baseUrl: string, ids: string[]): void {
  desktopModels.set(baseUrl.replace(/\/+$/, ""), ids);
}

/// The models the runtimes hold, each with the runtime that holds it.
export async function localModels(userId?: string | null): Promise<Array<{ id: string; baseUrl: string; loaded: boolean }>> {
  const out: Array<{ id: string; baseUrl: string; loaded: boolean }> = [];
  // The engine first: the built-in runtime's models are the files in its
  // folder, in memory only when it says so (never started to be asked).
  const active = await engineModels().catch(() => null);
  if (active) {
    const loaded = active.loaded ?? (await loadedModels(active.baseUrl, active.models));
    for (const id of active.models) {
      if (!isChatModel(id) || out.some((m) => m.id === id)) continue;
      out.push({ id, baseUrl: active.baseUrl, loaded: loaded.has(id) });
    }
  }
  for (const runtime of localRuntimes(userId)) {
    if (active && runtime.baseUrl === active.baseUrl.replace(/\/+$/, "")) continue;
    const probe = await probeRuntime(runtime.baseUrl).catch(() => null);
    const listed = probe?.models ?? desktopModels.get(runtime.baseUrl) ?? (runtime.model ? [runtime.model] : []);
    // A runtime that does not answer (stopped, not started yet) holds nothing
    // in memory, whatever model its provider names (01/11/2026: `twoody list`
    // said « in memory » after the Desktop's last model was removed).
    const loaded = probe && !probe.reachable ? new Set<string>() : await loadedModels(runtime.baseUrl, listed);
    for (const id of listed) {
      if (!isChatModel(id) || out.some((m) => m.id === id)) continue;
      out.push({ id, baseUrl: runtime.baseUrl, loaded: loaded.has(id) });
    }
  }
  return out;
}

const lastUsed = new Map<string, number>();

/// Marks a model as just used here: without a runtime that says what it
/// holds in memory, a model used in the last five minutes is taken as loaded.
export function noteModelUsed(model: string): void {
  lastUsed.set(model, Date.now());
}

const psCache = new Map<string, { at: number; names: Set<string> | null }>();

/// Which of `listed` are in memory: Ollama says so (/api/ps); a runtime
/// that holds a single model (llama-server) holds it; otherwise the ones
/// used in the last five minutes.
async function loadedModels(baseUrl: string, listed: string[]): Promise<Set<string>> {
  const recent = new Set(listed.filter((id) => Date.now() - (lastUsed.get(id) ?? 0) < 5 * 60_000));
  if (listed.length === 1) return new Set(listed);
  const cached = psCache.get(baseUrl);
  let names: Set<string> | null;
  if (cached && Date.now() - cached.at < 10_000) {
    names = cached.names;
  } else {
    names = null;
    try {
      const origin = new URL(baseUrl).origin;
      const response = await outboundFetch(`${origin}/api/ps`, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) {
        const body = (await response.json().catch(() => null)) as { models?: Array<{ name?: unknown; model?: unknown }> } | null;
        if (body && Array.isArray(body.models)) {
          names = new Set(body.models.flatMap((m) => [m.name, m.model]).filter((n): n is string => typeof n === "string"));
        }
      } else {
        await response.body?.cancel().catch(() => undefined);
      }
    } catch {
      names = null;
    }
    psCache.set(baseUrl, { at: Date.now(), names });
  }
  if (!names) return recent;
  return new Set(listed.filter((id) => names!.has(id) || recent.has(id)));
}

/// Median writing speed per model over the last answers timed here (chat,
/// memory, and those written for a peer), at most 20 each.
export function measuredTps(userId?: string | null, sinceDays = 30): Record<string, number> {
  const since = new Date(Date.now() - sinceDays * 24 * 3600 * 1000);
  const rows = db
    .select({ model: modelCalls.model, completionTokens: modelCalls.completionTokens, generationMs: modelCalls.generationMs, estimated: modelCalls.estimated })
    .from(modelCalls)
    .where(
      and(
        userId ? eq(modelCalls.userId, userId) : undefined,
        gte(modelCalls.occurredAt, since),
        isNotNull(modelCalls.model),
        inArray(modelCalls.source, ["chat", "memory", "peer"]),
      ),
    )
    .orderBy(desc(modelCalls.occurredAt))
    .limit(500)
    .all();
  const byModel = new Map<string, number[]>();
  for (const row of rows) {
    const tps = generationTps(row);
    if (tps === null || !row.model) continue;
    const list = byModel.get(row.model) ?? [];
    if (list.length < 20) list.push(tps);
    byModel.set(row.model, list);
  }
  const out: Record<string, number> = {};
  for (const [model, list] of byModel) out[model] = median(list);
  return out;
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round(((sorted[mid - 1]! + sorted[mid]!) / 2) * 10) / 10;
}

/// The machine's last two load samples: this process's sampler, or — when
/// Twoody Desktop measures and posts them — the last ones it posted.
export function lastLoad(userId?: string | null): LoadSample[] {
  const inMemory = recentLoad();
  if (inMemory.length > 0) return inMemory;
  const owner = userId ?? db.select({ id: users.id }).from(users).limit(1).all()[0]?.id;
  if (!owner) return [];
  return samplesSince(owner, new Date(Date.now() - 2 * 60_000))
    .slice(-2)
    .map((row) => ({
      at: row.at,
      cpuPct: row.cpuPct,
      gpuPct: row.gpuPct,
      ramUsedPct: row.ramUsedBytes && row.ramTotalBytes ? Math.round((row.ramUsedBytes / row.ramTotalBytes) * 1000) / 10 : null,
      ramUsedBytes: row.ramUsedBytes,
      ramTotalBytes: row.ramTotalBytes,
    }));
}

function accepts(): Purpose[] {
  const raw = process.env.TWOODY_PEER_ACCEPTS;
  if (raw === undefined) return ["chat", "background"];
  return (["chat", "background"] as const).filter((p) => raw.split(",").map((s) => s.trim()).includes(p));
}

export async function buildStatus(userId?: string | null): Promise<ComputerStatus> {
  const owner = userId ?? db.select({ id: users.id }).from(users).limit(1).all()[0]?.id ?? null;
  const models = await localModels(owner);
  const load = lastLoad(owner).at(-1) ?? null;
  const tps = measuredTps(owner);
  const engineId = engine().managedByDesktop ? undefined : (await activeEngine().catch(() => null))?.id;
  return boundStatus({
    app_version: appVersion(),
    models: models.map((m) => ({ id: m.id, loaded: m.loaded })),
    load: {
      cpu_pct: load?.cpuPct ?? null,
      gpu_pct: load?.gpuPct ?? null,
      ram_used_pct: load?.ramUsedPct ?? null,
      at: load ? load.at.toISOString() : null,
    },
    tps: Object.fromEntries(Object.entries(tps).filter(([model]) => models.some((m) => m.id === model))),
    inflight: inflight(),
    accepts: accepts(),
    tools: process.env.TWOODY_PEER_TOOLS !== "0",
    ...(engineId !== undefined ? { engine: engineId } : {}),
  });
}
