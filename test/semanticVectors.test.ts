import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The semantic scan reads each stored vector as a Float32Array view of the
// SQLite blob instead of calling readFloatLE 1024 times
// (docs/mesh-design.md §0): the same scores to the last bit, in less time.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-semantic-vectors-"));
const { vectorScore, vectorView } = await import("../src/documents/semantic.js");

const DIM = 1024;

function prng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32 - 0.5;
  };
}

function normalised(random: () => number): Float32Array {
  const v = Float32Array.from({ length: DIM }, random);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

/// As indexSemantic writes it: Buffer.from(vector.buffer).
const blobOf = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

/// The loop semanticPassages had before.
function readFloatLEScore(query: Float32Array, blob: Buffer): number {
  let score = 0;
  for (let i = 0; i < query.length; i++) score += query[i]! * blob.readFloatLE(i * 4);
  return score;
}

test("the view gives exactly the scores the readFloatLE loop gave, aligned or not", () => {
  const random = prng(7);
  const query = normalised(random);
  for (let n = 0; n < 500; n++) {
    const blob = blobOf(normalised(random));
    assert.equal(vectorScore(query, blob), readFloatLEScore(query, blob));
    // A blob that does not start on a 4-byte boundary is copied, same result.
    const shifted = Buffer.alloc(blob.length + 1);
    blob.copy(shifted, 1);
    const unaligned = shifted.subarray(1);
    assert.equal(unaligned.byteOffset % 4, 1);
    assert.equal(vectorScore(query, unaligned), readFloatLEScore(query, unaligned));
  }
  const blob = blobOf(normalised(random));
  const view = vectorView(blob);
  assert.equal(view.length, DIM);
  assert.equal(view.buffer, blob.buffer, "a view, not a copy, when aligned");
});

test("micro-benchmark: 20 000 × 1024 vectors, view against readFloatLE", () => {
  const random = prng(2026);
  const query = normalised(random);
  // One Buffer per row, as better-sqlite3 hands them.
  const rows = Array.from({ length: 20_000 }, () => blobOf(normalised(random)));

  const run = (score: (q: Float32Array, b: Buffer) => number) => {
    const started = process.hrtime.bigint();
    let above = 0;
    let sum = 0;
    for (const row of rows) {
      const s = score(query, row);
      sum += s;
      if (s >= 0.35) above += 1;
    }
    return { ms: Number(process.hrtime.bigint() - started) / 1e6, sum, above };
  };
  // Warm both up, then keep the best of three of each.
  run(readFloatLEScore);
  run(vectorScore);
  const before = [run(readFloatLEScore), run(readFloatLEScore), run(readFloatLEScore)];
  const after = [run(vectorScore), run(vectorScore), run(vectorScore)];
  const best = (runs: typeof before) => Math.min(...runs.map((r) => r.ms));
  assert.equal(after[0]!.sum, before[0]!.sum, "identical results");
  assert.equal(after[0]!.above, before[0]!.above);
  console.log(`# semantic scan 20000×1024: readFloatLE ${best(before).toFixed(1)} ms, Float32Array view ${best(after).toFixed(1)} ms (×${(best(before) / best(after)).toFixed(1)})`);
  // Timing on a shared machine is noisy: only a clear regression fails.
  assert.ok(best(after) <= best(before) * 1.25, `view ${best(after)} ms vs readFloatLE ${best(before)} ms`);
});
