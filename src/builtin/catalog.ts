import { readFileSync } from "node:fs";

import { VERIFIED_MODELS } from "./catalogData.js";
import type { MemoryFigures, MlxVariant, ModelFamily, ModelUse, VerifiedModel } from "./catalogTypes.js";
import { catalogMemoryNeed, minRamFor } from "./memory.js";
import { runtimeSlots } from "./slots.js";

export type { MemoryFigures, MlxFile, MlxVariant, ModelFamily, ModelUse, VerifiedModel } from "./catalogTypes.js";
export { CATALOG_VERIFIED_AT } from "./catalogData.js";

// The models Twoody offers to install, for the built-in runtime
// (llama.cpp's server, see manager.ts) and, on a Mac with Apple silicon,
// for its MLX engine (twoody-desktop docs/mlx-engine.md).
//
// Twoody's own models first (Qwen3.5 4B and 9B, recommended, and a larger
// one beside them where it fits), then others to choose from (Jimmy,
// 01/10/2026: « plus de choix de modèles »; 15/10/2026: a catalogue of some
// fifty, several versions of each family), in a quantisation that keeps
// most of the quality. The publisher's own file where there is one (Google,
// Mistral AI, Qwen, NVIDIA), llama.cpp's own (ggml-org), Osmove's
// conversions (huggingface.co/twoody, scripts/convert-model.sh, reproducible
// to the byte), else a well-known independent quantiser's (bartowski:
// imatrix quantisations, no app of its own) — unsloth only for the one
// model none of these publish in 4 bits (Qwen3-Coder 30B-A3B).
//
// Every entry is data verified against the Hugging Face API
// (catalogData.ts, written by scripts/model-catalog.mjs, which says how to
// refresh it): repository revision, size, SHA-256 — so what gets installed
// is exactly what was checked, and a corrupted or substituted file is
// refused —, licence, context length, and the figures from which memory.ts
// computes what the model needs in memory.
//
// Measured with Twoody (twoody-bench, docs/builtin-runtime-design.md §8):
// Qwen3.5 4B and 9B (memory, tools, documents), Qwen3.6 35B-A3B. The others
// are offered as they are, their capabilities as their chat template says.
//
// No Electron import here: `test/builtinCatalog.test.ts` runs under Node.

export interface CatalogModel {
  /// What the runtime lists the model as: the file name without ".gguf".
  id: string;
  name: string;
  file: string;
  url: string;
  bytes: number;
  sha256: string;
  /// Memory from which the model runs comfortably next to other apps.
  minRamGb: number;
  publisher: string;
  license: string;
  /// Its vision part (llama.cpp's « mmproj »), for a model that reads
  /// images: downloaded with it, kept beside the models folder (never in
  /// it: the runtime would list it as a model) and given to the runtime
  /// with the model (runtimeArgs.ts modelsPreset).
  vision?: VisionFile;
  /// Offered as the first choice (recommendedModel): Twoody's own models,
  /// with which memory, tools and documents are measured.
  recommendable?: boolean;
  /// Measured like them, but larger: offered beside them only where it
  /// fits (modelFits), never chosen first — its download and its memory
  /// are the person's choice (Jimmy, 11/10/2026: « ajoute un modèle plus
  /// grand au moteur intégré »).
  larger?: boolean;
  /// What it is good at, for the model screen: « reasoning » for a model
  /// that thinks before it answers, « code » for one made for code.
  traits?: Array<"reasoning" | "code">;
  // The verified catalogue's facts (catalogData.ts); absent from a test
  // catalogue (TWOODY_MODEL_CATALOG).
  key?: string;
  family?: ModelFamily;
  quant?: string;
  quantizer?: string;
  licenseKind?: "open" | "restricted";
  licenseUrl?: string;
  paramsB?: number | null;
  contextLength?: number | null;
  capabilities?: { tools: boolean; vision: boolean; reasoning: boolean };
  uses?: ModelUse[];
  memory?: MemoryFigures;
  /// The same model for MLX (Mac with Apple silicon only).
  mlx?: MlxVariant;
}

export interface VisionFile {
  url: string;
  bytes: number;
  sha256: string;
}

/// The vision file of a model, as a download of its own (downloads.ts):
/// `<model id>.mmproj.gguf` in the vision folder.
export function visionDownload(model: CatalogModel): CatalogModel | null {
  if (!model.vision) return null;
  return { id: `${model.id}.mmproj`, name: model.name, file: `${model.id}.mmproj.gguf`, url: model.vision.url, bytes: model.vision.bytes, sha256: model.vision.sha256, minRamGb: 0, publisher: model.publisher, license: model.license };
}

/// A verified entry as the catalogue offers it. Its memory threshold: the
/// one measured by hand for the models offered before 15/10/2026, else the
/// smallest memory where memory.ts's need fits what the GPU may use.
function catalogEntry(entry: VerifiedModel): CatalogModel {
  const traits = (["reasoning", "code"] as const).filter((trait) => entry.uses.includes(trait));
  return {
    ...entry,
    minRamGb: entry.minRamGb ?? minRamFor(entry) ?? 256,
    ...(traits.length > 0 ? { traits } : {}),
  };
}

export const CATALOG: CatalogModel[] = VERIFIED_MODELS.map(catalogEntry);

/// What a computer offers a model, beyond its memory: where the engine will
/// run it (catalogView, the Desktop's model screen).
export interface MachineFacts {
  /// `process.arch`. A Mac with an Intel processor ("x64") has no Metal build
  /// of the engine (runtimeManifest.ts: llama.cpp's macOS x64 release is
  /// CPU-only): it runs a model on its processor, like a PC without a graphics
  /// card, and its memory is not shared with a GPU.
  arch?: string;
  /// The memory of its largest graphics card with memory of its own (Vulkan,
  /// `dedicatedGpuMemory()` in acceleration.ts), in bytes; null or absent for
  /// none, an integrated one (it shares the system's memory) or unknown.
  dedicatedVramBytes?: number | null;
  /// Shared with someone now (slots.ts): llama.cpp gives the people it is
  /// shared with a slot of their own from 24 GB, and a model's « mémoire
  /// nécessaire » counts it. Never changes which model is recommended.
  shared?: boolean;
}

const GIB = 1024 ** 3;
/// A graphics card that holds Qwen3.5 9B whole, with its 32 768-token
/// window in an f16 cache (Vulkan has no q8_0 cache without flash
/// attention) and its vision file: 5.4 GiB of weights + 1 GiB of cache +
/// 0.3 GiB of work buffers + 1.15 GiB for images, plus llama.cpp's 1 GiB
/// margin (measured with b11146 on Metal, 10/10/2026, the cache recomputed
/// in f16). A "10 GB" card reports 10 240 MiB.
export const VRAM_FOR_9B_BYTES = 9.5 * GIB;

/// The model offered first, by this computer's memory and where the engine
/// runs it (measured 10/10/2026 on an M5, b11146, the app's settings):
///   - a Mac with Apple silicon: its memory is the GPU's. The largest of
///     Twoody's models it holds next to the system and the app — 4B on
///     8 GB (with its vision file, some 3.8 GiB in all at 8 192 tokens), 9B
///     from 16 GB (some 7.4 GiB at 32 768 tokens). The 9B on 8 GB does not
///     fit the GPU's share of it (about 5.3 GiB): 19 or 20 of its 34 layers
///     on the GPU, the others copied for the processor (1.8 GiB more, some
///     8.8 GiB in all); even with memory to spare, it read a 3 000-token
///     prompt eleven times slower than the 4B (65 against 742 tokens a
///     second) and wrote three times slower (9 against 29).
///   - on the processor (Linux, an Intel Mac, a PC without a graphics card
///     of its own): the 4B below 32 GB. On 4 cores the 9B read 16 tokens a
///     second and wrote 4, the 4B 24 to 36 and 6 to 11 (a busy M5): a
///     3 000-token prompt is minutes either way, and the 9B's twice as
///     long. The 9B from 32 GB.
///   - a PC whose graphics card holds the 9B whole (VRAM_FOR_9B_BYTES) and
///     16 GB of memory: the 9B.
/// The person can always choose the other size.
export function recommendedModel(
  totalRamBytes: number,
  catalog: CatalogModel[] = CATALOG,
  platform: NodeJS.Platform = process.platform,
  machine: MachineFacts = {},
): CatalogModel | null {
  if (catalog.length === 0) return null;
  const ramGb = totalRamBytes / GIB;
  // The measured models first; any other only when the catalogue has none.
  // Never a larger one: offered beside, not chosen for the person.
  const firstChoices = catalog.filter((model) => !model.larger);
  if (firstChoices.length === 0) return null;
  const candidates = firstChoices.some((model) => model.recommendable) ? firstChoices.filter((model) => model.recommendable) : firstChoices;
  const sorted = [...candidates].sort((a, b) => a.minRamGb - b.minRamGb);
  const unifiedMemory = platform === "darwin" && machine.arch !== "x64";
  const largeCard = (machine.dedicatedVramBytes ?? 0) >= VRAM_FOR_9B_BYTES && ramGb + 0.5 >= 16;
  if (!unifiedMemory && !largeCard && ramGb + 0.5 < 32) return sorted[0];
  // A "16 GB" Mac reports a little under 16 GiB.
  const fitting = sorted.filter((model) => model.minRamGb <= ramGb + 0.5);
  return fitting.length > 0 ? fitting[fitting.length - 1] : sorted[0];
}

function isLoopbackHttp(url: URL): boolean {
  return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

/// Where a model may be downloaded from, redirects included: Hugging Face
/// and its content network, over HTTPS. `allowLoopback` is for the test
/// catalogue, served by a local mirror.
export function isAllowedDownloadUrl(value: string, allowLoopback = false): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (allowLoopback && isLoopbackHttp(url)) return true;
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return host === "huggingface.co" || host.endsWith(".huggingface.co") || host === "hf.co" || host.endsWith(".hf.co");
}

function isCatalogModel(value: unknown): value is CatalogModel {
  if (!value || typeof value !== "object") return false;
  const model = value as Record<string, unknown>;
  return (
    typeof model.id === "string" &&
    /^[\w.-]{1,80}$/.test(model.id) &&
    typeof model.name === "string" &&
    model.file === `${model.id}.gguf` &&
    typeof model.url === "string" &&
    typeof model.bytes === "number" &&
    model.bytes > 0 &&
    typeof model.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(model.sha256) &&
    typeof model.minRamGb === "number" &&
    (model.vision === undefined || isVisionFile(model.vision))
  );
}

function isVisionFile(value: unknown): value is VisionFile {
  const vision = value as Record<string, unknown> | null;
  return !!vision && typeof vision.url === "string" && typeof vision.bytes === "number" && vision.bytes > 0 && typeof vision.sha256 === "string" && /^[0-9a-f]{64}$/.test(vision.sha256);
}

/// The catalogue in force. TWOODY_MODEL_CATALOG (or the Desktop's
/// TWOODY_DESKTOP_MODEL_CATALOG) names a JSON file that replaces it: a test
/// run installs a small model from a local mirror instead of fetching
/// gigabytes. Entries that do not hold together, or point anywhere other
/// than Hugging Face or this computer, are dropped.
export function loadCatalog(env: NodeJS.ProcessEnv = process.env): { models: CatalogModel[]; overridden: boolean } {
  const path = (env.TWOODY_MODEL_CATALOG ?? env.TWOODY_DESKTOP_MODEL_CATALOG)?.trim();
  if (!path) return { models: CATALOG, overridden: false };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const entries = Array.isArray(parsed) ? parsed : [];
    const models = entries
      .filter(isCatalogModel)
      .filter((model) => isAllowedDownloadUrl(model.url, true) && (!model.vision || isAllowedDownloadUrl(model.vision.url, true)))
      .map((model) => ({ ...model, publisher: model.publisher ?? "", license: model.license ?? "" }));
    return { models, overridden: true };
  } catch {
    return { models: [], overridden: true };
  }
}

/// Whether a model runs comfortably on a computer with this much memory
/// (the same half-gigabyte allowance as the recommendation).
export function modelFits(model: CatalogModel, totalRamBytes: number): boolean {
  return model.minRamGb <= totalRamBytes / GIB + 0.5;
}

export interface CatalogEntryView extends Omit<CatalogModel, "mlx"> {
  installed: boolean;
  recommended: boolean;
  fits: boolean;
  /// What it needs in memory on this computer, as Twoody runs it there
  /// (memory.ts, llama.cpp); null for an entry without figures.
  memoryNeed: number | null;
  /// Its MLX folder, without the file list: id, size, and what it needs
  /// in memory on MLX.
  mlx?: { id: string; bytes: number; memoryNeed: number | null };
}

/// The catalogue as a model screen shows it (`GET /runtime/catalog`).
export function catalogView(
  models: CatalogModel[],
  installedIds: Iterable<string>,
  totalRamBytes: number,
  platform: NodeJS.Platform = process.platform,
  machine: MachineFacts = {},
): CatalogEntryView[] {
  const installed = new Set(installedIds);
  const recommended = recommendedModel(totalRamBytes, models, platform, machine)?.id ?? null;
  return models.map(({ mlx, ...model }) => ({
    ...model,
    installed: installed.has(model.id),
    recommended: model.id === recommended,
    fits: modelFits(model, totalRamBytes),
    memoryNeed: catalogMemoryNeed(model, totalRamBytes, "llamacpp", catalogSlots(model, totalRamBytes, machine)),
    ...(mlx ? { mlx: { id: mlx.id, bytes: mlx.bytes, memoryNeed: catalogMemoryNeed({ ...model, mlx }, totalRamBytes, "mlx") } } : {}),
  }));
}

/// llama.cpp's slots for a catalogue model on this computer (slots.ts): two
/// when it is shared with someone, from 24 GB, if the model takes them.
export function catalogSlots(model: Pick<CatalogModel, "bytes" | "memory" | "vision">, totalRamBytes: number, machine: MachineFacts = {}): number {
  return runtimeSlots({
    totalMemory: totalRamBytes,
    shared: machine.shared === true,
    modelBytes: model.bytes,
    figures: model.memory ?? null,
    visionBytes: model.vision?.bytes ?? null,
    // On a PC's graphics card of its own, llama.cpp's cache is in 16 bits.
    deviceMemory: machine.dedicatedVramBytes ?? null,
    f16Cache: !!machine.dedicatedVramBytes,
  });
}
