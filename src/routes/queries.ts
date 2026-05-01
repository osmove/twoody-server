import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.js";
import { db, providers } from "../db.js";
import { eq } from "drizzle-orm";

interface QueryBody {
  content: string;
  channel?: string;
  format_shape?: string;
  model?: string;
  discussion_id?: string;
}

// Minimal SSE streaming wrapper around OpenAI / Anthropic / Gemini / mlx-lm
export async function queryRoutes(app: FastifyInstance) {
  app.post<{ Body: QueryBody }>("/queries", {
    schema: {
      tags: ["queries"],
      summary: "Stream a chat completion over SSE",
      security: [{ bearerAuth: [] }],
      body: {
        type: "object",
        required: ["content"],
        properties: {
          content: { type: "string" },
          channel: { type: "string" },
          format_shape: { type: "string" },
          model: { type: "string" },
          discussion_id: { type: "string" },
        },
      },
      produces: ["text/event-stream"],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;

      const { content, channel = "cli", model } = req.body;

      if (!content?.trim()) {
        return reply.code(422).send({ error: "content is required" });
      }

      void channel;

      let sseStarted = false;
      let keepalive: ReturnType<typeof setInterval> | null = null;
      const startSse = () => {
        if (sseStarted) return;
        sseStarted = true;
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        keepalive = setInterval(() => {
          reply.raw.write(": ping\n\n");
        }, 15_000);
      };

      try {
        const provider = resolveProvider(auth.userId, model);
        await streamFromProvider(provider, content, (delta) => {
          startSse();
          reply.raw.write(`data: ${JSON.stringify({ delta })}\n\n`);
        });
        startSse();
        reply.raw.write("data: [DONE]\n\n");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        if (!sseStarted) {
          if (err instanceof LocalLlmUnavailableError) {
            return reply.code(503).send({ error: "local_llm_unavailable", message: msg });
          }
          return reply.code(502).send({ error: "provider_error", message: msg });
        }
        reply.raw.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
      } finally {
        if (keepalive) clearInterval(keepalive);
        if (sseStarted) reply.raw.end();
      }
    },
  });
}

type Provider =
  | { kind: "openai"; model: string }
  | { kind: "anthropic"; model: string }
  | { kind: "gemini"; model: string }
  | { kind: "local_openai"; model: string; baseUrl: string };

class LocalLlmUnavailableError extends Error {}

function resolveProvider(userId: string, requestedModel?: string): Provider {
  const configuredProviders = db
    .select()
    .from(providers)
    .where(eq(providers.userId, userId))
    .all()
    .filter((provider) => provider.enabled);

  const defaultProvider =
    configuredProviders.find((provider) => provider.isDefault) ?? configuredProviders[0];

  if (defaultProvider?.kind === "local_openai" && defaultProvider.baseUrl) {
    return {
      kind: "local_openai",
      baseUrl: defaultProvider.baseUrl,
      model: requestedModel ?? defaultProvider.model ?? "local",
    };
  }

  if (process.env.BRIDGE_LOCAL_LLM_ENDPOINT) {
    return {
      kind: "local_openai",
      baseUrl: process.env.BRIDGE_LOCAL_LLM_ENDPOINT,
      model: requestedModel ?? "local",
    };
  }

  if (process.env.TWOODY_CLOUD_FALLBACK_ENABLED === "true") {
    if (requestedModel?.startsWith("claude")) {
      return { kind: "anthropic", model: requestedModel };
    }
    if (requestedModel?.startsWith("gemini")) {
      return { kind: "gemini", model: requestedModel };
    }
    if (process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
      return { kind: "anthropic", model: requestedModel ?? "claude-haiku-4-5-20251001" };
    }
    if (process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY) {
      return { kind: "gemini", model: requestedModel ?? "gemini-2.0-flash" };
    }
    if (process.env.OPENAI_API_KEY) {
      return { kind: "openai", model: requestedModel ?? "gpt-4o-mini" };
    }
  }

  throw new LocalLlmUnavailableError(
    "No local LLM provider is configured and cloud fallback is disabled"
  );
}

async function streamFromProvider(
  provider: Provider,
  content: string,
  onDelta: (text: string) => void
) {
  switch (provider.kind) {
    case "openai":
      return streamOpenAI(content, provider.model, onDelta);
    case "anthropic":
      return streamAnthropic(content, provider.model, onDelta);
    case "gemini":
      return streamGemini(content, provider.model, onDelta);
    case "local_openai":
      return streamLocal(provider.baseUrl, content, provider.model, onDelta);
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
  baseUrl: string,
  content: string,
  model: string,
  onDelta: (t: string) => void
) {
  const endpoint = baseUrl.replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetch(endpoint + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content }],
        stream: true,
      }),
    });
  } catch {
    throw new LocalLlmUnavailableError("Local LLM provider is unavailable");
  }

  if (!res.ok) {
    throw new LocalLlmUnavailableError(`Local LLM provider returned ${res.status}`);
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
