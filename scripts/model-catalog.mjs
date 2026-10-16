#!/usr/bin/env node
// The verified model catalogue: every model Twoody offers to install, checked
// against the Hugging Face API — the repository, the exact file at a pinned
// revision, its size and SHA-256, its vision file, the matching MLX folder for
// a Mac with Apple silicon, the licence, the context length, and what the
// model needs in memory (src/builtin/memory.ts).
//
//   node scripts/model-catalog.mjs            fetch every entry, write src/builtin/catalogData.ts
//   node scripts/model-catalog.mjs --check    fetch again and compare: exit 1 when anything moved
//   node scripts/model-catalog.mjs --table    print the table (markdown) of what is written
//   node scripts/model-catalog.mjs --only qwen3.5-9b,gemma-4-e4b   refresh some entries, keep the others
//
// Nothing here is written by hand but the choices below (SOURCES): which
// model, from which repository, which quantisation. Sizes, digests, licences,
// context lengths and the architecture figures come from the API and the
// repositories' own config.json; an entry whose file is not found makes the
// run fail, never a guess. A new revision of a repository is not followed
// silently: --check says so, and a refresh pins it.
//
// Then, in twoody-desktop: `node scripts/sync-builtin.mjs` (the Desktop keeps
// a byte-for-byte copy of src/builtin/); and here, `node --import tsx
// scripts/site-calculator.ts` (twoody.com's calculator copies the catalogue
// and what memory.ts makes of it; that script reuses the helpers exported
// below).
//
// Quantisers, in this order (catalog.ts): the publisher's own GGUF, llama.cpp's
// (ggml-org), Osmove's conversions (huggingface.co/twoody), then bartowski
// (imatrix quantisations); unsloth or lmstudio-community only where none of
// these has the model. MLX: the publisher's own MLX folder, else
// mlx-community's 4-bit conversion.
//
// Licences: open (Apache 2.0, MIT…), « restricted » (usable, commercial use
// included, but with conditions the screen names: Llama, Gemma, NVIDIA, LFM),
// and none that forbids what Twoody is for (non-commercial, research only):
// those are refused here (FORBIDDEN_LICENSES).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src", "builtin", "catalogData.ts");
const HF = "https://huggingface.co";

// ── The choices ─────────────────────────────────────────────────────────
// `id`: the file's name on disk without ".gguf" — kept for the models
// already offered, since installed files are known by it. `gguf.revision`:
// pinned for those already offered; a new entry takes the revision of the
// day. `uses`: general, code, reasoning, vision, small.

export const SOURCES = [
  // Qwen (Alibaba)
  { key: "qwen3.5-0.8b", id: "Qwen3.5-0.8B-Q4_K_M", name: "Qwen3.5 0.8B", family: "qwen", publisher: "Qwen (Alibaba)", base: "Qwen/Qwen3.5-0.8B",
    gguf: { repo: "bartowski/Qwen_Qwen3.5-0.8B-GGUF", file: /Q4_K_M\.gguf$/, mmproj: /mmproj.*-f16\.gguf$/i }, mlx: { repo: "mlx-community/Qwen3.5-0.8B-MLX-4bit" }, uses: ["general", "small"] },
  { key: "qwen3.5-2b", id: "Qwen3.5-2B-Q4_K_M", name: "Qwen3.5 2B", family: "qwen", publisher: "Qwen (Alibaba)", base: "Qwen/Qwen3.5-2B",
    gguf: { repo: "bartowski/Qwen_Qwen3.5-2B-GGUF", file: /Q4_K_M\.gguf$/, mmproj: /mmproj.*f16\.gguf$/i }, mlx: { repo: "mlx-community/Qwen3.5-2B-MLX-4bit" }, uses: ["general", "small"] },
  { key: "qwen3.5-4b", id: "Qwen3.5-4B-Q4_K_M", name: "Qwen3.5 4B", family: "qwen", publisher: "Qwen (Alibaba)", base: "Qwen/Qwen3.5-4B",
    gguf: { repo: "twoody/Qwen3.5-4B-GGUF", revision: "d741a25c4cf8eea74fe876af7631b659b366f126", file: "Qwen3.5-4B-Q4_K_M.gguf",
      mmproj: { revision: "7e234459682a77fdae11b46591a6e6c37a45a495", file: "mmproj-F16.gguf" } },
    mlx: { repo: "mlx-community/Qwen3.5-4B-MLX-4bit" }, uses: ["general", "small"], recommendable: true, minRamGb: 8 },
  { key: "qwen3.5-9b", id: "Qwen3.5-9B-Q4_K_M", name: "Qwen3.5 9B", family: "qwen", publisher: "Qwen (Alibaba)", base: "Qwen/Qwen3.5-9B",
    gguf: { repo: "twoody/Qwen3.5-9B-GGUF", revision: "2b317993ff076b9a878324a33400187a41613735", file: "Qwen3.5-9B-Q4_K_M.gguf",
      mmproj: { revision: "b647a5938c8cf40d1c3553ddd9bf2892895f0110", file: "mmproj-F16.gguf" } },
    mlx: { repo: "mlx-community/Qwen3.5-9B-MLX-4bit" }, uses: ["general"], recommendable: true, minRamGb: 16 },
  { key: "qwen3.5-27b", id: "Qwen3.5-27B-Q4_K_M", name: "Qwen3.5 27B", family: "qwen", publisher: "Qwen (Alibaba)", base: "Qwen/Qwen3.5-27B",
    gguf: { repo: "bartowski/Qwen_Qwen3.5-27B-GGUF", file: /Q4_K_M\.gguf$/, mmproj: /mmproj.*f16\.gguf$/i }, mlx: { repo: "mlx-community/Qwen3.5-27B-4bit" }, uses: ["general", "reasoning"] },
  { key: "qwen3.5-35b-a3b", id: "Qwen3.5-35B-A3B-Q4_K_M", name: "Qwen3.5 35B-A3B", family: "qwen", publisher: "Qwen (Alibaba)", base: "Qwen/Qwen3.5-35B-A3B",
    gguf: { repo: "bartowski/Qwen_Qwen3.5-35B-A3B-GGUF", file: /Q4_K_M\.gguf$/, mmproj: /mmproj.*-f16\.gguf$/i }, mlx: { repo: "mlx-community/Qwen3.5-35B-A3B-4bit" }, uses: ["general"] },
  { key: "qwen3.6-27b", id: "Qwen3.6-27B-Q4_K_M", name: "Qwen3.6 27B", family: "qwen", publisher: "Qwen (Alibaba)", base: "Qwen/Qwen3.6-27B",
    gguf: { repo: "ggml-org/Qwen3.6-27B-GGUF", file: /Q4_K_M\.gguf$/, mmproj: /mmproj.*f16\.gguf$/i }, mlx: { repo: "mlx-community/Qwen3.6-27B-4bit" }, uses: ["general", "code", "reasoning"] },
  { key: "qwen3.6-35b-a3b-iq3", id: "Qwen3.6-35B-A3B-IQ3_XXS", name: "Qwen3.6 35B-A3B", family: "qwen", publisher: "Qwen (Alibaba)", base: "Qwen/Qwen3.6-35B-A3B",
    gguf: { repo: "bartowski/Qwen_Qwen3.6-35B-A3B-GGUF", revision: "5c2410d71524f4f72b023ce8daf7a80528226d5f", file: "Qwen_Qwen3.6-35B-A3B-IQ3_XXS.gguf",
      mmproj: { revision: "5c2410d71524f4f72b023ce8daf7a80528226d5f", file: "mmproj-Qwen_Qwen3.6-35B-A3B-f16.gguf" } },
    uses: ["general", "code"], recommendable: true, larger: true, minRamGb: 24, quant: "3 bits" },
  { key: "qwen3.6-35b-a3b", id: "Qwen3.6-35B-A3B-Q4_K_M", name: "Qwen3.6 35B-A3B (4 bits)", family: "qwen", publisher: "Qwen (Alibaba)", base: "Qwen/Qwen3.6-35B-A3B",
    gguf: { repo: "ggml-org/Qwen3.6-35B-A3B-GGUF", file: /Q4_K_M\.gguf$/, mmproj: /mmproj.*f16\.gguf$/i }, mlx: { repo: "mlx-community/Qwen3.6-35B-A3B-4bit" }, uses: ["general", "code"] },
  { key: "qwen3.8-27b", id: "Qwen3.8-27B-Q4_K_M", name: "Qwen3.8 27B", family: "qwen", publisher: "Qwen (Alibaba)", base: "Qwen/Qwen3.8-27B",
    gguf: { repo: "ggml-org/Qwen3.8-27B-GGUF", file: /Q4_K_M\.gguf$/, mmproj: /mmproj.*f16\.gguf$/i }, mlx: { repo: "mlx-community/Qwen3.8-27B-4bit" }, uses: ["general", "code", "reasoning"] },
  { key: "qwen3-4b-instruct-2507", id: "Qwen3-4B-Instruct-2507-Q4_K_M", name: "Qwen3 4B Instruct 2507", family: "qwen", publisher: "Qwen (Alibaba)", base: "Qwen/Qwen3-4B-Instruct-2507",
    gguf: { repo: "bartowski/Qwen_Qwen3-4B-Instruct-2507-GGUF", file: /Q4_K_M\.gguf$/ }, mlx: { repo: "mlx-community/Qwen3-4B-Instruct-2507-4bit" }, uses: ["general", "small"] },
  { key: "qwen3-4b-thinking-2507", id: "Qwen3-4B-Thinking-2507-Q4_K_M", name: "Qwen3 4B Thinking 2507", family: "qwen", publisher: "Qwen (Alibaba)", base: "Qwen/Qwen3-4B-Thinking-2507",
    gguf: { repo: "bartowski/Qwen_Qwen3-4B-Thinking-2507-GGUF", file: /Q4_K_M\.gguf$/ }, mlx: { repo: "mlx-community/Qwen3-4B-Thinking-2507-4bit" }, uses: ["reasoning", "small"] },
  { key: "qwen3-8b", id: "Qwen3-8B-Q4_K_M", name: "Qwen3 8B", family: "qwen", publisher: "Qwen (Alibaba)", base: "Qwen/Qwen3-8B",
    gguf: { repo: "Qwen/Qwen3-8B-GGUF", file: /Q4_K_M\.gguf$/ }, mlx: { repo: "mlx-community/Qwen3-8B-4bit" }, uses: ["general", "reasoning"] },
  { key: "qwen3-14b", id: "Qwen3-14B-Q4_K_M", name: "Qwen3 14B", family: "qwen", publisher: "Qwen (Alibaba)", base: "Qwen/Qwen3-14B",
    gguf: { repo: "Qwen/Qwen3-14B-GGUF", revision: "530227a7d994db8eca5ab5ced2fb692b614357fd", file: "Qwen3-14B-Q4_K_M.gguf" }, mlx: { repo: "Qwen/Qwen3-14B-MLX-4bit" }, uses: ["general", "reasoning"], minRamGb: 24 },
  { key: "qwen3-32b", id: "Qwen3-32B-Q4_K_M", name: "Qwen3 32B", family: "qwen", publisher: "Qwen (Alibaba)", base: "Qwen/Qwen3-32B",
    gguf: { repo: "Qwen/Qwen3-32B-GGUF", file: /Q4_K_M\.gguf$/ }, mlx: { repo: "Qwen/Qwen3-32B-MLX-4bit" }, uses: ["general", "reasoning"] },
  { key: "qwen3-30b-a3b-instruct-2507", id: "Qwen3-30B-A3B-Instruct-2507-Q4_K_M", name: "Qwen3 30B-A3B Instruct 2507", family: "qwen", publisher: "Qwen (Alibaba)", base: "Qwen/Qwen3-30B-A3B-Instruct-2507",
    gguf: { repo: "bartowski/Qwen_Qwen3-30B-A3B-Instruct-2507-GGUF", file: /Q4_K_M\.gguf$/ }, mlx: { repo: "mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit" }, uses: ["general"] },
  { key: "qwen3-30b-a3b-thinking-2507", id: "Qwen3-30B-A3B-Thinking-2507-Q4_K_M", name: "Qwen3 30B-A3B Thinking 2507", family: "qwen", publisher: "Qwen (Alibaba)", base: "Qwen/Qwen3-30B-A3B-Thinking-2507",
    gguf: { repo: "bartowski/Qwen_Qwen3-30B-A3B-Thinking-2507-GGUF", file: /Q4_K_M\.gguf$/ }, mlx: { repo: "mlx-community/Qwen3-30B-A3B-Thinking-2507-4bit" }, uses: ["reasoning"] },
  { key: "qwen3-coder-30b-a3b", id: "Qwen3-Coder-30B-A3B-Instruct-Q4_K_M", name: "Qwen3-Coder 30B-A3B", family: "qwen", publisher: "Qwen (Alibaba)", base: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
    gguf: { repo: "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF", file: /Q4_K_M\.gguf$/ }, mlx: { repo: "mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit" }, uses: ["code"] },

  // GLM (Z.ai)
  { key: "glm-4-9b-0414", id: "GLM-4-9B-0414-Q4_K_M", name: "GLM-4 9B", family: "glm", publisher: "Z.ai", base: "zai-org/GLM-4-9B-0414",
    gguf: { repo: "bartowski/THUDM_GLM-4-9B-0414-GGUF", file: /Q4_K_M\.gguf$/ }, mlx: { repo: "mlx-community/GLM-4-9B-0414-4bit" }, uses: ["general"] },
  { key: "glm-z1-9b-0414", id: "GLM-Z1-9B-0414-Q4_K_M", name: "GLM-Z1 9B", family: "glm", publisher: "Z.ai", base: "zai-org/GLM-Z1-9B-0414",
    gguf: { repo: "bartowski/THUDM_GLM-Z1-9B-0414-GGUF", file: /Q4_K_M\.gguf$/ }, mlx: { repo: "mlx-community/GLM-Z1-9B-0414-4bit" }, uses: ["reasoning"] },
  { key: "glm-4.6v-flash", id: "GLM-4.6V-Flash-Q4_K_M", name: "GLM-4.6V Flash", family: "glm", publisher: "Z.ai", base: "zai-org/GLM-4.6V-Flash",
    gguf: { repo: "ggml-org/GLM-4.6V-Flash-GGUF", file: /Q4_K_M\.gguf$/, mmproj: /mmproj.*\.gguf$/i }, uses: ["general", "vision"] },
  { key: "glm-4.7-flash", id: "GLM-4.7-Flash-Q4_K_M", name: "GLM-4.7 Flash", family: "glm", publisher: "Z.ai", base: "zai-org/GLM-4.7-Flash",
    gguf: { repo: "ggml-org/GLM-4.7-Flash-GGUF", file: /Q4_K\.gguf$/ }, quant: "Q4_K", mlx: { repo: "mlx-community/GLM-4.7-Flash-4bit" }, uses: ["code", "reasoning"] },
  { key: "glm-4-32b-0414", id: "GLM-4-32B-0414-Q4_K_M", name: "GLM-4 32B", family: "glm", publisher: "Z.ai", base: "zai-org/GLM-4-32B-0414",
    gguf: { repo: "bartowski/THUDM_GLM-4-32B-0414-GGUF", file: /Q4_K_M\.gguf$/ }, mlx: { repo: "mlx-community/GLM-4-32B-0414-4bit" }, uses: ["general", "code"] },

  // DeepSeek
  { key: "deepseek-r1-0528-qwen3-8b", id: "DeepSeek-R1-0528-Qwen3-8B-Q4_K_M", name: "DeepSeek-R1 8B", family: "deepseek", publisher: "DeepSeek", base: "deepseek-ai/DeepSeek-R1-0528-Qwen3-8B",
    gguf: { repo: "twoody/DeepSeek-R1-0528-Qwen3-8B-GGUF", revision: "9d92e7c542bdd24e3331a2205fb7525be40787d7", file: "DeepSeek-R1-0528-Qwen3-8B-Q4_K_M.gguf" },
    mlx: { repo: "mlx-community/DeepSeek-R1-0528-Qwen3-8B-4bit" }, uses: ["reasoning"], minRamGb: 16 },
  { key: "deepseek-r1-distill-qwen-7b", id: "DeepSeek-R1-Distill-Qwen-7B-Q4_K_M", name: "DeepSeek-R1 Distill Qwen 7B", family: "deepseek", publisher: "DeepSeek", base: "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B",
    gguf: { repo: "bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF", file: /Q4_K_M\.gguf$/ }, mlx: { repo: "mlx-community/DeepSeek-R1-Distill-Qwen-7B-4bit" }, uses: ["reasoning"] },
  { key: "deepseek-r1-distill-llama-8b", id: "DeepSeek-R1-Distill-Llama-8B-Q4_K_M", name: "DeepSeek-R1 Distill Llama 8B", family: "deepseek", publisher: "DeepSeek", base: "deepseek-ai/DeepSeek-R1-Distill-Llama-8B",
    gguf: { repo: "bartowski/DeepSeek-R1-Distill-Llama-8B-GGUF", file: /Q4_K_M\.gguf$/ }, mlx: { repo: "mlx-community/DeepSeek-R1-Distill-Llama-8B-4bit" }, uses: ["reasoning"] },
  { key: "deepseek-r1-distill-qwen-14b", id: "DeepSeek-R1-Distill-Qwen-14B-Q4_K_M", name: "DeepSeek-R1 Distill Qwen 14B", family: "deepseek", publisher: "DeepSeek", base: "deepseek-ai/DeepSeek-R1-Distill-Qwen-14B",
    gguf: { repo: "bartowski/DeepSeek-R1-Distill-Qwen-14B-GGUF", file: /Q4_K_M\.gguf$/ }, mlx: { repo: "mlx-community/DeepSeek-R1-Distill-Qwen-14B-4bit" }, uses: ["reasoning"] },
  { key: "deepseek-r1-distill-qwen-32b", id: "DeepSeek-R1-Distill-Qwen-32B-Q4_K_M", name: "DeepSeek-R1 Distill Qwen 32B", family: "deepseek", publisher: "DeepSeek", base: "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B",
    gguf: { repo: "bartowski/DeepSeek-R1-Distill-Qwen-32B-GGUF", file: /Q4_K_M\.gguf$/ }, mlx: { repo: "mlx-community/DeepSeek-R1-Distill-Qwen-32B-4bit" }, uses: ["reasoning"] },
  { key: "deepseek-coder-v2-lite", id: "DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M", name: "DeepSeek-Coder-V2 Lite", family: "deepseek", publisher: "DeepSeek", base: "deepseek-ai/DeepSeek-Coder-V2-Lite-Instruct",
    gguf: { repo: "bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF", file: /Q4_K_M\.gguf$/ }, mlx: { repo: "mlx-community/DeepSeek-Coder-V2-Lite-Instruct-4bit" }, uses: ["code"] },

  // Gemma (Google)
  { key: "gemma-4-e2b", id: "gemma-4-E2B-it-qat-q4_0", name: "Gemma 4 E2B", family: "gemma", publisher: "Google", base: "google/gemma-4-E2B-it",
    gguf: { repo: "google/gemma-4-E2B-it-qat-q4_0-gguf", file: /q4_0-it\.gguf$/, mmproj: /mmproj\.gguf$/ }, mlx: { repo: "mlx-community/gemma-4-e2b-it-4bit" }, uses: ["general", "small", "vision"] },
  { key: "gemma-4-e4b", id: "gemma-4-E4B-it-qat-q4_0", name: "Gemma 4 E4B", family: "gemma", publisher: "Google", base: "google/gemma-4-E4B-it",
    gguf: { repo: "google/gemma-4-E4B-it-qat-q4_0-gguf", file: /q4_0-it\.gguf$/, mmproj: /mmproj\.gguf$/ }, mlx: { repo: "mlx-community/gemma-4-e4b-it-4bit" }, uses: ["general", "small", "vision"] },
  { key: "gemma-4-12b", id: "gemma-4-12b-it-qat-q4_0", name: "Gemma 4 12B", family: "gemma", publisher: "Google", base: "google/gemma-4-12B-it",
    gguf: { repo: "google/gemma-4-12B-it-qat-q4_0-gguf", revision: "29d097773436b69ff9feafd636ab4cf873786537", file: "gemma-4-12b-it-qat-q4_0.gguf",
      mmproj: { revision: "29d097773436b69ff9feafd636ab4cf873786537", file: "mmproj-gemma-4-12b-it-qat-q4_0.gguf" } },
    mlx: { repo: "mlx-community/gemma-4-12B-it-4bit" }, uses: ["general", "vision"], minRamGb: 16 },
  { key: "gemma-4-26b-a4b", id: "gemma-4-26B_q4_0-it", name: "Gemma 4 26B (A4B)", family: "gemma", publisher: "Google", base: "google/gemma-4-26B-A4B-it",
    gguf: { repo: "google/gemma-4-26B-A4B-it-qat-q4_0-gguf", revision: "d1c082be9cf3c8a514acf63b8761f4b41935842e", file: "gemma-4-26B_q4_0-it.gguf",
      mmproj: { revision: "d1c082be9cf3c8a514acf63b8761f4b41935842e", file: "gemma-4-26B-it-mmproj.gguf" } },
    mlx: { repo: "mlx-community/gemma-4-26b-a4b-it-4bit" }, uses: ["general", "vision"], minRamGb: 32 },
  { key: "gemma-4-31b", id: "gemma-4-31B-it-qat-q4_0", name: "Gemma 4 31B", family: "gemma", publisher: "Google", base: "google/gemma-4-31B-it",
    gguf: { repo: "google/gemma-4-31B-it-qat-q4_0-gguf", file: /q4_0-it\.gguf$/, mmproj: /mmproj\.gguf$/ }, mlx: { repo: "mlx-community/gemma-4-31b-it-4bit" }, uses: ["general", "vision"] },

  // Mistral AI
  { key: "ministral-3-3b", id: "Ministral-3-3B-Instruct-2512-Q4_K_M", name: "Ministral 3 3B", family: "mistral", publisher: "Mistral AI", base: "mistralai/Ministral-3-3B-Instruct-2512",
    gguf: { repo: "mistralai/Ministral-3-3B-Instruct-2512-GGUF", file: /Q4_K_M\.gguf$/, mmproj: /mmproj\.gguf$/i }, mlx: { repo: "mlx-community/Ministral-3-3B-Instruct-2512-4bit" }, uses: ["general", "small"] },
  { key: "ministral-3-8b", id: "Ministral-3-8B-Instruct-2512-Q4_K_M", name: "Ministral 3 8B", family: "mistral", publisher: "Mistral AI", base: "mistralai/Ministral-3-8B-Instruct-2512",
    gguf: { repo: "mistralai/Ministral-3-8B-Instruct-2512-GGUF", file: /Q4_K_M\.gguf$/, mmproj: /mmproj\.gguf$/i }, mlx: { repo: "mlx-community/Ministral-3-8B-Instruct-2512-4bit" }, uses: ["general"] },
  { key: "ministral-3-14b", id: "Ministral-3-14B-Instruct-2512-Q4_K_M", name: "Ministral 3 14B", family: "mistral", publisher: "Mistral AI", base: "mistralai/Ministral-3-14B-Instruct-2512",
    gguf: { repo: "mistralai/Ministral-3-14B-Instruct-2512-GGUF", revision: "74fac473c43357d7fb2671713608183cc72496d0", file: "Ministral-3-14B-Instruct-2512-Q4_K_M.gguf",
      mmproj: { revision: "74fac473c43357d7fb2671713608183cc72496d0", file: "Ministral-3-14B-Instruct-2512-BF16-mmproj.gguf" } },
    mlx: { repo: "mlx-community/Ministral-3-14B-Instruct-2512-4bit" }, uses: ["general", "vision"], minRamGb: 24 },
  { key: "ministral-3-14b-reasoning", id: "Ministral-3-14B-Reasoning-2512-Q4_K_M", name: "Ministral 3 14B Reasoning", family: "mistral", publisher: "Mistral AI", base: "mistralai/Ministral-3-14B-Reasoning-2512",
    gguf: { repo: "mistralai/Ministral-3-14B-Reasoning-2512-GGUF", file: /Q4_K_M\.gguf$/ }, mlx: { repo: "mlx-community/Ministral-3-14B-Reasoning-2512-4bit" }, uses: ["reasoning"] },
  { key: "mistral-small-3.2", id: "Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M", name: "Mistral Small 3.2 24B", family: "mistral", publisher: "Mistral AI", base: "mistralai/Mistral-Small-3.2-24B-Instruct-2506",
    gguf: { repo: "bartowski/mistralai_Mistral-Small-3.2-24B-Instruct-2506-GGUF", file: /Q4_K_M\.gguf$/, mmproj: /mmproj.*f16\.gguf$/i }, mlx: { repo: "mlx-community/Mistral-Small-3.2-24B-Instruct-2506-4bit" }, uses: ["general", "vision"] },
  { key: "magistral-small-2509", id: "Magistral-Small-2509-Q4_K_M", name: "Magistral Small 1.2", family: "mistral", publisher: "Mistral AI", base: "mistralai/Magistral-Small-2509",
    gguf: { repo: "bartowski/mistralai_Magistral-Small-2509-GGUF", file: /Q4_K_M\.gguf$/ }, uses: ["reasoning"] },
  { key: "devstral-small-2", id: "Devstral-Small-2-24B-Instruct-2512-Q4_K_M", name: "Devstral Small 2 24B", family: "mistral", publisher: "Mistral AI", base: "mistralai/Devstral-Small-2-24B-Instruct-2512",
    gguf: { repo: "bartowski/mistralai_Devstral-Small-2-24B-Instruct-2512-GGUF", file: /Q4_K_M\.gguf$/ }, mlx: { repo: "mlx-community/Devstral-Small-2-24B-Instruct-2512-4bit" }, uses: ["code"] },

  // Llama (Meta)
  { key: "llama-3.2-1b", id: "Llama-3.2-1B-Instruct-Q4_K_M", name: "Llama 3.2 1B", family: "llama", publisher: "Meta", base: "meta-llama/Llama-3.2-1B-Instruct",
    gguf: { repo: "bartowski/Llama-3.2-1B-Instruct-GGUF", file: /Q4_K_M\.gguf$/ }, mlx: { repo: "mlx-community/Llama-3.2-1B-Instruct-4bit" }, uses: ["small"] },
  { key: "llama-3.2-3b", id: "Llama-3.2-3B-Instruct-Q4_K_M", name: "Llama 3.2 3B", family: "llama", publisher: "Meta", base: "meta-llama/Llama-3.2-3B-Instruct",
    gguf: { repo: "bartowski/Llama-3.2-3B-Instruct-GGUF", file: /Q4_K_M\.gguf$/ }, mlx: { repo: "mlx-community/Llama-3.2-3B-Instruct-4bit" }, uses: ["general", "small"] },
  { key: "llama-3.1-8b", id: "Meta-Llama-3.1-8B-Instruct-Q4_K_M", name: "Llama 3.1 8B", family: "llama", publisher: "Meta", base: "meta-llama/Llama-3.1-8B-Instruct",
    gguf: { repo: "bartowski/Meta-Llama-3.1-8B-Instruct-GGUF", file: /Q4_K_M\.gguf$/ }, mlx: { repo: "mlx-community/Llama-3.1-8B-Instruct-4bit" }, uses: ["general"] },
  { key: "llama-3.3-70b", id: "Llama-3.3-70B-Instruct-Q4_K_M", name: "Llama 3.3 70B", family: "llama", publisher: "Meta", base: "meta-llama/Llama-3.3-70B-Instruct",
    gguf: { repo: "bartowski/Llama-3.3-70B-Instruct-GGUF", file: /Q4_K_M\.gguf$/ }, mlx: { repo: "mlx-community/Llama-3.3-70B-Instruct-4bit" }, uses: ["general"] },

  // Phi (Microsoft)
  { key: "phi-4-mini", id: "Phi-4-mini-instruct-Q4_K_M", name: "Phi-4 mini", family: "phi", publisher: "Microsoft", base: "microsoft/Phi-4-mini-instruct",
    gguf: { repo: "bartowski/microsoft_Phi-4-mini-instruct-GGUF", file: /Q4_K_M\.gguf$/ }, mlx: { repo: "mlx-community/Phi-4-mini-instruct-4bit" }, uses: ["general", "small"] },
  { key: "phi-4-mini-reasoning", id: "Phi-4-mini-reasoning-Q4_K_M", name: "Phi-4 mini reasoning", family: "phi", publisher: "Microsoft", base: "microsoft/Phi-4-mini-reasoning",
    gguf: { repo: "bartowski/microsoft_Phi-4-mini-reasoning-GGUF", file: /Q4_K_M\.gguf$/ }, mlx: { repo: "mlx-community/Phi-4-mini-reasoning-4bit" }, uses: ["reasoning", "small"] },
  { key: "phi-4", id: "phi-4-Q4_K_M", name: "Phi-4 14B", family: "phi", publisher: "Microsoft", base: "microsoft/phi-4",
    gguf: { repo: "bartowski/phi-4-GGUF", file: /Q4_K_M\.gguf$/ }, mlx: { repo: "mlx-community/phi-4-4bit" }, uses: ["general"] },
  { key: "phi-4-reasoning-plus", id: "Phi-4-reasoning-plus-Q4_K_M", name: "Phi-4 reasoning plus", family: "phi", publisher: "Microsoft", base: "microsoft/Phi-4-reasoning-plus",
    gguf: { repo: "bartowski/microsoft_Phi-4-reasoning-plus-GGUF", file: /Q4_K_M\.gguf$/ }, mlx: { repo: "mlx-community/Phi-4-reasoning-plus-4bit" }, uses: ["reasoning"] },

  // gpt-oss (OpenAI)
  { key: "gpt-oss-20b", id: "gpt-oss-20b-MXFP4", name: "gpt-oss 20B", family: "gpt-oss", publisher: "OpenAI", base: "openai/gpt-oss-20b",
    gguf: { repo: "ggml-org/gpt-oss-20b-GGUF", revision: "ef9b12f2ff56c69cf32153a02784e7a3c88bf524", file: "gpt-oss-20b-MXFP4.gguf" },
    mlx: { repo: "mlx-community/gpt-oss-20b-MXFP4-Q8" }, uses: ["reasoning", "code"], minRamGb: 24 },

  // Others
  { key: "nemotron-3-nano-4b", id: "Nemotron-3-Nano-4B-Q4_K_M", name: "Nemotron 3 Nano 4B", family: "nemotron", publisher: "NVIDIA", base: "nvidia/NVIDIA-Nemotron-3-Nano-4B-BF16",
    gguf: { repo: "nvidia/NVIDIA-Nemotron-3-Nano-4B-GGUF", file: /Q4_K_M\.gguf$/ }, mlx: { repo: "mlx-community/NVIDIA-Nemotron-3-Nano-4B-4bit" }, uses: ["general", "small", "reasoning"] },
  { key: "nemotron-3-nano-30b-a3b", id: "Nemotron-3-Nano-30B-A3B-Q4_K_M", name: "Nemotron 3 Nano 30B-A3B", family: "nemotron", publisher: "NVIDIA", base: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16",
    gguf: { repo: "ggml-org/NVIDIA-Nemotron-3-Nano-30B-A3B-GGUF", file: /Q4_K_M\.gguf$/ }, mlx: { repo: "mlx-community/NVIDIA-Nemotron-3-Nano-30B-A3B-4bit" }, uses: ["general", "reasoning", "code"] },
  { key: "smollm3-3b", id: "SmolLM3-3B-Q4_K_M", name: "SmolLM3 3B", family: "other", publisher: "Hugging Face", base: "HuggingFaceTB/SmolLM3-3B",
    gguf: { repo: "ggml-org/SmolLM3-3B-GGUF", file: /Q4_K_M\.gguf$/ }, mlx: { repo: "mlx-community/SmolLM3-3B-4bit" }, uses: ["small", "reasoning"] },
  { key: "granite-4.1-8b", id: "granite-4.1-8b-Q4_K_M", name: "Granite 4.1 8B", family: "other", publisher: "IBM", base: "ibm-granite/granite-4.1-8b",
    gguf: { repo: "bartowski/ibm-granite_granite-4.1-8b-GGUF", file: /Q4_K_M\.gguf$/ }, mlx: { repo: "mlx-community/granite-4.1-8b-4bit" }, uses: ["general"] },
  { key: "olmo-3-7b-instruct", id: "Olmo-3-7B-Instruct-Q4_K_M", name: "Olmo 3 7B", family: "other", publisher: "Ai2", base: "allenai/Olmo-3-7B-Instruct",
    gguf: { repo: "bartowski/allenai_Olmo-3-7B-Instruct-GGUF", file: /Q4_K_M\.gguf$/ }, mlx: { repo: "mlx-community/Olmo-3-7B-Instruct-4bit" }, uses: ["general"] },
  { key: "lfm2.5-2.6b", id: "LFM2.5-2.6B-Q4_K_M", name: "LFM2.5 2.6B", family: "other", publisher: "Liquid AI", base: "LiquidAI/LFM2.5-2.6B",
    gguf: { repo: "bartowski/LiquidAI_LFM2.5-2.6B-GGUF", file: /Q4_K_M\.gguf$/ }, mlx: { repo: "mlx-community/LFM2.5-2.6B-4bit" }, uses: ["small"] },
  { key: "minicpm5-2b", id: "MiniCPM5-2B-Q4_K_M", name: "MiniCPM5 2B", family: "other", publisher: "OpenBMB", base: "openbmb/MiniCPM5-2B",
    gguf: { repo: "bartowski/MiniCPM5-2B-GGUF", file: /Q4_K_M\.gguf$/ }, uses: ["small"] },
];

// Licences that forbid what Twoody is for — a person or a company running
// the model on its own computers, for any purpose: refused.
const FORBIDDEN_LICENSES = /(^|[-_ ])(nc|non-?commercial|research|mrl)([-_ .]|$)|cc-by-nc|qwen-research/i;
// Licences that allow it with conditions the screen names.
const RESTRICTED = [
  [/^llama3/i, "llama"],
  [/^gemma$/i, "gemma"],
  [/nvidia/i, "nvidia"],
  [/^lfm/i, "lfm"],
  [/^other$/i, "other"],
];
const LICENSE_NAMES = {
  "apache-2.0": "Apache 2.0",
  mit: "MIT",
  "llama3.1": "Llama 3.1 Community",
  "llama3.2": "Llama 3.2 Community",
  "llama3.3": "Llama 3.3 Community",
  gemma: "Gemma Terms of Use",
  "deepseek-license": "DeepSeek License",
  "nvidia-nemotron-open-model-license": "NVIDIA Nemotron Open Model License",
  "lfm1.0": "LFM Open License v1.0",
};

// ── Hugging Face ────────────────────────────────────────────────────────

export async function getJson(url, attempt = 0) {
  const res = await fetch(url, { headers: { "User-Agent": "twoody-model-catalog" }, redirect: "follow" });
  if (res.status === 429 && attempt < 5) {
    await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    return getJson(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

const infoCache = new Map();
/// A repository at a revision (or its main branch): its sha, licence and files.
export async function repoInfo(repo, revision) {
  const key = `${repo}@${revision ?? "main"}`;
  if (!infoCache.has(key)) {
    const path = revision ? `${HF}/api/models/${repo}/revision/${revision}?blobs=true` : `${HF}/api/models/${repo}?blobs=true&expand[]=gguf&expand[]=sha&expand[]=cardData&expand[]=siblings&expand[]=gated&expand[]=safetensors`;
    infoCache.set(key, getJson(path));
  }
  return infoCache.get(key);
}

export async function repoConfig(repo, revision) {
  try {
    return await getJson(`${HF}/${repo}/resolve/${revision}/config.json`);
  } catch {
    return null;
  }
}

function pickFile(siblings, wanted, what) {
  const files = siblings.filter((file) => (typeof wanted === "string" ? file.rfilename === wanted : wanted.test(file.rfilename)) && !file.rfilename.includes("/"));
  if (files.length === 0) throw new Error(`${what}: no file matches ${wanted}`);
  // Several matches (a « f16 » and a « bf16 » vision file…): the shortest name.
  files.sort((a, b) => a.rfilename.length - b.rfilename.length);
  const file = files[0];
  if (!file.lfs?.sha256) throw new Error(`${what}: ${file.rfilename} has no SHA-256 (not an LFS file)`);
  return file;
}

// ── Architecture → memory figures ──────────────────────────────────────

/// What a model's KV cache and fixed state take, from its config.json:
/// `kvBytesPerToken`: f16 bytes a token over the layers that keep the whole
/// conversation; `swa`: sliding-window layers (bytes a token, window);
/// `stateBytes`: recurrent state (linear attention, Mamba, short
/// convolutions), whatever the length; `hybrid`: has such layers (Twoody
/// runs it with a q8_0 cache and a longer window, runtimeArgs.ts).
export function architectureFigures(config) {
  const t = config.text_config ?? config.llm_config ?? config;
  const layers = t.num_hidden_layers ?? t.n_layer ?? t.num_layers;
  const heads = t.num_attention_heads ?? t.n_head;
  const kvHeads = t.num_key_value_heads ?? t.num_kv_heads ?? heads;
  const headDim = t.head_dim ?? Math.round(t.hidden_size / heads);
  if (!layers || !heads) throw new Error("config: no layer or head count");
  const shared = t.num_kv_shared_layers ?? 0;
  let full = layers;
  let sliding = 0;
  let recurrent = 0;
  let types = Array.isArray(t.layer_types) ? t.layer_types.slice(0, layers - shared) : null;
  if (!types && typeof t.hybrid_override_pattern === "string") {
    types = [...t.hybrid_override_pattern].map((c) => (c === "*" ? "full_attention" : c === "M" ? "mamba" : "none"));
  }
  if (!types && t.full_attention_interval) {
    types = Array.from({ length: layers }, (_, i) => ((i + 1) % t.full_attention_interval === 0 ? "full_attention" : "linear_attention"));
  }
  if (types) {
    full = types.filter((x) => x === "full_attention" || x === "attention").length;
    sliding = types.filter((x) => x === "sliding_attention" || x === "chunked_attention").length;
    recurrent = types.filter((x) => ["linear_attention", "mamba", "mamba2", "conv", "recurrent"].includes(x)).length;
  } else if (t.sliding_window && t.use_sliding_window !== false && (t.sliding_window_pattern || t.model_type?.startsWith("gemma"))) {
    const pattern = t.sliding_window_pattern ?? 6;
    full = Math.floor(layers / pattern);
    sliding = layers - full;
  }
  let kvBytesPerToken;
  if (t.kv_lora_rank) {
    // Multi-head latent attention: llama.cpp keeps the compressed latent and
    // the rotary part, once for K and V.
    kvBytesPerToken = full * (t.kv_lora_rank + (t.qk_rope_head_dim ?? 64)) * 2;
  } else {
    const fullKvHeads = t.num_global_key_value_heads ?? kvHeads;
    const fullHeadDim = t.global_head_dim ?? headDim;
    const kAndV = t.attention_k_eq_v ? 1 : 2;
    kvBytesPerToken = full * kAndV * fullKvHeads * fullHeadDim * 2;
  }
  const swa = sliding > 0 ? { bytesPerToken: sliding * (t.attention_k_eq_v ? 1 : 2) * kvHeads * headDim * 2, window: t.sliding_window ?? 4096 } : null;
  let stateBytes = 0;
  if (recurrent > 0) {
    if (t.linear_num_value_heads && t.linear_key_head_dim) {
      // Gated DeltaNet (Qwen3.5, Qwen3-Next): a value×key matrix a head, f32.
      stateBytes = recurrent * t.linear_num_value_heads * t.linear_key_head_dim * (t.linear_value_head_dim ?? t.linear_key_head_dim) * 4;
    } else if (t.mamba_num_heads || t.mamba_n_heads) {
      const mambaHeads = t.mamba_num_heads ?? t.mamba_n_heads;
      const mambaHeadDim = t.mamba_head_dim ?? t.mamba_d_head;
      stateBytes = recurrent * mambaHeads * mambaHeadDim * (t.ssm_state_size ?? t.mamba_d_state ?? 128) * 4;
    } else if (t.conv_L_cache) {
      stateBytes = recurrent * t.conv_L_cache * (t.conv_dim ?? t.hidden_size) * 4;
    } else {
      stateBytes = 64 * 1024 ** 2;
    }
  }
  const context = t.max_position_embeddings ?? config.max_position_embeddings ?? t.seq_length ?? null;
  return { layers, kvBytesPerToken, swa, stateBytes, hybrid: recurrent > 0, context };
}

export function capabilities(template, source, hasVision) {
  const text = typeof template === "string" ? template : "";
  const tools = /\btools\b/.test(text) && /tool_call|tool_calls|\[TOOL_CALLS\]|<tool_call>|function/.test(text);
  const reasoning = source.uses.includes("reasoning") || /<think>|enable_thinking|reasoning_effort|\[THINK\]/.test(text);
  return { tools, vision: hasVision, reasoning };
}

export function licenseOf(info, what) {
  const card = info.cardData ?? {};
  const id = String(card.license ?? "unknown");
  const name = card.license_name ? String(card.license_name) : null;
  const label = `${id}${name ? ` (${name})` : ""}`;
  if (FORBIDDEN_LICENSES.test(id) || (name && FORBIDDEN_LICENSES.test(name))) throw new Error(`${what}: licence ${label} forbids Twoody's use`);
  const restricted = RESTRICTED.find(([pattern]) => pattern.test(id) || (name && pattern.test(name)));
  return {
    license: LICENSE_NAMES[name ?? ""] ?? LICENSE_NAMES[id] ?? name ?? id,
    licenseKind: restricted ? "restricted" : "open",
    licenseUrl: `${HF}/${info.id ?? info.modelId}/blob/main/${card.license_link && !/^https?:/.test(card.license_link) ? card.license_link : "README.md"}`,
  };
}

// ── One entry ───────────────────────────────────────────────────────────

async function verify(source) {
  const what = source.key;
  const base = await repoInfo(source.base);
  const { license, licenseKind, licenseUrl } = licenseOf(base, what);
  // GGUF: the pinned revision, or the main branch of the day.
  const ggufMain = await repoInfo(source.gguf.repo);
  const revision = source.gguf.revision ?? ggufMain.sha;
  const at = source.gguf.revision ? await repoInfo(source.gguf.repo, revision) : ggufMain;
  const file = pickFile(at.siblings, source.gguf.file, `${what} gguf`);
  let vision = null;
  if (source.gguf.mmproj) {
    const spec = source.gguf.mmproj;
    const mmRevision = spec.revision ?? revision;
    const mmAt = spec.revision ? await repoInfo(source.gguf.repo, mmRevision) : at;
    const mm = pickFile(mmAt.siblings, spec.file ?? spec, `${what} mmproj`);
    vision = { url: `${HF}/${source.gguf.repo}/resolve/${mmRevision}/${mm.rfilename}`, bytes: mm.size, sha256: mm.lfs.sha256 };
  }
  // MLX: every file of the folder but the card, git's own and code
  // (mlx-lm never runs a repository's code: trust_remote_code stays off).
  let mlx = null;
  let config = null;
  if (source.mlx) {
    const mlxInfo = await repoInfo(source.mlx.repo);
    const mlxRevision = source.mlx.revision ?? mlxInfo.sha;
    const mlxAt = source.mlx.revision ? await repoInfo(source.mlx.repo, mlxRevision) : mlxInfo;
    const files = mlxAt.siblings
      .filter((entry) => !entry.rfilename.includes("/") && !/^(README\.md|\.gitattributes|LICENSE.*|.*\.(py|png|jpg|jpeg|gif|md|pdf))$/i.test(entry.rfilename))
      .map((entry) => (entry.lfs?.sha256 ? { path: entry.rfilename, bytes: entry.size, sha256: entry.lfs.sha256 } : { path: entry.rfilename, bytes: entry.size, gitSha1: entry.blobId }));
    if (!files.some((entry) => entry.path.endsWith(".safetensors"))) throw new Error(`${what} mlx: no weights`);
    if (!files.some((entry) => entry.path === "config.json")) throw new Error(`${what} mlx: no config.json`);
    for (const entry of files) {
      if (!/^[\w.+-]+$/.test(entry.path)) throw new Error(`${what} mlx: unexpected file name ${entry.path}`);
      if (!entry.sha256 && !/^[0-9a-f]{40}$/.test(entry.gitSha1 ?? "")) throw new Error(`${what} mlx: ${entry.path} has no digest`);
    }
    config = await repoConfig(source.mlx.repo, mlxRevision);
    const weights = files.filter((entry) => entry.path.endsWith(".safetensors")).reduce((sum, entry) => sum + entry.bytes, 0);
    mlx = { id: `${source.id.replace(/-(Q\d.*|IQ\d.*|MXFP4|q4_0.*|qat.*)$/i, "").replace(/_q4_0-it$/, "")}-MLX`, repo: source.mlx.repo, revision: mlxRevision, bytes: files.reduce((sum, entry) => sum + entry.bytes, 0), weightsBytes: weights, files };
  }
  config ??= base.gated ? null : await repoConfig(source.base, base.sha);
  if (!config) throw new Error(`${what}: no config.json to read the architecture from (base gated and no MLX folder)`);
  const arch = architectureFigures(config);
  const template = ggufMain.gguf?.chat_template ?? at.gguf?.chat_template ?? null;
  const caps = capabilities(template, source, !!vision);
  const params = base.safetensors?.total ?? ggufMain.gguf?.total ?? null;
  return {
    key: source.key,
    id: source.id,
    name: source.name,
    family: source.family,
    publisher: source.publisher,
    file: `${source.id}.gguf`,
    url: `${HF}/${source.gguf.repo}/resolve/${revision}/${file.rfilename}`,
    bytes: file.size,
    sha256: file.lfs.sha256,
    ...(vision ? { vision } : {}),
    quantizer: source.gguf.repo.split("/")[0],
    quant: source.quant ?? (/MXFP4/i.test(file.rfilename) ? "MXFP4" : /q4_0/i.test(file.rfilename) ? "Q4_0 (QAT)" : (file.rfilename.match(/(I?Q\d_[A-Z0-9_]+)/)?.[1] ?? "?")),
    license,
    licenseKind,
    licenseUrl,
    paramsB: params ? Math.round(params / 1e8) / 10 : null,
    contextLength: arch.context ?? ggufMain.gguf?.context_length ?? null,
    capabilities: caps,
    uses: [...new Set([...source.uses, ...(caps.vision ? ["vision"] : [])])],
    memory: { kvBytesPerToken: arch.kvBytesPerToken, ...(arch.swa ? { swa: arch.swa } : {}), stateBytes: arch.stateBytes, hybrid: arch.hybrid },
    ...(source.minRamGb ? { minRamGb: source.minRamGb } : {}),
    ...(source.recommendable ? { recommendable: true } : {}),
    ...(source.larger ? { larger: true } : {}),
    ...(mlx ? { mlx } : {}),
  };
}

async function inBatches(items, size, run) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(run))));
  return out;
}

// ── Output ──────────────────────────────────────────────────────────────

function render(entries, date) {
  const lines = entries.map((entry) => `  ${JSON.stringify(entry)},`);
  return `// Generated by scripts/model-catalog.mjs on ${date} from the Hugging Face API — do not edit by hand.
//
// Every entry was fetched: the repository, the exact file at a pinned
// revision, its size and SHA-256 (git's object id for the small text files of
// an MLX folder), the licence of the publisher's repository, the context
// length and the architecture figures of its config.json. To refresh:
//   node scripts/model-catalog.mjs            (re-fetches every entry, rewrites this file)
//   node scripts/model-catalog.mjs --check    (says what no longer matches; exit 1)
// then, in twoody-desktop, node scripts/sync-builtin.mjs.
// The choices (which model, which repository, which quantisation) are the
// script's SOURCES; catalog.ts turns these entries into the catalogue.

import type { VerifiedModel } from "./catalogTypes.js";

export const CATALOG_VERIFIED_AT = ${JSON.stringify(date)};

export const VERIFIED_MODELS: VerifiedModel[] = [
${lines.join("\n")}
];
`;
}

function readCurrent() {
  try {
    const text = readFileSync(OUT, "utf8");
    const start = text.indexOf("export const VERIFIED_MODELS");
    const body = text.slice(text.indexOf("[", start) + 1, text.lastIndexOf("];"));
    return body
      .split("\n")
      .map((line) => line.trim().replace(/,$/, ""))
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

const GIB = 1024 ** 3;
function table(entries, memoryNeed) {
  const rows = ["| Modèle | Famille | Fichier (quantisation, éditeur) | Téléchargement | Mémoire nécessaire (24 Go) | Licence | Contexte | Outils / vision / raisonnement | MLX |", "|---|---|---|---|---|---|---|---|---|"];
  for (const entry of entries) {
    const need = memoryNeed ? memoryNeed(entry, 24 * GIB) : null;
    rows.push(`| ${entry.name} | ${entry.family} | ${entry.quant}, ${entry.quantizer} | ${(entry.bytes / 1e9).toFixed(2)} Go${entry.vision ? ` + vision ${(entry.vision.bytes / 1e9).toFixed(2)}` : ""} | ${need ? `${(need / GIB).toFixed(1)} Gio` : "?"} | ${entry.license}${entry.licenseKind === "restricted" ? " (conditions)" : ""} | ${entry.contextLength ? `${Math.round(entry.contextLength / 1024)}k` : "?"} | ${entry.capabilities.tools ? "oui" : "non"} / ${entry.capabilities.vision ? "oui" : "non"} / ${entry.capabilities.reasoning ? "oui" : "non"} | ${entry.mlx ? `${(entry.mlx.bytes / 1e9).toFixed(2)} Go` : "—"} |`);
  }
  return rows.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const only = args.find((arg) => arg.startsWith("--only"))?.split("=")[1] ?? (args.includes("--only") ? args[args.indexOf("--only") + 1] : null);
  if (args.includes("--table")) {
    let memoryNeed = null;
    try {
      ({ catalogMemoryNeed: memoryNeed } = await import(join(ROOT, "src", "builtin", "memory.ts")));
    } catch {
      // run with: node --experimental-strip-types scripts/model-catalog.mjs --table
    }
    console.log(table(readCurrent(), memoryNeed));
    return;
  }
  const current = readCurrent();
  const wanted = only ? SOURCES.filter((source) => only.split(",").includes(source.key)) : SOURCES;
  const keys = new Set();
  for (const source of SOURCES) {
    if (keys.has(source.key) || keys.has(source.id)) throw new Error(`duplicate ${source.key}`);
    keys.add(source.key).add(source.id);
  }
  const failures = [];
  const fetched = await inBatches(wanted, 4, async (source) => {
    try {
      const entry = await verify(source);
      process.stderr.write(`ok   ${source.key}\n`);
      return entry;
    } catch (err) {
      failures.push(`${source.key}: ${err.message}`);
      process.stderr.write(`FAIL ${source.key}: ${err.message}\n`);
      return null;
    }
  });
  if (failures.length > 0) {
    console.error(`\n${failures.length} entr${failures.length === 1 ? "y" : "ies"} could not be verified:\n${failures.join("\n")}`);
    process.exit(1);
  }
  const byKey = new Map(current.map((entry) => [entry.key, entry]));
  if (check) {
    let moved = 0;
    for (const entry of fetched) {
      const was = byKey.get(entry.key);
      const pinned = (e) => JSON.stringify({ url: e?.url, bytes: e?.bytes, sha256: e?.sha256, vision: e?.vision, mlx: e?.mlx && { repo: e.mlx.repo, revision: e.mlx.revision, files: e.mlx.files } });
      if (!was) {
        console.error(`new  ${entry.key}`);
        moved += 1;
      } else if (pinned(was) !== pinned(entry)) {
        console.error(`moved ${entry.key}: a newer revision or another file (refresh to pin it)`);
        moved += 1;
      }
    }
    console.log(moved === 0 ? "every entry matches Hugging Face" : `${moved} entr${moved === 1 ? "y" : "ies"} differ`);
    process.exit(moved === 0 ? 0 : 1);
  }
  for (const entry of fetched) byKey.set(entry.key, entry);
  const ordered = SOURCES.map((source) => byKey.get(source.key)).filter(Boolean);
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(OUT, render(ordered, date));
  console.log(`wrote ${ordered.length} entries to src/builtin/catalogData.ts (${date})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
