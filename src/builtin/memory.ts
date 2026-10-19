// What a model needs in memory on this computer, as Twoody runs it — the
// « Mémoire nécessaire » of the model screen, and the size from which a model
// is said to fit (minRamGb). One formula for the app, the server and the
// site's calculator (twoody-backend Marketing::LocalLlm::Estimator, which
// uses the same terms and constants: docs/builtin-runtime-design.md §9).
//
//   need = weights
//        + KV cache   = kvBytesPerToken × context × cache factor
//        + sliding    = swa.bytesPerToken × min(context, window + 512) × cache factor
//        + state      = recurrent state (linear attention, Mamba…), fixed
//        + 0.3 GiB    = the engine's work buffers
//        + vision     = its vision file + 0.3 GiB to read an image (llama.cpp only)
//        + another slot's KV cache, sliding layers and state, for each slot
//          past the first (slots.ts: two on a computer shared with someone,
//          from 24 GB; each slot has its own whole window)
//
// - weights: the GGUF file (llama.cpp maps it whole), or the MLX folder's
//   safetensors;
// - context: what Twoody opens the model with (twoodyContext: 32 768 tokens
//   for a hybrid model from 16 GB, 65 536 from 32 GB; 16 384 for another
//   from 16 GB; 8 192 below);
// - cache factor: llama.cpp keeps a hybrid model's cache in q8_0 (34 bytes
//   for 32 values: 0.53125 of f16) and any other's in f16 (1); MLX keeps it
//   in the model's own 16 bits (1);
// - kvBytesPerToken, swa, state: from the model's config.json
//   (scripts/model-catalog.mjs architectureFigures).
//
// Checked against llama.cpp b11146's own buffers on an M5 (10–11/10/2026,
// twoody-desktop scripts/memory-bench.mjs): Qwen3.5 9B with its vision file at
// 32 768 tokens 7.4 GiB measured, 7.4 here; the 4B without it at 8 192 tokens
// 2.9 measured, 3.1 here; Qwen3.6 35B-A3B IQ3_XXS at 32 768 tokens 14.5
// measured, 15.4 here (llama.cpp leaves some of its weights out of the GPU's
// count) — on the safe side.
//
// No import from Electron or the server: the Desktop copies this file.

import type { MemoryFigures } from "./catalogTypes.js";

const GIB = 1024 ** 3;
export const WORK_BUFFERS_BYTES = 0.3 * GIB;
export const VISION_BUFFERS_BYTES = 0.3 * GIB;
/// q8_0: 32 values in 34 bytes, against 64 in f16.
export const Q8_0_FACTOR = 34 / 64;
/// llama.cpp sizes a sliding-window cache to its window and one batch.
const SWA_BATCH = 512;

export type EngineKind = "llamacpp" | "mlx";

/// The window Twoody opens a model with (twoody-desktop runtimeArgs.ts
/// builtinContextFor, which calls this): a hybrid model (Qwen3.5, Nemotron-H,
/// LFM2…) 32 768 tokens from 16 GB of memory and 65 536 from 32 GB, an 8 GB
/// computer 8 192; any other 16 384 from 16 GB, else 8 192. A "16 GB" Mac
/// reports a little under 16 GiB.
export function twoodyContext(input: { hybrid: boolean; totalMemory: number }): number {
  if (!input.hybrid) return input.totalMemory >= 15 * GIB ? 16_384 : 8_192;
  if (input.totalMemory >= 31 * GIB) return 65_536;
  if (input.totalMemory >= 15 * GIB) return 32_768;
  return 8_192;
}

export interface MemoryInput {
  weightsBytes: number;
  figures: MemoryFigures;
  context: number;
  engine: EngineKind;
  visionBytes?: number | null;
  /// llama.cpp's slots, each with its own whole `context` (slots.ts): one,
  /// unless the computer is shared. Ignored on MLX, which keeps a cache per
  /// request as it comes (mlx-lm's batching) and reserves none ahead.
  slots?: number;
}

/// What one llama.cpp slot holds for a window of `context` tokens: its KV
/// cache, its sliding layers and its recurrent state. Measured with b11146
/// on an M5 (19/10/2026): Qwen3.5 9B at 32 768 tokens, 544 MiB of q8_0
/// cache and 50 MiB of state — the model's process 571 MB larger with a
/// second slot (2 295 MB against 1 724 at load, the weights left out).
export function slotMemory(figures: MemoryFigures, context: number, engine: EngineKind): number {
  const factor = engine === "llamacpp" && figures.hybrid ? Q8_0_FACTOR : 1;
  const kv = figures.kvBytesPerToken * context * factor;
  const swa = figures.swa ? figures.swa.bytesPerToken * Math.min(context, figures.swa.window + SWA_BATCH) * factor : 0;
  return kv + swa + figures.stateBytes;
}

/// The formula above, in bytes.
export function memoryNeed(input: MemoryInput): number {
  const { figures, context } = input;
  const factor = input.engine === "llamacpp" && figures.hybrid ? Q8_0_FACTOR : 1;
  const kv = figures.kvBytesPerToken * context * factor;
  const swa = figures.swa ? figures.swa.bytesPerToken * Math.min(context, figures.swa.window + SWA_BATCH) * factor : 0;
  const vision = input.engine === "llamacpp" && input.visionBytes ? input.visionBytes + VISION_BUFFERS_BYTES : 0;
  // Summed as before for one slot, to the byte: the site's calculator and
  // its Ruby port compare these figures exactly (memory-parity.json).
  const extraSlots = input.engine === "llamacpp" ? Math.max(0, Math.floor(input.slots ?? 1) - 1) : 0;
  const more = extraSlots > 0 ? extraSlots * slotMemory(figures, context, input.engine) : 0;
  return input.weightsBytes + kv + swa + figures.stateBytes + WORK_BUFFERS_BYTES + vision + more;
}

/// What a catalogue entry needs on a computer with `totalMemory` bytes, as
/// Twoody would run it there: llama.cpp with its vision file when it has
/// one, or MLX (text only) when `engine` says so and the entry has an MLX
/// folder. `slots`: llama.cpp's on this computer (slots.ts runtimeSlots).
/// Null for an entry without figures (a test catalogue).
export function catalogMemoryNeed(
  entry: { bytes: number; vision?: { bytes: number } | null; memory?: MemoryFigures | null; mlx?: { weightsBytes: number } | null },
  totalMemory: number,
  engine: EngineKind = "llamacpp",
  slots = 1,
): number | null {
  if (!entry.memory) return null;
  const context = twoodyContext({ hybrid: entry.memory.hybrid, totalMemory });
  if (engine === "mlx") {
    if (!entry.mlx) return null;
    return memoryNeed({ weightsBytes: entry.mlx.weightsBytes, figures: entry.memory, context, engine });
  }
  return memoryNeed({ weightsBytes: entry.bytes, figures: entry.memory, context, engine, visionBytes: entry.vision?.bytes ?? null, slots });
}

/// What a Mac lets its GPU use of its memory (Metal's
/// recommendedMaxWorkingSetSize, as llama.cpp logs it): about two thirds up
/// to 32 GB, three quarters up to 128 GB, 0.8 above. The site's calculator
/// uses the same shares (Estimator.mac_share).
export function gpuShare(memoryGb: number): number {
  if (memoryGb <= 32) return 2 / 3;
  if (memoryGb <= 128) return 0.75;
  return 0.8;
}

/// The memory sizes computers are sold with.
export const MEMORY_SIZES_GB = [8, 16, 18, 24, 32, 36, 48, 64, 96, 128, 192, 256];

/// The smallest memory on which the model runs — its need within what the
/// GPU may use there (the site's verdict « juste » or better) — for a
/// catalogue entry whose size was not measured by hand. Null when even
/// 256 GB is not enough.
export function minRamFor(entry: Parameters<typeof catalogMemoryNeed>[0], engine: EngineKind = "llamacpp"): number | null {
  for (const gb of MEMORY_SIZES_GB) {
    const need = catalogMemoryNeed(entry, gb * GIB, engine);
    if (need === null) return null;
    if (need <= gb * GIB * gpuShare(gb)) return gb;
  }
  return null;
}
