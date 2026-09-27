import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizedVector, fusePassages } from "../src/documents/vectorMath.js";
test("vectors reject wrong dimensions, NaNs and empty information", () => {
  for (const v of [
    [],
    Array(1024).fill(0),
    Array(1024).fill(NaN),
    Array(4).fill(1),
  ])
    assert.throws(() => normalizedVector(v));
  const v = normalizedVector(Array(1024).fill(1));
  assert.ok(Math.abs(v.reduce((s, x) => s + x * x, 0) - 1) < 0.00001);
});
test("fusion boosts matches from both methods, deduplicates and preserves diversity", () => {
  const p = (id: string, text = id) => ({
    document_id: id,
    name: id,
    path: id,
    text,
    page: null,
    snippet: text,
  });
  const result = fusePassages(
    [p("a"), p("b")],
    [p("b"), p("c"), p("c", "c2"), p("c", "c3"), p("c", "c4")],
    10,
  );
  assert.equal(result[0].document_id, "b");
  assert.equal(result.filter((x) => x.document_id === "b").length, 1);
  assert.equal(result.filter((x) => x.document_id === "c").length, 3);
});
