import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { requireAuth, generateId, PLACEHOLDER_USER_NAME } from "../auth.js";
import { db, providers, discussions, messages, memories, users } from "../db.js";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { transcribeWavWithWhisperCpp, withoutNonSpeech, WhisperUnavailableError } from "../whisper.js";
import { publish as publishEvent } from "../events.js";
import {
  buildChatMessages,
  HISTORY_MAX_MESSAGES,
  type ChatMessage,
  type HistoryRow,
  type MemoryRow,
} from "../chatContext.js";
import { chooseDiscussion, reuseWindowMs } from "../discussionWindow.js";
import { runtimeAuthHeaders } from "../runtimeAuth.js";
import { createThinkFilter } from "../thinkFilter.js";
import { hasIndexedDocuments, searchPassages } from "../documents/library.js";
import { LOCAL_ONLY, LocalOnlyError, outboundFetch } from "../outbound.js";
import { probeRuntime } from "../localRuntime.js";
import { discussionTitle, typedText } from "../documentBlocks.js";

interface QueryBody {
  content?: string;
  text?: string;
  channel?: string;
  format_shape?: string;
  model?: string;
  provider?: string;
  discussion_id?: string;
  /// "New conversation": never continue an earlier one, whatever the
  /// channel. Same name as the cloud backend's parameter.
  force_new_discussion?: boolean | string;
  /// How many tokens the model holds, when the client knows (the desktop
  /// asks the runtime): the history and documents given are sized to it.
  context_window?: number | string;
  /// How far the model reasons before answering: "fast" (not at all, the
  /// default), "think", "deep".
  effort?: string;
  /// The client's id for this reply: « Répondre maintenant » names it.
  request_id?: string;
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
    force_new_discussion?: boolean | string;
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

  // « Répondre maintenant »: the reasoning of a reply being written is
  // cut, and the model answers from what it reasoned so far.
  app.post<{ Body: { request_id?: string } }>("/queries/answer_now", {
    schema: {
      tags: ["queries"],
      summary: "Cut the reasoning of a reply being written: the model answers now",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      body: { type: "object", required: ["request_id"], properties: { request_id: { type: "string" } } },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const cut = answerNow.get(`${auth.userId}:${req.body?.request_id ?? ""}`);
      if (!cut) return reply.code(404).send({ error: "not_found" });
      cut();
      return reply.code(204).send();
    },
  });

  // « Compacter la conversation »: the model writes a summary of the
  // discussion, given to it from then on instead of those messages.
  app.post<{ Params: { id: string }; Body: { model?: string; context_window?: number } }>("/discussions/:id/compact", {
    schema: {
      tags: ["session"],
      summary: "Replace a discussion's messages, for the model, with a summary it writes",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    },
    handler: handleCompact,
  });
}

const COMPACT_REQUEST =
  "[Twoody] This conversation is about to be replaced by a summary, to free the model's memory. Write that summary now, " +
  "in the language the person uses: what they asked and wanted, the facts, figures and decisions that came up (from joined " +
  "documents too, naming them), what was concluded, and what remains open. Be precise and brief, and invent nothing.";

function discussionSummary(id: string): { summary: string | null; summaryThrough: string | null } {
  const [row] = db
    .select({ summary: discussions.summary, summaryThrough: discussions.summaryThrough })
    .from(discussions)
    .where(eq(discussions.id, id))
    .limit(1)
    .all();
  return { summary: row?.summary ?? null, summaryThrough: row?.summaryThrough ?? null };
}

/// What the next turn of a discussion would give the model, counted:
/// the gauge of a conversation opened again.
export function discussionContext(
  userId: string,
  discussionId: string,
): { summary: string | null; summaryThrough: string | null; tokensEstimate: number } {
  const compacted = discussionSummary(discussionId);
  const chatMessages = buildChatMessages({
    ...loadUserContext(userId),
    history: loadHistory(discussionId, compacted.summaryThrough),
    summary: compacted.summary,
    content: "",
    hasDocuments: hasIndexedDocuments(userId),
    local: true,
  });
  return { ...compacted, tokensEstimate: estimateTokens(messagesChars(chatMessages)) };
}

function readWindow(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? parseInt(value, 10) : NaN;
  return Number.isInteger(parsed) && parsed >= 1_024 && parsed <= 1_048_576 ? parsed : null;
}

async function handleCompact(req: FastifyRequest<{ Params: { id: string }; Body: { model?: string; context_window?: number } }>, reply: FastifyReply) {
  const auth = await requireAuth(req, reply);
  if (!auth) return;
  const [discussion] = db
    .select({ id: discussions.id })
    .from(discussions)
    .where(and(eq(discussions.id, req.params.id), eq(discussions.userId, auth.userId)))
    .limit(1)
    .all();
  if (!discussion) return reply.code(404).send({ error: "not_found" });

  const compacted = discussionSummary(discussion.id);
  const history = loadHistory(discussion.id, compacted.summaryThrough);
  if (history.filter((row) => row.content.trim()).length < 2) return reply.code(409).send({ error: "nothing_to_compact" });
  const [last] = db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.discussionId, discussion.id))
    .orderBy(desc(messages.createdAt), sql`rowid DESC`)
    .limit(1)
    .all();

  const upstream = new AbortController();
  reply.raw.on("close", () => {
    if (!reply.raw.writableFinished) upstream.abort();
  });
  try {
    const provider = await resolveProvider(auth.userId, req.body?.model ?? undefined);
    if (provider.kind === "local_openai" && !(await probeRuntime(provider.baseUrl)).reachable) {
      throw new LocalLlmUnavailableError("Local LLM provider is unavailable");
    }
    // The conversation as a turn gives it (the runtime reuses what it
    // already read), then the demand for the summary.
    const chatMessages = buildChatMessages({
      ...loadUserContext(auth.userId),
      history,
      summary: compacted.summary,
      contextWindow: readWindow(req.body?.context_window),
      content: COMPACT_REQUEST,
      hasDocuments: hasIndexedDocuments(auth.userId),
      local: provider.kind === "local_openai",
    });
    let written = "";
    const thinkFilter = createThinkFilter((delta) => {
      written += delta;
    });
    const reported = await streamFromProvider(provider, chatMessages, 0.2, thinkFilter.push, upstream.signal);
    thinkFilter.flush();
    const summary = written.trim();
    if (!summary) return reply.code(502).send({ error: "provider_error", message: "the model wrote no summary" });

    db.update(discussions).set({ summary, summaryThrough: last.id }).where(eq(discussions.id, discussion.id)).run();
    return reply.send({
      summary,
      summary_through: last.id,
      tokens_before: reported?.prompt_tokens ?? estimateTokens(messagesChars(chatMessages)),
      tokens_after: discussionContext(auth.userId, discussion.id).tokensEstimate,
    });
  } catch (err) {
    if (upstream.signal.aborted) return;
    const message = err instanceof Error ? err.message : "Unknown error";
    const [status, code] =
      err instanceof LocalLlmUnavailableError ? [503, "local_llm_unavailable"]
      : err instanceof LocalOnlyError ? [403, "local_only"]
      : [502, "provider_error"];
    return reply.code(status).send({ error: code, message });
  }
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
  let transcribed = false;
  if (!content && audioBuffer && !skipTranscription) {
    try {
      // Whisper writes [BLANK_AUDIO] and the like for what it did not
      // hear as speech: that is no message.
      content = withoutNonSpeech(await transcribeWavWithWhisperCpp(audioBuffer));
      transcribed = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = err instanceof WhisperUnavailableError ? 501 : 422;
      return reply.code(code).send({ error: "stt_failed", message: msg });
    }
  }

  if (!content) {
    return reply.code(422).send({ error: transcribed ? "no_speech" : "content_or_audio_required" });
  }

  const channel = parsed.channel ?? "cli";
  const model   = parsed.model ?? undefined;

  // Resolve / create the discussion before we open the SSE stream so
  // the `final` event can carry the discussion_id back to the client.
  // A message that names no conversation starts one, except on a voice
  // surface, where it continues the latest one for a short while (see
  // discussionWindow.ts; same rule as the cloud's DiscussionResolver).
  const discussion = resolveDiscussion(
    auth.userId,
    parsed.discussion_id ?? null,
    channel,
    readBool(parsed.force_new_discussion ?? parsed.query?.force_new_discussion, false),
  );

  // Read the thread before the new prompt lands in it, so the history
  // handed to the model never contains the current turn twice. What a
  // compaction summarised is given as its summary.
  const compacted = discussionSummary(discussion.id);
  const history = loadHistory(discussion.id, compacted.summaryThrough);

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
      title:        discussionTitle(content),
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
    // The headers Fastify's hooks already set — CORS for a browser
    // client among them — go out with the stream: writing to the raw
    // response skips them otherwise, and the browser drops the answer.
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) reply.raw.setHeader(name, value);
    }
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
    // A voice message: what was heard, first, so the person reads their
    // own words while the answer is being written — not at its end.
    if (transcribed) reply.raw.write(`event: transcription\ndata: ${JSON.stringify({ text: content })}\n\n`);
  };

  // The reader left (closed the window, pressed Stop): stop the model
  // too. A local runtime otherwise keeps generating, for minutes on a
  // long answer, a reply nobody will read — and the next question queues
  // behind it.
  const upstream = new AbortController();
  // The response's "close", not the request's: since Node 16 the latter
  // fires as soon as the request body has been read.
  reply.raw.on("close", () => {
    if (!reply.raw.writableFinished) upstream.abort();
  });

  let aggregated = "";
  let reasoningMs: number | null = null;
  let answerNowKey: string | null = null;
  let answeredBy: { kind: string; model: string | null } | null = null;
  try {
    const provider = await resolveProvider(auth.userId, model);
    answeredBy = { kind: provider.kind, model: "model" in provider ? provider.model : null };
    // A runtime that is not there is said now, as an HTTP error, before
    // the reply is opened below.
    if (provider.kind === "local_openai" && !(await probeRuntime(provider.baseUrl)).reachable) {
      throw new LocalLlmUnavailableError("Local LLM provider is unavailable");
    }
    const userContext = loadUserContext(auth.userId);
    // Passages from the user's own documents that match this prompt.
    // The model sees them numbered; the client gets the same list to
    // resolve the [1], [2]… the reply cites.
    // What was typed is the question; the documents joined to it are
    // already in front of the model.
    const passages = searchPassages(auth.userId, typedText(content));
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
      summary: compacted.summary,
      contextWindow: readWindow(parsed.context_window),
      hasDocuments: hasIndexedDocuments(auth.userId),
      excerpts: passages.map((passage) => ({ name: passage.name, page: passage.page, text: passage.text })),
      local: provider.kind === "local_openai",
    });
    // « Répondre maintenant », for this reply.
    const answerNowController = new AbortController();
    const answerNowSignal = answerNowController.signal;
    if (typeof parsed.request_id === "string" && /^[\w-]{8,64}$/.test(parsed.request_id)) {
      answerNowKey = `${auth.userId}:${parsed.request_id}`;
      answerNow.set(answerNowKey, () => answerNowController.abort());
    }
    // What the model reasons, sent as it comes and kept with the answer.
    let reasoning = "";
    let reasoningStarted = 0;
    const onReasoning = (delta: string) => {
      startSse();
      if (!reasoningStarted) reasoningStarted = Date.now();
      reasoning += delta;
      reply.raw.write(`event: reasoning\ndata: ${escapeData(delta)}\n\n`);
    };
    const thinkFilter = createThinkFilter((delta) => {
      startSse();
      if (reasoningStarted && reasoningMs === null) reasoningMs = Date.now() - reasoningStarted;
      aggregated += delta;
      // Cloud-compat shape: per-token `event: message` with the
      // raw delta as the data line. The watch/RN parser slices
      // on event-name boundaries.
      reply.raw.write(`event: message\ndata: ${escapeData(delta)}\n\n`);
    });
    // The reply opens before the model's first word, which can be many
    // seconds away: a model to load, a long prompt to read. A phone
    // takes a reply that has not opened within 3 s for a computer out of
    // reach on this network, and asks again through the relay
    // (twoody-app/utils/chatStream.js) — the question then reached the
    // computer twice. Opened, the keepalive also runs while it waits.
    startSse();
    const reported = await streamFromProvider(
      provider,
      chatMessages,
      readTemperature(userContext.prefs),
      thinkFilter.push,
      upstream.signal,
      { effort: readEffort(parsed.effort), onReasoning, answerNow: answerNowSignal },
    );
    thinkFilter.flush();
    if (reasoningStarted && reasoningMs === null) reasoningMs = Date.now() - reasoningStarted;
    // The context gauge under the composer: what the runtime counted, or
    // a count from the characters when it did not say.
    const usage = reported
      ? { ...reported, estimated: false }
      : { prompt_tokens: estimateTokens(messagesChars(chatMessages)), completion_tokens: estimateTokens(aggregated.length), estimated: true };
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
      reasoning:    reasoning.trim() || null,
      reasoningMs,
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
      usage,
      reasoning_ms: reasoningMs,
    };
    reply.raw.write(`event: final\ndata: ${JSON.stringify(finalPayload)}\n\n`);
  } catch (err) {
    if (upstream.signal.aborted) {
      // Keep what was written: the conversation would otherwise show a
      // question with no answer, and the next turn's history would lack it.
      if (aggregated.trim()) {
        insertMessage({
          discussionId: discussion.id,
          userId:       auth.userId,
          role:         "assistant",
          content:      `${aggregated.trimEnd()}…`,
          provider:     answeredBy?.kind ?? null,
          model:        answeredBy?.model ?? null,
        });
        touchDiscussion(discussion.id);
      }
      return;
    }
    const msg = err instanceof Error ? err.message : "Unknown error";
    const [status, code] =
      err instanceof LocalLlmUnavailableError ? [503, "local_llm_unavailable"]
      : err instanceof LocalOnlyError ? [403, "local_only"]
      : [502, "provider_error"];
    if (!sseStarted) {
      return reply.code(status).send({ error: code, message: msg });
    }
    // Once the reply is open, the same error, as its last event.
    reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: code, message: msg })}\n\n`);
  } finally {
    if (answerNowKey) answerNow.delete(answerNowKey);
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
    force_new_discussion: (nested.force_new_discussion as boolean | string) ?? (fields.force_new_discussion as boolean | string),
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

/// Where a turn goes. With a local provider as the default, a model named
/// by the client goes to the runtime that holds it: the provider naming
/// it, or a runtime whose own list has it — a phone paired with this
/// computer offers every model the runtimes hold (routes/providers.ts).
/// A name no runtime here offers — one from the account's catalogue, a
/// model since removed — gets the default model: sent on, a runtime could
/// go and fetch it from the internet. "local" is what a client sends when
/// it knows no model by name.
async function resolveProvider(userId: string, requestedModel?: string): Promise<Provider> {
  const configuredProviders = db
    .select()
    .from(providers)
    .where(eq(providers.userId, userId))
    .all()
    .filter((provider) => provider.enabled);

  const defaultProvider =
    configuredProviders.find((provider) => provider.isDefault) ?? configuredProviders[0];

  if (defaultProvider?.kind === "local_openai" && defaultProvider.baseUrl) {
    const byDefault: Provider = {
      kind: "local_openai",
      baseUrl: defaultProvider.baseUrl,
      model: defaultProvider.model ?? "local",
    };
    const wanted = requestedModel && requestedModel !== "local" ? requestedModel : null;
    if (!wanted || wanted === defaultProvider.model) return byDefault;

    const local = [
      defaultProvider,
      ...configuredProviders.filter((provider) => provider !== defaultProvider && provider.kind === "local_openai"),
    ].filter((provider): provider is typeof provider & { baseUrl: string } => Boolean(provider.baseUrl));
    const naming = local.find((provider) => provider.model === wanted);
    if (naming) return { kind: "local_openai", baseUrl: naming.baseUrl, model: wanted };
    for (const provider of local) {
      const probe = await probeRuntime(provider.baseUrl).catch(() => null);
      if (probe?.models?.includes(wanted)) return { kind: "local_openai", baseUrl: provider.baseUrl, model: wanted };
    }
    return byDefault;
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

type Usage = { prompt_tokens: number; completion_tokens: number };

/// Streams the answer; resolves with the tokens it took when the
/// provider says (the local runtimes, asked with stream_options).
async function streamFromProvider(
  provider: Provider,
  chatMessages: ChatMessage[],
  temperature: number | undefined,
  onDelta: (text: string) => void,
  signal: AbortSignal,
  options: { effort?: Effort; onReasoning?: (text: string) => void; answerNow?: AbortSignal } = {},
): Promise<Usage | null> {
  switch (provider.kind) {
    case "openai":
      await streamOpenAI(chatMessages, provider.model, temperature, onDelta, signal);
      return null;
    case "anthropic":
      await streamAnthropic(chatMessages, provider.model, temperature, onDelta, signal);
      return null;
    case "gemini":
      await streamGemini(chatMessages, provider.model, temperature, onDelta, signal);
      return null;
    case "local_openai":
      return streamLocal(provider.baseUrl, chatMessages, provider.model, temperature, onDelta, signal, options);
  }
}

/// A token count from characters: about 3.5 a token for prose under the
/// Qwen, Llama and GLM tokenizers.
function estimateTokens(chars: number): number {
  return Math.ceil(chars / 3.5);
}

function messagesChars(chatMessages: ChatMessage[]): number {
  return chatMessages.reduce((total, message) => total + message.content.length, 0);
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
  onDelta: (t: string) => void,
  signal: AbortSignal,
) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set");

  const res = await outboundFetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    signal,
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
  onDelta: (t: string) => void,
  signal: AbortSignal,
) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");

  const res = await outboundFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal,
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
  onDelta: (t: string) => void,
  signal: AbortSignal,
) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${key}`;
  const res = await outboundFetch(url, {
    method: "POST",
    signal,
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

/// How far a model reasons before it answers, as the person chose: not
/// at all, or until it is done — with a limit in tokens and one in time,
/// whichever comes first, past which it is asked to answer from what it
/// reasoned so far; and the person can say « Répondre maintenant » at
/// any moment. The limits are wide on purpose: cut at 30 s on a MacBook
/// Air (Qwen3 14B writes some 10 tokens a second there), a reasoning
/// stopped mid-calculation gave a wrong answer that no reasoning at all
/// got right.
export type Effort = "fast" | "think" | "deep";
const THINKING_BUDGET: Record<Effort, number> = { fast: 0, think: 1_500, deep: 6_000 };
const THINKING_TIME_MS: Record<Effort, number> = { fast: 0, think: 90_000, deep: 300_000 };

/// The replies being written, by the id the client gave them: where
/// « Répondre maintenant » finds the reasoning to cut.
const answerNow = new Map<string, () => void>();

function readEffort(value: unknown): Effort {
  return value === "think" || value === "deep" ? value : "fast";
}

async function streamLocal(
  baseUrl: string,
  chatMessages: ChatMessage[],
  model: string,
  temperature: number | undefined,
  onDelta: (t: string) => void,
  signal: AbortSignal,
  options: { effort?: Effort; onReasoning?: (text: string) => void; answerNow?: AbortSignal } = {},
): Promise<Usage | null> {
  const endpoint = baseUrl.replace(/\/$/, "");
  const budget = THINKING_BUDGET[options.effort ?? "fast"];
  const timeLimit = THINKING_TIME_MS[options.effort ?? "fast"];
  const thinking = budget > 0;
  const body = {
    model,
    messages: chatMessages,
    stream: true,
    max_tokens: LOCAL_MAX_TOKENS + budget,
    ...(temperature !== undefined ? { temperature } : {}),
  };
  // Qwen3-style models otherwise reason silently for 20-40 s before the
  // first token: reasoning is on only when the person asked for it.
  // mlx-lm, vLLM and llama.cpp honour this switch and Ollama ignores it.
  // The tokens used come last in the stream when asked (the context
  // gauge); llama.cpp ends the reasoning itself at the budget. A strict
  // OpenAI-compatible server may reject these fields: plain retry below.
  const extras = {
    chat_template_kwargs: { enable_thinking: thinking },
    stream_options: { include_usage: true },
    ...(thinking ? { thinking_budget_tokens: budget } : {}),
  };

  // Ours, so that the reasoning can be cut without the reader leaving;
  // the answer asked for after a cut has its own.
  let upstream = new AbortController();
  const stop = () => upstream.abort();
  signal.addEventListener("abort", stop, { once: true });

  const post = async (payload: object): Promise<Response> => {
    try {
      return await outboundFetch(endpoint + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...runtimeAuthHeaders(endpoint) },
        body: JSON.stringify(payload),
        signal: upstream.signal,
      });
    } catch (err) {
      // A provider URL outside the private network is a configuration
      // problem the user must see, not a runtime that happens to be down.
      if (err instanceof LocalOnlyError) throw err;
      if (signal.aborted) throw err;
      throw new LocalLlmUnavailableError("Local LLM provider is unavailable");
    }
  };

  try {
    let res = await post({ ...body, ...extras });
    if (res.status === 400 || res.status === 422) {
      res = await post(body);
    }
    if (!res.ok) {
      throw new LocalLlmUnavailableError(`Local LLM provider returned ${res.status}`);
    }

    // The reasoning comes in its own field (mlx-lm, llama.cpp, LM Studio)
    // or between <think> tags; either way the person sees it as it comes.
    let reasoning = "";
    let reasoningStarted = 0;
    let answered = false;
    let cut = false;
    const limit = thinking ? Math.ceil(budget * 1.15 * 3.5) : Infinity;
    const reason = (text: string) => {
      if (!text) return;
      if (!reasoningStarted) reasoningStarted = Date.now();
      reasoning += text;
      options.onReasoning?.(text);
      if (!answered && !cut && (reasoning.length > limit || Date.now() - reasoningStarted > timeLimit)) {
        cut = true;
        upstream.abort();
      }
    };
    const filter = createThinkFilter((text) => {
      answered = true;
      onDelta(text);
    }, reason);
    // « Répondre maintenant »: the same cut, when the person says so.
    options.answerNow?.addEventListener(
      "abort",
      () => {
        if (!answered && !cut && reasoning) {
          cut = true;
          upstream.abort();
        }
      },
      { once: true },
    );
    try {
      const usage = await consumeOpenAIStream(res, filter.push, reason);
      filter.flush();
      if (!cut) return usage;
    } catch (err) {
      if (!cut || signal.aborted) throw err;
    }

    // Past its budget: the model answers from what it reasoned so far.
    upstream = new AbortController();
    if (signal.aborted) throw new Error("aborted");
    const last = chatMessages[chatMessages.length - 1];
    const answer = await post({
      ...body,
      max_tokens: LOCAL_MAX_TOKENS,
      messages: [
        ...chatMessages.slice(0, -1),
        { ...last, content: `${last.content}\n\n[Your reasoning so far, cut to answer in time:]\n${reasoning.trim()}\n[Now answer directly.]` },
      ],
      chat_template_kwargs: { enable_thinking: false },
      stream_options: { include_usage: true },
    });
    if (!answer.ok) throw new LocalLlmUnavailableError(`Local LLM provider returned ${answer.status}`);
    // A model that always reasons may start again: that part is dropped.
    const answerFilter = createThinkFilter(onDelta);
    const usage = await consumeOpenAIStream(answer, answerFilter.push, () => undefined);
    answerFilter.flush();
    return usage;
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

function systemText(chatMessages: ChatMessage[]): string {
  return chatMessages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
}

async function consumeOpenAIStream(
  res: Response,
  onDelta: (t: string) => void,
  onReasoning?: (t: string) => void,
): Promise<Usage | null> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let usage: Usage | null = null;

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
          choices?: Array<{ delta?: { content?: string; reasoning?: string; reasoning_content?: string } }>;
          usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
        };
        const delta = evt.choices?.[0]?.delta;
        const thought = delta?.reasoning ?? delta?.reasoning_content ?? "";
        if (thought) onReasoning?.(thought);
        const text = delta?.content ?? "";
        if (text) onDelta(text);
        if (typeof evt.usage?.prompt_tokens === "number") {
          usage = {
            prompt_tokens: evt.usage.prompt_tokens,
            completion_tokens: typeof evt.usage.completion_tokens === "number" ? evt.usage.completion_tokens : 0,
          };
        }
      } catch {
        // ignore
      }
    }
  }
  return usage;
}

// ─── Discussion helpers ─────────────────────────────────────────────────────
//
// Self-hosted mode keeps history in the same SQLite the rest of the
// server uses. Reuses the most recently-touched discussion within a
// 30-min window — past that, a fresh one starts so a casual "thanks"
// hours later doesn't reattach to last week's thread. Mirrors the
// cloud's DiscussionResolver but trimmed to the only knob we need.

function resolveDiscussion(
  userId: string,
  requestedId: string | null,
  channel: string,
  forceNew: boolean,
): { id: string; title: string | null } {
  const own = db.select().from(discussions).where(eq(discussions.userId, userId));
  const explicit = requestedId && !forceNew
    ? own.all().find((row) => row.id === requestedId) ?? null
    : null;
  // Only a voice surface ever continues a conversation it did not name.
  const mostRecent = !forceNew && reuseWindowMs(channel) !== null
    ? own.all().sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime())[0] ?? null
    : null;

  const chosen = chooseDiscussion({ channel, forceNew, explicit, mostRecent });
  if (chosen) return { id: chosen.id, title: chosen.title };

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

function loadHistory(discussionId: string, after: string | null = null): HistoryRow[] {
  // `created_at` has one-second resolution, so a fast reply can share
  // its timestamp with the prompt. `rowid` keeps insertion order. A
  // compaction's summary stands for the messages up to `after`.
  const rows = db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(
      after
        ? and(eq(messages.discussionId, discussionId), sql`rowid > (SELECT rowid FROM messages WHERE id = ${after})`)
        : eq(messages.discussionId, discussionId),
    )
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
  reasoning?: string | null;
  reasoningMs?: number | null;
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
      reasoning:    args.reasoning ?? null,
      reasoningMs:  args.reasoningMs ?? null,
      createdAt:    new Date(),
    })
    .run();
}

function setDiscussionTitle(id: string, prompt: string) {
  // Cap at ~60 chars so the index list reads cleanly. Don't try to
  // generate a "real" title via a separate LLM call — self-hosted
  // mode optimises for token cost over polish.
  const trimmed = discussionTitle(prompt);
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
