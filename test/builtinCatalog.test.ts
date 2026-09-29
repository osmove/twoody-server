// Ported from twoody-desktop/test/modelCatalog.test.mjs, with the acceleration and failure tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG, catalogView, isAllowedDownloadUrl, loadCatalog, modelFits, recommendedModel } from "../src/builtin/catalog.js";
import { accelerationArgs, countGpuDevices, selectRuntimeEngine } from "../src/builtin/acceleration.js";
import { failureOf } from "../src/builtin/failure.js";
import { mkdir } from "node:fs/promises";

const GIB = 1024 ** 3;

test("every entry of the catalogue is pinned: revision, size, digest, file named after its id", () => {
  assert.ok(CATALOG.length >= 2);
  for (const model of CATALOG) {
    assert.equal(model.file, `${model.id}.gguf`);
    assert.match(model.url, /^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+\/resolve\/[0-9a-f]{40}\//, `${model.id}: not pinned to a revision`);
    // Osmove's own conversions (scripts/convert-model.sh), not a competitor's.
    assert.match(model.url, /^https:\/\/huggingface\.co\/twoody\//, `${model.id}: not a file of huggingface.co/twoody`);
    assert.ok(model.url.endsWith(`/${model.file}`));
    assert.match(model.sha256, /^[0-9a-f]{64}$/);
    assert.ok(model.bytes > 1e9);
    assert.ok(isAllowedDownloadUrl(model.url));
  }
});

test("the recommendation is the largest model the computer runs comfortably", () => {
  const pick = (gb: number) => recommendedModel(gb * GIB, CATALOG, "darwin")!.id;
  assert.equal(pick(8), "Qwen3.5-4B-Q4_K_M");
  assert.equal(pick(15.9), "Qwen3.5-9B-Q4_K_M"); // a "16 GB" Mac reports a little less
  assert.equal(pick(18), "Qwen3.5-9B-Q4_K_M");
  assert.equal(pick(24), "Qwen3.5-9B-Q4_K_M");
  assert.equal(pick(64), "Qwen3.5-9B-Q4_K_M");
  assert.equal(pick(4), "Qwen3.5-4B-Q4_K_M"); // nothing fits: the smallest is the least bad
  assert.equal(recommendedModel(16 * GIB, []), null);
});

test("a model only ever comes from Hugging Face, over HTTPS", () => {
  assert.ok(isAllowedDownloadUrl("https://huggingface.co/Qwen/x/resolve/main/x.gguf"));
  assert.ok(isAllowedDownloadUrl("https://us.aws.cdn.hf.co/xet-bridge-us/abc"));
  assert.ok(isAllowedDownloadUrl("https://cdn-lfs.huggingface.co/repos/abc"));
  assert.ok(!isAllowedDownloadUrl("http://huggingface.co/Qwen/x.gguf"));
  assert.ok(!isAllowedDownloadUrl("https://huggingface.co.evil.example/x.gguf"));
  assert.ok(!isAllowedDownloadUrl("https://evilhf.co/x.gguf"));
  assert.ok(!isAllowedDownloadUrl("https://example.com/x.gguf"));
  assert.ok(!isAllowedDownloadUrl("file:///etc/passwd"));
  assert.ok(!isAllowedDownloadUrl("not a url"));
  // The test catalogue's local mirror, and only when asked for.
  assert.ok(!isAllowedDownloadUrl("http://127.0.0.1:8000/x.gguf"));
  assert.ok(isAllowedDownloadUrl("http://127.0.0.1:8000/x.gguf", true));
  assert.ok(!isAllowedDownloadUrl("http://192.168.1.10:8000/x.gguf", true));
});

test("a replacement catalogue is validated entry by entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "twoody-catalog-"));
  try {
    const path = join(dir, "catalog.json");
    const good = { id: "Tiny-Q8_0", name: "Tiny", file: "Tiny-Q8_0.gguf", url: "http://127.0.0.1:9000/Tiny-Q8_0.gguf", bytes: 10, sha256: "a".repeat(64), minRamGb: 4 };
    writeFileSync(
      path,
      JSON.stringify([
        good,
        { ...good, id: "Elsewhere-Q8_0", file: "Elsewhere-Q8_0.gguf", url: "https://example.com/Elsewhere-Q8_0.gguf" },
        { ...good, id: "../escape", file: "../escape.gguf" },
        { ...good, id: "Mismatch", file: "other.gguf" },
        { ...good, id: "NoDigest", file: "NoDigest.gguf", sha256: "abc" },
      ]),
    );
    const { models, overridden } = loadCatalog({ TWOODY_DESKTOP_MODEL_CATALOG: path });
    assert.equal(overridden, true);
    assert.deepEqual(models.map((model) => model.id), ["Tiny-Q8_0"]);
    assert.deepEqual(loadCatalog({ TWOODY_DESKTOP_MODEL_CATALOG: join(dir, "missing.json") }), { models: [], overridden: true });
    assert.equal(loadCatalog({}).overridden, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CPU-only Windows and Linux recommend 9B from 32 GiB, keeping both choices", () => {
  for (const platform of ["win32", "linux"] as const) {
    for (const gb of [4, 8, 16, 24]) assert.equal(recommendedModel(gb * GIB, CATALOG, platform)!.id, "Qwen3.5-4B-Q4_K_M");
    for (const gb of [31.9, 32, 64]) assert.equal(recommendedModel(gb * GIB, CATALOG, platform)!.id, "Qwen3.5-9B-Q4_K_M");
    assert.equal(recommendedModel(16 * GIB, [], platform), null);
    assert.equal(recommendedModel(16 * GIB, [CATALOG[1]], platform)!.id, CATALOG[1].id);
  }
});

test("the pinned entries are the Desktop's, byte for byte", () => {
  assert.deepEqual(
    CATALOG.map((model) => [model.id, model.bytes, model.sha256]),
    [
      ["Qwen3.5-4B-Q4_K_M", 2_783_446_880, "b7508d8b4a652bc020a439aafdd4ce1527d49774865ce3334a43b16dbeaa90ca"],
      ["Qwen3.5-9B-Q4_K_M", 5_780_090_688, "8c4cc24f54473f3d4e080d4ec7fd2a40d0bbec0f94f3c807cd62694905357d54"],
    ],
  );
});

test("TWOODY_MODEL_CATALOG replaces the catalogue like the Desktop's variable", () => {
  const dir = mkdtempSync(join(tmpdir(), "twoody-catalog-"));
  try {
    const path = join(dir, "catalog.json");
    writeFileSync(path, JSON.stringify([{ id: "Tiny-Q8_0", name: "Tiny", file: "Tiny-Q8_0.gguf", url: "http://127.0.0.1:9000/Tiny-Q8_0.gguf", bytes: 10, sha256: "a".repeat(64), minRamGb: 4 }]));
    assert.deepEqual(loadCatalog({ TWOODY_MODEL_CATALOG: path }).models.map((model) => model.id), ["Tiny-Q8_0"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the catalogue view says what is installed, recommended and fits", () => {
  const view = catalogView(CATALOG, ["Qwen3.5-4B-Q4_K_M"], 16 * GIB, "linux");
  assert.deepEqual(
    view.map((entry) => [entry.id, entry.installed, entry.recommended, entry.fits]),
    [
      ["Qwen3.5-4B-Q4_K_M", true, true, true],
      ["Qwen3.5-9B-Q4_K_M", false, false, true],
    ],
  );
  assert.equal(modelFits(CATALOG[1], 8 * GIB), false);
});

// Ported from twoody-desktop/test/runtimeAcceleration.test.mjs.
test("GPU detection excludes CPU/BLAS and accepts integrated or discrete Vulkan devices", () => {
  assert.equal(countGpuDevices("Available devices:\n  MTL0: Apple M5 (18186 MiB, 18185 MiB free)\n  BLAS: Accelerate (0 MiB, 0 MiB free)", "metal"), 1);
  assert.equal(countGpuDevices("  Vulkan0: NVIDIA (8192 MiB, 6100 MiB free)\n  Vulkan1: Intel GPU (4096 MiB, 3000 MiB free)", "vulkan"), 2);
  assert.equal(countGpuDevices("ggml_vulkan: Found 0 Vulkan devices:\n  CPU: CPU (8192 MiB, 6000 MiB free)", "vulkan"), 0);
});

test("Linux is CPU without asking; Metal on a Mac with a device; Vulkan beside the CPU build on Windows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "twoody-accel-"));
  try {
    writeFileSync(join(dir, "llama-server"), "");
    writeFileSync(join(dir, "llama-server.exe"), "");
    let probes = 0;
    const vulkan = async () => { probes += 1; return "  Vulkan0: GPU (8192 MiB, 7000 MiB free)"; };
    assert.equal((await selectRuntimeEngine(dir, "linux", {}, false, vulkan)).backend, "cpu");
    assert.equal(probes, 0);
    assert.equal((await selectRuntimeEngine(dir, "darwin", {}, false, async () => " MTL0: Apple M5 (18000 MiB, 17000 MiB free)")).backend, "metal");
    assert.equal((await selectRuntimeEngine(dir, "darwin", {}, false, async () => " BLAS: Accelerate (0 MiB, 0 MiB free)")).backend, "cpu");
    assert.equal((await selectRuntimeEngine(dir, "win32", {}, false, vulkan)).backend, "cpu", "no vulkan/ folder");
    await mkdir(join(dir, "vulkan"));
    writeFileSync(join(dir, "vulkan", "llama-server.exe"), "");
    assert.equal((await selectRuntimeEngine(dir, "win32", {}, false, vulkan)).backend, "vulkan");
    assert.equal((await selectRuntimeEngine(dir, "win32", {}, false, async () => { throw Error("bad driver"); })).backend, "cpu");
    assert.equal((await selectRuntimeEngine(dir, "win32", {}, true, vulkan)).backend, "cpu");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GPU auto-fit keeps layer count unset; CPU disables every offload", () => {
  for (const backend of ["metal", "vulkan"] as const) assert.deepEqual(accelerationArgs(backend), ["--fit", "on", "--flash-attn", "auto"]);
  assert.deepEqual(accelerationArgs("cpu"), ["--device", "none", "--gpu-layers", "0", "--no-op-offload"]);
});

// Ported from twoody-desktop/test/runtimeFailure.test.mjs.
test("a library missing to the runtime is told apart from other failures", () => {
  assert.equal(failureOf(3221225781, "win32").reason, "missing-library");
  assert.equal(failureOf(-1073741515, "win32").reason, "missing-library");
  assert.equal(failureOf(127, "linux").reason, "missing-library");
  assert.equal(failureOf(1, "win32").reason, "exited");
  assert.equal(failureOf(127, "win32").reason, "exited");
  assert.equal(failureOf(null, "darwin").reason, "no-answer");
  assert.equal(failureOf(null, "darwin", "SIGABRT").reason, "exited");
});
