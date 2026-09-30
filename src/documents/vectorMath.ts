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
  // One computer's two lists: the same passage in both is one passage.
  return fuseRankedLists(
    [
      { key: "lexical", passages: lexical },
      { key: "semantic", passages: semantic },
    ],
    { limit, sourceOf: () => "", reserve: false },
  );
}

/// What fusion needs of a passage, wherever it was found.
export interface FusablePassage {
  document_id: string;
  page: number | null;
  text: string;
  match?: "content" | "name" | "semantic";
  cosine?: number;
}

/// One computer's list, best first, and the embedding model its cosines
/// come from (null: none, or lexical only).
export interface RankedList<P> {
  key: string;
  passages: P[];
  embedModel?: string | null;
}

/// A semantic-only passage below this cosine does not earn its computer a
/// place of its own (docs/mesh-design.md §2: « ≥1 per computer above floor »).
export const COSINE_FLOOR = 0.5;
const RRF_K = 60;

/**
 * N ranked lists — this computer's and each trusted computer's that
 * answered in time (docs/mesh-design.md §2) — as one, best first:
 *
 *  - reciprocal rank over the lists (1 / (60 + rank));
 *  - when every list that has cosines got them from the same embedding
 *    model, the cosines are comparable: their ranking across all the lists
 *    counts as one list more (a cosine from another model is never
 *    compared);
 *  - at most `perDocument` (3) passages of one document;
 *  - each source (computer) whose best passage is above the floor — a
 *    lexical match, or a cosine ≥ COSINE_FLOOR — keeps at least one place;
 *  - `limit` passages, whose texts together fit in `budgetChars` (a text is
 *    cut to what is left, and dropped under 200 characters).
 *
 * `sourceOf` says which source a passage is from (its list by default):
 * the per-document cap and the reserved place are per source.
 */
export function fuseRankedLists<P extends FusablePassage>(
  lists: Array<RankedList<P>>,
  options: { limit?: number; perDocument?: number; budgetChars?: number; floor?: number; sourceOf?: (passage: P, list: string) => string; reserve?: boolean } = {},
): P[] {
  const limit = Math.max(1, options.limit ?? 6);
  const perDocument = Math.max(1, options.perDocument ?? 3);
  const floor = options.floor ?? COSINE_FLOOR;
  const sourceOf = options.sourceOf ?? ((_: P, list: string) => list);
  type Row = { passage: P; source: string; score: number; order: number };
  const rows = new Map<string, Row>();
  let order = 0;
  const rowOf = (passage: P, list: string): Row => {
    const source = sourceOf(passage, list);
    const key = JSON.stringify([source, passage.document_id, passage.page, passage.text]);
    let row = rows.get(key);
    if (!row) rows.set(key, (row = { passage, source, score: 0, order: order++ }));
    return row;
  };
  for (const list of lists) list.passages.forEach((passage, index) => (rowOf(passage, list.key).score += 1 / (RRF_K + index)));

  const withCosines = lists.filter((list) => list.passages.some((p) => typeof p.cosine === "number"));
  const models = new Set(withCosines.map((list) => list.embedModel ?? null));
  if (withCosines.length > 1 && models.size === 1 && !models.has(null)) {
    const byCosine = withCosines
      .flatMap((list) => list.passages.filter((p) => typeof p.cosine === "number").map((passage) => ({ row: rowOf(passage, list.key), cosine: passage.cosine! })))
      .sort((a, b) => b.cosine - a.cosine);
    const seen = new Set<Row>();
    let rank = 0;
    for (const { row } of byCosine) {
      if (seen.has(row)) continue;
      seen.add(row);
      row.score += 1 / (RRF_K + rank++);
    }
  }

  const ranked = [...rows.values()].sort((a, b) => b.score - a.score || a.order - b.order);
  const perDoc = new Map<string, number>();
  const docKey = (row: Row) => JSON.stringify([row.source, row.passage.document_id]);
  const take = (row: Row) => perDoc.set(docKey(row), (perDoc.get(docKey(row)) ?? 0) + 1);
  const chosen = new Set<Row>();
  const reserved: Row[] = [];
  if (options.reserve !== false) {
    const sources = new Set<string>();
    for (const row of ranked) {
      if (sources.has(row.source)) continue;
      const above = row.passage.match !== "semantic" || (typeof row.passage.cosine === "number" && row.passage.cosine >= floor);
      if (!above) continue;
      sources.add(row.source);
      if (reserved.length < limit) reserved.push(row);
    }
    for (const row of reserved) {
      chosen.add(row);
      take(row);
    }
  }
  for (const row of ranked) {
    if (chosen.size >= limit) break;
    if (chosen.has(row) || (perDoc.get(docKey(row)) ?? 0) >= perDocument) continue;
    chosen.add(row);
    take(row);
  }

  // The reserved places are served first from the budget, then the rest
  // best first; the answer keeps the fused order.
  const budget = options.budgetChars;
  const kept = new Map<Row, P>();
  if (budget === undefined) for (const row of chosen) kept.set(row, row.passage);
  else {
    let room = budget;
    for (const row of [...reserved, ...ranked.filter((r) => chosen.has(r) && !reserved.includes(r))]) {
      if (room < 200) break;
      const text = row.passage.text.length > room ? row.passage.text.slice(0, room) : row.passage.text;
      room -= text.length;
      kept.set(row, text === row.passage.text ? row.passage : { ...row.passage, text });
    }
  }
  return ranked.filter((row) => kept.has(row)).map((row) => kept.get(row)!);
}
