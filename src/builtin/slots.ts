// How many slots Twoody's llama.cpp opens a model with, and when a computer
// is « shared » (19/10/2026, Jimmy: « deux emplacements quand l'ordinateur
// est partagé »).
//
//   - A computer used by its owner alone: one slot, nothing changes.
//   - A computer shared with at least one person — an active grant of this
//     computer's models on the account (ComputeGrant, Desktop « Réglages » ›
//     « Partage » › « Partager ce Mac ») — with 24 GB of memory or more:
//     two. Slot 0 is the owner's: their chat, their other devices, Twoody
//     Code, the warms of their start, and the work in the background; slot 1
//     the people it is shared with (their questions and their warms).
//   - 16 GB: one. Measured with the Desktop's 16 GB settings (2 GiB of prompt
//     cache), Qwen3.5 9B: the model's process 596 MB larger at load with a
//     second slot, 794 MB larger at its peak (4 574 MB against 3 780, the
//     weights left out) — with the weights, some 9.9 GiB of the 10.7 GiB a
//     16 GB Mac lets its GPU use, beside macOS and the app. Giving it back
//     from the prompt cache (slotCacheRam) would leave 1.4 GiB, about one of
//     the owner's long conversations; and the two writing together went at
//     14 tokens/s each on an M5, which the slower chips of 16 GB Macs would
//     take under 8. Not shown safe: no 16 GB Mac to measure on.
//   - 48 GB and more (a Mac Studio in a firm): room for three or four one
//     day (sharedSlotsByMemory), two for now (MAX_SLOTS) — nothing measured
//     there; the aim would be 8 tokens a second or more per conversation.
//   - Only llama.cpp: MLX (mlx-lm 0.32.0) batches the requests that come
//     together on its own and keeps a cache per conversation in its prompt
//     trie, shared or not; nothing to set.
//   - A model that takes more than 45 % of the memory (Qwen3.6 35B-A3B on 24
//     and 32 GB: its prompt cache and checkpoints were cut to fit), one whose
//     need with two slots passes what the GPU may use, or one without the
//     catalogue's figures (a GGUF put in the folder by hand: what a second
//     slot costs is unknown): one slot.
//   - The person may choose (19/10/2026, Jimmy: Desktop « Réglages » ›
//     « Partage » › « Réponses en même temps »): « Automatique » is the rule
//     above — the Desktop counts the computer as shared only while it also
//     answers the people it is shared with (its bridge running); « Une à la
//     fois » one slot; « Deux en même temps » two on any computer, 16 GB
//     included, shared or not, unless the model's own figures show it cannot
//     hold them (SlotsMode).
//
// Each slot has the model's whole window: the cache is split, not shared
// (ctx-size = window × slots, kv-unified off), and an idle slot is left where
// it is when the other starts (cache-idle-slots off). Measured on Jimmy's M5
// 24 GB, Qwen3.5 9B Q4_K_M, the Desktop's settings (twoody-bench
// scripts/two-slots-router-bench.mjs, AGENTS.md §5): one pool of 32 768 tokens
// for both (the measurement of 18/10/2026) purged the owner's idle
// conversation of 19 161 tokens when a guest's of 16 458 came (the owner's
// next message read everything again: 59.6 s instead of 1.7 s), and failed
// both answers (« Context size has been exceeded ») when the two asked at
// once; a pool split in two lost nothing (1.7 s, both answered in 3.2 s), and
// wrote faster (21.4 tokens/s alone, 14.4 each together, against 19.6 and
// 12.7). Its cost: 544 MiB of cache and 50 MiB of state for the 9B at 32 768
// tokens (memory.ts slotMemory), given back by the prompt cache
// (slotCacheRam) so that the most the runtime can take stays what it was.
//
// No import from Electron or the server's routes: the Desktop copies this
// file (scripts/sync-builtin.mjs).

import type { MemoryFigures } from "./catalogTypes.js";
import { gpuShare, memoryNeed, slotMemory, twoodyContext, type EngineKind } from "./memory.js";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/// The owner's slot and the guests'.
export const OWNER_SLOT = 0;
export const GUEST_SLOT = 1;

/// The most slots Twoody opens a model with, for now.
export const MAX_SLOTS = 2;

/// A model whose file takes more than this share of the memory keeps one
/// slot (and, in the Desktop, a smaller prompt cache: runtimeArgs.ts).
export const LARGE_MODEL_SHARE = 0.45;

export function largeForMemory(modelBytes: number | null | undefined, totalMemory: number): boolean {
  return !!modelBytes && modelBytes > LARGE_MODEL_SHARE * totalMemory;
}

/// The slots a shared computer would have by its memory alone, before
/// MAX_SLOTS: one below 24 GB (a « 24 GB » Mac reports 24 GiB; 23 as for
/// the prompt cache), two from 24, four from 48 one day.
export function sharedSlotsByMemory(totalMemory: number): number {
  if (totalMemory >= 47 * GIB) return 4;
  if (totalMemory >= 23 * GIB) return 2;
  return 1;
}

/// « Réponses en même temps » (the Desktop's setting, slotsPref.ts there):
/// the rule, one slot, or two.
export type SlotsMode = "auto" | "one" | "two";
export const SLOTS_MODES: readonly SlotsMode[] = ["auto", "one", "two"];

export function slotsModeOf(value: unknown): SlotsMode {
  return typeof value === "string" && (SLOTS_MODES as readonly string[]).includes(value) ? (value as SlotsMode) : "auto";
}

export interface SlotInput {
  totalMemory: number;
  /// This computer is shared with someone now (sharedFromGrants; in the
  /// Desktop, and answering them: its bridge running).
  shared: boolean;
  /// The person's choice (default: the rule).
  mode?: SlotsMode;
  engine?: EngineKind;
  /// The model's file and its catalogue figures (memory.ts).
  modelBytes?: number | null;
  figures?: MemoryFigures | null;
  visionBytes?: number | null;
  /// What the model's process may take where it runs, when that is not the
  /// share of the memory a Mac lets its GPU use (memory.ts gpuShare): a
  /// PC's graphics card of its own (Vulkan), its memory less llama.cpp's
  /// margin of 1 GiB (--fit on).
  deviceMemory?: number | null;
  /// The cache is in 16 bits where the Desktop keeps it so (a Vulkan GPU may
  /// lack flash attention, runtimeArgs.ts): a slot costs twice as much.
  f16Cache?: boolean;
}

/// The slots of the model's process on this computer (the rule above).
export function runtimeSlots(input: SlotInput): number {
  const mode = input.mode ?? "auto";
  if (mode === "one" || (input.engine ?? "llamacpp") !== "llamacpp") return 1;
  if (mode === "two") {
    // The person's choice, whatever the memory and whether it is shared:
    // two, unless the model's own figures show it cannot hold them.
    if (!input.figures || !input.modelBytes) return 2;
    return needWith(input, 2) <= roomFor(input) ? 2 : 1;
  }
  if (!input.shared) return 1;
  const wanted = Math.min(sharedSlotsByMemory(input.totalMemory), MAX_SLOTS);
  if (wanted < 2 || !input.figures || !input.modelBytes) return 1;
  if (largeForMemory(input.modelBytes, input.totalMemory)) return 1;
  const room = roomFor(input);
  for (let slots = wanted; slots >= 2; slots -= 1) {
    if (needWith(input, slots) <= room) return slots;
  }
  return 1;
}

/// What may hold the model: a PC's own graphics card less llama.cpp's
/// margin, else the share of the memory a Mac lets its GPU use.
function roomFor(input: SlotInput): number {
  return input.deviceMemory && input.deviceMemory > 0
    ? input.deviceMemory - GIB
    : gpuShare(input.totalMemory / GIB) * input.totalMemory;
}

function needWith(input: SlotInput, slots: number): number {
  const figures = input.figures!;
  const context = twoodyContext({ hybrid: figures.hybrid, totalMemory: input.totalMemory });
  const need = memoryNeed({ weightsBytes: input.modelBytes!, figures, context, engine: "llamacpp", visionBytes: input.visionBytes ?? null, slots });
  // A 16-bit cache: what memory.ts counts in q8_0 counted again, almost.
  return input.f16Cache && figures.hybrid ? need + slots * (slotMemory(figures, context, "llamacpp") - figures.stateBytes) * (64 / 34 - 1) : need;
}

/// llama.cpp's options for these slots, each with a window of `window`
/// tokens, as its command line takes them (the router's presets take the
/// same names without « -- », a flag as « = true »).
export function slotArgs(slots: number, window: number): string[] {
  const n = Math.max(1, Math.floor(slots));
  if (n === 1) return ["--parallel", "1", "--ctx-size", String(window)];
  return ["--parallel", String(n), "--ctx-size", String(window * n), "--no-kv-unified", "--no-cache-idle-slots"];
}

/// The prompt cache, in MiB, with `slots` slots: what each slot past the
/// first takes in the GPU's memory is taken from it, down to half of it, so
/// that the model, its slots full and the cache full take no more than they
/// did with one. Qwen3.5 9B on a 24 GB Mac: 4 096 MiB with one slot, 3 504
/// with two (a slot: 544 MiB of cache and 48 of state, memory.ts).
export function slotCacheRam(cacheRamMiB: number, slots: number, slotBytes: number): number {
  const extra = Math.max(0, Math.floor(slots) - 1);
  if (extra === 0 || cacheRamMiB <= 0) return cacheRamMiB;
  return Math.max(Math.floor(cacheRamMiB / 2), Math.floor(cacheRamMiB - (extra * slotBytes) / MIB));
}

// ── Is this computer shared? ────────────────────────────────────────────

export interface SharedAnswer {
  shared: boolean;
  /// When the first of this computer's grants with an end runs out (ms), to
  /// ask again then; null when none ends.
  until: number | null;
}

/// From the account's `GET /api/v1/compute_grants` (twoody-backend
/// ComputeGrantsController: `given`, the owner's active grants): whether one
/// of them, not yet expired, is for this computer — its bridge device id,
/// the account's `computer.host_id`. Null when the answer says nothing usable
/// (an error page, another shape): what was known is kept then.
///
/// The account is taken as possibly malicious (AGENTS.md rule 12): what it
/// says here only moves this computer between one slot and two — memory, and
/// a reload of the model at a quiet moment, at most once every
/// MIN_SWITCH_INTERVAL_MS. Who may ask anything is decided elsewhere, as
/// before (the sealed turns, the pinned keys).
export function sharedFromGrants(body: unknown, hostId: string | null | undefined, now = Date.now()): SharedAnswer | null {
  const given = body && typeof body === "object" ? (body as { given?: unknown }).given : undefined;
  if (!Array.isArray(given)) return null;
  const host = (hostId ?? "").trim().toLowerCase();
  if (!host) return { shared: false, until: null };
  let shared = false;
  let until: number | null = null;
  for (const grant of given as Array<{ expires_at?: unknown; computer?: { host_id?: unknown } } | null>) {
    const of = grant?.computer?.host_id;
    if (typeof of !== "string" || of.trim().toLowerCase() !== host) continue;
    const end = grant?.expires_at;
    if (end === null || end === undefined || end === "") {
      shared = true;
      continue;
    }
    const at = typeof end === "string" ? Date.parse(end) : NaN;
    if (!Number.isFinite(at) || at <= now) continue;
    shared = true;
    until = until === null ? at : Math.min(until, at);
  }
  return { shared, until: shared ? until : null };
}

/// How often the account is asked whether this computer is shared, between
/// the moments that ask it at once (a launch, a share made or taken back
/// from this app, a grant's end).
export const SHARED_CHECK_EVERY_MS = 15 * 60_000;

// ── Switching at a quiet moment ─────────────────────────────────────────

/// The shortest time between two switches: an account that answers shared,
/// not shared, shared… cannot make the model load again more often.
export const MIN_SWITCH_INTERVAL_MS = 10 * 60_000;
/// How often a pending switch looks for a quiet moment.
export const QUIET_POLL_MS = 2_000;

/// How the router is asked: the server's outboundFetch (its local-only gate),
/// the Desktop's fetch.
export type RouterFetch = (input: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;
type Fetch = RouterFetch;

/// The router's models, with their state (« loaded », « sleeping »,
/// « loading », « unloaded »), or null when it does not answer.
async function routerModels(baseUrl: string, key: string, fetchImpl: Fetch): Promise<Array<{ id: string; status: string }> | null> {
  const root = baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  const response = await fetchImpl(`${root}/v1/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(3_000) });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const body = (await response.json().catch(() => null)) as { data?: Array<{ id?: unknown; status?: unknown }> } | null;
  return (body?.data ?? []).flatMap((row) => {
    const status = typeof row?.status === "string" ? row.status : (row?.status as { value?: unknown } | null | undefined)?.value;
    return typeof row?.id === "string" ? [{ id: row.id, status: typeof status === "string" ? status : "" }] : [];
  });
}

/// Whether nothing is being generated by llama.cpp's router now: no model
/// loading, and every slot of the model it holds idle (`/slots`, never
/// loading a model for it). A model asleep is quiet, and is not woken to
/// be asked. False when the router cannot tell.
export async function routerQuiet(baseUrl: string, key: string, fetchImpl: Fetch): Promise<boolean> {
  try {
    const models = await routerModels(baseUrl, key, fetchImpl);
    if (!models) return false;
    if (models.some((model) => model.status === "loading")) return false;
    const root = baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
    for (const model of models.filter((row) => row.status === "loaded")) {
      const response = await fetchImpl(`${root}/slots?model=${encodeURIComponent(model.id)}&autoload=false`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(3_000) });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return false;
      }
      const slots = (await response.json().catch(() => null)) as Array<{ is_processing?: unknown }> | null;
      if (!Array.isArray(slots) || slots.some((slot) => slot?.is_processing !== false)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/// The model the router holds awake now, if any (a model asleep is not).
export async function routerLoadedModel(baseUrl: string, key: string, fetchImpl: Fetch): Promise<string | null> {
  try {
    return (await routerModels(baseUrl, key, fetchImpl))?.find((model) => model.status === "loaded")?.id ?? null;
  } catch {
    return null;
  }
}

/// Has the router read its presets file again (`GET /v1/models?reload=1`,
/// llama.cpp b11146 server-models.cpp load_models): a model whose preset
/// changed is let go — its process stopped — and loads with the new one at
/// the next request; the router itself keeps running, at the same address.
export async function routerReload(baseUrl: string, key: string, fetchImpl: Fetch): Promise<boolean> {
  const root = baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  const response = await fetchImpl(`${root}/v1/models?reload=1`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) });
  await response.body?.cancel().catch(() => undefined);
  return response.ok;
}

export interface SlotSwitch {
  /// Something changed (shared or not, the models): look whether the
  /// runtime must switch, and do it at the next quiet moment. `asked`: the
  /// person chose it (« Réponses en même temps »): as soon as it is quiet,
  /// whenever the last switch was.
  request(options?: { asked?: boolean }): void;
  /// A switch waits for its moment.
  pending(): boolean;
  stop(): void;
}

/// Switches the runtime's slots at a quiet moment — never during an answer —
/// and at most once every MIN_SWITCH_INTERVAL_MS, unless the person asked for
/// it (`request({asked: true})`: as soon as it is quiet). `needed` says whether what
/// runs differs from what should (read again at the moment itself: a change
/// taken back before then does nothing); `quiet` whether nothing is being
/// generated; `apply` does it (the Desktop writes the presets and has the
/// router read them, the server's manager starts its runtime again).
export function createSlotSwitch(deps: {
  needed: () => Promise<boolean>;
  quiet: () => Promise<boolean>;
  apply: () => Promise<void>;
  now?: () => number;
  pollMs?: number;
  minIntervalMs?: number;
  log?: (line: string) => void;
  /// Tests: their own clock.
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
}): SlotSwitch {
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? QUIET_POLL_MS;
  const minIntervalMs = deps.minIntervalMs ?? MIN_SWITCH_INTERVAL_MS;
  const setTimer = deps.setTimer ?? ((fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  });
  let timer: { cancel(): void } | null = null;
  let running = false;
  let again = false;
  let lastApplied: number | null = null;
  let stopped = false;
  /// The person asked: the next switch does not wait for the interval.
  let asked = false;

  const schedule = (ms: number) => {
    timer?.cancel();
    timer = setTimer(() => {
      timer = null;
      void tick();
    }, Math.max(0, ms));
  };

  async function tick(): Promise<void> {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      if (!(await deps.needed().catch(() => false))) {
        asked = false;
        return;
      }
      const wait = lastApplied === null || asked ? 0 : lastApplied + minIntervalMs - now();
      if (wait > 0) {
        schedule(wait);
        return;
      }
      if (!(await deps.quiet().catch(() => false))) {
        schedule(pollMs);
        return;
      }
      lastApplied = now();
      asked = false;
      await deps.apply();
    } catch (err) {
      deps.log?.(`[runtime] the slots could not be switched now: ${err instanceof Error ? err.message : String(err)}`);
      schedule(pollMs);
    } finally {
      running = false;
      if (again && !stopped) {
        again = false;
        if (!timer) schedule(0);
      }
    }
  }

  return {
    request(options = {}) {
      if (stopped) return;
      if (options.asked) asked = true;
      if (running) {
        again = true;
        return;
      }
      // Asked by the person: no waiting out the interval already scheduled.
      if (!timer || options.asked) schedule(0);
    },
    pending: () => timer !== null || running,
    stop() {
      stopped = true;
      timer?.cancel();
      timer = null;
    },
  };
}
