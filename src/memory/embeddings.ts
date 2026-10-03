import { createHash } from "node:crypto";
import { sqlite } from "../db.js";
import { EMBED_MODEL, embed, embeddingFilesPresent, vectorView } from "../embeddings.js";
import { inflight } from "../account/inflight.js";

// The memories' vectors (docs/memory-v2-design.md §3, lot L1): made on this
// computer with its embedding model (src/embeddings.ts), kept in
// memory_embeddings — never synchronised, each computer embeds with its
// own — and read through an in-memory cache of Float32Arrays, dropped at
// every write.
//
// On by default once the model files are on the computer (the Desktop
// downloads them with « Rechercher par le sens »); `memory_embeddings:
// false` in the person's prefs switches them off. A memory is embedded
// after it is written and after a vault sync brought some, when the
// computer generates nothing (inflight() = 0): a chat turn always comes
// first, the job waits for it and goes on after.
//
// Retrieval v2 (src/memory/retrieve.ts) reads them to answer; the search of
// the memories (src/memory/search.ts) too.

/// What a question looks for among the memories (Qwen3-Embedding's
/// instruction, for the query side only).
export const MEMORY_QUERY_INSTRUCTION = "Given a message to a personal assistant, retrieve facts about the user that help answer it.";

type Row = { id: string; title: string | null; content: string; tags: string };

/// The text a memory is embedded from: its line, as a prompt gives it.
export function memoryEmbeddingText(memory: { title: string | null; content: string }): string {
  const body = memory.content.trim().replace(/\s+/g, " ");
  const title = memory.title?.trim().replace(/…$/, "");
  return title && !body.startsWith(title) ? `${title}: ${body}` : body;
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

function prefsOf(userId: string): Record<string, unknown> {
  const row = sqlite.prepare("SELECT prefs FROM users WHERE id = ?").get(userId) as { prefs: string } | undefined;
  try {
    const parsed = JSON.parse(row?.prefs || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/// Whether this person's memories are embedded on this computer.
export function memoryEmbeddingsEnabled(userId: string): boolean {
  return prefsOf(userId).memory_embeddings !== false && embeddingFilesPresent();
}

/// The memories a search would read: current, with something to say, not
/// the whole answer an import keeps for the person to read.
function candidates(userId: string): Row[] {
  return (sqlite.prepare("SELECT id, title, content, tags FROM memories WHERE user_id = ? AND superseded_by_id IS NULL ORDER BY updated_at DESC, id").all(userId) as Row[])
    .filter((row) => row.content.trim() && !/"archive"/.test(row.tags));
}

// ── the cache ─────────────────────────────────────────────────────────────

const cache = new Map<string, Map<string, Float32Array>>();

/// Every vector there is for this person's memories, by memory id: the
/// ones made from the memory's text as it is now, with this computer's
/// model. Built once, then held until a memory or a vector changes.
export function memoryVectors(userId: string): Map<string, Float32Array> {
  const known = cache.get(userId);
  if (known) return known;
  const stored = new Map(
    (sqlite.prepare("SELECT memory_id, hash, vector FROM memory_embeddings WHERE user_id = ? AND model = ?").all(userId, EMBED_MODEL) as Array<{ memory_id: string; hash: string; vector: Buffer }>)
      .map((row) => [row.memory_id, row] as const),
  );
  const vectors = new Map<string, Float32Array>();
  for (const memory of candidates(userId)) {
    const row = stored.get(memory.id);
    // A copy: the cache outlives the blob's buffer.
    if (row && row.hash === digest(memoryEmbeddingText(memory))) vectors.set(memory.id, Float32Array.from(vectorView(row.vector)));
  }
  cache.set(userId, vectors);
  return vectors;
}

/// The person switched memory embeddings off: their vectors go.
export function dropVectorsIfSwitchedOff(userId: string): number {
  if (prefsOf(userId).memory_embeddings !== false) return 0;
  const removed = sqlite.prepare("DELETE FROM memory_embeddings WHERE user_id = ?").run(userId).changes;
  if (removed) invalidateMemoryVectors(userId);
  return removed;
}

/// Drops the cache (a memory was written, deleted, or synchronised).
export function invalidateMemoryVectors(userId?: string | null) {
  if (userId) cache.delete(userId);
  else cache.clear();
}

/// The vector of a question about the memories.
export function embedMemoryQuery(text: string): Promise<Float32Array> {
  return embed(text, MEMORY_QUERY_INSTRUCTION);
}

// ── the job ───────────────────────────────────────────────────────────────

const jobs = new Map<string, { running: boolean; error: boolean }>();

export function memoryEmbeddingStatus(userId: string) {
  const total = candidates(userId).length;
  return {
    enabled: memoryEmbeddingsEnabled(userId),
    available: embeddingFilesPresent(),
    running: jobs.get(userId)?.running ?? false,
    error: jobs.get(userId)?.error ?? false,
    indexed: memoryVectors(userId).size,
    total,
    model: EMBED_MODEL,
  };
}

/// Embeds this person's memories that have no vector for their text yet,
/// and drops the vectors of memories gone. Stops when the computer starts
/// generating (`busy` says so): returns `yielded` then, to go on later.
export async function embedPendingMemories(userId: string, options: { busy?: () => boolean } = {}): Promise<{ embedded: number; reused: number; removed: number; yielded: boolean }> {
  const busy = options.busy ?? (() => inflight() > 0);
  const result = { embedded: 0, reused: 0, removed: 0, yielded: false };
  if (jobs.get(userId)?.running) return result;
  const job = { running: true, error: false };
  jobs.set(userId, job);
  try {
    // Gone, or made by another model: of no use here.
    result.removed = sqlite.prepare(
      "DELETE FROM memory_embeddings WHERE user_id = ? AND (model != ? OR memory_id NOT IN (SELECT id FROM memories WHERE user_id = ?))",
    ).run(userId, EMBED_MODEL, userId).changes;
    if (result.removed) invalidateMemoryVectors(userId);
    if (!memoryEmbeddingsEnabled(userId)) return result;
    const stored = new Map(
      (sqlite.prepare("SELECT memory_id, hash FROM memory_embeddings WHERE user_id = ? AND model = ?").all(userId, EMBED_MODEL) as Array<{ memory_id: string; hash: string }>)
        .map((row) => [row.memory_id, row.hash] as const),
    );
    const put = sqlite.prepare(
      `INSERT INTO memory_embeddings (memory_id, user_id, model, hash, vector, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(memory_id, model) DO UPDATE SET hash = excluded.hash, vector = excluded.vector, created_at = excluded.created_at`,
    );
    // The same text under another id (a memory renamed by the vault's first
    // upload, the same fact twice) takes the vector there is.
    const byHash = sqlite.prepare("SELECT vector FROM memory_embeddings WHERE user_id = ? AND model = ? AND hash = ? LIMIT 1");
    const current = sqlite.prepare("SELECT title, content FROM memories WHERE id = ? AND user_id = ?");
    for (const memory of candidates(userId)) {
      const text = memoryEmbeddingText(memory);
      const hash = digest(text);
      if (stored.get(memory.id) === hash) continue;
      const known = byHash.get(userId, EMBED_MODEL, hash) as { vector: Buffer } | undefined;
      if (known) {
        put.run(memory.id, userId, EMBED_MODEL, hash, known.vector, Date.now());
        result.reused += 1;
        invalidateMemoryVectors(userId);
        continue;
      }
      if (busy()) {
        result.yielded = true;
        break;
      }
      const vector = await embed(text);
      // Edited or deleted while it was being embedded: never a vector for
      // a text that is not there.
      const now = current.get(memory.id, userId) as { title: string | null; content: string } | undefined;
      if (!now || digest(memoryEmbeddingText(now)) !== hash || !memoryEmbeddingsEnabled(userId)) continue;
      put.run(memory.id, userId, EMBED_MODEL, hash, Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength), Date.now());
      result.embedded += 1;
      invalidateMemoryVectors(userId);
      await new Promise((resolve) => setImmediate(resolve));
    }
  } catch {
    job.error = true;
  } finally {
    job.running = false;
  }
  return result;
}
