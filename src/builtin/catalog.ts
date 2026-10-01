import { readFileSync } from "node:fs";

// The models Twoody offers to install, for the built-in runtime
// (llama.cpp's server, see manager.ts). Ported from
// twoody-desktop/src/main/modelCatalog.ts: same entries, same pins.
//
// Twoody's own models first (Qwen3.5 4B and 9B, recommended), then others
// to choose from (Jimmy, 01/10/2026: « plus de choix de modèles »), in a
// quantisation that keeps most of the quality. Never from Twoody's
// competitors (Unsloth, LM Studio's community): the publisher's own file
// where there is one (Google, Mistral AI, Qwen), llama.cpp's own (ggml-org),
// else Osmove's, converted from the publisher's weights with the llama.cpp
// release the app ships (scripts/convert-model.sh, reproducible to the
// byte) and published under huggingface.co/twoody (scripts/publish-model.sh).
// Each entry is pinned — repository revision, size, SHA-256 — so what gets
// installed is exactly what was tried, and a corrupted or substituted file
// is refused.
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
  /// What it is good at, for the model screen: « reasoning » for a model
  /// that thinks before it answers, « code » for one made for code.
  traits?: Array<"reasoning" | "code">;
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

const HF = "https://huggingface.co";

export const CATALOG: CatalogModel[] = [
  // Twoody's own (huggingface.co/twoody), recommended: memory, tools and
  // documents are measured with them (twoody-bench).
  {
    id: "Qwen3.5-4B-Q4_K_M",
    name: "Qwen3.5 4B",
    file: "Qwen3.5-4B-Q4_K_M.gguf",
    url: `${HF}/twoody/Qwen3.5-4B-GGUF/resolve/d741a25c4cf8eea74fe876af7631b659b366f126/Qwen3.5-4B-Q4_K_M.gguf`,
    bytes: 2_783_446_880,
    sha256: "b7508d8b4a652bc020a439aafdd4ce1527d49774865ce3334a43b16dbeaa90ca",
    minRamGb: 8,
    publisher: "Qwen (Alibaba)",
    license: "Apache 2.0",
    recommendable: true,
    vision: {
      url: `${HF}/twoody/Qwen3.5-4B-GGUF/resolve/7e234459682a77fdae11b46591a6e6c37a45a495/mmproj-F16.gguf`,
      bytes: 672_423_488,
      sha256: "d293cd66fd524937c9bd5f37e802d5cdab553eae3d53979a1c02eb6d9e81b6ea",
    },
  },
  {
    id: "Qwen3.5-9B-Q4_K_M",
    name: "Qwen3.5 9B",
    file: "Qwen3.5-9B-Q4_K_M.gguf",
    url: `${HF}/twoody/Qwen3.5-9B-GGUF/resolve/2b317993ff076b9a878324a33400187a41613735/Qwen3.5-9B-Q4_K_M.gguf`,
    bytes: 5_780_090_688,
    sha256: "8c4cc24f54473f3d4e080d4ec7fd2a40d0bbec0f94f3c807cd62694905357d54",
    minRamGb: 16,
    publisher: "Qwen (Alibaba)",
    license: "Apache 2.0",
    recommendable: true,
    vision: {
      url: `${HF}/twoody/Qwen3.5-9B-GGUF/resolve/b647a5938c8cf40d1c3553ddd9bf2892895f0110/mmproj-F16.gguf`,
      bytes: 918_165_888,
      sha256: "2f7ce3652232b91c2220fad23f5b62d110f67e84bd5ed33a7d2bea82f8ee1d26",
    },
  },
  {
    id: "DeepSeek-R1-0528-Qwen3-8B-Q4_K_M",
    name: "DeepSeek-R1 8B",
    file: "DeepSeek-R1-0528-Qwen3-8B-Q4_K_M.gguf",
    url: `${HF}/twoody/DeepSeek-R1-0528-Qwen3-8B-GGUF/resolve/9d92e7c542bdd24e3331a2205fb7525be40787d7/DeepSeek-R1-0528-Qwen3-8B-Q4_K_M.gguf`,
    bytes: 5_027_782_816,
    sha256: "4422f4ed58f2a0d1b4b93067fd312207c2adc326a30f67a3bf9914f889d1d7cc",
    minRamGb: 16,
    publisher: "DeepSeek",
    license: "MIT",
    traits: ["reasoning"],
  },
  // The publishers' own files (Google, Mistral AI, Qwen) or llama.cpp's
  // (ggml-org), each tried with the runtime the app ships — a question, a
  // tool call, an image — before it was pinned here (01/10/2026).
  {
    id: "gemma-4-12b-it-qat-q4_0",
    name: "Gemma 4 12B",
    file: "gemma-4-12b-it-qat-q4_0.gguf",
    url: `${HF}/google/gemma-4-12B-it-qat-q4_0-gguf/resolve/29d097773436b69ff9feafd636ab4cf873786537/gemma-4-12b-it-qat-q4_0.gguf`,
    bytes: 6_975_879_296,
    sha256: "93567e57a8fe10b23569b9d9ec38cd005deedf71e29477c421a4b83f418a538b",
    minRamGb: 16,
    publisher: "Google",
    license: "Apache 2.0",
    vision: {
      url: `${HF}/google/gemma-4-12B-it-qat-q4_0-gguf/resolve/29d097773436b69ff9feafd636ab4cf873786537/mmproj-gemma-4-12b-it-qat-q4_0.gguf`,
      bytes: 175_115_616,
      sha256: "cb018338a7538a9814d994bfe54644c71eb7ed54e31eae2f721e45fd3c260da7",
    },
  },
  {
    id: "Ministral-3-14B-Instruct-2512-Q4_K_M",
    name: "Ministral 3 14B",
    file: "Ministral-3-14B-Instruct-2512-Q4_K_M.gguf",
    url: `${HF}/mistralai/Ministral-3-14B-Instruct-2512-GGUF/resolve/74fac473c43357d7fb2671713608183cc72496d0/Ministral-3-14B-Instruct-2512-Q4_K_M.gguf`,
    bytes: 8_239_593_024,
    sha256: "824e0f3373e69b84f2cae46fdcb9bd1ebc6ab3bfc7acc125d818b7b8178cc613",
    minRamGb: 24,
    publisher: "Mistral AI",
    license: "Apache 2.0",
    vision: {
      url: `${HF}/mistralai/Ministral-3-14B-Instruct-2512-GGUF/resolve/74fac473c43357d7fb2671713608183cc72496d0/Ministral-3-14B-Instruct-2512-BF16-mmproj.gguf`,
      bytes: 879_258_784,
      sha256: "ab7616148b7081030fd38e410c9213ce8346a8b0588291c8ca279058e78cfae7",
    },
  },
  {
    id: "Qwen3-14B-Q4_K_M",
    name: "Qwen3 14B",
    file: "Qwen3-14B-Q4_K_M.gguf",
    url: `${HF}/Qwen/Qwen3-14B-GGUF/resolve/530227a7d994db8eca5ab5ced2fb692b614357fd/Qwen3-14B-Q4_K_M.gguf`,
    bytes: 9_001_752_960,
    sha256: "500a8806e85ee9c83f3ae08420295592451379b4f8cf2d0f41c15dffeb6b81f0",
    minRamGb: 24,
    publisher: "Qwen (Alibaba)",
    license: "Apache 2.0",
  },
  {
    id: "gpt-oss-20b-MXFP4",
    name: "gpt-oss 20B",
    file: "gpt-oss-20b-MXFP4.gguf",
    url: `${HF}/ggml-org/gpt-oss-20b-GGUF/resolve/ef9b12f2ff56c69cf32153a02784e7a3c88bf524/gpt-oss-20b-MXFP4.gguf`,
    bytes: 12_109_566_624,
    sha256: "27cd6c432c7672cb812a92f611cf3ba7bbc35928262bb1e1253ff4ee6ae35901",
    minRamGb: 24,
    publisher: "OpenAI",
    license: "Apache 2.0",
    traits: ["reasoning"],
  },
  {
    id: "gemma-4-26B_q4_0-it",
    name: "Gemma 4 26B (A4B)",
    file: "gemma-4-26B_q4_0-it.gguf",
    url: `${HF}/google/gemma-4-26B-A4B-it-qat-q4_0-gguf/resolve/d1c082be9cf3c8a514acf63b8761f4b41935842e/gemma-4-26B_q4_0-it.gguf`,
    bytes: 14_439_363_584,
    sha256: "3eca3b8f6d7baf218a7dd6bba5fb59a56ee25fe2d567b6f5f589b4f697eca51d",
    minRamGb: 32,
    publisher: "Google",
    license: "Apache 2.0",
    vision: {
      url: `${HF}/google/gemma-4-26B-A4B-it-qat-q4_0-gguf/resolve/d1c082be9cf3c8a514acf63b8761f4b41935842e/gemma-4-26B-it-mmproj.gguf`,
      bytes: 1_194_828_160,
      sha256: "a359953a076b877db30c31dbbb4c6d93b4a6e017ee5db5784247e4d4c0dd4f3b",
    },
  },
];

/// Keep a conservative RAM recommendation on Windows/Linux, including PCs
/// that fall back to CPU. GPU acceleration does not guarantee enough VRAM.
/// macOS uses the catalogue RAM floor.
export function recommendedModel(totalRamBytes: number, catalog: CatalogModel[] = CATALOG, platform: NodeJS.Platform = process.platform): CatalogModel | null {
  if (catalog.length === 0) return null;
  const ramGb = totalRamBytes / 1024 ** 3;
  // The measured models first; any other only when the catalogue has none.
  const candidates = catalog.some((model) => model.recommendable) ? catalog.filter((model) => model.recommendable) : catalog;
  const sorted = [...candidates].sort((a, b) => a.minRamGb - b.minRamGb);
  if (platform !== "darwin" && ramGb + 0.5 < 32) return sorted[0];
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
  return model.minRamGb <= totalRamBytes / 1024 ** 3 + 0.5;
}

export interface CatalogEntryView extends CatalogModel {
  installed: boolean;
  recommended: boolean;
  fits: boolean;
}

/// The catalogue as a model screen shows it (`GET /runtime/catalog`).
export function catalogView(
  models: CatalogModel[],
  installedIds: Iterable<string>,
  totalRamBytes: number,
  platform: NodeJS.Platform = process.platform,
): CatalogEntryView[] {
  const installed = new Set(installedIds);
  const recommended = recommendedModel(totalRamBytes, models, platform)?.id ?? null;
  return models.map((model) => ({
    ...model,
    installed: installed.has(model.id),
    recommended: model.id === recommended,
    fits: modelFits(model, totalRamBytes),
  }));
}
