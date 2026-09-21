import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { requireAuth, generateId, PLACEHOLDER_USER_NAME } from "../auth.js";
import { db, providers, discussions, messages, memories, users } from "../db.js";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { transcribeWavWithWhisperCpp, WhisperUnavailableError } from "../whisper.js";
import { publish as publishEvent } from "../events.js";
import {
  buildChatMessages,
  HISTORY_MAX_MESSAGES,
  type ChatMessage,
  type HistoryRow,
  type MemoryRow,
} from "../chatContext.js";
import { createThinkFilter } from "../thinkFilter.js";
import { hasIndexedDocuments, searchPassages } from "../documents/library.js";
import { LOCAL_ONLY, LocalOnlyError, outboundFetch } from "../outbound.js";

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

  // Resolve / create the discussion before we open the SSE stream so
  // the `final` event can carry the discussion_id back to the client.
  // Reuses the most recently-active discussion within a 30-min window
  // (mirrors the cloud's DiscussionResolver inactivity gate); past
  // that, a fresh thread starts so an "ok thanks" hours later doesn't
  // attach to yesterday's conversation.
  const discussion = resolveDiscussion(
    auth.userId,
    parsed.discussion_id ?? null,
    channel,
  );

  // Read the thread before the new prompt lands in it, so the history
  // handed to the model never contains the current turn twice.
  const history = loadHistory(discussion.id);

  // Persist the user prompt up front so a streaming failure doesn't
  // erase the question. Assistant message is inserted after the
  // stream completes (or with a partial body on error).
  insertMessage({
    discussionId: discussion.id,
    userId:       auth.userId,
    role:         "user",
    content,
    provider:     null,
    model:        null,
  });
  const wasNewDiscussion = !discussion.title;
  if (wasNewDiscussion) {
    setDiscussionTitle(discussion.id, content);
  }
  touchDiscussion(discussion.id);

  if (wasNewDiscussion) {
    publishEvent({
      kind:         "discussion.created",
      userId:       auth.userId,
      discussionId: discussion.id,
      title:        content.trim().replace(/\s+/g, " ").slice(0, 60),
    });
  }
  publishEvent({
    kind:         "message.appended",
    userId:       auth.userId,
    discussionId: discussion.id,
    role:         "user",
  });

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
    const userContext = loadUserContext(auth.userId);
    // Passages from the user's own documents that match this prompt.
    // The model sees them numbered; the client gets the same list to
    // resolve the [1], [2]… the reply cites.
    const passages = searchPassages(auth.userId, content);
    const sources = passages.map((passage, index) => ({
      n: index + 1,
      document_id: passage.document_id,
      name: passage.name,
      path: passage.path,
      page: passage.page,
      snippet: passage.snippet,
    }));
    const chatMessages = buildChatMessages({
      ...userContext,
      history,
      content,
      hasDocuments: hasIndexedDocuments(auth.userId),
      excerpts: passages.map((passage) => ({ name: passage.name, page: passage.page, text: passage.text })),
      local: provider.kind === "local_openai",
    });
    const thinkFilter = createThinkFilter((delta) => {
      startSse();
      aggregated += delta;
      // Cloud-compat shape: per-token `event: message` with the
      // raw delta as the data line. The watch/RN parser slices
      // on event-name boundaries.
      reply.raw.write(`event: message\ndata: ${escapeData(delta)}\n\n`);
    });
    await streamFromProvider(
      provider,
      chatMessages,
      readTemperature(userContext.prefs),
      thinkFilter.push,
    );
    thinkFilter.flush();
    startSse();

    // Persist the assistant reply now that we have the full body.
    // Same `provider`/`model` we just dispatched against — gives the
    // history view a "answered by" chip per turn.
    const providerModel = "model" in provider ? provider.model : null;
    insertMessage({
      discussionId: discussion.id,
      userId:       auth.userId,
      role:         "assistant",
      content:      aggregated,
      provider:     provider.kind,
      model:        providerModel,
      sources,
    });
    touchDiscussion(discussion.id);
    publishEvent({
      kind:           "message.appended",
      userId:         auth.userId,
      discussionId:   discussion.id,
      role:           "assistant",
    });
    publishEvent({
      kind:           "discussion.touched",
      userId:         auth.userId,
      discussionId:   discussion.id,
      lastActivityAt: new Date().toISOString(),
    });

    const finalPayload = {
      id:            null,
      ref:           null,
      discussion_id: discussion.id,
      provider:      provider.kind,
      model:         providerModel,
      text:          aggregated,
      message:       aggregated,
      status:        "responded",
      transcription: parsed.text ? null : (audioBuffer ? content : null),
      language:      null,
      sources,
    };
    reply.raw.write(`event: final\ndata: ${JSON.stringify(finalPayload)}\n\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    if (!sseStarted) {
      if (err instanceof LocalLlmUnavailableError) {
        return reply.code(503).send({ error: "local_llm_unavailable", message: msg });
      }
      if (err instanceof LocalOnlyError) {
        return reply.code(403).send({ error: "local_only", message: msg });
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

  if (process.env.TWOODY_CLOUD_FALLBACK_ENABLED === "true" && !LOCAL_ONLY) {
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
  chatMessages: ChatMessage[],
  temperature: number | undefined,
  onDelta: (text: string) => void
) {
  switch (provider.kind) {
    case "openai":
      return streamOpenAI(chatMessages, provider.model, temperature, onDelta);
    case "anthropic":
      return streamAnthropic(chatMessages, provider.model, temperature, onDelta);
    case "gemini":
      return streamGemini(chatMessages, provider.model, temperature, onDelta);
    case "local_openai":
      return streamLocal(provider.baseUrl, chatMessages, provider.model, temperature, onDelta);
  }
}

/// `default_temperature` comes from the client-owned prefs blob, so it
/// is only trusted when it is a number in the usual 0–2 range.
function readTemperature(prefs: Record<string, unknown>): number | undefined {
  const value = prefs.default_temperature;
  return typeof value === "number" && value >= 0 && value <= 2 ? value : undefined;
}

async function streamOpenAI(
  chatMessages: ChatMessage[],
  model: string,
  temperature: number | undefined,
  onDelta: (t: string) => void
) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set");

  const res = await outboundFetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: chatMessages,
      stream: true,
      // gpt-5+ and the o-series reject a custom temperature.
      ...(temperature !== undefined && !/^(gpt-5|o\d)/.test(model) ? { temperature } : {}),
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI ${res.status}: ${err}`);
  }

  await consumeOpenAIStream(res, onDelta);
}

async function streamAnthropic(
  chatMessages: ChatMessage[],
  model: string,
  temperature: number | undefined,
  onDelta: (t: string) => void
) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");

  const res = await outboundFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      // Anthropic takes the system prompt as a top-level field and
      // caps temperature at 1.
      system: systemText(chatMessages),
      messages: chatMessages.filter((message) => message.role !== "system"),
      stream: true,
      ...(temperature !== undefined ? { temperature: Math.min(temperature, 1) } : {}),
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
  chatMessages: ChatMessage[],
  model: string,
  temperature: number | undefined,
  onDelta: (t: string) => void
) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${key}`;
  const res = await outboundFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemText(chatMessages) }] },
      // Gemini names the assistant role "model".
      contents: chatMessages
        .filter((message) => message.role !== "system")
        .map((message) => ({
          role: message.role === "assistant" ? "model" : "user",
          parts: [{ text: message.content }],
        })),
      ...(temperature !== undefined ? { generationConfig: { temperature } } : {}),
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

// mlx-lm stops at 512 tokens unless told otherwise, which cuts a
// drafted letter or summary short. Override with TWOODY_LOCAL_MAX_TOKENS.
const LOCAL_MAX_TOKENS = (() => {
  const parsed = parseInt(process.env.TWOODY_LOCAL_MAX_TOKENS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2048;
})();

async function streamLocal(
  baseUrl: string,
  chatMessages: ChatMessage[],
  model: string,
  temperature: number | undefined,
  onDelta: (t: string) => void
) {
  const endpoint = baseUrl.replace(/\/$/, "");
  const body = {
    model,
    messages: chatMessages,
    stream: true,
    max_tokens: LOCAL_MAX_TOKENS,
    ...(temperature !== undefined ? { temperature } : {}),
  };
  // Qwen3-style models otherwise reason silently for 20-40 s before
  // the first token. mlx-lm, vLLM and llama.cpp honour this switch and
  // Ollama ignores it; a strict OpenAI-compatible server may reject the
  // unknown field, hence the plain retry below.
  const withoutThinking = { ...body, chat_template_kwargs: { enable_thinking: false } };

  const post = async (payload: object): Promise<Response> => {
    try {
      return await outboundFetch(endpoint + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      // A provider URL outside the private network is a configuration
      // problem the user must see, not a runtime that happens to be down.
      if (err instanceof LocalOnlyError) throw err;
      throw new LocalLlmUnavailableError("Local LLM provider is unavailable");
    }
  };

  let res = await post(withoutThinking);
  if (res.status === 400 || res.status === 422) {
    res = await post(body);
  }

  if (!res.ok) {
    throw new LocalLlmUnavailableError(`Local LLM provider returned ${res.status}`);
  }

  await consumeOpenAIStream(res, onDelta);
}

function systemText(chatMessages: ChatMessage[]): string {
  return chatMessages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
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

// ─── Discussion helpers ─────────────────────────────────────────────────────
//
// Self-hosted mode keeps history in the same SQLite the rest of the
// server uses. Reuses the most recently-touched discussion within a
// 30-min window — past that, a fresh one starts so a casual "thanks"
// hours later doesn't reattach to last week's thread. Mirrors the
// cloud's DiscussionResolver but trimmed to the only knob we need.

const DISCUSSION_INACTIVITY_MS = 30 * 60 * 1000;

function resolveDiscussion(
  userId: string,
  requestedId: string | null,
  channel: string,
): { id: string; title: string | null } {
  if (requestedId) {
    const [row] = db
      .select()
      .from(discussions)
      .where(and(eq(discussions.id, requestedId), eq(discussions.userId, userId)))
      .limit(1)
      .all();
    if (row) return { id: row.id, title: row.title };
    // Requested id wasn't ours (or doesn't exist) — fall through to
    // the inactivity-window resolution rather than 404'ing the chat.
  }

  const cutoff = new Date(Date.now() - DISCUSSION_INACTIVITY_MS);
  const recent = db
    .select()
    .from(discussions)
    .where(eq(discussions.userId, userId))
    .all()
    .filter((d) => d.lastActivityAt > cutoff)
    .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime())[0];
  if (recent) return { id: recent.id, title: recent.title };

  const id = generateId();
  const now = new Date();
  db.insert(discussions)
    .values({
      id,
      userId,
      channel,
      title: null,
      createdAt: now,
      lastActivityAt: now,
    })
    .run();
  return { id, title: null };
}

function loadHistory(discussionId: string): HistoryRow[] {
  // `created_at` has one-second resolution, so a fast reply can share
  // its timestamp with the prompt. `rowid` keeps insertion order.
  const rows = db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.discussionId, discussionId))
    .orderBy(desc(messages.createdAt), sql`rowid DESC`)
    // Twice the cap: the trimmer skips empty rows and folds unanswered
    // prompts together, so it needs some slack to fill its window.
    .limit(HISTORY_MAX_MESSAGES * 2)
    .all();
  return rows.reverse();
}

function loadUserContext(userId: string): {
  userName: string | null;
  prefs: Record<string, unknown>;
  memories: MemoryRow[];
} {
  const [user] = db.select().from(users).where(eq(users.id, userId)).limit(1).all();

  let prefs: Record<string, unknown> = {};
  try {
    prefs = JSON.parse(user?.prefsJson || "{}");
  } catch {
    prefs = {};
  }

  const rows = db
    .select({ kind: memories.kind, title: memories.title, content: memories.content })
    .from(memories)
    .where(and(eq(memories.userId, userId), isNull(memories.supersededById)))
    .orderBy(desc(memories.updatedAt), asc(memories.id))
    .limit(200)
    .all();

  const userName = user?.name && user.name !== PLACEHOLDER_USER_NAME ? user.name : null;
  return { userName, prefs, memories: rows };
}

function insertMessage(args: {
  discussionId: string;
  userId: string;
  role: "user" | "assistant";
  content: string;
  provider: string | null;
  model: string | null;
  sources?: unknown[];
}) {
  db.insert(messages)
    .values({
      id:           generateId(),
      discussionId: args.discussionId,
      userId:       args.userId,
      role:         args.role,
      content:      args.content,
      provider:     args.provider,
      model:        args.model,
      sourcesJson:  args.sources && args.sources.length > 0 ? JSON.stringify(args.sources) : null,
      createdAt:    new Date(),
    })
    .run();
}

function setDiscussionTitle(id: string, prompt: string) {
  // Cap at ~60 chars so the index list reads cleanly. Don't try to
  // generate a "real" title via a separate LLM call — self-hosted
  // mode optimises for token cost over polish.
  const trimmed = prompt.trim().replace(/\s+/g, " ").slice(0, 60);
  if (!trimmed) return;
  db.update(discussions)
    .set({ title: trimmed })
    .where(eq(discussions.id, id))
    .run();
}

function touchDiscussion(id: string) {
  db.update(discussions)
    .set({ lastActivityAt: new Date() })
    .where(eq(discussions.id, id))
    .run();
}
