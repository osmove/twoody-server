import { and, asc, eq, gte, lt } from "drizzle-orm";
import { db, sqlite, modelCalls, usageMachines, usageSamples } from "./db.js";
import { generateId } from "./auth.js";

// What this computer's models did and what it cost the machine, kept to be
// added up and audited (Jimmy, 29/09/2026: tokens per day, week, month and
// year, speed, CPU, GPU and memory). Every call to a model is one row of
// model_calls, kept as long as the conversations are; the machine's load
// is sampled every 15 s and thinned out with age (see compactUsageSamples).

/// « peer »: an answer this computer wrote for another computer of the
/// account (routes/peer.ts) — recorded here, never posted by a client.
export type UsageSource = "chat" | "code" | "agent" | "memory" | "peer";
export const USAGE_SOURCES: readonly UsageSource[] = ["chat", "code", "agent", "memory"];

export interface UsageEventInput {
  userId: string;
  at?: Date;
  source: UsageSource;
  model: string | null;
  client: string | null;
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number | null;
  promptMs?: number | null;
  generationMs?: number | null;
  ttftMs?: number | null;
  estimated?: boolean;
  messageId?: string | null;
}

const count = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

export function recordUsageEvent(event: UsageEventInput): void {
  db.insert(modelCalls)
    .values({
      id: generateId(),
      userId: event.userId,
      occurredAt: event.at ?? new Date(),
      source: event.source,
      model: event.model,
      client: event.client,
      promptTokens: count(event.promptTokens) ?? 0,
      completionTokens: count(event.completionTokens) ?? 0,
      cachedTokens: count(event.cachedTokens),
      promptMs: count(event.promptMs),
      generationMs: count(event.generationMs),
      ttftMs: count(event.ttftMs),
      estimated: event.estimated === true,
      messageId: event.messageId ?? null,
    })
    .run();
}

/// The answers written before model calls were recorded carry their tokens:
/// they are copied once (source chat), so the history starts with them.
/// Idempotent twice over: a marker, and one row per message at most.
export function backfillUsageEvents(): number {
  const done = sqlite.prepare("SELECT value FROM usage_meta WHERE key = 'backfill_messages'").get();
  if (done) return 0;
  const copy = sqlite.transaction(() => {
    const result = sqlite
      .prepare(
        `INSERT INTO model_calls (id, user_id, occurred_at, source, model, client, prompt_tokens, completion_tokens, estimated, message_id)
         SELECT 'backfill-' || m.id, m.user_id, m.created_at, 'chat', m.model, m.client,
                COALESCE(m.prompt_tokens, 0), m.completion_tokens, COALESCE(m.tokens_estimated, 0), m.id
           FROM messages m
          WHERE m.role = 'assistant' AND m.completion_tokens IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM model_calls e WHERE e.message_id = m.id)`,
      )
      .run();
    sqlite.prepare("INSERT OR REPLACE INTO usage_meta (key, value) VALUES ('backfill_messages', ?)").run(new Date().toISOString());
    return result.changes;
  });
  return copy();
}

// ── machine samples ─────────────────────────────────────────────────────────

export interface SampleInput {
  at: Date;
  cpuPct: number | null;
  ramUsedBytes: number | null;
  ramTotalBytes: number | null;
  gpuPct: number | null;
  runtimeRssBytes: number | null;
  appRssBytes: number | null;
}

export function recordSamples(userId: string, samples: SampleInput[]): void {
  if (samples.length === 0) return;
  db.transaction((tx) => {
    for (const sample of samples) {
      tx.insert(usageSamples).values({ userId, spanS: 15, ...sample }).run();
    }
  });
}

export interface MachineInput {
  cpuModel: string | null;
  cores: number | null;
  ramTotalBytes: number | null;
  gpuName: string | null;
  os: string | null;
}

export function recordMachine(userId: string, machine: MachineInput): void {
  const row = { ...machine, updatedAt: new Date() };
  db.insert(usageMachines).values({ userId, ...row }).onConflictDoUpdate({ target: usageMachines.userId, set: row }).run();
}

export function machineOf(userId: string): { cpu_model: string | null; cores: number | null; ram_total_bytes: number | null; gpu_name: string | null; os: string | null } | null {
  const [row] = db.select().from(usageMachines).where(eq(usageMachines.userId, userId)).limit(1).all();
  return row ? { cpu_model: row.cpuModel, cores: row.cores, ram_total_bytes: row.ramTotalBytes, gpu_name: row.gpuName, os: row.os } : null;
}

export const RAW_SAMPLES_KEPT_MS = 48 * 3600 * 1000;
export const AVERAGES_KEPT_MS = 30 * 24 * 3600 * 1000;
const AVERAGE_MS = 5 * 60 * 1000;

/// Metrics downsampling, not the person's content: 15-s samples older than
/// 48 h become one 5-min average each, averages older than 30 days go.
/// Run at startup and every hour (src/index.ts).
export function compactUsageSamples(now = new Date()): { averaged: number; dropped: number } {
  // Whole 5-min windows only, so none is averaged in two halves.
  const cutoff = Math.floor((now.getTime() - RAW_SAMPLES_KEPT_MS) / AVERAGE_MS) * AVERAGE_MS;
  const run = sqlite.transaction(() => {
    const averaged = sqlite
      .prepare(
        `INSERT INTO usage_samples (user_id, at, span_s, cpu_pct, ram_used_bytes, ram_total_bytes, gpu_pct, runtime_rss_bytes, app_rss_bytes)
         SELECT user_id, (at / ${AVERAGE_MS}) * ${AVERAGE_MS}, 300, AVG(cpu_pct), CAST(AVG(ram_used_bytes) AS INTEGER),
                CAST(AVG(ram_total_bytes) AS INTEGER), AVG(gpu_pct), CAST(AVG(runtime_rss_bytes) AS INTEGER), CAST(AVG(app_rss_bytes) AS INTEGER)
           FROM usage_samples WHERE span_s = 15 AND at < ?
          GROUP BY user_id, at / ${AVERAGE_MS}`,
      )
      .run(cutoff).changes;
    sqlite.prepare("DELETE FROM usage_samples WHERE span_s = 15 AND at < ?").run(cutoff);
    const dropped = sqlite.prepare("DELETE FROM usage_samples WHERE span_s <> 15 AND at < ?").run(now.getTime() - AVERAGES_KEPT_MS).changes;
    return { averaged, dropped };
  });
  return run();
}

/// Backfill once, then the samples' retention now and every hour.
export function startUsageMaintenance(log: (message: string) => void = () => undefined): () => void {
  const tick = () => {
    try {
      compactUsageSamples();
    } catch (err) {
      log(`usage samples retention failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  try {
    const copied = backfillUsageEvents();
    if (copied > 0) log(`usage: ${copied} earlier answers copied into model_calls`);
  } catch (err) {
    log(`usage backfill failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  tick();
  const timer = setInterval(tick, 3600 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

// ── reading ─────────────────────────────────────────────────────────────────

export type UsageEventRow = typeof modelCalls.$inferSelect;

export function eventsBetween(userId: string, from: Date, to: Date): UsageEventRow[] {
  return db
    .select()
    .from(modelCalls)
    .where(and(eq(modelCalls.userId, userId), gte(modelCalls.occurredAt, from), lt(modelCalls.occurredAt, to)))
    .orderBy(asc(modelCalls.occurredAt))
    .all();
}

export type SampleRow = typeof usageSamples.$inferSelect;

export function samplesSince(userId: string, from: Date): SampleRow[] {
  return db
    .select()
    .from(usageSamples)
    .where(and(eq(usageSamples.userId, userId), gte(usageSamples.at, from)))
    .orderBy(asc(usageSamples.at))
    .all();
}

/// Tokens a second while writing, for an answer the runtime timed.
export function generationTps(event: Pick<UsageEventRow, "completionTokens" | "generationMs" | "estimated">): number | null {
  if (event.estimated || !event.generationMs || event.generationMs <= 0 || event.completionTokens <= 0) return null;
  return round1((event.completionTokens * 1000) / event.generationMs);
}

export const round1 = (value: number): number => Math.round(value * 10) / 10;
