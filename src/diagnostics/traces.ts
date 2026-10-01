import { randomUUID } from "node:crypto";
import { sqlite } from "../db.js";

// What happened in each answer (Jimmy, 01/10/2026: « ne faudrait-il pas
// logguer les function calls, et tout ce qui peut être utile pour
// debugger ? »): kept on this computer, read on the Diagnostic screen
// (GET /diagnostics/turns). Nothing here leaves it; what could one day be
// shared, on the person's say, is the content-free part (telemetryOf).

export interface ToolCallTrace {
  name: string;
  /// As the model wrote them: they hold the person's words (local only).
  arguments: string;
  round: number;
  ms: number;
  result_chars: number;
  /// Passages a document search returned.
  passages?: number;
  error?: string;
}

export interface TurnTrace {
  kind: "chat" | "learn" | "warm";
  discussionId?: string | null;
  messageId?: string | null;
  client?: string | null;
  model?: string | null;
  outcome: "answered" | "stopped" | "error" | "skipped";
  error?: string | null;
  totalMs?: number | null;
  /// Everything else, as it comes: provider, computer, effort, modes,
  /// documents decision, tools offered and called, prompt parts, timings,
  /// tokens, fallbacks; or, for the learner, what it kept and dropped.
  detail: Record<string, unknown>;
}

const MAX_JSON = 64 * 1024;

export function recordTrace(userId: string, trace: TurnTrace, at = Date.now()): string | null {
  try {
    const id = randomUUID();
    let json = JSON.stringify(trace.detail ?? {});
    if (json.length > MAX_JSON) json = JSON.stringify({ truncated: true, keys: Object.keys(trace.detail ?? {}) });
    sqlite.prepare(`INSERT INTO turn_traces (id, user_id, at, kind, discussion_id, message_id, client, model, outcome, error, total_ms, trace_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, userId, at, trace.kind, trace.discussionId ?? null, trace.messageId ?? null, trace.client ?? null, trace.model ?? null,
      trace.outcome, trace.error ? String(trace.error).slice(0, 500) : null, trace.totalMs ?? null, json,
    );
    return id;
  } catch {
    // A trace is never worth failing an answer.
    return null;
  }
}

export interface TraceRow {
  id: string;
  at: string;
  kind: string;
  discussion_id: string | null;
  message_id: string | null;
  client: string | null;
  model: string | null;
  outcome: string;
  error: string | null;
  total_ms: number | null;
  detail: Record<string, unknown>;
}

function rowOf(row: Record<string, unknown>): TraceRow {
  let detail: Record<string, unknown> = {};
  try { detail = JSON.parse(String(row.trace_json ?? "{}")); } catch { /* empty */ }
  return {
    id: String(row.id), at: new Date(Number(row.at)).toISOString(), kind: String(row.kind),
    discussion_id: (row.discussion_id as string | null) ?? null, message_id: (row.message_id as string | null) ?? null,
    client: (row.client as string | null) ?? null, model: (row.model as string | null) ?? null,
    outcome: String(row.outcome), error: (row.error as string | null) ?? null, total_ms: (row.total_ms as number | null) ?? null, detail,
  };
}

export function listTraces(userId: string, options: { limit?: number; before?: number | null; kind?: string | null; discussionId?: string | null } = {}): TraceRow[] {
  const limit = Math.min(200, Math.max(1, options.limit ?? 50));
  const rows = sqlite.prepare(`SELECT * FROM turn_traces WHERE user_id = ? AND at < ? AND (? IS NULL OR kind = ?) AND (? IS NULL OR discussion_id = ?)
    ORDER BY at DESC LIMIT ?`).all(userId, options.before ?? Number.MAX_SAFE_INTEGER, options.kind ?? null, options.kind ?? null, options.discussionId ?? null, options.discussionId ?? null, limit) as Array<Record<string, unknown>>;
  return rows.map(rowOf);
}

export function traceOfMessage(userId: string, messageId: string): TraceRow | null {
  const row = sqlite.prepare("SELECT * FROM turn_traces WHERE user_id = ? AND message_id = ? ORDER BY at DESC LIMIT 1").get(userId, messageId) as Record<string, unknown> | undefined;
  return row ? rowOf(row) : null;
}

/// What a trace says without anything the person wrote: names, counts,
/// sizes, durations, model ids, outcomes. The part that could be shared,
/// one day, on the person's say (never the arguments, texts or titles).
export function telemetryOf(row: TraceRow): Record<string, unknown> {
  const detail = row.detail;
  const calls = Array.isArray(detail.tool_calls) ? (detail.tool_calls as ToolCallTrace[]) : [];
  return {
    at: row.at, kind: row.kind, model: row.model, outcome: row.outcome, error: row.error, total_ms: row.total_ms,
    provider: detail.provider ?? null, routed: detail.routed ?? null, effort: detail.effort ?? null,
    memory_mode: detail.memory_mode ?? null, documents: detail.documents ?? null,
    tools_offered: detail.tools_offered ?? [], tool_calls: calls.map(({ name, round, ms, result_chars, passages, error }) => ({ name, round, ms, result_chars, passages, error })),
    prompt: detail.prompt ?? null, timings: detail.timings ?? null, tokens: detail.tokens ?? null,
  };
}
