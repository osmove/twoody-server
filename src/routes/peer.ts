import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.js";
import { atCapacity, beginGeneration } from "../account/inflight.js";
import { buildStatus, localModels, noteModelUsed } from "../account/statusSource.js";
import type { Purpose } from "../account/status.js";
import { DATA_DIR } from "../db.js";
import { dataAtRest } from "../dataAtRest.js";
import { LocalOnlyError, outboundFetch } from "../outbound.js";
import { unpairSession } from "../pairing.js";
import { runtimeAuthHeaders } from "../runtimeAuth.js";
import { runtimeSlot } from "../runtimeSlots.js";
import { ensureBuiltin, isBuiltinUrl } from "../engine.js";
import { RuntimeError } from "../builtin/index.js";
import { recordUsageEvent } from "../usageStore.js";
import { clientOf } from "./usage.js";
import { withTimings } from "./queries.js";
import { peerVaultRoutes } from "./peerVault.js";

// What this computer answers to another computer of the same account
// (docs/multi-computer-design.md §3), through the sealed tunnel:
//
//   GET    /api/v1/peer/status                  the status object (account/status.ts)
//   POST   /api/v1/peer/v1/chat/completions     OpenAI-compatible, passed to the runtime
//   DELETE /api/v1/peer/session                 the caller forgets its session here
//   GET    /api/v1/peer/vault/identity          this computer's vault public keys (peerVault.ts, tunnel only)
//   POST   /api/v1/peer/vault/anchor            the person device approving it names itself (peerVault.ts)
//
// Errors: 404 no_model, 503 busy (1 chat + 1 background at a time), 422
// for a request past the limits (64 messages; max_tokens is cut to 4096).
// Nothing of the conversation is kept here: only a usage event (source
// « peer », client = the calling computer).

const MAX_MESSAGES = 64;
const MAX_TOKENS = 4096;
/// The fields passed to the runtime; anything else is dropped.
const PASSED = ["model", "messages", "tools", "tool_choice", "max_tokens", "temperature", "top_p", "stop", "stream", "stream_options", "response_format", "seed"] as const;
/// The runtime-specific switches (reasoning), dropped on a runtime that refuses them.
const EXTRAS = ["chat_template_kwargs", "reasoning_effort", "thinking_budget_tokens"] as const;

type Body = Record<string, unknown>;

function validMessages(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_MESSAGES &&
    value.every((m) => m && typeof m === "object" && typeof (m as { role?: unknown }).role === "string")
  );
}

export async function peerRoutes(app: FastifyInstance) {
  await peerVaultRoutes(app);

  app.get("/peer/status", {
    schema: { tags: ["providers"], summary: "This computer's status, for the account's other computers" },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      // Whether its data is on an encrypted volume, for the person's
      // other computers only: the heartbeat to the account (buildStatus
      // alone) does not carry it.
      return reply.send({ ...(await buildStatus(auth.userId)), data_at_rest: dataAtRest(DATA_DIR) });
    },
  });

  app.delete("/peer/session", {
    schema: { tags: ["providers"], summary: "The calling computer forgets its session on this one" },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!auth.sessionId) return reply.code(401).send({ error: "session_token_required" });
      unpairSession(auth.sessionId);
      return reply.code(204).send();
    },
  });

  app.post<{ Body: Body }>("/peer/v1/chat/completions", {
    schema: { tags: ["providers"], summary: "OpenAI-compatible chat completion on this computer's runtime, for another computer of the account" },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const body = (req.body ?? {}) as Body;
      const model = typeof body.model === "string" ? body.model : "";
      if (!model || !validMessages(body.messages)) {
        return reply.code(422).send({ error: "invalid_request", message: `model and 1 to ${MAX_MESSAGES} messages are required` });
      }
      if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 64)) {
        return reply.code(422).send({ error: "invalid_request", message: "tools must be a list of at most 64" });
      }
      const purpose: Purpose = body.x_purpose === "background" ? "background" : "chat";
      const status = await buildStatus(auth.userId);
      if (!status.accepts.includes(purpose) || atCapacity(purpose)) {
        return reply.code(503).send({ error: "busy", message: "this computer is answering already" });
      }
      const holder = (await localModels(auth.userId)).find((m) => m.id === model);
      if (!holder) return reply.code(404).send({ error: "no_model", message: `${model} is not on this computer` });
      // The built-in runtime is started for it (engine.ts); a model that
      // would not fit in memory now is refused like a busy computer.
      if (isBuiltinUrl(holder.baseUrl)) {
        try {
          await ensureBuiltin(model);
        } catch (err) {
          if (!(err instanceof RuntimeError)) throw err;
          const status = err.code === "insufficient_memory" ? 503 : err.status;
          return reply.code(status).send({ error: err.code === "insufficient_memory" ? "busy" : "runtime_unavailable", message: err.message });
        }
      }

      const payload: Body = {};
      for (const field of PASSED) if (body[field] !== undefined) payload[field] = body[field];
      const requested = typeof body.max_tokens === "number" && body.max_tokens > 0 ? Math.floor(body.max_tokens) : MAX_TOKENS;
      payload.max_tokens = Math.min(requested, MAX_TOKENS);
      const stream = payload.stream === true;
      if (stream) payload.stream_options = { include_usage: true };
      const extras: Body = {};
      for (const field of EXTRAS) if (body[field] !== undefined) extras[field] = body[field];
      // This computer's runtime, this computer's slots: the caller never
      // names one (runtimeSlots.ts).
      const slot = await runtimeSlot(holder.baseUrl, model, purpose);
      if (slot !== null) extras.id_slot = slot;

      const end = beginGeneration(purpose);
      const upstream = new AbortController();
      reply.raw.on("close", () => {
        if (!reply.raw.writableFinished) upstream.abort();
      });
      const endpoint = `${holder.baseUrl}/chat/completions`;
      const post = (json: Body) =>
        outboundFetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...runtimeAuthHeaders(holder.baseUrl) },
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
          return reply.code(503).send({ error: "runtime_unavailable", message: "the model runtime on this computer does not answer" });
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
            userId: auth.userId,
            source: "peer",
            model,
            client: clientOf(auth),
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
        if (err instanceof LocalOnlyError) return reply.code(403).send({ error: "local_only", message: err.message });
        return reply.code(502).send({ error: "runtime_error", message: "the model runtime on this computer failed" });
      } finally {
        end();
      }
    },
  });
}
