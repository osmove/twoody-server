import { randomUUID } from "node:crypto";
import { outboundFetch } from "../outbound.js";
import { createThinkFilter } from "../thinkFilter.js";
import { createCompletionAccumulator, createSseDataParser } from "./completionStream.js";
import { resolveTarget } from "./localModels.js";

// `llm_infer` task — run a chat completion on a local OpenAI-compatible
// runtime (mlx-lm, LM Studio, Ollama, llama.cpp, vLLM) on behalf of the
// backend that enqueued it.
//
// Same contract as the macOS and firmware workers:
//   - the runtime is always asked to stream, so each piece of text can be
//     relayed (`onDelta`) while the model is still writing;
//   - the task result is `{ response_json, model_used, latency_ms }`,
//     where `response_json` is an ordinary non-streaming completion
//     rebuilt from the stream, as a string. The backend parses it for the
//     message, the tool calls and the usage.
//
// The model named in the request is honoured; a placeholder ("local",
// "auto") becomes this machine's configured default. See localModels.ts.

// How long a completion may run. The backend waits 180 s for a short
// answer and longer for a long one (60 s to warm up, then its slowest
// supported machine, 7 tokens a second); this stays 10 s under it, so a
// stuck runtime is reported as an error rather than as a timeout nobody
// can explain.
export function inferenceTimeoutMs(maxTokens: unknown): number {
  const tokens = typeof maxTokens === "number" && maxTokens > 0 ? maxTokens : 512;
  const backendWaitSeconds = Math.max(180, 60 + Math.ceil(tokens / 7));
  return Math.min(backendWaitSeconds - 10, 15 * 60) * 1000;
}

export interface LlmInferResult {
  response_json: string;
  model_used: string;
  latency_ms: number;
}

export interface LlmInferHooks {
  onDelta?: (text: string) => void;
  /// Reported once the run is over, for the worker's heartbeat.
  onStats?: (stats: { model: string; completionTokens: number; latencyMs: number }) => void;
}

export async function runLlmInfer(args: Record<string, unknown>, hooks: LlmInferHooks = {}): Promise<LlmInferResult> {
  const raw = String(args.openai_body_json ?? "");
  if (!raw) throw new Error("openai_body_json is required");

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error("openai_body_json_invalid_json");
  }

  const started = Date.now();
  const { endpoint, model } = await resolveTarget(body.model);
  const request = { ...body, model, stream: true, stream_options: { include_usage: true } };

  const post = (payload: object) =>
    outboundFetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(inferenceTimeoutMs(body.max_tokens)),
    });

  let res = await post(request);
  // `chat_template_kwargs` and `stream_options` are extensions a strict
  // runtime may refuse; the completion works without them.
  if (res.status === 400 || res.status === 422) {
    const { chat_template_kwargs: _kwargs, stream_options: _options, ...plain } = request as Record<string, unknown>;
    res = await post(plain);
  }
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`local_llm_status_${res.status}: ${detail.slice(0, 200)}`);
  }

  const accumulator = createCompletionAccumulator();
  let content = "";
  // Reasoning models open with a <think> block. It is dropped from what
  // is relayed and from the stored message alike.
  const visible = createThinkFilter((text) => {
    content += text;
    hooks.onDelta?.(text);
  });
  const parser = createSseDataParser((payload) => {
    try {
      const text = accumulator.push(JSON.parse(payload));
      if (text) visible.push(text);
    } catch {
      // a malformed line must not lose the rest of the answer
    }
  });

  if ((res.headers.get("content-type") ?? "").includes("application/json")) {
    // A runtime that ignored `stream`: one ordinary completion. Feed it
    // through the same path as a single piece.
    const completion = (await res.json()) as {
      choices?: Array<{ message?: { content?: string; tool_calls?: unknown[] }; finish_reason?: string }>;
      usage?: object;
    };
    const choice = completion.choices?.[0];
    const text = accumulator.push({
      choices: [{ delta: { content: choice?.message?.content ?? "", tool_calls: choice?.message?.tool_calls }, finish_reason: choice?.finish_reason }],
      usage: completion.usage,
    });
    if (text) visible.push(text);
  } else {
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.flush();
  }
  visible.flush();

  const latencyMs = Date.now() - started;
  hooks.onStats?.({ model, completionTokens: accumulator.completionTokens(), latencyMs });

  return {
    response_json: JSON.stringify(accumulator.result({ id: randomUUID(), model, content })),
    model_used: model,
    latency_ms: latencyMs,
  };
}
