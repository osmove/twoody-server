import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// 01/11/2026: the Desktop says which models are on its disk (`builtin-models`,
// index.ts); while its runtime does not answer — not started yet, or stopped
// once the last model was removed — they are what /v1/models and `twoody
// list` show, none of them in memory, instead of the model the provider was
// set up with (which `twoody list` still named, « in memory », after `twoody rm`).

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-desktop-models-"));
// A port nothing listens on: the runtime is stopped.
const probe = createServer();
await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
const port = (probe.address() as AddressInfo).port;
await new Promise<void>((done) => probe.close(() => done()));
const base = `http://127.0.0.1:${port}/v1`;
process.env.BRIDGE_LOCAL_LLM_ENDPOINT = base;

const { localModels, noteDesktopModels } = await import("../src/account/statusSource.js");

test("a silent runtime: the Desktop's models on disk, none in memory; none once the last is removed", async () => {
  assert.deepEqual(await localModels(), []);
  noteDesktopModels(`${base}/`, ["Qwen3.5-9B-Q4_K_M", "Qwen3.5-0.8B-Q4_K_M"]);
  assert.deepEqual(await localModels(), [
    { id: "Qwen3.5-9B-Q4_K_M", baseUrl: base, loaded: false },
    { id: "Qwen3.5-0.8B-Q4_K_M", baseUrl: base, loaded: false },
  ]);
  noteDesktopModels(base, []);
  assert.deepEqual(await localModels(), []);
});
