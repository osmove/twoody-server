import type { FastifyReply, FastifyRequest } from "fastify";
import { beginGeneration } from "./account/inflight.js";
import { noteModelUsed } from "./account/statusSource.js";
import type { Purpose } from "./account/status.js";
import { ensureBuiltin, isBuiltinUrl } from "./engine.js";
import { RuntimeError } from "./builtin/index.js";
import { LocalOnlyError, outboundFetch } from "./outbound.js";
import { runtimeAuthHeaders } from "./runtimeAuth.js";
import { runtimeSlot } from "./runtimeSlots.js";
import { recordUsageEvent, type UsageSource } from "./usageStore.js";
import { withTimings } from "./routes/queries.js";

// An OpenAI-compatible chat completion passed to this computer's runtime,
// as it is, and its answer passed back as it comes (streamed or not): what
// another computer of the account asks (routes/peer.ts) and what a program
// of this machine asks with a local API key (routes/developerApi.ts,
// docs/developer-api-design.md). Only the fields below go through; nothing
// of the conversation is kept, only a usage event.

/// The fields passed to the runtime; anything else is dropped.
export const PASSED = ["model", "messages", "tools", "tool_choice", "max_tokens", "temperature", "top_p", "stop", "stream", "stream_options", "response_format", "seed"] as const;
/// The runtime-specific switches (reasoning), dropped on a runtime that refuses them.
export const EXTRAS = ["chat_template_kwargs", "reasoning_effort", "thinking_budget_tokens"] as const;

type Body = Record<string, unknown>;

/// How a caller words a refusal: { error, message } for the peers,
/// OpenAI's { error: { message, type, code } } for the developer API.
export type Fail = (reply: FastifyReply, status: number, code: string, message: string) => unknown;

/// Starts the built-in runtime for a model it holds. False when the reply
/// was sent: a model that would not fit in memory now is « busy ».
export async function startHolder(baseUrl: string, model: string, reply: FastifyReply, fail: Fail): Promise<boolean> {
  if (!isBuiltinUrl(baseUrl)) return true;
  try {
    await ensureBuiltin(model);
    return true;
  } catch (err) {
    if (!(err instanceof RuntimeError)) throw err;
    if (err.code === "insufficient_memory") fail(reply, 503, "busy", err.message);
    else fail(reply, err.status, "runtime_unavailable", err.message);
    return false;
  }
}

export interface RelayOptions {
  req: FastifyRequest;
  reply: FastifyReply;
  userId: string;
  baseUrl: string;
  model: string;
  body: Body;
  purpose: Purpose;
  maxTokens: number;
  source: UsageSource;
  client: string | null;
  fail: Fail;
}

export async function relayCompletion(options: RelayOptions): Promise<unknown> {
  const { reply, baseUrl, model, body, purpose, fail } = options;
  const payload: Body = {};
  for (const field of PASSED) if (body[field] !== undefined) payload[field] = body[field];
  const requested = typeof body.max_tokens === "number" && body.max_tokens > 0 ? Math.floor(body.max_tokens) : options.maxTokens;
  payload.max_tokens = Math.min(requested, options.maxTokens);
  const stream = payload.stream === true;
  if (stream) payload.stream_options = { include_usage: true };
  const extras: Body = {};
  for (const field of EXTRAS) if (body[field] !== undefined) extras[field] = body[field];
  // This computer's runtime, this computer's slots: the caller never
  // names one (runtimeSlots.ts). The person's own computer, and a program
  // of this machine, ask as the owner: slot 0 when there are two.
  const slot = await runtimeSlot(baseUrl, model, purpose);
  if (slot !== null) extras.id_slot = slot;

  const end = beginGeneration(purpose);
  const upstream = new AbortController();
  reply.raw.on("close", () => {
    if (!reply.raw.writableFinished) upstream.abort();
  });
  const endpoint = `${baseUrl}/chat/completions`;
  const post = (json: Body) =>
    outboundFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...runtimeAuthHeaders(baseUrl) },
      body: JSON.stringify(json),
      signal: upstream.signal,
    });
  const started = Date.now();
  let first = 0;
  try {
    let response: Response;
    try {
      response = await post({ ...payload, ...extras });
      if ((response.status === 400 || response.status === 422) && Object.keys(extras).length > 0) {
        await response.body?.cancel().catch(() => undefined);
        response = await post(payload);
      }
    } catch (err) {
      if (err instanceof LocalOnlyError) throw err;
      return fail(reply, 503, "runtime_unavailable", "the model runtime on this computer does not answer");
    }
    noteModelUsed(model);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return reply.code(response.status >= 500 ? 502 : response.status).type("application/json").send(text || JSON.stringify({ error: "runtime_error" }));
    }

    // What the runtime said it spent, read on the way through.
    let usage: { prompt_tokens: number; completion_tokens: number; cached_tokens?: number | null } | null = null;
    let timings: Record<string, unknown> | null = null;
    let written = 0;
    const readEvent = (json: Record<string, unknown>) => {
      const u = json.usage as { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } } | undefined;
      if (u && typeof u.prompt_tokens === "number") {
        usage = {
          prompt_tokens: u.prompt_tokens,
          completion_tokens: typeof u.completion_tokens === "number" ? u.completion_tokens : 0,
          ...(typeof u.prompt_tokens_details?.cached_tokens === "number" ? { cached_tokens: u.prompt_tokens_details.cached_tokens } : {}),
        };
      }
      if (json.timings && typeof json.timings === "object") timings = json.timings as Record<string, unknown>;
      const choice = (json.choices as Array<{ delta?: { content?: unknown; reasoning?: unknown; reasoning_content?: unknown }; message?: { content?: unknown } }> | undefined)?.[0];
      for (const part of [choice?.delta?.content, choice?.delta?.reasoning, choice?.delta?.reasoning_content, choice?.message?.content]) {
        if (typeof part === "string" && part) {
          first ||= Date.now();
          written += part.length;
        }
      }
    };

    if (!stream) {
      const text = await response.text();
      try {
        readEvent(JSON.parse(text));
      } catch {
        // passed on as it came
      }
      reply.code(200).type(response.headers.get("content-type") ?? "application/json").send(text);
    } else {
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": response.headers.get("content-type") ?? "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        reply.raw.write(value);
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === "[DONE]") continue;
          try {
            readEvent(JSON.parse(raw));
          } catch {
            // not ours to judge
          }
        }
      }
      reply.raw.end();
    }
    const ended = Date.now();
    const reported = withTimings(usage, timings);
    try {
      recordUsageEvent({
        userId: options.userId,
        source: options.source,
        model,
        client: options.client,
        promptTokens: reported?.prompt_tokens ?? Math.ceil(JSON.stringify(payload.messages).length / 3.5),
        completionTokens: reported?.completion_tokens ?? Math.ceil(written / 3.5),
        cachedTokens: reported?.cached_tokens ?? null,
        promptMs: reported?.prompt_ms ?? null,
        generationMs: reported?.generation_ms ?? (first ? ended - first : null),
        ttftMs: first ? first - started : null,
        estimated: !reported,
      });
    } catch {
      // counted next time
    }
  } catch (err) {
    if (upstream.signal.aborted) {
      if (!reply.raw.writableEnded) reply.raw.end();
      return;
    }
    if (reply.sent || reply.raw.headersSent) {
      reply.raw.end();
      return;
    }
    if (err instanceof LocalOnlyError) return fail(reply, 403, "local_only", err.message);
    return fail(reply, 502, "runtime_error", "the model runtime on this computer failed");
  } finally {
    end();
  }
}
