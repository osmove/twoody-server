import { sqlite } from "../db.js";
import { memoryVectors } from "./embeddings.js";
import { memoryWords } from "./rank.js";

// « Doublons possibles » (Jimmy, 01/10/2026: « N'y a-t-il pas de
// doublons ? »): two current memories that say much the same, by meaning
// when this computer has the vectors, else by their words — two imports of
// the same fact from the account and from Claude, mostly. The person keeps
// one, merges them, or says they differ (never shown again); nothing is
// changed for them.

/// Cosine from which two memories are shown: on Jimmy's 150 memories,
/// 0.85 caught the facts said twice (e-mails without icons, BRD order…)
/// with a few related ones the person can dismiss.
export const SIMILAR_COSINE = 0.85;
const SIMILAR_WORDS = 0.6;
const MAX_PAIRS = 12;

interface Row { id: string; content: string; title: string | null; tags_json: string; source: string; source_ref: string | null; created_at: number }

export interface SimilarMemory { id: string; title: string | null; content: string; source: string; source_ref: string | null; created_at: string }
export interface SimilarPair { score: number; by: "meaning" | "words"; memories: [SimilarMemory, SimilarMemory] }

const pairKey = (a: string, b: string) => (a < b ? `${a}\n${b}` : `${b}\n${a}`);

function dismissed(userId: string): Set<string> {
  return new Set((sqlite.prepare("SELECT a, b FROM memory_pairs_dismissed WHERE user_id = ?").all(userId) as Array<{ a: string; b: string }>).map((row) => pairKey(row.a, row.b)));
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export function similarMemories(userId: string): SimilarPair[] {
  const rows = (sqlite.prepare("SELECT id, title, content, tags_json, source, source_ref, created_at FROM memories WHERE user_id = ? AND superseded_by_id IS NULL").all(userId) as Row[])
    .filter((row) => row.content.trim() && !/"archive"/.test(row.tags_json));
  const vectors = memoryVectors(userId);
  const words = new Map(rows.map((row) => [row.id, new Set(memoryWords(`${row.title ?? ""} ${row.content}`).filter((word) => word.length > 2))]));
  const skip = dismissed(userId);
  const pairs: Array<{ score: number; by: "meaning" | "words"; a: Row; b: Row }> = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i]!, b = rows[j]!;
      if (skip.has(pairKey(a.id, b.id))) continue;
      const va = vectors.get(a.id), vb = vectors.get(b.id);
      if (va && vb) {
        const score = cosine(va, vb);
        if (score >= SIMILAR_COSINE) pairs.push({ score, by: "meaning", a, b });
      } else {
        const score = jaccard(words.get(a.id)!, words.get(b.id)!);
        if (score >= SIMILAR_WORDS) pairs.push({ score, by: "words", a, b });
      }
    }
  }
  const shown = (row: Row): SimilarMemory => ({ id: row.id, title: row.title, content: row.content, source: row.source, source_ref: row.source_ref, created_at: new Date(row.created_at * 1000).toISOString() });
  return pairs
    .sort((x, y) => y.score - x.score)
    .slice(0, MAX_PAIRS)
    // The older first: the one most likely to be kept.
    .map(({ score, by, a, b }) => ({ score: Math.round(score * 1000) / 1000, by, memories: (a.created_at <= b.created_at ? [shown(a), shown(b)] : [shown(b), shown(a)]) as [SimilarMemory, SimilarMemory] }));
}

/// « Ce n'est pas la même chose »: this pair is never shown again.
export function dismissPair(userId: string, a: string, b: string, now = Date.now()) {
  const [first, second] = a < b ? [a, b] : [b, a];
  sqlite.prepare("INSERT OR IGNORE INTO memory_pairs_dismissed (user_id, a, b, created_at) VALUES (?, ?, ?, ?)").run(userId, first, second, now);
}
