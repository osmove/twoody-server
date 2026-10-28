import { createHash } from "node:crypto";
import { sqlite } from "../db.js";
import { EMBED_MODEL, embed as embedText, embeddingFilesPresent, stopEmbeddings, vectorScore, vectorView } from "../embeddings.js";
import type { Passage } from "./library.js";

// The documents' half of the embeddings (src/embeddings.ts runs the
// worker): their own switch (« Rechercher par le sens »), their own
// table, and the instruction a question about documents is embedded with.
export { EMBED_MODEL, vectorScore, vectorView } from "../embeddings.js";
const MODEL = EMBED_MODEL;
const DOCUMENT_QUERY = "Given a search question, retrieve relevant passages from personal documents that answer it.";
/// The worker is shared with the memories: stopping it stops both.
export const stopSemantic = stopEmbeddings;
const MAX_CHUNKS = 20000;
const jobs = new Map<string, { running: boolean; error: boolean }>();
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
function enabledFor(userId: string) {
  return Boolean(
    (
      sqlite
        .prepare(
          "SELECT enabled FROM document_semantic_settings WHERE user_id=?",
        )
        .get(userId) as { enabled: number } | undefined
    )?.enabled,
  );
}
export function semanticStatus(userId: string) {
  const enabled = enabledFor(userId);
  const count = (sql: string) =>
    (sqlite.prepare(sql).get(userId) as { n: number }).n;
  return {
    enabled,
    available: embeddingFilesPresent(),
    running: jobs.get(userId)?.running ?? false,
    error: jobs.get(userId)?.error ?? false,
    indexed: count(
      "SELECT count(*) AS n FROM document_embeddings WHERE user_id=?",
    ),
    total: count("SELECT count(*) AS n FROM document_chunks WHERE user_id=?"),
    limit: MAX_CHUNKS,
  };
}
export function setSemantic(userId: string, enabled: boolean) {
  sqlite
    .prepare(
      "INSERT INTO document_semantic_settings(user_id,enabled) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled",
    )
    .run(userId, Number(enabled));
  if (enabled) void indexSemantic(userId);
  return semanticStatus(userId);
}
async function embed(text: string, query = false) {
  return embedText(text, query ? DOCUMENT_QUERY : null);
}
const categories: Record<string, string> = {
  career:
    "A curriculum vitae, resume, work experience, professional skills, education and job applications.",
  contracts:
    "A contract, lease, legal agreement, obligations, termination clauses and legal notices.",
  finance:
    "An invoice, receipt, budget, expenses, accounting or financial statement.",
  correspondence:
    "A letter, email, formal correspondence or written message to another person.",
  projects:
    "Project notes, meeting minutes, technical specifications, plans or task lists.",
};
let categoryVectors: Promise<
  Array<{ category: string; vector: Float32Array }>
> | null = null;
async function labelDocument(documentId: string) {
  categoryVectors ??= (async () => {
    const result = [];
    for (const [category, text] of Object.entries(categories))
      result.push({ category, vector: await embed(text, true) });
    return result;
  })();
  let prototypes;
  try {
    prototypes = await categoryVectors;
  } catch {
    categoryVectors = null;
    throw Error("category_unavailable");
  }
  const rows = sqlite
    .prepare(
      "SELECT vector FROM document_embeddings WHERE document_id=? AND model=? ORDER BY position LIMIT 16",
    )
    .all(documentId, MODEL) as Array<{ vector: Buffer }>;
  if (!rows.length) return;
  const average = new Float32Array(1024);
  for (const row of rows) {
    const stored = vectorView(row.vector);
    for (let i = 0; i < 1024; i++) average[i] += stored[i] / rows.length;
  }
  const norm = Math.sqrt(average.reduce((sum, x) => sum + x * x, 0));
  if (!norm) return;
  const ranked = prototypes
    .map((p) => ({
      category: p.category,
      score: p.vector.reduce((sum, x, i) => sum + (x * average[i]) / norm, 0),
    }))
    .sort((a, b) => b.score - a.score);
  const category =
    ranked[0].score >= 0.4 && ranked[0].score - ranked[1].score >= 0.02
      ? ranked[0].category
      : "other";
  if (sqlite.prepare("SELECT 1 FROM documents WHERE id=?").get(documentId))
    sqlite
      .prepare(
        "INSERT INTO document_labels(document_id,category) VALUES(?,?) ON CONFLICT(document_id) DO UPDATE SET category=excluded.category",
      )
      .run(documentId, category);
}
export async function indexSemantic(userId: string) {
  if (jobs.get(userId)?.running || !enabledFor(userId)) return;
  const job = { running: true, error: false };
  jobs.set(userId, job);
  try {
    const rows = sqlite
      .prepare(
        `SELECT c.document_id,c.position,c.text,e.hash,l.category FROM document_chunks c
      JOIN documents d ON d.id=c.document_id JOIN document_folders f ON f.id=d.folder_id AND f.user_id=c.user_id
      LEFT JOIN document_embeddings e ON e.document_id=c.document_id AND e.position=c.position AND e.model=?
      LEFT JOIN document_labels l ON l.document_id=c.document_id
      WHERE c.user_id=? ORDER BY c.document_id,c.position LIMIT ?`,
      )
      .all(MODEL, userId, MAX_CHUNKS) as Array<{
      document_id: string;
      position: number;
      text: string;
      hash: string | null;
      category: string | null;
    }>;
    const changed = new Set<string>();
    for (const row of rows) {
      if (!enabledFor(userId)) break;
      const hash = digest(row.text);
      if (row.hash === hash) {
        if (!row.category) changed.add(row.document_id);
        continue;
      }
      const vector = await embed(row.text);
      changed.add(row.document_id);
      // Revocation/reindex can occur while the worker is busy. Never resurrect removed data.
      const current = sqlite
        .prepare(
          "SELECT c.text FROM document_chunks c JOIN documents d ON d.id=c.document_id WHERE c.user_id=? AND c.document_id=? AND c.position=?",
        )
        .get(userId, row.document_id, row.position) as
        | { text: string }
        | undefined;
      if (!enabledFor(userId)) break;
      if (current?.text !== row.text) continue;
      sqlite
        .prepare(
          `INSERT INTO document_embeddings(user_id,document_id,position,model,hash,vector) VALUES(?,?,?,?,?,?)
        ON CONFLICT(document_id,position) DO UPDATE SET model=excluded.model,hash=excluded.hash,vector=excluded.vector`,
        )
        .run(
          userId,
          row.document_id,
          row.position,
          MODEL,
          hash,
          Buffer.from(vector.buffer),
        );
      await new Promise((r) => setImmediate(r));
    }
    for (const id of changed) {
      if (!enabledFor(userId)) break;
      await labelDocument(id);
    }
  } catch {
    job.error = true;
  } finally {
    job.running = false;
  }
}
/// The passages nearest the question by meaning, best first; `documentIds`:
/// the nearest in those documents too, ahead of the others (retrieval.ts,
/// the documents a question names).
export async function semanticPassages(
  userId: string,
  question: string,
  folderIds: string[],
  documentIds?: string[],
): Promise<Passage[]> {
  if (!folderIds.length || !enabledFor(userId)) return [];
  try {
    const vector = await embed(question, true);
    if (!enabledFor(userId)) return [];
    const rows =
      sqlite.prepare(`SELECT c.document_id,d.name,d.path,c.page,c.text,e.vector,e.hash
      FROM document_embeddings e JOIN document_chunks c ON c.document_id=e.document_id AND c.position=e.position
      JOIN documents d ON d.id=c.document_id JOIN document_folders f ON f.id=d.folder_id AND f.user_id=d.user_id
      WHERE e.user_id=? AND e.model=? AND d.folder_id IN (${folderIds.map(() => "?").join(",")})`);
    const top: Array<Passage & { score: number }> = [];
    const named = new Set(documentIds ?? []);
    const topNamed: Array<Passage & { score: number }> = [];
    for (const raw of rows.iterate(userId, MODEL, ...folderIds)) {
      const row = raw as {
        document_id: string;
        name: string;
        path: string;
        page: number | null;
        text: string;
        vector: Buffer;
        hash: string;
      };
      if (
        digest(row.text) !== row.hash ||
        row.vector.byteLength !== vector.byteLength
      )
        continue;
      const score = vectorScore(vector, row.vector);
      if (score < 0.35) continue;
      const passage: Passage & { score: number } = {
        document_id: row.document_id,
        name: row.name,
        path: row.path,
        page: row.page,
        text: row.text,
        snippet: row.text.slice(0, 240),
        match: "semantic",
        cosine: score,
        score,
      };
      for (const list of named.has(row.document_id) ? [top, topNamed] : [top]) {
        list.push(passage);
        list.sort((a, b) => b.score - a.score);
        if (list.length > 12) list.pop();
      }
    }
    const seen = new Set<Passage & { score: number }>();
    return [...topNamed, ...top].filter((passage) => !seen.has(passage) && seen.add(passage)).map(({ score: _score, ...passage }) => passage);
  } catch {
    const job = jobs.get(userId) ?? { running: false, error: false };
    job.error = true;
    jobs.set(userId, job);
    return [];
  }
}
