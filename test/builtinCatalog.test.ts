// Ported from twoody-desktop/test/modelCatalog.test.mjs, with the acceleration and failure tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG, catalogView, isAllowedDownloadUrl, loadCatalog, modelFits, recommendedModel, visionDownload } from "../src/builtin/catalog.js";
import { accelerationArgs, countGpuDevices, dedicatedGpuMemory, selectRuntimeEngine } from "../src/builtin/acceleration.js";
import { failureOf } from "../src/builtin/failure.js";
import { mkdir } from "node:fs/promises";

const GIB = 1024 ** 3;

test("every entry of the catalogue is pinned: revision, size, digest, file named after its id", () => {
  assert.ok(CATALOG.length >= 2);
  for (const model of CATALOG) {
    assert.equal(model.file, `${model.id}.gguf`);
    assert.match(model.url, /^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+\/resolve\/[0-9a-f]{40}\//, `${model.id}: not pinned to a revision`);
    // Osmove's own conversions (scripts/convert-model.sh), the publisher's
    // or llama.cpp's own — never a competitor's (Unsloth, LM Studio, …).
    assert.match(model.url, /^https:\/\/huggingface\.co\/(?:twoody|google|mistralai|Qwen|ggml-org)\//, `${model.id}: not Osmove's, the publisher's or llama.cpp's`);
    if (model.recommendable) assert.match(model.url, /^https:\/\/huggingface\.co\/twoody\//, `${model.id}: a recommended model is Osmove's`);
    if (model.vision) {
      assert.match(model.vision.url, /^https:\/\/huggingface\.co\/(?:twoody|google|mistralai|Qwen|ggml-org)\/[\w.-]+\/resolve\/[0-9a-f]{40}\//, `${model.id}: its vision file is pinned too`);
      assert.match(model.vision.sha256, /^[0-9a-f]{64}$/);
      assert.equal(visionDownload(model)!.file, `${model.id}.mmproj.gguf`);
    }
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

// A first launch on a modest computer (10/10/2026): where the engine runs
// the model decides as much as how much memory there is.
test("an Intel Mac runs on its processor: the 4B below 32 GB, like a PC without a graphics card", () => {
  for (const gb of [8, 16, 24]) assert.equal(recommendedModel(gb * GIB, CATALOG, "darwin", { arch: "x64" })!.id, "Qwen3.5-4B-Q4_K_M");
  assert.equal(recommendedModel(32 * GIB, CATALOG, "darwin", { arch: "x64" })!.id, "Qwen3.5-9B-Q4_K_M");
  // Apple silicon: its memory is the GPU's.
  assert.equal(recommendedModel(15.9 * GIB, CATALOG, "darwin", { arch: "arm64" })!.id, "Qwen3.5-9B-Q4_K_M");
  assert.equal(recommendedModel(8 * GIB, CATALOG, "darwin", { arch: "arm64" })!.id, "Qwen3.5-4B-Q4_K_M");
});

test("a PC whose graphics card holds the 9B whole gets the 9B from 16 GB; a smaller or shared one does not", () => {
  const MIB = 1024 ** 2;
  const pick = (ramGb: number, vramMib: number | null) => recommendedModel(ramGb * GIB, CATALOG, "win32", { dedicatedVramBytes: vramMib === null ? null : vramMib * MIB })!.id;
  assert.equal(pick(16, 12_288), "Qwen3.5-9B-Q4_K_M");
  assert.equal(pick(15.8, 10_240), "Qwen3.5-9B-Q4_K_M"); // a "16 GB" PC, a "10 GB" card
  assert.equal(pick(16, 8_192), "Qwen3.5-4B-Q4_K_M");
  assert.equal(pick(8, 24_576), "Qwen3.5-4B-Q4_K_M"); // the card is large, the computer is not
  assert.equal(pick(16, null), "Qwen3.5-4B-Q4_K_M");
  assert.equal(pick(32, null), "Qwen3.5-9B-Q4_K_M");
  // Linux runs on its processor whatever the card says.
  assert.equal(recommendedModel(16 * GIB, CATALOG, "linux")!.id, "Qwen3.5-4B-Q4_K_M");
  assert.equal(catalogView(CATALOG, [], 16 * GIB, "win32", { dedicatedVramBytes: 12 * GIB }).find((entry) => entry.recommended)!.id, "Qwen3.5-9B-Q4_K_M");
});

test("a graphics card's own memory is read from Vulkan's device list; an integrated one does not count", () => {
  const discrete = [
    "ggml_vulkan: Found 2 Vulkan devices:",
    "ggml_vulkan: 0 = NVIDIA GeForce RTX 4070 (NVIDIA) | uma: 0 | fp16: 1 | bf16: 0 | warp size: 32 | shared memory: 49152 | int dot: 1 | matrix cores: NV_coopmat2",
    "ggml_vulkan: 1 = Intel(R) UHD Graphics 770 (Intel Corporation) | uma: 1 | fp16: 1 | bf16: 0 | warp size: 32 | shared memory: 32768 | int dot: 1 | matrix cores: none",
    "Available devices:",
    "  Vulkan0: NVIDIA GeForce RTX 4070 (12282 MiB, 11468 MiB free)",
    "  Vulkan1: Intel(R) UHD Graphics 770 (16233 MiB, 16000 MiB free)",
  ].join("\n");
  assert.equal(dedicatedGpuMemory(discrete), 12_282 * 1024 ** 2);
  const integrated = "ggml_vulkan: 0 = AMD Radeon(TM) Graphics (AMD proprietary driver) | uma: 1 | fp16: 1\n  Vulkan0: AMD Radeon(TM) Graphics (16384 MiB, 15000 MiB free)";
  assert.equal(dedicatedGpuMemory(integrated), null);
  // The kind not said: not counted.
  assert.equal(dedicatedGpuMemory("  Vulkan0: GPU (8192 MiB, 7000 MiB free)"), null);
  assert.equal(dedicatedGpuMemory(""), null);
});

test("the pinned entries are the Desktop's, byte for byte", () => {
  assert.deepEqual(
    CATALOG.map((model) => [model.id, model.bytes, model.sha256]),
    [
      ["Qwen3.5-4B-Q4_K_M", 2_783_446_880, "b7508d8b4a652bc020a439aafdd4ce1527d49774865ce3334a43b16dbeaa90ca"],
      ["Qwen3.5-9B-Q4_K_M", 5_780_090_688, "8c4cc24f54473f3d4e080d4ec7fd2a40d0bbec0f94f3c807cd62694905357d54"],
      ["DeepSeek-R1-0528-Qwen3-8B-Q4_K_M", 5_027_782_816, "4422f4ed58f2a0d1b4b93067fd312207c2adc326a30f67a3bf9914f889d1d7cc"],
      ["gemma-4-12b-it-qat-q4_0", 6_975_879_296, "93567e57a8fe10b23569b9d9ec38cd005deedf71e29477c421a4b83f418a538b"],
      ["Ministral-3-14B-Instruct-2512-Q4_K_M", 8_239_593_024, "824e0f3373e69b84f2cae46fdcb9bd1ebc6ab3bfc7acc125d818b7b8178cc613"],
      ["Qwen3-14B-Q4_K_M", 9_001_752_960, "500a8806e85ee9c83f3ae08420295592451379b4f8cf2d0f41c15dffeb6b81f0"],
      ["gpt-oss-20b-MXFP4", 12_109_566_624, "27cd6c432c7672cb812a92f611cf3ba7bbc35928262bb1e1253ff4ee6ae35901"],
      ["gemma-4-26B_q4_0-it", 14_439_363_584, "3eca3b8f6d7baf218a7dd6bba5fb59a56ee25fe2d567b6f5f589b4f697eca51d"],
    ],
  );
});

// More models to choose from (Jimmy, 01/10/2026), but the one recommended
// stays a Qwen3.5 of Twoody's own: memory and tools are measured with it.
test("the recommendation stays a Qwen3.5 of Twoody's, however large the computer", () => {
  assert.equal(recommendedModel(64 * GIB, CATALOG, "darwin")?.id, "Qwen3.5-9B-Q4_K_M");
  assert.equal(recommendedModel(8 * GIB, CATALOG, "darwin")?.id, "Qwen3.5-4B-Q4_K_M");
  // Images: Qwen3.5, Gemma 4 and Ministral 3 read them.
  assert.deepEqual(CATALOG.filter((model) => model.vision).map((model) => model.id), ["Qwen3.5-4B-Q4_K_M", "Qwen3.5-9B-Q4_K_M", "gemma-4-12b-it-qat-q4_0", "Ministral-3-14B-Instruct-2512-Q4_K_M", "gemma-4-26B_q4_0-it"]);
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
      ["DeepSeek-R1-0528-Qwen3-8B-Q4_K_M", false, false, true],
      ["gemma-4-12b-it-qat-q4_0", false, false, true],
      ["Ministral-3-14B-Instruct-2512-Q4_K_M", false, false, false],
      ["Qwen3-14B-Q4_K_M", false, false, false],
      ["gpt-oss-20b-MXFP4", false, false, false],
      ["gemma-4-26B_q4_0-it", false, false, false],
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
