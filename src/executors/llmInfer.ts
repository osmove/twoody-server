// `llm_infer` task — proxy a chat completion to the local OpenAI-compatible LLM.
//
// `BRIDGE_LOCAL_LLM_ENDPOINT` should point at the `/v1` root of an
// OpenAI-compatible server. The two supported deployments today are:
//   - Ollama:  http://127.0.0.1:11434/v1
//   - mlx-lm:  http://127.0.0.1:8080/v1
//
// We deliberately force `stream: false` here even if the caller asked
// for streaming — the in-process bridge path doesn't surface deltas to
// the bridge consumer, so streaming would only buffer in memory before
// the same final shape gets returned anyway. The legacy Mac worker
// streamed via PATCH deltas; that path is still available when this
// server is itself fronted by a long-polling worker, see
// `runStreamingInference` below.

const DEFAULT_ENDPOINT = process.env.BRIDGE_LOCAL_LLM_ENDPOINT ?? "http://127.0.0.1:11434/v1";

export async function runLlmInfer(args: Record<string, unknown>) {
  const raw = String(args.openai_body_json ?? "");
  if (!raw) throw new Error("openai_body_json is required");

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch (error) {
    throw new Error("openai_body_json_invalid_json");
  }

  body.stream = false;

  const endpoint = (process.env.BRIDGE_LOCAL_LLM_ENDPOINT ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const url = `${endpoint}/chat/completions`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // surface raw text if the local LLM returned a non-JSON error page
  }

  if (!res.ok) {
    throw new Error(`local_llm_status_${res.status}: ${typeof parsed === "string" ? parsed.slice(0, 200) : ""}`);
  }

  return parsed;
}
