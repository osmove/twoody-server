// What a model needs in memory (src/builtin/memory.ts), against what
// llama.cpp b11146 itself allocated on an M5 (docs/builtin-runtime-design.md
// §8–9), and the thresholds it gives the catalogue.
import { test } from "node:test";
import assert from "node:assert/strict";

import { CATALOG } from "../src/builtin/catalog.js";
import { catalogMemoryNeed, gpuShare, memoryNeed, minRamFor, twoodyContext } from "../src/builtin/memory.js";

const GIB = 1024 ** 3;
const byId = (id: string) => CATALOG.find((model) => model.id === id)!;
const MEASURED = new Set(["Qwen3.5-4B-Q4_K_M", "Qwen3.5-9B-Q4_K_M", "Qwen3.6-35B-A3B-IQ3_XXS", "DeepSeek-R1-0528-Qwen3-8B-Q4_K_M", "gemma-4-12b-it-qat-q4_0", "Ministral-3-14B-Instruct-2512-Q4_K_M", "Qwen3-14B-Q4_K_M", "gpt-oss-20b-MXFP4", "gemma-4-26B_q4_0-it"]);

test("the window Twoody opens a model with", () => {
  assert.equal(twoodyContext({ hybrid: true, totalMemory: 8 * GIB }), 8_192);
  assert.equal(twoodyContext({ hybrid: true, totalMemory: 15.9 * GIB }), 32_768);
  assert.equal(twoodyContext({ hybrid: true, totalMemory: 32 * GIB }), 65_536);
  assert.equal(twoodyContext({ hybrid: false, totalMemory: 8 * GIB }), 8_192);
  assert.equal(twoodyContext({ hybrid: false, totalMemory: 24 * GIB }), 16_384);
});

test("the need matches llama.cpp's own buffers for the measured models", () => {
  // Qwen3.5 9B with its vision file at 32 768 tokens: 7.4 GiB measured.
  const nine = catalogMemoryNeed(byId("Qwen3.5-9B-Q4_K_M"), 24 * GIB)! / GIB;
  assert.ok(Math.abs(nine - 7.4) < 0.15, `9B: ${nine}`);
  // The 4B without its vision file at 8 192 tokens: 2.9 measured.
  const four = byId("Qwen3.5-4B-Q4_K_M");
  const fourNeed = memoryNeed({ weightsBytes: four.bytes, figures: four.memory!, context: 8_192, engine: "llamacpp" }) / GIB;
  assert.ok(fourNeed >= 2.9 && fourNeed < 3.2, `4B: ${fourNeed}`);
  // Qwen3.6 35B-A3B IQ3_XXS at 32 768 tokens without its vision file: 14.5
  // measured; the formula stays on the safe side.
  const large = byId("Qwen3.6-35B-A3B-IQ3_XXS");
  const largeNeed = memoryNeed({ weightsBytes: large.bytes, figures: large.memory!, context: 32_768, engine: "llamacpp" }) / GIB;
  assert.ok(largeNeed >= 14.5 && largeNeed < 15.6, `35B-A3B: ${largeNeed}`);
});

test("a hybrid model's cache is q8_0 on llama.cpp, 16 bits on MLX; MLX reads no images", () => {
  const nine = byId("Qwen3.5-9B-Q4_K_M");
  const cache = (engine: "llamacpp" | "mlx") => memoryNeed({ weightsBytes: 0, figures: { ...nine.memory!, stateBytes: 0 }, context: 32_768, engine }) - 0.3 * GIB;
  assert.ok(Math.abs(cache("llamacpp") / cache("mlx") - 34 / 64) < 1e-9);
  const mlx = catalogMemoryNeed(nine, 24 * GIB, "mlx")!;
  const gguf = catalogMemoryNeed(nine, 24 * GIB)!;
  assert.ok(mlx < gguf, "no vision file on MLX");
  assert.equal(catalogMemoryNeed(byId("Qwen3.6-35B-A3B-IQ3_XXS"), 24 * GIB, "mlx"), null, "no MLX folder");
});

test("sliding windows are counted once, up to their window", () => {
  const gemma = byId("gemma-4-31B-it-qat-q4_0");
  const at = (context: number) => memoryNeed({ weightsBytes: 0, figures: gemma.memory!, context, engine: "llamacpp" });
  const swa = gemma.memory!.swa!;
  // Past the window, only the full-attention layers grow.
  assert.equal(at(65_536) - at(32_768), gemma.memory!.kvBytesPerToken * 32_768);
  assert.ok(at(1_000) - at(500) > gemma.memory!.kvBytesPerToken * 500, "within the window both grow");
  assert.ok(swa.window > 0);
});

test("every model's threshold leaves its need within what the GPU may use", () => {
  for (const model of CATALOG) {
    const computed = minRamFor(model);
    assert.ok(computed !== null, `${model.id}: fits nowhere`);
    // A threshold measured by hand before 15/10/2026 stands: Qwen3.6
    // 35B-A3B runs on a 24 GB Mac whose GPU may use 17.8 GiB (more than the
    // two thirds the formula assumes up to 32 GB).
    if (MEASURED.has(model.id)) continue;
    assert.equal(model.minRamGb, computed, model.id);
    const need = catalogMemoryNeed(model, model.minRamGb * GIB)!;
    assert.ok(need <= model.minRamGb * GIB * gpuShare(model.minRamGb), `${model.id}: ${need / GIB} GiB on ${model.minRamGb} GB`);
  }
  assert.equal(byId("Qwen3.5-4B-Q4_K_M").minRamGb, 8);
  assert.equal(byId("Qwen3.5-9B-Q4_K_M").minRamGb, 16);
  assert.ok(byId("Llama-3.3-70B-Instruct-Q4_K_M").minRamGb >= 64);
  assert.ok(byId("Llama-3.2-1B-Instruct-Q4_K_M").minRamGb <= 8);
});
