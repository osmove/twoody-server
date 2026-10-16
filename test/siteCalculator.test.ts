// twoody.com's calculator says what Twoody says (scripts/site-calculator.ts):
// what it reads — site/twoody-models.json — and what its Ruby port of
// memory.ts is checked against — site/memory-parity.json — are what the
// catalogue, memory.ts and recommendedModel() give now. A change to any of
// them fails here until the script is run again, and its files committed
// here and in twoody-backend (which checks its port against them).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CATALOG, recommendedModel } from "../src/builtin/catalog.js";
import { catalogMemoryNeed } from "../src/builtin/memory.js";
import { BACKEND_DIR, BACKEND_FILES, FILES, outputs, readFetched, SITE_DIR, SITE_ONLY } from "../scripts/site-calculator.js";

const GIB = 1024 ** 3;
const REGENERATE = "run `node --import tsx scripts/site-calculator.ts`, then commit site/ here and the copies in twoody-backend";

test("site/ holds what the catalogue, memory.ts and recommendedModel() say now", () => {
  const fetched = readFetched();
  const written = outputs(fetched);
  assert.equal(readFileSync(join(SITE_DIR, FILES.models), "utf8"), written.models, `site/${FILES.models} is out of date: ${REGENERATE}`);
  assert.equal(readFileSync(join(SITE_DIR, FILES.parity), "utf8"), written.parity, `site/${FILES.parity} is out of date: ${REGENERATE}`);
});

test("every catalogue model, and every model the calculator adds, is in the site's data", () => {
  const fetched = readFetched();
  for (const model of CATALOG) {
    const architecture = fetched.architectures[model.key!];
    assert.ok(architecture && architecture.layers > 0, `${model.key}: no layer count in site/${FILES.fetched} — run scripts/site-calculator.ts --refresh`);
  }
  assert.deepEqual(fetched.models.map((model) => model.key), SITE_ONLY.map((source) => source.key), `site/${FILES.fetched}: run scripts/site-calculator.ts --refresh`);
  const exported = JSON.parse(readFileSync(join(SITE_DIR, FILES.models), "utf8")) as { models: Array<{ key: string; in_catalogue: boolean; min_ram_gb: number }> };
  assert.deepEqual(exported.models.filter((model) => model.in_catalogue).map((model) => model.key), CATALOG.map((model) => model.key));
  for (const model of fetched.models) {
    assert.ok(!CATALOG.some((entry) => entry.key === model.key), `${model.key} is in the catalogue now: take it out of SITE_ONLY`);
    assert.ok(model.bytes > 1e10 && model.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256)), model.key);
  }
});

test("the fixture is memory.ts's answer: two spot checks against the measured models", () => {
  const parity = JSON.parse(readFileSync(join(SITE_DIR, FILES.parity), "utf8")) as { memory_gib: number[]; models: Record<string, { llamacpp: number[]; context: number[] }>; recommended: Array<{ memory_gib: number; platform: string; arch: string; vram_bytes: number | null; key: string | null }> };
  const at = parity.memory_gib.indexOf(16);
  const nine = CATALOG.find((model) => model.key === "qwen3.5-9b")!;
  // Qwen3.5 9B with its vision file at 32 768 tokens: 7.4 GiB, measured (builtinMemory.test.ts).
  assert.equal(parity.models["qwen3.5-9b"]!.llamacpp[at], catalogMemoryNeed(nine, 16 * GIB));
  assert.equal(Math.round((parity.models["qwen3.5-9b"]!.llamacpp[at]! / GIB) * 10) / 10, 7.4);
  assert.equal(parity.models["qwen3.5-9b"]!.context[at], 32_768);
  for (const row of parity.recommended) {
    assert.equal(row.key, recommendedModel(row.memory_gib * GIB, CATALOG, row.platform as NodeJS.Platform, { arch: row.arch, dedicatedVramBytes: row.vram_bytes })?.key ?? null);
  }
});

const backend = existsSync(join(BACKEND_DIR, "config"));

test("twoody-backend's copies are byte for byte the server's", { skip: backend ? false : "twoody-backend is not next to this checkout" }, () => {
  const written = outputs(readFetched());
  for (const name of ["models", "parity"] as const) {
    const path = join(BACKEND_DIR, BACKEND_FILES[name]);
    assert.ok(existsSync(path), `${path} is missing: ${REGENERATE}`);
    assert.equal(readFileSync(path, "utf8"), written[name], `${path} differs from site/${FILES[name]}: ${REGENERATE}`);
  }
});
