import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.js";
import { atCapacity } from "../account/inflight.js";
import { buildStatus, localModels } from "../account/statusSource.js";
import type { Purpose } from "../account/status.js";
import { DATA_DIR } from "../db.js";
import { dataAtRest } from "../dataAtRest.js";
import { unpairSession } from "../pairing.js";
import { clientOf } from "./usage.js";
import { peerVaultRoutes } from "./peerVault.js";
import { relayCompletion, startHolder, type Fail } from "../runtimeRelay.js";

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

const fail: Fail = (reply, status, code, message) => reply.code(status).send({ error: code, message });

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
      if (!(await startHolder(holder.baseUrl, model, reply, fail))) return;
      return relayCompletion({
        req,
        reply,
        userId: auth.userId,
        baseUrl: holder.baseUrl,
        model,
        body,
        purpose,
        maxTokens: MAX_TOKENS,
        source: "peer",
        client: clientOf(auth),
        fail,
      });
    },
  });
}
