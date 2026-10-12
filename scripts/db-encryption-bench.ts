// What encrypting the local database costs (12/10/2026, src/dbCipher.ts):
// the server's own startup and the chat path's reads and writes, on a copy
// of a real database, in clear and encrypted.
//
//   node --import tsx scripts/db-encryption-bench.ts <copy of local.db> --work <scratch folder> [--runs 20] [--rounds 3] [--cache-mb <n>]
//
// The copy: `sqlite3 -readonly …/local.db ".backup <scratch>/clear.db"` for a
// clear database (AGENTS.md §7), never the live file. The work folder gets
// two copies — one left in clear, one encrypted with a throwaway key — and
// is yours to move to the Trash afterwards. Each round starts a fresh
// process per variant, in turn, so that both see the same page cache:
// `startup` is importing db.ts (opening, the key, migrations' check, the
// full-text tables), then each query runs once (`cold`) and `--runs` times
// (median, p95). --cache-mb sets SQLite's page cache of both variants
// (the server's own setting otherwise).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1]! : fallback;
};

if (process.env.BENCH_CHILD === "1") {
  await child();
} else {
  parent();
}

function parent() {
  const source = args[0];
  const work = option("--work", "");
  if (!source || !work) {
    console.error("usage: node --import tsx scripts/db-encryption-bench.ts <copy of local.db> --work <scratch folder> [--runs 20] [--rounds 3]");
    process.exit(2);
  }
  const rounds = Number(option("--rounds", "3"));
  const runs = option("--runs", "20");
  const key = randomBytes(32).toString("hex");
  const dirs = { clear: join(resolve(work), "clear"), encrypted: join(resolve(work), "encrypted") };
  for (const dir of Object.values(dirs)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    copyFileSync(source, join(dir, "local.db"));
  }
  const results: Record<string, Array<Record<string, { cold: number; median: number; p95: number } | number>>> = { clear: [], encrypted: [] };
  // The encrypted copy is made by the server's own first start with a key.
  for (let round = 0; round <= rounds; round += 1) {
    for (const variant of ["clear", "encrypted"] as const) {
      const run = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--runs", runs, ...(option("--cache-mb", "") ? ["--cache-mb", option("--cache-mb", "")] : [])], {
        env: { ...process.env, BENCH_CHILD: "1", BENCH_VARIANT: variant, BENCH_KEY: variant === "encrypted" ? key : "", TWOODY_DATA_DIR: dirs[variant] },
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      const line = run.stdout.trim().split("\n").pop() ?? "";
      if (run.status !== 0 || !line.startsWith("{")) {
        console.error(run.stderr.slice(-2000));
        process.exit(1);
      }
      const parsed = JSON.parse(line);
      // Round 0 warms the page cache (and, encrypted, encrypts the copy): its
      // migration time is reported, its timings are not counted.
      if (round === 0) {
        if (parsed.encryption) console.log(`first start with a key: ${JSON.stringify(parsed.encryption)}`);
        continue;
      }
      results[variant]!.push(parsed.timings);
    }
  }
  const names = Object.keys(results.clear![0]!);
  const pick = (variant: string, name: string, field: "cold" | "median" | "p95" | null) => {
    const values = results[variant]!.map((timings) => {
      const value = timings[name]!;
      return typeof value === "number" ? value : value[field ?? "median"];
    }).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)]!;
  };
  console.log(`\n${"measure".padEnd(34)}${"clear".padStart(10)}${"encrypted".padStart(12)}${"×".padStart(7)}`);
  for (const name of names) {
    const fields = typeof results.clear![0]![name] === "number" ? [null] : (["cold", "median", "p95"] as const);
    for (const field of fields) {
      const a = pick("clear", name, field);
      const b = pick("encrypted", name, field);
      console.log(`${`${name}${field ? ` ${field}` : ""}`.padEnd(34)}${a.toFixed(2).padStart(10)}${b.toFixed(2).padStart(12)}${(b / a).toFixed(2).padStart(7)}`);
    }
  }
  console.log("\n(milliseconds; the median of the rounds)");
}

async function child() {
  const key = process.env.BENCH_KEY ?? "";
  const runs = Number(option("--runs", "20"));
  const posted: Array<Record<string, unknown>> = [];
  if (key) {
    // A stand-in for the Desktop at the other end of process.parentPort.
    const listeners = new Set<(event: { data: unknown }) => void>();
    (process as unknown as { parentPort: unknown }).parentPort = {
      on: (_event: string, listener: (event: { data: unknown }) => void) => void listeners.add(listener),
      removeListener: (_event: string, listener: (event: { data: unknown }) => void) => void listeners.delete(listener),
      postMessage: (message: { type: string; id?: string }) => {
        posted.push(message);
        const reply = message.type === "db-key-request" ? { type: "db-key", state: "ok", hex: key } : message.type === "db-trash" ? { type: "db-trash-result", id: message.id, ok: false } : null;
        if (reply) queueMicrotask(() => listeners.forEach((listener) => listener({ data: reply })));
      },
    };
    process.env.TWOODY_DB_KEY_STORE = "desktop";
  }
  const log = console.log;
  console.log = () => undefined;
  const started = performance.now();
  const { sqlite, databaseEncryption } = await import("../src/db.ts");
  const startup = performance.now() - started;
  const { searchPassages } = await import("../src/documents/library.ts");
  const { searchMemories, searchConversations } = await import("../src/memory/search.ts");
  console.log = log;
  if ((key ? "encrypted" : "clear") !== databaseEncryption) throw new Error(`expected ${key ? "encrypted" : "clear"}, got ${databaseEncryption}`);
  if (option("--cache-mb", "")) sqlite.pragma(`cache_size = -${Number(option("--cache-mb", "")) * 1024}`);

  const user = (sqlite.prepare("SELECT id FROM users LIMIT 1").get() as { id: string }).id;
  const folders = (sqlite.prepare("SELECT id FROM document_folders WHERE user_id = ?").all(user) as Array<{ id: string }>).map((row) => row.id);
  const latest = (sqlite.prepare("SELECT id FROM discussions WHERE user_id = ? ORDER BY last_activity_at DESC LIMIT 1").get(user) as { id: string } | undefined)?.id ?? "";
  const questions = ["facture électricité 2025", "contrat de travail", "loyer de l'appartement", "déclaration d'impôts 2024", "rendez-vous médecin"];
  let n = 0;
  const measures: Record<string, () => unknown> = {
    // The chat turn: its history, the person's memories (profile and the
    // lexical search), the conversations' index, the documents' BM25.
    history_40: () => sqlite.prepare("SELECT role, content, created_at FROM messages WHERE discussion_id = ? ORDER BY created_at DESC LIMIT 40").all(latest),
    memories_all: () => sqlite.prepare("SELECT id, kind, title, content, tags, updated_at FROM memories WHERE user_id = ?").all(user),
    memory_search: () => searchMemories(user, { q: questions[n++ % questions.length], embedTimeoutMs: 0 }),
    conversation_search: () => searchConversations(user, { q: questions[n++ % questions.length] }),
    document_search: () => searchPassages(user, questions[n++ % questions.length]!, 6, folders),
    // What the semantic search reads: every vector of the granted folders.
    document_vectors_scan: () => {
      let rows = 0;
      for (const _row of sqlite.prepare("SELECT c.text, e.vector FROM document_embeddings e JOIN document_chunks c ON c.document_id = e.document_id AND c.position = e.position WHERE e.user_id = ?").iterate(user)) rows += 1;
      return rows;
    },
    // A turn written: the question and the answer, with their index.
    write_turn: () => {
      const id = `bench-${process.pid}-${n++}`;
      sqlite.transaction(() => {
        sqlite.prepare("INSERT INTO messages (id, discussion_id, user_id, role, content, created_at) VALUES (?, ?, ?, 'user', ?, ?)").run(`${id}-q`, latest, user, "Quelle est la date de la facture d'électricité ?", Date.now());
        sqlite.prepare("INSERT INTO messages (id, discussion_id, user_id, role, content, created_at) VALUES (?, ?, ?, 'assistant', ?, ?)").run(`${id}-a`, latest, user, "La facture date du 3 mars 2025. ".repeat(20), Date.now());
      })();
    },
  };
  const timings: Record<string, { cold: number; median: number; p95: number } | number> = { startup };
  for (const [name, measure] of Object.entries(measures)) {
    const cold = await time(measure);
    const samples: number[] = [];
    for (let i = 0; i < runs; i += 1) samples.push(await time(measure));
    samples.sort((a, b) => a - b);
    timings[name] = { cold, median: samples[Math.floor(samples.length / 2)]!, p95: samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))]! };
  }
  sqlite.prepare("DELETE FROM messages WHERE id LIKE ?").run(`bench-${process.pid}-%`);
  sqlite.close();
  const encryption = posted.find((message) => message.type === "db-encryption" && message.state !== "running") ?? null;
  console.log(JSON.stringify({ timings, encryption }));
  process.exit(0);
}

async function time(measure: () => unknown): Promise<number> {
  const started = performance.now();
  await measure();
  return performance.now() - started;
}
