import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { requireAuth } from "../auth.js";
import { db, providers } from "../db.js";
import { eq } from "drizzle-orm";
import { transcribeWavWithWhisperCpp, WhisperUnavailableError } from "../whisper.js";

interface QueryBody {
  content?: string;
  text?: string;
  channel?: string;
  format_shape?: string;
  model?: string;
  provider?: string;
  discussion_id?: string;
  // The watch + iPhone voice path nests fields under `query`. We
  // accept both flat and nested shapes so a single client codebase
  // can target either backend without case-by-case wire reshaping.
  query?: {
    text?: string;
    content?: string;
    channel?: string;
    format_shape?: string;
    model?: string;
    provider?: string;
    discussion_id?: string;
    audio?: boolean | string;
    skip_transcription?: boolean | string;
  };
  audio?: boolean | string;
  skip_transcription?: boolean | string;
}

// SSE chat over /queries. Accepts both JSON (text-only) and multipart
// (audio_file inline). Mirrors the cloud's wire shape so the same
// RN/watch parser handles both backends:
//   - `event: message` per token delta
//   - `event: final`   with the full QueryResponse on completion
// Plus an 8 KB padding comment in the preamble to defeat iOS's
// XHR ~4 KB buffering quirk (same workaround the Rails backend
// uses, see queries_controller.rb).
export async function queryRoutes(app: FastifyInstance) {
  app.post("/queries", {
    schema: {
      tags: ["queries"],
      summary: "Stream a chat completion over SSE (text or multipart audio)",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      // Body schema intentionally omitted — Fastify can't describe
      // both JSON-application and multipart-form-data on the same
      // route. The handler does the shape gating.
      produces: ["text/event-stream"],
    },
    handler: handleQueriesRequest,
  });
}

async function handleQueriesRequest(req: FastifyRequest, reply: FastifyReply) {
  const auth = await requireAuth(req, reply);
  if (!auth) return;

  const isMultipart = req.isMultipart?.() === true;
  const parsed: ParsedBody = isMultipart
    ? (await parseMultipartBody(req)) ?? {}
    : ((req.body as QueryBody) ?? {});

  const audioBuffer = parsed.audioBuffer ?? null;
  const skipTranscription = readBool(parsed.skip_transcription, false);

  // Resolve the user's prompt: explicit text wins; otherwise we
  // shell out to whisper-cpp on the audio blob (when STT wasn't
  // skipped). Empty result → 422 so the client gets a clean error
  // instead of an empty SSE stream.
  let content = (parsed.text ?? parsed.content ?? "").trim();
  if (!content && audioBuffer && !skipTranscription) {
    try {
      content = (await transcribeWavWithWhisperCpp(audioBuffer)).trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = err instanceof WhisperUnavailableError ? 501 : 422;
      return reply.code(code).send({ error: "stt_failed", message: msg });
    }
  }

  if (!content) {
    return reply.code(422).send({ error: "content_or_audio_required" });
  }

  const channel = parsed.channel ?? "cli";
  const model   = parsed.model ?? undefined;
  void channel;

  let sseStarted = false;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  const startSse = () => {
    if (sseStarted) return;
    sseStarted = true;
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    // 8 KB comment padding — same trick Rails uses to flush past
    // iOS NSURLSession's 4 KB XHR buffer threshold so each delta
    // surfaces as it arrives instead of all at the end.
    reply.raw.write(":" + " ".repeat(8192) + "\n\n");
    keepalive = setInterval(() => {
      reply.raw.write(": ping\n\n");
    }, 15_000);
  };

  let aggregated = "";
  try {
    const provider = resolveProvider(auth.userId, model);
    await streamFromProvider(provider, content, (delta) => {
      startSse();
      aggregated += delta;
      // Cloud-compat shape: per-token `event: message` with the
      // raw delta as the data line. The watch/RN parser slices
      // on event-name boundaries.
      reply.raw.write(`event: message\ndata: ${escapeData(delta)}\n\n`);
    });
    startSse();
    const finalPayload = {
      id:            null,
      ref:           null,
      discussion_id: null,
      provider:      provider.kind,
      model:         "model" in provider ? provider.model : null,
      text:          aggregated,
      message:       aggregated,
      status:        "responded",
      transcription: parsed.text ? null : (audioBuffer ? content : null),
      language:      null,
    };
    reply.raw.write(`event: final\ndata: ${JSON.stringify(finalPayload)}\n\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    if (!sseStarted) {
      if (err instanceof LocalLlmUnavailableError) {
        return reply.code(503).send({ error: "local_llm_unavailable", message: msg });
      }
      return reply.code(502).send({ error: "provider_error", message: msg });
    }
    reply.raw.write(`event: error\ndata: ${JSON.stringify({ message: msg })}\n\n`);
  } finally {
    if (keepalive) clearInterval(keepalive);
    if (sseStarted) reply.raw.end();
  }
}

/// SSE `data:` lines can't contain raw newlines (they split events).
/// Replace LF with the multi-line continuation form: a leading `data: `
/// for each subsequent line so the client receives the full text on
/// one event. Cheap to do per-delta since deltas are typically <40 chars.
function escapeData(text: string): string {
  return text.replace(/\n/g, "\ndata: ");
}

function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true")  return true;
    if (value === "false") return false;
  }
  return fallback;
}

type ParsedBody = QueryBody & { audioBuffer?: Buffer };

async function parseMultipartBody(req: FastifyRequest): Promise<ParsedBody | null> {
  const fields: Record<string, unknown> = {};
  let audioBuffer: Buffer | null = null;

  for await (const part of req.parts()) {
    if (part.type === "file") {
      const chunks: Buffer[] = [];
      for await (const chunk of part.file) {
        chunks.push(chunk as Buffer);
      }
      audioBuffer = Buffer.concat(chunks);
    } else {
      // Multipart text fields. The watch sends `query[text]`,
      // `query[provider]`, etc — Rails-style nested keys that the
      // standard multipart parser hands us as flat strings. Convert
      // them into a nested `query` object so the same code path
      // handles JSON callers with literal `query: {...}`.
      const value = part.value;
      assignNested(fields, part.fieldname, value as string);
    }
  }

  // Promote `query.text`, `query.audio`, etc to top level so the
  // handler's flat reads work uniformly.
  const nested = (fields.query ?? {}) as Record<string, unknown>;
  return {
    text:               (nested.text as string) ?? (fields.text as string),
    content:            (nested.content as string) ?? (fields.content as string),
    channel:            (nested.channel as string) ?? (fields.channel as string),
    format_shape:       (nested.format_shape as string) ?? (fields.format_shape as string),
    model:              (nested.model as string) ?? (fields.model as string),
    provider:           (nested.provider as string) ?? (fields.provider as string),
    discussion_id:      (nested.discussion_id as string) ?? (fields.discussion_id as string),
    audio:              (nested.audio as boolean | string) ?? (fields.audio as boolean | string),
    skip_transcription: (nested.skip_transcription as boolean | string) ?? (fields.skip_transcription as boolean | string),
    audioBuffer:        audioBuffer ?? undefined,
  };
}

function assignNested(target: Record<string, unknown>, fieldname: string, value: string) {
  // `query[text]` → target.query.text. Bracket-style only; we don't
  // need full Rack params here.
  const match = fieldname.match(/^([^[]+)\[([^\]]+)\]$/);
  if (match) {
    const [, root, key] = match;
    if (!target[root] || typeof target[root] !== "object") target[root] = {};
    (target[root] as Record<string, unknown>)[key] = value;
    return;
  }
  target[fieldname] = value;
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
