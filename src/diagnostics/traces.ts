import { randomUUID } from "node:crypto";
import { sqlite } from "../db.js";
import { modelLabel } from "./installation.js";

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
  /// list_files: what became of the folder asked (ok, missing, not_granted…) and the files shown.
  status?: string;
  files?: number;
  error?: string;
  /// The start of what the tool returned, as the model read it (local only,
  /// never in telemetryOf).
  result_preview?: string;
}

/// What the model was given for an answer (« Détails » under it).
export interface TurnPrompt {
  messages: Array<{ role: string; content: unknown }>;
  tools: Array<{ name: string; description: string; parameters: unknown }>;
}

const MAX_PROMPT_JSON = 2 * 1024 * 1024;

/// message_traces.kind (schema/contract.json, the same on the account).
export const TRACE_KINDS = ["chat", "learn", "warm"] as const;

export interface TurnTrace {
  kind: (typeof TRACE_KINDS)[number];
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

export function recordTrace(userId: string, trace: TurnTrace, at = Date.now(), prompt: TurnPrompt | null = null): string | null {
  try {
    const id = randomUUID();
    let promptJson: string | null = null;
    if (prompt) {
      promptJson = JSON.stringify(prompt);
      if (promptJson.length > MAX_PROMPT_JSON) promptJson = JSON.stringify({ truncated: true, messages: prompt.messages.map((message) => ({ role: message.role, content: String(typeof message.content === "string" ? message.content : JSON.stringify(message.content)).slice(0, 20_000) })), tools: prompt.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: null })) });
    }
    let json = JSON.stringify(trace.detail ?? {});
    if (json.length > MAX_JSON) json = JSON.stringify({ truncated: true, keys: Object.keys(trace.detail ?? {}) });
    sqlite.prepare(`INSERT INTO message_traces (id, user_id, occurred_at, kind, discussion_id, message_id, client, model, outcome, error, total_ms, trace, prompt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, userId, at, trace.kind, trace.discussionId ?? null, trace.messageId ?? null, trace.client ?? null, trace.model ?? null,
      trace.outcome, trace.error ? String(trace.error).slice(0, 500) : null, trace.totalMs ?? null, json, promptJson,
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
  try { detail = JSON.parse(String(row.trace ?? "{}")); } catch { /* empty */ }
  return {
    id: String(row.id), at: new Date(Number(row.occurred_at)).toISOString(), kind: String(row.kind),
    discussion_id: (row.discussion_id as string | null) ?? null, message_id: (row.message_id as string | null) ?? null,
    client: (row.client as string | null) ?? null, model: (row.model as string | null) ?? null,
    outcome: String(row.outcome), error: (row.error as string | null) ?? null, total_ms: (row.total_ms as number | null) ?? null, detail,
  };
}

/// A trace of a walled-off project (src/projects/isolation.ts): one of its
/// conversations' answers, or the read-ahead of its start (`isolated` in
/// the trace). Never shared with the account, whatever is ticked, and
/// shown to this computer's app only.
const WALLED = `(COALESCE(discussion_id, '') IN (SELECT d.id FROM discussions d JOIN projects p ON p.id = d.project_id WHERE p.isolated = 1) OR COALESCE(json_extract(trace, '$.isolated'), 0) = 1)`;

export function listTraces(userId: string, options: { limit?: number; before?: number | null; kind?: string | null; discussionId?: string | null; hideWalled?: boolean } = {}): TraceRow[] {
  const limit = Math.min(200, Math.max(1, options.limit ?? 50));
  const rows = sqlite.prepare(`SELECT * FROM message_traces WHERE user_id = ? AND occurred_at < ? AND (? IS NULL OR kind = ?) AND (? IS NULL OR discussion_id = ?)${options.hideWalled ? ` AND NOT ${WALLED}` : ""}
    ORDER BY occurred_at DESC LIMIT ?`).all(userId, options.before ?? Number.MAX_SAFE_INTEGER, options.kind ?? null, options.kind ?? null, options.discussionId ?? null, options.discussionId ?? null, limit) as Array<Record<string, unknown>>;
  return rows.map(rowOf);
}

/// What the model was given for the answer of a trace, when it was kept.
export function promptOfTrace(userId: string, traceId: string): TurnPrompt | null {
  const row = sqlite.prepare("SELECT prompt FROM message_traces WHERE user_id = ? AND id = ?").get(userId, traceId) as { prompt: string | null } | undefined;
  try {
    return row?.prompt ? (JSON.parse(row.prompt) as TurnPrompt) : null;
  } catch {
    return null;
  }
}

export function traceOfMessage(userId: string, messageId: string, hideWalled = false): TraceRow | null {
  const row = sqlite.prepare(`SELECT * FROM message_traces WHERE user_id = ? AND message_id = ?${hideWalled ? ` AND NOT ${WALLED}` : ""} ORDER BY occurred_at DESC LIMIT 1`).get(userId, messageId) as Record<string, unknown> | undefined;
  return row ? rowOf(row) : null;
}

/// What a trace says without anything the person wrote: names, counts,
/// sizes, durations, model ids, outcomes — flat, at most 40 values (the
/// account's app analytics take no more, twoody-backend
/// AppAnalytics::EventIngestor). Shared only while « Partager des
/// diagnostics » is ticked (by default in a beta); never the arguments,
/// texts, titles, file or folder names.
/// A tool's name as diagnostics may share it: a connector's tool
/// (mcp__<connector>__<tool>) carries a name the person chose and what
/// their server calls its tools — shared as « mcp » only.
function sharedToolName(name: unknown): string {
  const text = String(name);
  return text.startsWith("mcp__") ? "mcp" : text;
}

export function telemetryOf(row: TraceRow): Record<string, string | number | boolean> {
  const detail = row.detail as Record<string, any>;
  const out: Record<string, string | number | boolean | null | undefined> = {
    model: modelLabel(row.model), outcome: row.outcome, error: row.error ? row.error.split(":")[0] : null, total_ms: row.total_ms,
  };
  if (row.kind === "chat") {
    const calls = Array.isArray(detail.tool_calls) ? (detail.tool_calls as ToolCallTrace[]) : [];
    Object.assign(out, {
      provider: detail.provider, routed: detail.computer?.routed ?? detail.routing, effort: detail.effort, channel: detail.channel,
      memory_mode: detail.memory_mode, memory_retrieval: detail.memory?.retrieval, memory_retrieval_ms: detail.memory?.retrieval_ms,
      memory_profile_tokens: detail.memory?.profile_tokens, memory_relevant_tokens: detail.memory?.relevant_tokens, memory_items: detail.memory?.items,
      documents_mode: detail.documents?.mode, documents_decision: detail.documents?.decision, documents_reason: detail.documents?.reason,
      documents_passages: detail.documents?.passages, documents_files: detail.documents?.files, documents_ms: detail.timings?.documents_ms,
      tools_offered: Array.isArray(detail.tools_offered) ? detail.tools_offered.map(sharedToolName).join(",") : null,
      tool_calls: calls.length, tool_names: calls.map((call) => sharedToolName(call.name)).join(","), tool_ms: calls.reduce((sum, call) => sum + (call.ms || 0), 0),
      tool_passages: calls.reduce((sum, call) => sum + (call.passages || 0), 0), tool_errors: calls.filter((call) => call.error).length,
      prompt_messages: detail.prompt?.messages, prompt_system_chars: detail.prompt?.system_chars, prompt_history_chars: detail.prompt?.history_chars,
      prompt_last_chars: detail.prompt?.last_chars, prompt_excerpts_chars: detail.prompt?.excerpts_chars, prompt_remembered: detail.prompt?.remembered,
      tokens_prompt: detail.tokens?.prompt, tokens_cached: detail.tokens?.cached, tokens_completion: detail.tokens?.completion, tokens_estimated: detail.tokens?.estimated,
      prompt_ms: detail.tokens?.prompt_ms, generation_ms: detail.tokens?.generation_ms, ttft_ms: detail.timings?.ttft_ms, answer_ms: detail.timings?.answer_ms,
      attempts_failed: Array.isArray(detail.attempts) ? detail.attempts.length : 0,
      projects: Array.isArray(detail.projects) ? detail.projects.length : 0,
    });
  } else if (row.kind === "learn") {
    const dropped = Array.isArray(detail.dropped) ? (detail.dropped as Array<{ reason: string }>) : [];
    Object.assign(out, {
      person_lines: detail.lines?.person, known: detail.lines?.known, facts: detail.facts,
      saved: Array.isArray(detail.saved) ? detail.saved.length : 0, proposed: Array.isArray(detail.proposed) ? detail.proposed.length : 0,
      dropped: dropped.length, dropped_reasons: [...new Set(dropped.map((entry) => entry.reason))].join(","),
      projects_proposed: Array.isArray(detail.projects?.proposed) ? detail.projects.proposed.length : 0,
      projects_dropped: Array.isArray(detail.projects?.dropped) ? detail.projects.dropped.length : 0,
    });
  } else if (row.kind === "warm") {
    Object.assign(out, { system_chars: detail.system_chars, tools: Array.isArray(detail.tools) ? detail.tools.join(",") : null });
  }
  return Object.fromEntries(Object.entries(out).filter((entry): entry is [string, string | number | boolean] => entry[1] !== null && entry[1] !== undefined && entry[1] !== "").slice(0, 40));
}

/// « Partager aussi le détail des réponses » (Jimmy, 03/10/2026, for audits,
/// off unless ticked): each trace whole — the person's words included — and
/// the prompt its model was given, after a point, oldest first.
export function fullTracesSince(userId: string, after: number, limit = 20) {
  const rows = sqlite.prepare(`SELECT * FROM message_traces WHERE user_id = ? AND occurred_at > ? AND NOT ${WALLED} ORDER BY occurred_at ASC LIMIT ?`).all(userId, after, Math.min(Math.max(limit, 1), 50)) as Array<Record<string, unknown>>;
  const traces = rows.map((row) => {
    const trace = rowOf(row);
    return { event_uuid: trace.id, occurred_at: trace.at, kind: trace.kind, discussion_id: trace.discussion_id, message_id: trace.message_id, client: trace.client, model: trace.model, outcome: trace.outcome, error: trace.error, total_ms: trace.total_ms, trace: trace.detail, prompt: promptOfTrace(userId, trace.id) };
  });
  return { traces, next: rows.length ? Number(rows[rows.length - 1]!.occurred_at) : after };
}

/// Traces after a point, oldest first, as the account's app analytics take
/// them (events of « assistant_turn », « assistant_learning »,
/// « assistant_warmup »).
export function telemetrySince(userId: string, after: number, limit = 50) {
  const rows = (sqlite.prepare(`SELECT * FROM message_traces WHERE user_id = ? AND occurred_at > ? AND NOT ${WALLED} ORDER BY occurred_at LIMIT ?`).all(userId, after, Math.min(50, Math.max(1, limit))) as Array<Record<string, unknown>>).map(rowOf);
  const names: Record<string, string> = { chat: "assistant_turn", learn: "assistant_learning", warm: "assistant_warmup" };
  return {
    events: rows.map((row) => ({ event_uuid: row.id, name: names[row.kind] ?? `assistant_${row.kind}`, occurred_at: row.at, metadata: telemetryOf(row) })),
    next: rows.length ? Date.parse(rows.at(-1)!.at) : after,
  };
}
