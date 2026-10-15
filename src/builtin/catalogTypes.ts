// What scripts/model-catalog.mjs verified for each model of the catalogue
// (catalogData.ts), as catalog.ts reads it. No import: catalogData.ts is
// generated, and both the server and the Desktop (a byte-for-byte copy, the
// Desktop's scripts/sync-builtin.mjs) compile it.

/// What a model is for, as the model screen filters it.
export type ModelUse = "general" | "code" | "reasoning" | "vision" | "small";

/// Families the model screen groups and filters by.
export type ModelFamily = "qwen" | "glm" | "deepseek" | "gemma" | "mistral" | "llama" | "phi" | "gpt-oss" | "nemotron" | "other";

/// What a model's memory takes besides its weights, from its config.json
/// (memory.ts turns it into bytes for a context and a cache type).
export interface MemoryFigures {
  /// KV cache, f16, a token, over the layers that keep the whole conversation.
  kvBytesPerToken: number;
  /// Sliding-window layers: their KV cache a token (f16) and their window.
  swa?: { bytesPerToken: number; window: number };
  /// Recurrent state (linear attention, Mamba, short convolutions): the
  /// same whatever the length.
  stateBytes: number;
  /// Has recurrent layers: llama.cpp runs it with a q8_0 cache and a longer
  /// window in Twoody (runtimeArgs.ts in the Desktop).
  hybrid: boolean;
}

/// One file of an MLX folder: SHA-256 for the large files (Git LFS), git's
/// own object id (SHA-1 of "blob <size>\0" and the content) for the small
/// text files, both as Hugging Face lists them at the pinned revision.
export interface MlxFile {
  path: string;
  bytes: number;
  sha256?: string;
  gitSha1?: string;
}

/// The same model for MLX on a Mac with Apple silicon (Twoody's MLX engine,
/// twoody-desktop docs/mlx-engine.md): a folder of safetensors and
/// configuration files, never code.
export interface MlxVariant {
  /// The folder's name on disk, and what the MLX engine lists the model as.
  id: string;
  repo: string;
  revision: string;
  /// Every file together.
  bytes: number;
  /// The weights alone (the safetensors files).
  weightsBytes: number;
  files: MlxFile[];
}

export interface VerifiedModel {
  /// Stable key of the entry, across quantisations and engines.
  key: string;
  /// The GGUF file's name on disk without ".gguf": what llama.cpp lists.
  id: string;
  name: string;
  family: ModelFamily;
  publisher: string;
  file: string;
  url: string;
  bytes: number;
  sha256: string;
  vision?: { url: string; bytes: number; sha256: string };
  /// Who made the GGUF file (the repository's owner).
  quantizer: string;
  quant: string;
  license: string;
  /// "restricted": usable, commercial use included, with conditions the
  /// screen points to (Llama, Gemma, NVIDIA, LFM, DeepSeek licences).
  licenseKind: "open" | "restricted";
  licenseUrl: string;
  paramsB: number | null;
  contextLength: number | null;
  capabilities: { tools: boolean; vision: boolean; reasoning: boolean };
  uses: ModelUse[];
  memory: MemoryFigures;
  minRamGb?: number;
  recommendable?: boolean;
  larger?: boolean;
  mlx?: MlxVariant;
}
