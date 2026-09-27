import { normalizedVector } from "./vectorMath.js";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { randomBytes, createHash } from "node:crypto";
import { sqlite } from "../db.js";
import { outboundFetch } from "../outbound.js";
import type { Passage } from "./library.js";

const MODEL = "qwen3-embedding-0.6b-q8-370f27d";
const MAX_CHUNKS = 20000;
let child: ChildProcess | null = null;
let address: { url: string; key: string } | null = null;
let starting: Promise<{ url: string; key: string }> | null = null;
let idle: ReturnType<typeof setTimeout> | null = null;
const jobs = new Map<string, { running: boolean; error: boolean }>();
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export function stopSemantic() {
  if (idle) clearTimeout(idle);
  idle = null;
  const proc = child;
  child = null;
  address = null;
  proc?.kill();
}
function touch() {
  if (idle) clearTimeout(idle);
  idle = setTimeout(stopSemantic, 120000);
  idle.unref();
}
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
    available:
      existsSync(process.env.TWOODY_EMBEDDING_MODEL ?? "") &&
      existsSync(process.env.TWOODY_EMBEDDING_BINARY ?? ""),
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
async function engine(): Promise<{ url: string; key: string }> {
  if (address && child && child.exitCode === null) {
    touch();
    return address;
  }
  if (starting) return starting;
  starting = (async () => {
    const binary = process.env.TWOODY_EMBEDDING_BINARY,
      model = process.env.TWOODY_EMBEDDING_MODEL;
    if (!binary || !model || !existsSync(binary) || !existsSync(model))
      throw Error("semantic_model_unavailable");
    const server = createServer();
    await new Promise<void>((r, j) => {
      server.once("error", j);
      server.listen(0, "127.0.0.1", r);
    });
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((r) => server.close(() => r()));
    const key = randomBytes(32).toString("hex"),
      url = `http://127.0.0.1:${port}`;
    // Small independent CPU worker: two threads leave the chat model's GPU/RAM budget alone.
    const proc = spawn(
      binary,
      [
        "--model",
        model,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--api-key",
        key,
        "--alias",
        MODEL,
        "--embedding",
        "--pooling",
        "last",
        "--ctx-size",
        "2048",
        "--batch-size",
        "2048",
        "--ubatch-size",
        "2048",
        "--parallel",
        "1",
        "--threads",
        "2",
        "--n-gpu-layers",
        "0",
        "--log-disable",
      ],
      { stdio: "ignore", windowsHide: true },
    );
    child = proc;
    let failed = false;
    proc.on("error", () => {
      failed = true;
    });
    proc.on("exit", () => {
      if (child === proc) {
        child = null;
        address = null;
      }
    });
    const deadline = Date.now() + 30000;
    while (
      Date.now() < deadline &&
      !failed &&
      child === proc &&
      proc.exitCode === null &&
      proc.signalCode === null
    ) {
      try {
        const r = await outboundFetch(url + "/health", {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(1000),
        });
        if (r.ok) {
          address = { url, key };
          touch();
          return address;
        }
      } catch {
        /* starting */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    proc.kill();
    throw Error("semantic_runtime_unavailable");
  })();
  try {
    return await starting;
  } finally {
    starting = null;
  }
}
async function embed(text: string, query = false) {
  const { url, key } = await engine();
  touch();
  const input = query
    ? `Instruct: Given a search question, retrieve relevant passages from personal documents that answer it.\nQuery: ${text.slice(0, 3000)}`
    : text.slice(0, 5000);
  const response = await outboundFetch(url + "/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ input, model: MODEL }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error("embedding_failed");
  const body = (await response.json()) as {
    data?: Array<{ embedding?: unknown }>;
  };
  return normalizedVector(body.data?.[0]?.embedding);
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
  for (const row of rows)
    for (let i = 0; i < 1024; i++)
      average[i] += row.vector.readFloatLE(i * 4) / rows.length;
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
export async function semanticPassages(
  userId: string,
  question: string,
  folderIds: string[],
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
      let score = 0;
      for (let i = 0; i < vector.length; i++)
        score += vector[i] * row.vector.readFloatLE(i * 4);
      if (score < 0.35) continue;
      top.push({
        document_id: row.document_id,
        name: row.name,
        path: row.path,
        page: row.page,
        text: row.text,
        snippet: row.text.slice(0, 240),
        match: "semantic",
        score,
      });
      top.sort((a, b) => b.score - a.score);
      if (top.length > 12) top.pop();
    }
    return top.map(({ score: _score, ...passage }) => passage);
  } catch {
    const job = jobs.get(userId) ?? { running: false, error: false };
    job.error = true;
    jobs.set(userId, job);
    return [];
  }
}
