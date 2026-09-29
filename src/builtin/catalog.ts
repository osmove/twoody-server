import { readFileSync } from "node:fs";

// The models Twoody offers to install, for the built-in runtime
// (llama.cpp's server, see manager.ts). Ported from
// twoody-desktop/src/main/modelCatalog.ts: same entries, same pins.
//
// A short list on purpose: one good general model per class of machine,
// in a quantisation that keeps most of the quality (Q4_K_M). Publishers
// no longer put GGUF files out (Qwen stopped with Qwen3.5), and the ones
// that circulate come mostly from Twoody's competitors (Unsloth, LM
// Studio's community): these files are Osmove's, converted from the
// publisher's own weights with the llama.cpp release the app ships
// (scripts/convert-model.sh, reproducible to the byte) and published under
// huggingface.co/twoody (scripts/publish-model.sh). Each entry is pinned —
// repository revision, size, SHA-256 — so what gets installed is exactly
// what was tried, and a corrupted or substituted file is refused.
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
}

const HF = "https://huggingface.co";

export const CATALOG: CatalogModel[] = [
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
  },
];

/// Keep a conservative RAM recommendation on Windows/Linux, including PCs
/// that fall back to CPU. GPU acceleration does not guarantee enough VRAM.
/// macOS uses the catalogue RAM floor.
export function recommendedModel(totalRamBytes: number, catalog: CatalogModel[] = CATALOG, platform: NodeJS.Platform = process.platform): CatalogModel | null {
  if (catalog.length === 0) return null;
  const ramGb = totalRamBytes / 1024 ** 3;
  const sorted = [...catalog].sort((a, b) => a.minRamGb - b.minRamGb);
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
    typeof model.minRamGb === "number"
  );
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
      .filter((model) => isAllowedDownloadUrl(model.url, true))
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
