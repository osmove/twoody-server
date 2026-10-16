// What twoody.com's local LLM calculator knows of the models (twoody-backend
// Marketing::LocalLlm), so that it says what Twoody says: the same catalogue,
// the same memory formula (src/builtin/memory.ts, ported to Ruby there), and
// the same model proposed first for each computer (catalog.ts
// recommendedModel). Nothing in these files is written by hand.
//
//   node --import tsx scripts/site-calculator.ts            write site/twoody-models.json and site/memory-parity.json,
//                                                           and copy both into ../twoody-backend (or --backend <dir>)
//   node --import tsx scripts/site-calculator.ts --check    say which file is not what would be written (exit 1)
//   node --import tsx scripts/site-calculator.ts --refresh  fetch site/site-models.json again from Hugging Face, then write
//
// - site/twoody-models.json (the backend's config/twoody_models.json): each
//   model of the catalogue as Twoody runs it — its file, its vision file, its
//   MLX weights, the figures memory.ts reads (KV cache, sliding windows,
//   recurrent state), the memory from which it fits (minRamGb) — the
//   constants of memory.ts, and the models the calculator shows that Twoody
//   does not offer (« Pas dans le catalogue de Twoody »), verified the same
//   way as the catalogue and computed with the same formula.
// - site/memory-parity.json (the backend's
//   test/fixtures/files/twoody_memory_parity.json): what memory.ts and
//   recommendedModel() answer for every model over a grid of computers; the
//   backend's test/services/marketing/local_llm/memory_parity_test.rb checks
//   that its port answers the same.
// - site/site-models.json (fetched, --refresh): what the site needs beyond
//   the catalogue — the layer and expert counts of each catalogue model,
//   read from the config.json its memory figures came from (the calculator's
//   speed estimate needs them), the languages its publisher's card declares,
//   and the models of SITE_ONLY.
//
// test/siteCalculator.test.ts fails when site/twoody-models.json or
// site/memory-parity.json is not what this script writes now — memory.ts,
// recommendedModel() or the catalogue changed: run it, then commit here and
// in twoody-backend — and when a catalogue model has no layer count (run
// --refresh).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CATALOG, CATALOG_VERIFIED_AT, recommendedModel, VRAM_FOR_9B_BYTES } from "../src/builtin/catalog.js";
import type { MemoryFigures } from "../src/builtin/catalogTypes.js";
import { catalogMemoryNeed, gpuShare, MEMORY_SIZES_GB, minRamFor, Q8_0_FACTOR, twoodyContext, VISION_BUFFERS_BYTES, WORK_BUFFERS_BYTES } from "../src/builtin/memory.js";
// A plain ES module (no types): the helpers the catalogue is verified with.
import { architectureFigures, capabilities, licenseOf, repoConfig, repoInfo, SOURCES } from "./model-catalog.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SITE_DIR = join(ROOT, "site");
export const FILES = {
  models: "twoody-models.json",
  parity: "memory-parity.json",
  fetched: "site-models.json",
} as const;
/// Where the backend keeps its copies, relative to its root.
export const BACKEND_FILES = {
  models: "config/twoody_models.json",
  parity: "test/fixtures/files/twoody_memory_parity.json",
} as const;
export const BACKEND_DIR = resolve(ROOT, "..", "twoody-backend");

const GIB = 1024 ** 3;
const HF = "https://huggingface.co";

// ── The models the calculator shows that Twoody does not offer ──────────
// Larger than any computer most people have, or a 4-bit file split in parts
// (the app's downloader takes one file): the calculator still says what
// they would need, with the same formula, for the Macs and PCs that hold
// them. The same choices as the catalogue's SOURCES: the publisher's GGUF,
// else ggml-org's, else bartowski's; Q4_K_M (MXFP4 for gpt-oss), with the
// vision file (f16) Twoody would install beside a model that reads images.
// Kept from the calculator before 16/10/2026; Qwen3 0.6B, 1.7B, 4B and
// 30B-A3B were dropped then: the catalogue has their successors (Qwen3.5
// 0.8B and 2B, Qwen3 4B and 30B-A3B 2507).

interface SiteOnlySource {
  key: string;
  name: string;
  family: string;
  publisher: string;
  base: string;
  gguf: { repo: string; file: string | RegExp; mmproj?: RegExp };
  uses: string[];
}

export const SITE_ONLY: SiteOnlySource[] = [
  { key: "qwen3-next-80b-a3b", name: "Qwen3-Next 80B-A3B", family: "qwen", publisher: "Qwen (Alibaba)", base: "Qwen/Qwen3-Next-80B-A3B-Instruct",
    gguf: { repo: "Qwen/Qwen3-Next-80B-A3B-Instruct-GGUF", file: "Qwen3-Next-80B-A3B-Instruct-Q4_K_M.gguf" }, uses: ["general"] },
  { key: "qwen3.5-122b-a10b", name: "Qwen3.5 122B-A10B", family: "qwen", publisher: "Qwen (Alibaba)", base: "Qwen/Qwen3.5-122B-A10B",
    gguf: { repo: "bartowski/Qwen_Qwen3.5-122B-A10B-GGUF", file: /\/Qwen_Qwen3\.5-122B-A10B-Q4_K_M-\d{5}-of-\d{5}\.gguf$/, mmproj: /^mmproj-.*-f16\.gguf$/ }, uses: ["general", "code"] },
  { key: "qwen3-235b-a22b-instruct-2507", name: "Qwen3 235B-A22B Instruct 2507", family: "qwen", publisher: "Qwen (Alibaba)", base: "Qwen/Qwen3-235B-A22B-Instruct-2507",
    gguf: { repo: "bartowski/Qwen_Qwen3-235B-A22B-Instruct-2507-GGUF", file: /\/Qwen_Qwen3-235B-A22B-Instruct-2507-Q4_K_M-\d{5}-of-\d{5}\.gguf$/ }, uses: ["general", "code"] },
  { key: "gpt-oss-120b", name: "gpt-oss 120B", family: "gpt-oss", publisher: "OpenAI", base: "openai/gpt-oss-120b",
    gguf: { repo: "ggml-org/gpt-oss-120b-GGUF", file: "gpt-oss-120b-MXFP4.gguf" }, uses: ["reasoning", "code"] },
  { key: "mistral-small-4-119b", name: "Mistral Small 4 119B", family: "mistral", publisher: "Mistral AI", base: "mistralai/Mistral-Small-4-119B-2603",
    gguf: { repo: "bartowski/mistralai_Mistral-Small-4-119B-2603-GGUF", file: /\/mistralai_Mistral-Small-4-119B-2603-Q4_K_M-\d{5}-of-\d{5}\.gguf$/, mmproj: /^mmproj-.*-f16\.gguf$/ }, uses: ["general"] },
];

// ── What --refresh fetches ───────────────────────────────────────────────

/// How a model's layers are made, from its config.json: the calculator's
/// speed estimate reads each layer once a token, and only the active experts
/// of a mixture of experts.
export interface Architecture {
  layers: number;
  /// Routed experts of a layer (0: a dense model).
  experts: number;
  /// Experts at work for each token.
  expertsPerToken: number;
  /// The config.json read: "<repository>@<revision>".
  config: string;
  /// The languages its publisher's card declares (Hugging Face `language`),
  /// or null when it declares none.
  languages: string[] | null;
}

export interface SiteOnlyModel {
  key: string;
  name: string;
  family: string;
  publisher: string;
  base: string;
  repo: string;
  revision: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
  bytes: number;
  vision: { path: string; bytes: number; sha256: string } | null;
  quant: string;
  quantizer: string;
  license: string;
  licenseKind: "open" | "restricted";
  licenseUrl: string;
  paramsB: number | null;
  contextLength: number | null;
  capabilities: { tools: boolean; vision: boolean; reasoning: boolean };
  uses: string[];
  memory: MemoryFigures;
  architecture: Architecture;
}

export interface SiteFetched {
  fetchedAt: string;
  architectures: Record<string, Architecture>;
  models: SiteOnlyModel[];
}

type Config = Record<string, unknown> & { text_config?: Record<string, unknown>; llm_config?: Record<string, unknown> };

function architectureOf(config: Config, from: string, base: { cardData?: { language?: unknown } }): Architecture {
  const t = (config.text_config ?? config.llm_config ?? config) as Record<string, number | null | undefined>;
  const figures = architectureFigures(config) as { layers: number };
  const experts = Number(t.num_experts ?? t.num_local_experts ?? t.n_routed_experts ?? 0) || 0;
  const expertsPerToken = Number(t.num_experts_per_tok ?? t.experts_per_token ?? t.top_k_experts ?? 0) || 0;
  const language = base.cardData?.language;
  const languages = Array.isArray(language) ? language.map(String) : typeof language === "string" ? [language] : null;
  return { layers: figures.layers, experts, expertsPerToken: experts > 0 ? expertsPerToken : 0, config: from, languages };
}

/// The config.json the catalogue read a model's memory figures from
/// (model-catalog.mjs verify): its MLX folder's at the pinned revision, else
/// its publisher's repository. The figures must come out the same, or this
/// is not the same file.
async function catalogueArchitecture(entry: (typeof CATALOG)[number]): Promise<Architecture> {
  const source = (SOURCES as Array<{ key: string; base: string }>).find((candidate) => candidate.key === entry.key);
  if (!source) throw new Error(`${entry.key}: not in model-catalog.mjs SOURCES`);
  let config: Config | null = null;
  let from = "";
  const base = await repoInfo(source.base);
  if (entry.mlx) {
    config = await repoConfig(entry.mlx.repo, entry.mlx.revision);
    from = `${entry.mlx.repo}@${entry.mlx.revision}`;
  }
  if (!config) {
    if (!base.gated) {
      config = await repoConfig(source.base, base.sha);
      from = `${source.base}@${base.sha}`;
    }
  }
  if (!config) throw new Error(`${entry.key}: no config.json`);
  const figures = architectureFigures(config) as MemoryFigures & { swa: MemoryFigures["swa"] | null };
  const same = figures.kvBytesPerToken === entry.memory?.kvBytesPerToken && figures.stateBytes === entry.memory?.stateBytes && figures.hybrid === entry.memory?.hybrid;
  if (!same) throw new Error(`${entry.key}: ${from} gives other memory figures than the catalogue's`);
  return architectureOf(config, from, base);
}

async function siteOnlyModel(source: SiteOnlySource): Promise<SiteOnlyModel> {
  const what = source.key;
  const base = await repoInfo(source.base);
  const { license, licenseKind, licenseUrl } = licenseOf(base, what);
  const main = await repoInfo(source.gguf.repo);
  const revision: string = main.sha;
  const siblings = main.siblings as Array<{ rfilename: string; size: number; lfs?: { sha256: string } }>;
  const wanted = source.gguf.file;
  const parts = siblings.filter((file) => (typeof wanted === "string" ? file.rfilename === wanted : wanted.test(file.rfilename))).sort((a, b) => a.rfilename.localeCompare(b.rfilename));
  if (parts.length === 0) throw new Error(`${what}: no file matches ${wanted}`);
  const count = Number(parts[0]!.rfilename.match(/-of-(\d{5})\.gguf$/)?.[1] ?? 1);
  if (parts.length !== count) throw new Error(`${what}: ${parts.length} parts found, ${count} expected`);
  for (const part of parts) if (!part.lfs?.sha256 || !part.size) throw new Error(`${what}: ${part.rfilename} has no size or SHA-256`);
  let vision: SiteOnlyModel["vision"] = null;
  if (source.gguf.mmproj) {
    const candidates = siblings.filter((file) => source.gguf.mmproj!.test(file.rfilename)).sort((a, b) => a.rfilename.length - b.rfilename.length);
    const file = candidates[0];
    if (!file?.lfs?.sha256) throw new Error(`${what}: no vision file`);
    vision = { path: file.rfilename, bytes: file.size, sha256: file.lfs.sha256 };
  }
  const config = (await repoConfig(source.base, base.sha)) as Config | null;
  if (!config) throw new Error(`${what}: no config.json in ${source.base}`);
  const figures = architectureFigures(config) as { kvBytesPerToken: number; swa: { bytesPerToken: number; window: number } | null; stateBytes: number; hybrid: boolean; context: number | null };
  const params = base.safetensors?.total ?? main.gguf?.total ?? null;
  const template = main.gguf?.chat_template ?? null;
  const fileName = parts[0]!.rfilename;
  return {
    key: source.key,
    name: source.name,
    family: source.family,
    publisher: source.publisher,
    base: source.base,
    repo: source.gguf.repo,
    revision,
    files: parts.map((part) => ({ path: part.rfilename, bytes: part.size, sha256: part.lfs!.sha256 })),
    bytes: parts.reduce((sum, part) => sum + part.size, 0),
    vision,
    quant: /MXFP4/i.test(fileName) ? "MXFP4" : (fileName.match(/(I?Q\d_[A-Z0-9_]+?)(?:-\d{5}-of-\d{5})?\.gguf$/)?.[1] ?? "?"),
    quantizer: source.gguf.repo.split("/")[0]!,
    license,
    licenseKind,
    licenseUrl,
    paramsB: params ? Math.round(params / 1e8) / 10 : null,
    contextLength: figures.context ?? null,
    capabilities: capabilities(template, source, !!vision),
    uses: [...new Set([...source.uses, ...(vision ? ["vision"] : [])])],
    memory: { kvBytesPerToken: figures.kvBytesPerToken, ...(figures.swa ? { swa: figures.swa } : {}), stateBytes: figures.stateBytes, hybrid: figures.hybrid },
    architecture: architectureOf(config, `${source.base}@${base.sha}`, base),
  };
}

async function refresh(): Promise<SiteFetched> {
  const architectures: Record<string, Architecture> = {};
  for (const entry of CATALOG) {
    architectures[entry.key!] = await catalogueArchitecture(entry);
    process.stderr.write(`ok   ${entry.key}\n`);
  }
  const models: SiteOnlyModel[] = [];
  for (const source of SITE_ONLY) {
    models.push(await siteOnlyModel(source));
    process.stderr.write(`ok   ${source.key} (not in the catalogue)\n`);
  }
  return { fetchedAt: new Date().toISOString().slice(0, 10), architectures, models };
}

// ── What the site reads (offline) ────────────────────────────────────────

export function readFetched(dir = SITE_DIR): SiteFetched {
  const parsed = JSON.parse(readFileSync(join(dir, FILES.fetched), "utf8")) as SiteFetched & { note?: string };
  return { fetchedAt: parsed.fetchedAt, architectures: parsed.architectures, models: parsed.models };
}

/// An entry memory.ts can size: a catalogue model, or one of SITE_ONLY.
interface Sized {
  bytes: number;
  vision?: { bytes: number } | null;
  memory: MemoryFigures;
  mlx?: { weightsBytes: number } | null;
}

interface SiteModel {
  key: string;
  inCatalogue: boolean;
  sized: Sized;
  exported: Record<string, unknown>;
}

function memoryJson(figures: MemoryFigures) {
  return {
    kv_bytes_per_token: figures.kvBytesPerToken,
    swa: figures.swa ? { bytes_per_token: figures.swa.bytesPerToken, window: figures.swa.window } : null,
    state_bytes: figures.stateBytes,
    hybrid: figures.hybrid,
  };
}

function architectureJson(architecture: Architecture) {
  return { layers: architecture.layers, experts: architecture.experts, experts_per_token: architecture.expertsPerToken, languages: architecture.languages };
}

/// Every model of the calculator: the catalogue's, in its order, then SITE_ONLY's.
export function siteModels(fetched: SiteFetched): SiteModel[] {
  const sources = new Map((SOURCES as Array<{ key: string; base: string }>).map((source) => [source.key, source]));
  const catalogue = CATALOG.map((entry): SiteModel => {
    const architecture = fetched.architectures[entry.key!];
    if (!architecture) throw new Error(`${entry.key}: no layer count in site/${FILES.fetched} — run scripts/site-calculator.ts --refresh`);
    const base = sources.get(entry.key!)?.base;
    if (!base) throw new Error(`${entry.key}: not in model-catalog.mjs SOURCES`);
    return {
      key: entry.key!,
      inCatalogue: true,
      sized: entry as Sized,
      exported: {
        key: entry.key,
        id: entry.id,
        name: entry.name,
        family: entry.family,
        publisher: entry.publisher,
        in_catalogue: true,
        recommendable: entry.recommendable === true,
        larger: entry.larger === true,
        base,
        quant: entry.quant,
        quantizer: entry.quantizer,
        license: entry.license,
        license_kind: entry.licenseKind,
        params_b: entry.paramsB ?? null,
        context_length: entry.contextLength ?? null,
        bytes: entry.bytes,
        vision_bytes: entry.vision?.bytes ?? null,
        mlx_weights_bytes: entry.mlx?.weightsBytes ?? null,
        memory: memoryJson(entry.memory!),
        min_ram_gb: entry.minRamGb,
        capabilities: entry.capabilities,
        uses: entry.uses,
        ...architectureJson(architecture),
      },
    };
  });
  const others = fetched.models.map((model): SiteModel => {
    const sized: Sized = { bytes: model.bytes, vision: model.vision, memory: model.memory, mlx: null };
    return {
      key: model.key,
      inCatalogue: false,
      sized,
      exported: {
        key: model.key,
        id: null,
        name: model.name,
        family: model.family,
        publisher: model.publisher,
        in_catalogue: false,
        recommendable: false,
        larger: false,
        base: model.base,
        quant: model.quant,
        quantizer: model.quantizer,
        license: model.license,
        license_kind: model.licenseKind,
        params_b: model.paramsB,
        context_length: model.contextLength,
        bytes: model.bytes,
        vision_bytes: model.vision?.bytes ?? null,
        mlx_weights_bytes: null,
        memory: memoryJson(model.memory),
        // What the app would say of it: the smallest memory where the need
        // fits what the GPU may use (memory.ts minRamFor).
        min_ram_gb: minRamFor(sized),
        capabilities: model.capabilities,
        uses: model.uses,
        ...architectureJson(model.architecture),
        files: model.files.map((file) => `${HF}/${model.repo}/resolve/${model.revision}/${file.path}`),
      },
    };
  });
  const keys = new Set<string>();
  for (const model of [...catalogue, ...others]) {
    if (keys.has(model.key)) throw new Error(`${model.key}: twice`);
    keys.add(model.key);
  }
  return [...catalogue, ...others];
}

export function buildModels(fetched: SiteFetched) {
  return {
    note: "Written by twoody-server scripts/site-calculator.ts from src/builtin/catalogData.ts, memory.ts and site/site-models.json — do not edit; run the script again (twoody-backend keeps a byte-for-byte copy as config/twoody_models.json).",
    catalogue_verified_at: CATALOG_VERIFIED_AT,
    fetched_at: fetched.fetchedAt,
    formula: {
      work_buffers_bytes: WORK_BUFFERS_BYTES,
      vision_buffers_bytes: VISION_BUFFERS_BYTES,
      q8_0_factor: Q8_0_FACTOR,
      memory_sizes_gb: MEMORY_SIZES_GB,
      vram_for_9b_bytes: VRAM_FOR_9B_BYTES,
    },
    models: siteModels(fetched).map((model) => model.exported),
  };
}

// The grid of the parity fixture: memory as a computer reports it (GiB),
// around each threshold of twoodyContext, gpuShare and recommendedModel.
export const PARITY_MEMORY_GIB = [4, 8, 12, 14.9, 15, 15.4, 15.5, 15.9, 16, 18, 24, 30.9, 31, 31.4, 31.5, 32, 36, 48, 64, 96, 128, 192, 256, 512];
// The computers recommendedModel() is asked about. The Desktop measures a
// graphics card of its own on Windows only (builtinRuntime.ts
// builtinGpuMemory); the function itself is asked about the others too.
export const PARITY_MACHINES: Array<{ platform: NodeJS.Platform; arch: string; vramGib: number | null }> = [
  { platform: "darwin", arch: "arm64", vramGib: null },
  { platform: "darwin", arch: "x64", vramGib: null },
  { platform: "win32", arch: "x64", vramGib: null },
  { platform: "win32", arch: "x64", vramGib: 8 },
  { platform: "win32", arch: "x64", vramGib: 9.4 },
  { platform: "win32", arch: "x64", vramGib: 9.5 },
  { platform: "win32", arch: "x64", vramGib: 10 },
  { platform: "win32", arch: "x64", vramGib: 24 },
  { platform: "linux", arch: "x64", vramGib: null },
  { platform: "linux", arch: "x64", vramGib: 12 },
];

export function buildParity(fetched: SiteFetched) {
  const models: Record<string, unknown> = {};
  for (const model of siteModels(fetched)) {
    const sized = model.sized;
    models[model.key] = {
      context: PARITY_MEMORY_GIB.map((gib) => twoodyContext({ hybrid: sized.memory.hybrid, totalMemory: gib * GIB })),
      llamacpp: PARITY_MEMORY_GIB.map((gib) => catalogMemoryNeed(sized, gib * GIB)),
      mlx: sized.mlx ? PARITY_MEMORY_GIB.map((gib) => catalogMemoryNeed(sized, gib * GIB, "mlx")) : null,
      min_ram_for: minRamFor(sized),
      min_ram_for_mlx: sized.mlx ? minRamFor(sized, "mlx") : null,
    };
  }
  const recommended = PARITY_MACHINES.flatMap((machine) =>
    PARITY_MEMORY_GIB.map((gib) => ({
      memory_gib: gib,
      platform: machine.platform,
      arch: machine.arch,
      vram_bytes: machine.vramGib === null ? null : machine.vramGib * GIB,
      key: recommendedModel(gib * GIB, CATALOG, machine.platform, { arch: machine.arch, dedicatedVramBytes: machine.vramGib === null ? null : machine.vramGib * GIB })?.key ?? null,
    })),
  );
  return {
    note: "Written by twoody-server scripts/site-calculator.ts: what src/builtin/memory.ts and catalog.ts recommendedModel() answer, in bytes, for each model of site/twoody-models.json over a grid of computers (memory_gib as a computer reports it) — do not edit; run the script again (twoody-backend keeps a byte-for-byte copy as test/fixtures/files/twoody_memory_parity.json).",
    memory_gib: PARITY_MEMORY_GIB,
    gpu_share: [...MEMORY_SIZES_GB, 512].map((gb) => [gb, gpuShare(gb)]),
    models,
    recommended,
  };
}

// ── Writing ──────────────────────────────────────────────────────────────

/// JSON with one model, one fixture row, per line: readable in a diff,
/// without a line per number.
export function render(value: Record<string, unknown>): string {
  const lines = Object.entries(value).map(([key, item]) => {
    if (Array.isArray(item) && item.length > 0 && typeof item[0] === "object" && item[0] !== null && !Array.isArray(item[0])) {
      return `  ${JSON.stringify(key)}: [\n${item.map((row) => `    ${JSON.stringify(row)}`).join(",\n")}\n  ]`;
    }
    if (item && typeof item === "object" && !Array.isArray(item) && Object.values(item).every((inner) => inner && typeof inner === "object")) {
      const inner = Object.entries(item).map(([name, row]) => `    ${JSON.stringify(name)}: ${JSON.stringify(row)}`);
      return `  ${JSON.stringify(key)}: {\n${inner.join(",\n")}\n  }`;
    }
    return `  ${JSON.stringify(key)}: ${JSON.stringify(item)}`;
  });
  return `{\n${lines.join(",\n")}\n}\n`;
}

export function renderFetched(fetched: SiteFetched): string {
  return render({
    note: "Fetched from the Hugging Face API by twoody-server scripts/site-calculator.ts --refresh — do not edit by hand. architectures: the layer and expert counts of each catalogue model, from the config.json its memory figures were read from; models: the calculator's models that are not in the catalogue (SITE_ONLY), each file at a pinned revision.",
    fetchedAt: fetched.fetchedAt,
    architectures: fetched.architectures,
    models: fetched.models as unknown as Record<string, unknown>[],
  });
}

export function outputs(fetched: SiteFetched): Record<keyof typeof BACKEND_FILES, string> {
  return { models: render(buildModels(fetched)), parity: render(buildParity(fetched)) };
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const backendIndex = args.indexOf("--backend");
  const backend = backendIndex >= 0 ? resolve(args[backendIndex + 1]!) : BACKEND_DIR;
  mkdirSync(SITE_DIR, { recursive: true });
  if (args.includes("--refresh")) {
    const fetched = await refresh();
    writeFileSync(join(SITE_DIR, FILES.fetched), renderFetched(fetched));
    console.log(`wrote site/${FILES.fetched}: ${Object.keys(fetched.architectures).length} catalogue models, ${fetched.models.length} others`);
  }
  const written = outputs(readFetched());
  let stale = 0;
  for (const name of ["models", "parity"] as const) {
    const targets = [join(SITE_DIR, FILES[name])];
    if (existsSync(join(backend, "config"))) targets.push(join(backend, BACKEND_FILES[name]));
    else if (backendIndex >= 0) throw new Error(`${backend} is not a twoody-backend checkout`);
    for (const target of targets) {
      const current = existsSync(target) ? readFileSync(target, "utf8") : null;
      if (current === written[name]) continue;
      stale += 1;
      if (check) console.error(`${target} is not what scripts/site-calculator.ts writes`);
      else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, written[name]);
        console.log(`wrote ${target}`);
      }
    }
  }
  if (stale === 0) console.log("site/ and twoody-backend's copies are up to date");
  if (check && stale > 0) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
