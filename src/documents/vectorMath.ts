import type { Passage } from "./library.js";
export function normalizedVector(value: unknown): Float32Array {
  if (
    !Array.isArray(value) ||
    value.length !== 1024 ||
    value.some((x) => typeof x !== "number" || !Number.isFinite(x))
  )
    throw Error("invalid_embedding");
  const norm = Math.sqrt(value.reduce((s, x) => s + x * x, 0));
  if (!norm) throw Error("invalid_embedding");
  return Float32Array.from(value, (x) => x / norm);
}

/** Reciprocal-rank fusion preserves precise lexical hits and adds semantic matches. */
export function fusePassages(
  lexical: Passage[],
  semantic: Passage[],
  limit = 6,
): Passage[] {
  const ranked = new Map<string, { passage: Passage; score: number }>();
  for (const list of [lexical, semantic])
    list.forEach((passage, index) => {
      const key = JSON.stringify([
        passage.document_id,
        passage.page,
        passage.text,
      ]);
      const row = ranked.get(key) ?? { passage, score: 0 };
      row.score += 1 / (60 + index);
      ranked.set(key, row);
    });
  const counts = new Map<string, number>();
  return [...ranked.values()]
    .sort((a, b) => b.score - a.score)
    .filter(({ passage }) => {
      const n = counts.get(passage.document_id) ?? 0;
      if (n >= 3) return false;
      counts.set(passage.document_id, n + 1);
      return true;
    })
    .slice(0, limit)
    .map((row) => row.passage);
}
