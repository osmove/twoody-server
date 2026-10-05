import { localRuntimeReady } from "./engine.js";
import { outboundFetch } from "./outbound.js";
import { runtimeAuthHeaders } from "./runtimeAuth.js";

// A model picked on a paired phone, loaded on this computer before the
// first question (POST /providers/load, routes/providers.ts).
//
// The phone's picker offers every model the runtimes here hold, loaded or
// not. Picking one that is not in memory used to show nothing until the
// first question, which then waited 10 to 40 s for the runtime to read the
// model — or, when the runtime was not running at all (mlx-lm on Jimmy's
// Mac, 05/10/2026), failed after the picker had already gone back to
// « Automatique » (Jimmy: « on croit que ça ne marche pas »).
//
// Loading is asking the runtime for one token from that model: llama.cpp's
// router, Ollama, LM Studio and mlx-lm all read it into memory to answer.
// No runtime reports a percentage while it loads, so progress is the time
// elapsed against how long this model took last time here (20 s the first
// time) — the same estimate Twoody Desktop shows on its send button
// (twoody-desktop/src/shared/modelWarmth.ts).

export type LoadStep = "idle" | "loading" | "ready" | "failed";

export interface ModelLoadState {
  model: string;
  /// What runs it (« Twoody », « mlx-lm », « Ollama »…), when known.
  runtime: string | null;
  state: LoadStep;
  /// 0 to 1: an estimate while loading, 1 once ready.
  progress: number;
  elapsed_ms: number;
  expected_ms: number;
}

export interface LoadTarget {
  baseUrl: string;
  model: string;
  runtime: string | null;
}

/// Asks the runtime to load `model`; resolves true once it answered.
export type Warm = (baseUrl: string, model: string) => Promise<boolean>;

const FIRST_LOAD_MS = 20_000;
const WARM_TIMEOUT_MS = 180_000;
/// A finished load is said for this long, then forgotten: the runtime may
/// put the model to sleep, and the next pick asks it again.
const KEEP_DONE_MS = 10 * 60_000;

type Entry = { runtime: string | null; state: LoadStep; startedAt: number; expectedMs: number; endedAt?: number };

const loads = new Map<string, Entry>();
const running = new Map<string, Promise<boolean>>();
const measured = new Map<string, number>();

/// Steady up to 90 % at the expected time, then slower, never 100 % before
/// the runtime has answered.
export function estimatedProgress(elapsedMs: number, expectedMs: number): number {
  const t = elapsedMs / Math.max(1, expectedMs);
  const p = t < 1 ? 0.9 * t : 0.9 + 0.09 * (1 - Math.exp(-(t - 1) * 2));
  return Math.max(0, Math.min(0.99, p));
}

/// Where the load of `model` is.
export function modelLoadState(model: string, now = Date.now()): ModelLoadState {
  const entry = loads.get(model);
  if (!entry || (entry.endedAt && now - entry.endedAt > KEEP_DONE_MS)) {
    return { model, runtime: entry?.runtime ?? null, state: "idle", progress: 0, elapsed_ms: 0, expected_ms: 0 };
  }
  const elapsed = (entry.endedAt ?? now) - entry.startedAt;
  const progress = entry.state === "ready" ? 1 : entry.state === "loading" ? estimatedProgress(elapsed, entry.expectedMs) : 0;
  return { model, runtime: entry.runtime, state: entry.state, progress, elapsed_ms: elapsed, expected_ms: entry.expectedMs };
}

/// Notes `model` as in memory already (the runtime said so).
export function noteModelReady(target: LoadTarget, now = Date.now()): ModelLoadState {
  if (!running.has(target.model)) loads.set(target.model, { runtime: target.runtime, state: "ready", startedAt: now, expectedMs: 0, endedAt: now });
  return modelLoadState(target.model, now);
}

/// Starts loading `model` unless a load of it is under way; answers at once
/// with where it is.
export function startModelLoad(target: LoadTarget, warm: Warm = warmModel): ModelLoadState {
  const { model } = target;
  if (!running.has(model)) {
    const startedAt = Date.now();
    const expectedMs = measured.get(model) ?? FIRST_LOAD_MS;
    loads.set(model, { runtime: target.runtime, state: "loading", startedAt, expectedMs });
    const attempt = (async () => {
      const ok = await (async () => {
        // The built-in runtime is started first when this server runs it.
        if (!(await localRuntimeReady(target.baseUrl, model))) return false;
        return warm(target.baseUrl, model);
      })().catch(() => false);
      const endedAt = Date.now();
      loads.set(model, { runtime: target.runtime, state: ok ? "ready" : "failed", startedAt, expectedMs, endedAt });
      if (ok) {
        // Kept smooth: one slow load (a busy disk) does not set the next.
        const took = endedAt - startedAt;
        const previous = measured.get(model);
        measured.set(model, previous ? Math.round(previous * 0.5 + took * 0.5) : took);
      }
      return ok;
    })().finally(() => running.delete(model));
    running.set(model, attempt);
  }
  return modelLoadState(model);
}

/// One token from `model`, which makes its runtime read it into memory.
/// Only ever sent to a runtime this computer's providers name.
export async function warmModel(baseUrl: string, model: string): Promise<boolean> {
  try {
    const response = await outboundFetch(`${baseUrl.trim().replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...runtimeAuthHeaders(baseUrl) },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ok" }],
        max_tokens: 1,
        stream: false,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(WARM_TIMEOUT_MS),
    });
    await response.arrayBuffer().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}

/// Resolves once the load of `model` under way, if any, is over: for tests.
export async function modelLoadSettled(model: string): Promise<void> {
  await running.get(model)?.catch(() => undefined);
}

/// Forgets every load: for tests.
export function forgetModelLoads(): void {
  loads.clear();
  measured.clear();
}
