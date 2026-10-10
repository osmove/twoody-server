import type { FastifyInstance, FastifyReply } from "fastify";
import { and, eq, gte, isNotNull } from "drizzle-orm";
import { authSessions, db, devices, messages, tunnelPeers } from "../db.js";
import { isOwnerSession, requireAuth } from "../auth.js";
import {
  eventsBetween,
  generationTps,
  machineOf,
  recordMachine,
  recordSamples,
  recordUsageEvent,
  round1,
  samplesSince,
  USAGE_SOURCES,
  type SampleInput,
  type UsageEventRow,
  type UsageSource,
} from "../usageStore.js";
import { bucketIndex, defaultTimeZone, PERIODS, periodRange, validTimeZone, type Period } from "../usagePeriods.js";

// What this computer's models answered, and for whom: the Devices screen of
// the Mac and of the iPhone (Jimmy, 28/09/2026, « ajoute-y aussi l'usage »).
// Counted from the answers kept with their tokens (messages.prompt_tokens,
// completion_tokens), so nothing is sent anywhere to know it.

/// Who asked, as the Devices screen names it: the paired phone by the name
/// it paired with, a device by its name, and this computer's own app as
/// « this-computer » (each screen says it in its language).
export function clientOf(auth: { sessionId?: string; deviceId?: string }): string | null {
  if (auth.deviceId) {
    const [device] = db.select({ name: devices.name }).from(devices).where(eq(devices.id, auth.deviceId)).limit(1).all();
    return device?.name ?? "device";
  }
  if (!auth.sessionId) return null;
  const [peer] = db.select({ name: tunnelPeers.name }).from(tunnelPeers).where(eq(tunnelPeers.sessionId, auth.sessionId)).limit(1).all();
  if (peer?.name) return peer.name;
  const [session] = db.select({ kind: authSessions.clientKind }).from(authSessions).where(eq(authSessions.id, auth.sessionId)).limit(1).all();
  if (!session) return null;
  if (session.kind.startsWith("pair:")) {
    const name = session.kind.slice("pair:".length);
    return name === "Twoody Desktop" ? "this-computer" : name || "device";
  }
  return session.kind === "desktop" ? "this-computer" : session.kind;
}

type Tally = { prompt_tokens: number; completion_tokens: number; messages: number };
const empty = (): Tally => ({ prompt_tokens: 0, completion_tokens: 0, messages: 0 });

export interface UsageSummary {
  days: number;
  totals: Tally;
  by_day: Array<Tally & { day: string }>;
  by_model: Array<Tally & { model: string }>;
  by_device: Array<Tally & { device: string }>;
}

/// The last `days` days of answers for this user, newest day first.
export function usageSummary(userId: string, days: number, now = new Date()): UsageSummary {
  const since = new Date(now.getTime() - days * 24 * 3600 * 1000);
  const rows = db
    .select({
      prompt: messages.promptTokens,
      completion: messages.completionTokens,
      model: messages.model,
      client: messages.client,
      at: messages.createdAt,
    })
    .from(messages)
    .where(and(eq(messages.userId, userId), eq(messages.role, "assistant"), isNotNull(messages.completionTokens), gte(messages.createdAt, since)))
    .all();
  const totals = empty();
  const byDay = new Map<string, Tally>();
  const byModel = new Map<string, Tally>();
  const byDevice = new Map<string, Tally>();
  const add = (map: Map<string, Tally>, key: string, prompt: number, completion: number) => {
    const tally = map.get(key) ?? empty();
    tally.prompt_tokens += prompt;
    tally.completion_tokens += completion;
    tally.messages += 1;
    map.set(key, tally);
  };
  for (const row of rows) {
    const prompt = row.prompt ?? 0;
    const completion = row.completion ?? 0;
    totals.prompt_tokens += prompt;
    totals.completion_tokens += completion;
    totals.messages += 1;
    add(byDay, row.at.toISOString().slice(0, 10), prompt, completion);
    add(byModel, row.model ?? "unknown", prompt, completion);
    add(byDevice, row.client ?? "unknown", prompt, completion);
  }
  const heaviest = <T extends Tally>(list: T[]) => list.sort((a, b) => b.prompt_tokens + b.completion_tokens - (a.prompt_tokens + a.completion_tokens));
  return {
    days,
    totals,
    by_day: [...byDay].map(([day, tally]) => ({ day, ...tally })).sort((a, b) => b.day.localeCompare(a.day)),
    by_model: heaviest([...byModel].map(([model, tally]) => ({ model, ...tally }))),
    by_device: heaviest([...byDevice].map(([device, tally]) => ({ device, ...tally }))),
  };
}

// ── periods: tokens, speed, by model, device and source ─────────────────────

interface PeriodTally {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  requests: number;
  estimated_requests: number;
  prompt_ms: number;
  generation_ms: number;
}

/// What a set of calls adds up to, and how fast they were written.
class Tallier {
  tally: PeriodTally = { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, requests: 0, estimated_requests: 0, prompt_ms: 0, generation_ms: 0 };
  // Timed answers only: tokens and ms, so the speed is weighted by tokens.
  private timedTokens = 0;
  private timedMs = 0;

  add(event: UsageEventRow) {
    const t = this.tally;
    t.prompt_tokens += event.promptTokens;
    t.completion_tokens += event.completionTokens;
    t.cached_tokens += event.cachedTokens ?? 0;
    t.requests += 1;
    if (event.estimated) t.estimated_requests += 1;
    t.prompt_ms += event.promptMs ?? 0;
    t.generation_ms += event.generationMs ?? 0;
    if (generationTps(event) !== null) {
      this.timedTokens += event.completionTokens;
      this.timedMs += event.generationMs!;
    }
  }

  get generationTps(): number | null {
    return this.timedMs > 0 ? round1((this.timedTokens * 1000) / this.timedMs) : null;
  }
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

export function speedOf(events: UsageEventRow[]) {
  const tps = events.map(generationTps).filter((value): value is number => value !== null);
  const all = new Tallier();
  let promptTokens = 0;
  let promptMs = 0;
  const ttft: number[] = [];
  for (const event of events) {
    all.add(event);
    if (!event.estimated && event.promptMs && event.promptMs > 0) {
      promptTokens += Math.max(0, event.promptTokens - (event.cachedTokens ?? 0));
      promptMs += event.promptMs;
    }
    if (event.ttftMs !== null && event.ttftMs !== undefined) ttft.push(event.ttftMs);
  }
  return {
    generation_tps_avg: all.generationTps,
    generation_tps_p50: percentile(tps, 50),
    prompt_tps_avg: promptMs > 0 ? round1((promptTokens * 1000) / promptMs) : null,
    ttft_ms_p50: percentile(ttft, 50),
    ttft_ms_p95: percentile(ttft, 95),
  };
}

function groupBy<K extends string>(events: UsageEventRow[], name: K, keyOf: (event: UsageEventRow) => string) {
  const groups = new Map<string, Tallier>();
  for (const event of events) {
    const key = keyOf(event);
    const tallier = groups.get(key) ?? new Tallier();
    tallier.add(event);
    groups.set(key, tallier);
  }
  return [...groups]
    .map(([key, tallier]) => ({ [name]: key, ...tallier.tally, generation_tps: tallier.generationTps }) as Record<K, string> & PeriodTally & { generation_tps: number | null })
    .sort((a, b) => b.prompt_tokens + b.completion_tokens - (a.prompt_tokens + a.completion_tokens));
}

export function periodUsage(userId: string, period: Period, tz: string, offset = 0, now = Date.now()) {
  const range = periodRange(period, tz, offset, now);
  const events = eventsBetween(userId, new Date(range.from), new Date(range.to));
  const totals = new Tallier();
  const series = range.buckets.map(() => new Tallier());
  for (const event of events) {
    totals.add(event);
    const index = bucketIndex(range.buckets, event.occurredAt.getTime());
    if (index >= 0) series[index].add(event);
  }
  const previous = periodRange(period, tz, offset + 1, now);
  const before = new Tallier();
  for (const event of eventsBetween(userId, new Date(previous.from), new Date(previous.to))) before.add(event);
  return {
    period,
    tz,
    offset,
    from: new Date(range.from).toISOString(),
    to: new Date(range.to).toISOString(),
    bucket: range.bucket,
    totals: totals.tally,
    speed: speedOf(events),
    series: range.buckets.map((t, index) => {
      const { prompt_tokens, completion_tokens, cached_tokens, requests } = series[index].tally;
      return { t: new Date(t).toISOString(), prompt_tokens, completion_tokens, cached_tokens, requests, generation_tps: series[index].generationTps };
    }),
    by_model: groupBy(events, "model", (event) => event.model ?? "unknown"),
    by_device: groupBy(events, "device", (event) => event.client ?? "unknown"),
    by_source: groupBy(events, "source", (event) => event.source),
    previous: { from: new Date(previous.from).toISOString(), to: new Date(previous.to).toISOString(), totals: before.tally },
  };
}

// ── performance: the machine's load and the answers' speed ──────────────────

const RANGES = { "1h": [3600, 15], "24h": [86_400, 120], "7d": [7 * 86_400, 900], "30d": [30 * 86_400, 3600] } as const;
type Range = keyof typeof RANGES;

export function performance(userId: string, range: Range, now = Date.now()) {
  const [seconds, step] = RANGES[range];
  const from = now - seconds * 1000;
  const stepMs = step * 1000;
  const fields = ["cpuPct", "ramUsedBytes", "gpuPct", "runtimeRssBytes", "appRssBytes"] as const;
  // Averaged over each step, weighted by the time each row stands for.
  const buckets = new Map<number, { sum: Record<string, number>; weight: Record<string, number> }>();
  for (const row of samplesSince(userId, new Date(from))) {
    const key = Math.floor(row.at.getTime() / stepMs) * stepMs;
    const bucket = buckets.get(key) ?? { sum: {}, weight: {} };
    for (const field of fields) {
      const value = row[field];
      if (value === null || value === undefined) continue;
      bucket.sum[field] = (bucket.sum[field] ?? 0) + value * row.spanS;
      bucket.weight[field] = (bucket.weight[field] ?? 0) + row.spanS;
    }
    buckets.set(key, bucket);
  }
  const mean = (bucket: { sum: Record<string, number>; weight: Record<string, number> }, field: string, whole: boolean) => {
    const weight = bucket.weight[field];
    if (!weight) return null;
    const value = bucket.sum[field] / weight;
    return whole ? Math.round(value) : round1(value);
  };
  const samples = [...buckets].sort(([a], [b]) => a - b).map(([t, bucket]) => ({
    t: new Date(t).toISOString(),
    cpu_pct: mean(bucket, "cpuPct", false),
    ram_used_bytes: mean(bucket, "ramUsedBytes", true),
    gpu_pct: mean(bucket, "gpuPct", false),
    runtime_rss_bytes: mean(bucket, "runtimeRssBytes", true),
    app_rss_bytes: mean(bucket, "appRssBytes", true),
  }));
  const generation = eventsBetween(userId, new Date(from), new Date(now + 1))
    .map((event) => ({ t: event.occurredAt.toISOString(), tps: generationTps(event), model: event.model, source: event.source, ttft_ms: event.ttftMs }))
    .filter((point) => point.tps !== null);
  return { range, step_seconds: step, machine: machineOf(userId), samples, generation };
}

// ── export ──────────────────────────────────────────────────────────────────

const CSV_COLUMNS = ["id", "at", "source", "model", "client", "prompt_tokens", "completion_tokens", "cached_tokens", "prompt_ms", "generation_ms", "ttft_ms", "generation_tps", "estimated"];

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  // A spreadsheet runs a cell that starts like a formula: not these.
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function usageCsv(events: UsageEventRow[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const event of events) {
    lines.push(
      [
        event.id,
        event.occurredAt.toISOString(),
        event.source,
        event.model,
        event.client,
        event.promptTokens,
        event.completionTokens,
        event.cachedTokens,
        event.promptMs,
        event.generationMs,
        event.ttftMs,
        generationTps(event),
        event.estimated ? "true" : "false",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

// ── what the desktop app reports ────────────────────────────────────────────

/// This computer's own app, and nothing else: its session is the owner's
/// (the account made on first launch, or the pairing with the setup token:
/// auth_sessions.origin), and never a phone's, which has a tunnel peer;
/// and the request comes from this very machine (auth.ts fromThisMachine,
/// set by authenticate): not through the tunnel or a proxy, not from the
/// local network — an owner's password typed on another device, or the
/// app's token carried elsewhere, is not the app
/// (docs/connectors-security-review.md, « Other routes »).
export function isThisComputersApp(auth: { sessionId?: string; deviceId?: string; thisMachine?: boolean }): boolean {
  if (auth.deviceId || !auth.sessionId || auth.thisMachine !== true) return false;
  if (!isOwnerSession(auth.sessionId)) return false;
  const [peer] = db.select({ key: tunnelPeers.publicKey }).from(tunnelPeers).where(eq(tunnelPeers.sessionId, auth.sessionId)).limit(1).all();
  return !peer;
}

export const MAX_BATCH = 500;
// A report that waited for a server that was down: a week at most.
const OLDEST_MS = 7 * 24 * 3600 * 1000;
const FUTURE_MS = 5 * 60 * 1000;
const MAX_TOKENS = 10_000_000;
const MAX_MS = 24 * 3600 * 1000;

class Invalid extends Error {}

function readAt(value: unknown, now: number): Date {
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms) || ms < now - OLDEST_MS || ms > now + FUTURE_MS) throw new Invalid("at");
  return new Date(ms);
}

function readCount(value: unknown, name: string, max: number, required: boolean): number | null {
  if (value === undefined || value === null) {
    if (required) throw new Invalid(name);
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) throw new Invalid(name);
  return Math.round(value);
}

function readText(value: unknown, name: string, required: boolean): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Invalid(name);
    return null;
  }
  if (typeof value !== "string" || value.length > 200) throw new Invalid(name);
  return value;
}

function readBatch(body: unknown, key: string): unknown[] {
  const list = (body as Record<string, unknown> | null)?.[key];
  if (!Array.isArray(list) || list.length === 0) throw new Invalid(key);
  if (list.length > MAX_BATCH) throw new Invalid(`${key}: ${MAX_BATCH} at most`);
  return list;
}

function readEvents(body: unknown, now: number) {
  return readBatch(body, "events").map((raw) => {
    if (!raw || typeof raw !== "object") throw new Invalid("events");
    const event = raw as Record<string, unknown>;
    const source = event.source as UsageSource;
    if (!USAGE_SOURCES.includes(source) || source === "chat") throw new Invalid("source");
    if (event.estimated !== undefined && typeof event.estimated !== "boolean") throw new Invalid("estimated");
    return {
      at: readAt(event.at, now),
      source,
      model: readText(event.model, "model", true),
      client: readText(event.client, "client", false) ?? "this-computer",
      promptTokens: readCount(event.prompt_tokens, "prompt_tokens", MAX_TOKENS, true)!,
      completionTokens: readCount(event.completion_tokens, "completion_tokens", MAX_TOKENS, true)!,
      cachedTokens: readCount(event.cached_tokens, "cached_tokens", MAX_TOKENS, false),
      promptMs: readCount(event.prompt_ms, "prompt_ms", MAX_MS, false),
      generationMs: readCount(event.generation_ms, "generation_ms", MAX_MS, false),
      ttftMs: readCount(event.ttft_ms, "ttft_ms", MAX_MS, false),
      estimated: event.estimated === true,
    };
  });
}

function readPct(value: unknown, name: string): number | null {
  const pct = readCount(value, name, 100, false);
  return pct === null ? null : (value as number);
}

function readSamples(body: unknown, now: number): SampleInput[] {
  return readBatch(body, "samples").map((raw) => {
    if (!raw || typeof raw !== "object") throw new Invalid("samples");
    const sample = raw as Record<string, unknown>;
    return {
      at: readAt(sample.at, now),
      cpuPct: readPct(sample.cpu_pct, "cpu_pct"),
      ramUsedBytes: readCount(sample.ram_used_bytes, "ram_used_bytes", Number.MAX_SAFE_INTEGER, false),
      ramTotalBytes: readCount(sample.ram_total_bytes, "ram_total_bytes", Number.MAX_SAFE_INTEGER, false),
      gpuPct: readPct(sample.gpu_pct, "gpu_pct"),
      runtimeRssBytes: readCount(sample.runtime_rss_bytes, "runtime_rss_bytes", Number.MAX_SAFE_INTEGER, false),
      appRssBytes: readCount(sample.app_rss_bytes, "app_rss_bytes", Number.MAX_SAFE_INTEGER, false),
    };
  });
}

function readMachine(body: unknown) {
  const raw = (body as Record<string, unknown> | null)?.machine;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object") throw new Invalid("machine");
  const machine = raw as Record<string, unknown>;
  return {
    cpuModel: readText(machine.cpu_model, "cpu_model", false),
    cores: readCount(machine.cores, "cores", 4096, false),
    ramTotalBytes: readCount(machine.ram_total_bytes, "ram_total_bytes", Number.MAX_SAFE_INTEGER, false),
    gpuName: readText(machine.gpu_name, "gpu_name", false),
    os: readText(machine.os, "os", false),
  };
}

function refuse(reply: FastifyReply, err: unknown) {
  if (err instanceof Invalid) return reply.code(422).send({ error: "invalid", field: err.message });
  throw err;
}

function readPeriodQuery(query: { period?: string; tz?: string; offset?: string }): { period: Period; tz: string; offset: number } | null {
  if (!PERIODS.includes(query.period as Period)) return null;
  const tz = query.tz === undefined ? defaultTimeZone() : validTimeZone(query.tz);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!tz || !Number.isInteger(offset) || offset < 0 || offset > 1000) return null;
  return { period: query.period as Period, tz, offset };
}

export async function usageRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { days?: string; period?: string; tz?: string; offset?: string } }>("/usage", {
    schema: {
      tags: ["usage"],
      summary: "Tokens this computer's models spent: ?days= (by day, model and device) or ?period=day|week|month|year&tz=&offset= (series, speed, by model, device and source)",
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (req.query.period !== undefined) {
        const asked = readPeriodQuery(req.query);
        if (!asked) return reply.code(422).send({ error: "invalid", field: "period, tz or offset" });
        return reply.send(periodUsage(auth.userId, asked.period, asked.tz, asked.offset));
      }
      const asked = Number.parseInt(req.query.days ?? "30", 10);
      const days = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), 365) : 30;
      reply.send(usageSummary(auth.userId, days));
    },
  });

  app.get<{ Querystring: { range?: string } }>("/usage/performance", {
    schema: { tags: ["usage"], summary: "This computer's CPU, GPU and memory, and each answer's speed, over 1h, 24h, 7d or 30d" },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const range = (req.query.range ?? "24h") as Range;
      if (!(range in RANGES)) return reply.code(422).send({ error: "invalid", field: "range" });
      reply.send(performance(auth.userId, range));
    },
  });

  app.get<{ Querystring: { period?: string; tz?: string; offset?: string; from?: string; to?: string } }>("/usage/export.csv", {
    schema: { tags: ["usage"], summary: "Every call to a model in a period (?period=&tz=&offset=) or between ?from= and ?to= (ISO), as CSV" },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      let from: number;
      let to: number;
      if (req.query.period !== undefined) {
        const asked = readPeriodQuery(req.query);
        if (!asked) return reply.code(422).send({ error: "invalid", field: "period, tz or offset" });
        ({ from, to } = periodRange(asked.period, asked.tz, asked.offset));
      } else {
        from = req.query.from ? Date.parse(req.query.from) : 0;
        to = req.query.to ? Date.parse(req.query.to) : Date.now() + 1;
        if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return reply.code(422).send({ error: "invalid", field: "from or to" });
      }
      const name = `twoody-usage-${new Date(from).toISOString().slice(0, 10)}-${new Date(to - 1).toISOString().slice(0, 10)}.csv`;
      reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${name}"`)
        .send(usageCsv(eventsBetween(auth.userId, new Date(from), new Date(to))));
    },
  });

  app.post("/usage/events", {
    schema: { tags: ["usage"], summary: "The desktop app reports its own calls to a model (Twoody Code, the Agent): 500 at most per call" },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!isThisComputersApp(auth)) return reply.code(403).send({ error: "desktop_only" });
      let events: ReturnType<typeof readEvents>;
      try {
        events = readEvents(req.body, Date.now());
      } catch (err) {
        return refuse(reply, err);
      }
      db.transaction(() => {
        for (const event of events) recordUsageEvent({ userId: auth.userId, ...event });
      });
      reply.code(201).send({ accepted: events.length });
    },
  });

  app.post("/usage/samples", {
    schema: { tags: ["usage"], summary: "The desktop app reports this computer's load (15-s samples, 500 at most per call) and, once, the machine" },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!isThisComputersApp(auth)) return reply.code(403).send({ error: "desktop_only" });
      let samples: SampleInput[];
      let machine: ReturnType<typeof readMachine>;
      try {
        machine = readMachine(req.body);
        const list = (req.body as Record<string, unknown> | null)?.samples;
        samples = machine && (list === undefined || (Array.isArray(list) && list.length === 0)) ? [] : readSamples(req.body, Date.now());
      } catch (err) {
        return refuse(reply, err);
      }
      if (machine) recordMachine(auth.userId, machine);
      recordSamples(auth.userId, samples);
      reply.code(201).send({ accepted: samples.length });
    },
  });
}
