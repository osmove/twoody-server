// Turns an OpenAI-style streamed chat completion back into the
// non-streaming response shape. Pure, so it is tested without a runtime.
//
// The Bridge worker streams from the local runtime so tokens reach the
// user as they are generated, but the backend that enqueued the task
// still wants one ordinary completion at the end: the assistant message,
// any tool calls, the finish reason and the token usage.

export interface CompletionToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

export interface CompletionResult {
  id: string;
  object: "chat.completion";
  model: string;
  choices: Array<{
    index: 0;
    finish_reason: string;
    message: { role: "assistant"; content: string; tool_calls?: CompletionToolCall[] };
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

export function createCompletionAccumulator() {
  const toolCalls = new Map<number, CompletionToolCall>();
  let finishReason: string | null = null;
  let promptTokens = 0;
  let completionTokens = 0;

  return {
    /// Feeds one parsed `data:` payload. Returns the text it carried, if
    /// any, so the caller can relay it.
    push(chunk: unknown): string {
      if (!chunk || typeof chunk !== "object") return "";
      const { choices, usage } = chunk as StreamChunk;

      if (usage) {
        promptTokens = usage.prompt_tokens ?? promptTokens;
        completionTokens = usage.completion_tokens ?? completionTokens;
      }

      const choice = choices?.[0];
      if (!choice) return "";
      if (choice.finish_reason) finishReason = choice.finish_reason;

      // `id`, `type` and `name` arrive on the first fragment of a call;
      // `arguments` arrives as string pieces to concatenate. Ollama
      // sends a whole call at once, which is the same thing in one piece.
      for (const fragment of choice.delta?.tool_calls ?? []) {
        const index = fragment.index ?? 0;
        const call = toolCalls.get(index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
        if (fragment.id) call.id = fragment.id;
        if (fragment.type) call.type = fragment.type;
        if (fragment.function?.name) call.function.name = fragment.function.name;
        if (typeof fragment.function?.arguments === "string") call.function.arguments += fragment.function.arguments;
        toolCalls.set(index, call);
      }

      return typeof choice.delta?.content === "string" ? choice.delta.content : "";
    },

    /// `content` is passed in rather than accumulated here: what the
    /// backend stores must be what the user saw, after reasoning blocks
    /// were filtered out of the stream.
    result(args: { id: string; model: string; content: string }): CompletionResult {
      const ordered = [...toolCalls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, call]) => ({ ...call, id: call.id || `call_${args.id}_${index}` }));
      return {
        id: `chatcmpl-${args.id}`,
        object: "chat.completion",
        model: args.model,
        choices: [
          {
            index: 0,
            finish_reason: finishReason ?? (ordered.length > 0 ? "tool_calls" : "stop"),
            message: {
              role: "assistant",
              content: args.content,
              ...(ordered.length > 0 ? { tool_calls: ordered } : {}),
            },
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      };
    },

    completionTokens: () => completionTokens,
  };
}

/// Splits a text/event-stream body into its `data:` payloads, whatever
/// the chunk boundaries of the transport were. `[DONE]` is dropped.
export function createSseDataParser(onData: (payload: string) => void) {
  let buffer = "";
  const handle = (line: string) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (payload && payload !== "[DONE]") onData(payload);
  };
  return {
    push(text: string) {
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) handle(line);
    },
    flush() {
      if (buffer) handle(buffer);
      buffer = "";
    },
  };
}

/// Relays pieces of text through `send` (one HTTP request each) without
/// ever falling behind the model: at most one request is in flight, and
/// whatever is written meanwhile leaves as a single piece as soon as it
/// returns. The batches therefore size themselves to the link — one
/// request per token on a LAN, a few per second across the internet —
/// where a fixed "every N characters" rule would queue requests faster
/// than a slow link can take them, and the text would reach the user
/// later and later. The first piece leaves at once: time to first token
/// is what the user feels.
///
/// `minIntervalMs` only caps the request rate of a very fast model on a
/// very fast link.
export function createDeltaRelay(
  send: (text: string) => Promise<void>,
  options: { minIntervalMs?: number; now?: () => number; wait?: (ms: number) => Promise<void> } = {},
) {
  const minIntervalMs = options.minIntervalMs ?? 40;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let pending = "";
  let lastStart: number | null = null;
  let pump: Promise<void> | null = null;

  async function run() {
    while (pending) {
      const sinceLast = lastStart === null ? Infinity : now() - lastStart;
      if (sinceLast < minIntervalMs) await wait(minIntervalMs - sinceLast);
      const text = pending;
      pending = "";
      lastStart = now();
      // A piece that could not be delivered is not retried: the complete
      // text travels again in the task's final result.
      await send(text).catch(() => undefined);
    }
    pump = null;
  }

  return {
    push(text: string) {
      if (!text) return;
      pending += text;
      pump ??= run();
    },
    /// Resolves once everything pushed so far has been sent.
    async drain() {
      while (pump) await pump;
    },
  };
}
