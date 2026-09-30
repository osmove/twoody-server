import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizedVector, fusePassages, fuseRankedLists } from "../src/documents/vectorMath.js";
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

test("N computers' lists: RRF, cosines compared under one embedding model only, a place per computer, the budget", () => {
  type P = { document_id: string; page: number | null; text: string; match?: "content" | "name" | "semantic"; cosine?: number; computer: string };
  const p = (computer: string, id: string, extra: Partial<P> = {}): P => ({ computer, document_id: id, page: null, text: `${computer}:${id}`, match: "content", ...extra });
  const mac = Array.from({ length: 8 }, (_, i) => p("mac", `m${i}`));
  const pi = [p("pi", "p0")];
  // Plain RRF: the Pi's best is second (rank 1 on each list), never pushed out by the Mac's eight.
  const fused = fuseRankedLists([{ key: "mac", passages: mac }, { key: "pi", passages: pi }], { limit: 4 });
  assert.deepEqual(fused.map((x) => x.text), ["mac:m0", "pi:p0", "mac:m1", "mac:m2"]);
  // The same document id on two computers is two documents: ≤ 3 each.
  const same = fuseRankedLists([
    { key: "mac", passages: [1, 2, 3, 4].map((i) => p("mac", "d", { text: `mac ${i}` })) },
    { key: "pi", passages: [1, 2, 3, 4].map((i) => p("pi", "d", { text: `pi ${i}` })) },
  ], { limit: 8 });
  assert.equal(same.filter((x) => x.computer === "mac").length, 3);
  assert.equal(same.filter((x) => x.computer === "pi").length, 3);
  // Same embedding model: the Pi's 0.9 passage outranks the Mac's 0.4 one ranked first there.
  const sem = (computer: string, id: string, cosine: number) => p(computer, id, { match: "semantic", cosine });
  const comparable = fuseRankedLists([
    { key: "mac", passages: [sem("mac", "a", 0.4), sem("mac", "b", 0.38)], embedModel: "bge-m3" },
    { key: "pi", passages: [sem("pi", "c", 0.9), sem("pi", "d", 0.2)], embedModel: "bge-m3" },
  ], { limit: 4 });
  assert.equal(comparable[0]!.text, "pi:c");
  // Different models: cosines are not compared, list order decides ties.
  const apart = fuseRankedLists([
    { key: "mac", passages: [sem("mac", "a", 0.4)], embedModel: "bge-m3" },
    { key: "pi", passages: [sem("pi", "c", 0.9)], embedModel: "nomic" },
  ], { limit: 4 });
  assert.equal(apart[0]!.text, "mac:a");
  // A place for each computer above the floor; below it, none.
  const strong = (computer: string) => [sem(computer, `${computer}1`, 0.95), sem(computer, `${computer}2`, 0.94), sem(computer, `${computer}3`, 0.93)];
  const lists = (piCosine: number) => [
    { key: "mac", passages: strong("mac"), embedModel: "bge-m3" },
    { key: "nas", passages: strong("nas"), embedModel: "bge-m3" },
    { key: "pi", passages: [sem("pi", "w", piCosine)], embedModel: "bge-m3" },
  ];
  assert.ok(fuseRankedLists(lists(0.55), { limit: 3 }).some((x) => x.computer === "pi"), "above the floor: kept");
  assert.ok(!fuseRankedLists(lists(0.36), { limit: 3 }).some((x) => x.computer === "pi"), "below the floor: no place of its own");
  // The budget: texts together within it, the last one cut, none under 200 characters.
  const long = (computer: string, id: string) => p(computer, id, { text: "x".repeat(1_000) });
  const trimmed = fuseRankedLists([{ key: "mac", passages: [long("mac", "1"), long("mac", "2")] }, { key: "pi", passages: [long("pi", "3")] }], { limit: 8, budgetChars: 2_500 });
  assert.equal(trimmed.reduce((sum, x) => sum + x.text.length, 0), 2_500);
  assert.equal(trimmed.length, 3);
  assert.equal(fuseRankedLists([{ key: "mac", passages: [long("mac", "1"), long("mac", "2")] }], { budgetChars: 1_150 }).length, 1);
});
