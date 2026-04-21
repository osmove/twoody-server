import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.js";

interface QueryBody {
  content: string;
  channel?: string;
  format_shape?: string;
  model?: string;
  discussion_id?: string;
}

// Minimal SSE streaming wrapper around OpenAI / Anthropic / Gemini / mlx-lm
export async function queryRoutes(app: FastifyInstance) {
  app.post<{ Body: QueryBody }>("/queries", async (req, reply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return;

    const {
      content,
      channel = "cli",
      model,
    } = req.body;

    if (!content?.trim()) {
      return reply.code(422).send({ error: "content is required" });
    }

    // Resolve provider and key from env
    const provider = resolveProvider(model);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Keepalive ping every 15 s (Heroku / nginx drops idle SSE after 30 s)
    const keepalive = setInterval(() => {
      reply.raw.write(": ping\n\n");
    }, 15_000);

    try {
      await streamFromProvider(provider, content, model, (delta) => {
        reply.raw.write(`data: ${JSON.stringify({ delta })}\n\n`);
      });
      reply.raw.write("data: [DONE]\n\n");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      reply.raw.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
    } finally {
      clearInterval(keepalive);
      reply.raw.end();
    }
  });
}

type Provider = "openai" | "anthropic" | "gemini" | "mlx";

function resolveProvider(model?: string): Provider {
  if (model?.startsWith("claude")) return "anthropic";
  if (model?.startsWith("gemini")) return "gemini";
  if (model === "local" || model === "mlx") return "mlx";
  // Env-driven default
  if (process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY)
    return "anthropic";
  if (process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY)
    return "gemini";
  if (process.env.BRIDGE_LOCAL_LLM_ENDPOINT) return "mlx";
  return "openai";
}

async function streamFromProvider(
  provider: Provider,
  content: string,
  model: string | undefined,
  onDelta: (text: string) => void
) {
  switch (provider) {
    case "openai":
      return streamOpenAI(content, model ?? "gpt-4o-mini", onDelta);
    case "anthropic":
      return streamAnthropic(content, model ?? "claude-haiku-4-5-20251001", onDelta);
    case "gemini":
      return streamGemini(content, model ?? "gemini-2.0-flash", onDelta);
    case "mlx":
      return streamLocal(content, model ?? "local", onDelta);
  }
}

async function streamOpenAI(
  content: string,
  model: string,
  onDelta: (t: string) => void
) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      stream: true,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI ${res.status}: ${err}`);
  }

  await consumeOpenAIStream(res, onDelta);
}

async function streamAnthropic(
  content: string,
  model: string,
  onDelta: (t: string) => void
) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [{ role: "user", content }],
      stream: true,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic ${res.status}: ${err}`);
  }

  // Parse Anthropic SSE (event: content_block_delta / delta.text)
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (!raw || raw === "[DONE]") continue;
      try {
        const evt = JSON.parse(raw) as {
          type?: string;
          delta?: { type?: string; text?: string };
        };
        if (evt.type === "content_block_delta" && evt.delta?.text)
          onDelta(evt.delta.text);
      } catch {
        // ignore
      }
    }
  }
}

async function streamGemini(
  content: string,
  model: string,
  onDelta: (t: string) => void
) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${key}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: content }] }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini ${res.status}: ${err}`);
  }

  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (!raw) continue;
      try {
        const evt = JSON.parse(raw) as {
          candidates?: Array<{
            content?: { parts?: Array<{ text?: string }> };
          }>;
        };
        const text = evt.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
        if (text) onDelta(text);
      } catch {
        // ignore
      }
    }
  }
}

async function streamLocal(
  content: string,
  model: string,
  onDelta: (t: string) => void
) {
  const endpoint =
    process.env.BRIDGE_LOCAL_LLM_ENDPOINT ?? "http://127.0.0.1:8080/v1";

  const res = await fetch(endpoint + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      stream: true,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Local LLM ${res.status}: ${err}`);
  }

  await consumeOpenAIStream(res, onDelta);
}

async function consumeOpenAIStream(
  res: Response,
  onDelta: (t: string) => void
) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (!raw || raw === "[DONE]") continue;
      try {
        const evt = JSON.parse(raw) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const text = evt.choices?.[0]?.delta?.content ?? "";
        if (text) onDelta(text);
      } catch {
        // ignore
      }
    }
  }
}
