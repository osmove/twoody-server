import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { endianness, totalmem } from "node:os";
import { normalizedVector } from "./documents/vectorMath.js";
import { outboundFetch } from "./outbound.js";

// The embedding model of this computer (Qwen3-Embedding 0.6B through
// llama-server), shared by the documents (src/documents/semantic.ts) and
// the memories (src/memory/embeddings.ts) — docs/memory-v2-design.md §3.
// Each keeps its own switch; this module only runs the worker: started on
// the first vector asked for, stopped two minutes after the last one.
//
// A passage is embedded as it is; a question with the instruction its
// caller gives (Qwen3-Embedding's « Instruct: …\nQuery: … » form), so the
// documents' and the memories' searches each say what they look for.

// Electron's utility process can be terminated without running Fastify's close hook.
// Tell its owning main process which worker to stop before it terminates us.
const parentPort = (process as NodeJS.Process & {
  parentPort?: { postMessage(message: unknown): void };
}).parentPort;
function reportWorker(pid: number | undefined, running: boolean) {
  if (pid) parentPort?.postMessage({ type: "document-semantic-worker", pid, running });
}
process.once("exit", () => stopEmbeddings());

const MODEL = "qwen3-embedding-0.6b-q8-370f27d";
/// The embedding model this computer's vectors come from: another computer
/// compares cosines only when it is the same (docs/mesh-design.md §2), and
/// stored vectors are keyed by it.
export const EMBED_MODEL = MODEL;
/// Its vectors' length.
export const EMBED_DIMENSIONS = 1024;
const LITTLE_ENDIAN = endianness() === "LE";

/// A stored vector (float32, little-endian) as a Float32Array. A view over
/// the SQLite blob when it can be one — aligned, on a little-endian
/// machine, which every Twoody target is — a copy otherwise.
export function vectorView(blob: Buffer): Float32Array {
  const length = blob.byteLength >>> 2;
  if (LITTLE_ENDIAN && blob.byteOffset % 4 === 0) return new Float32Array(blob.buffer, blob.byteOffset, length);
  const copy = new Float32Array(length);
  for (let i = 0; i < length; i++) copy[i] = blob.readFloatLE(i * 4);
  return copy;
}

/// Dot product of the question's vector with a stored one, summed in the
/// same order and precision as the readFloatLE loop it replaces.
export function vectorScore(query: Float32Array, blob: Buffer): number {
  const stored = vectorView(blob);
  let score = 0;
  for (let i = 0; i < query.length; i++) score += query[i] * stored[i];
  return score;
}

/// Whether the model and the runtime that serves it are on this computer
/// (the Desktop downloads them with « Rechercher par le sens »).
/// Where the vectors are computed: on a Mac with Apple silicon and 24 GB or
/// more, on its graphics chip — 7.6 passages a second instead of 0.9 on two
/// cores (M5, 24 GB, Qwen3 Embedding 0.6B, 28/10/2026: a folder of 1,300
/// documents, 8,525 passages, about 19 minutes instead of 2 h 40); the documents
/// wait while an answer is written (semantic.ts). Below, the chat model
/// needs that memory (docs/builtin-runtime-design.md §10: 9.9 of the 10.7 GiB
/// a 16 GB Mac's graphics chip can take); elsewhere, not measured: as before.
export function embeddingGpuLayers(platform: string, arch: string, totalBytes: number): string {
  return platform === "darwin" && arch === "arm64" && totalBytes >= 24 * 1024 ** 3 ? "99" : "0";
}

export function embeddingFilesPresent(): boolean {
  return existsSync(process.env.TWOODY_EMBEDDING_MODEL ?? "") && existsSync(process.env.TWOODY_EMBEDDING_BINARY ?? "");
}

let child: ChildProcess | null = null;
let address: { url: string; key: string } | null = null;
let starting: Promise<{ url: string; key: string }> | null = null;
let idle: ReturnType<typeof setTimeout> | null = null;

export function stopEmbeddings() {
  if (idle) clearTimeout(idle);
  idle = null;
  const proc = child;
  child = null;
  address = null;
  proc?.kill();
}

/// Whether the worker is up now: a vector costs no start.
export function embeddingsWarm(): boolean {
  return !!(address && child && child.exitCode === null);
}

function touch() {
  if (idle) clearTimeout(idle);
  idle = setTimeout(stopEmbeddings, 120000);
  idle.unref();
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
    if (!binary || !model || !existsSync(binary) || !existsSync(model)) throw Error("semantic_model_unavailable");
    const server = createServer();
    await new Promise<void>((r, j) => {
      server.once("error", j);
      server.listen(0, "127.0.0.1", r);
    });
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((r) => server.close(() => r()));
    const key = randomBytes(32).toString("hex"),
      url = `http://127.0.0.1:${port}`;
    // Small independent CPU worker: two threads leave the chat model's
    // GPU/RAM budget alone, and a Pi's other cores to the chat model — except
    // on a Mac with Apple silicon and room to spare (embeddingGpuLayers).
    const proc = spawn(
      binary,
      [
        "--model", model,
        "--host", "127.0.0.1",
        "--port", String(port),
        "--api-key", key,
        "--alias", MODEL,
        "--embedding",
        "--pooling", "last",
        "--ctx-size", "2048",
        "--batch-size", "2048",
        "--ubatch-size", "2048",
        "--parallel", "1",
        "--threads", "2",
        "--n-gpu-layers", embeddingGpuLayers(process.platform, process.arch, totalmem()),
        "--log-disable",
      ],
      { stdio: "ignore", windowsHide: true },
    );
    child = proc;
    reportWorker(proc.pid, true);
    let failed = false;
    proc.on("error", () => {
      failed = true;
    });
    proc.on("exit", () => {
      reportWorker(proc.pid, false);
      if (child === proc) {
        child = null;
        address = null;
      }
    });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !failed && child === proc && proc.exitCode === null && proc.signalCode === null) {
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

/// The normalised vector of a text: a passage as it is, or a question with
/// the instruction that says what it looks for.
export async function embed(text: string, instruction?: string | null): Promise<Float32Array> {
  const { url, key } = await engine();
  touch();
  const input = instruction ? `Instruct: ${instruction}\nQuery: ${text.slice(0, 3000)}` : text.slice(0, 5000);
  const response = await outboundFetch(url + "/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ input, model: MODEL }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error("embedding_failed");
  const body = (await response.json()) as { data?: Array<{ embedding?: unknown }> };
  return normalizedVector(body.data?.[0]?.embedding);
}
