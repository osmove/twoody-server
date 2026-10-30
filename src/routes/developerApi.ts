import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authenticate, requireAuth } from "../auth.js";
import { atCapacity } from "../account/inflight.js";
import { localModels } from "../account/statusSource.js";
import { forwardedByProxy, isLoopbackAddress, viaTunnel } from "../adminAccess.js";
import { createApiKey, KeyLimitError, listApiKeys, revokeApiKey, verifyApiKey } from "../developerApi/keys.js";
import { EMBED_MODEL, embed, embeddingFilesPresent } from "../embeddings.js";
import { ownerRequest } from "../localAccess.js";
import { relayCompletion, startHolder, type Fail } from "../runtimeRelay.js";
import { ownerHere } from "../sessionTrust.js";
import { soleUserId } from "../shares/serve.js";
import { addressedToLoopback, fromOtherPage } from "../webOrigin.js";

// The developer API (docs/developer-api-design.md): this computer's models
// for the programs of this computer, the OpenAI way.
//
//   GET    /v1/models              the chat models this computer holds
//   POST   /v1/chat/completions    passed to the runtime as it is (runtimeRelay.ts)
//   POST   /v1/embeddings          the semantic search model, when installed
//
// Each needs a local API key (`Authorization: Bearer twk_…`, migration 21)
// and comes from this very machine: a loopback address, addressed as
// 127.0.0.1, [::1] or localhost, not through the tunnel, not forwarded by a
// proxy, not sent by a browser from a web page (webOrigin.ts). Raw models
// only: no memory, no documents, no history, no tools of Twoody, no
// connector, nothing kept but a usage event (source « api »).
//
// The keys (owner only: this machine's console or the owner's session here):
//
//   GET    /api/v1/api_keys        the keys, never a token
//   POST   /api/v1/api_keys        { name } → the token, shown once
//   DELETE /api/v1/api_keys/:id    revoked, kept
//
// TWOODY_API_ALLOW_NETWORK=1 (the Docker image, whose port is published on
// the host's loopback) lets a key in from another address; a browser page
// stays refused.

const MAX_MESSAGES = 512;
const MAX_TOKENS = 32_768;
const MAX_EMBED_INPUTS = 64;
const WAIT_MS = 30_000;

type Body = Record<string, unknown>;

/// OpenAI's error shape.
const fail: Fail = (reply, status, code, message) =>
  reply.code(status).send({
    error: { message, type: status === 401 ? "authentication_error" : status >= 500 ? "server_error" : "invalid_request_error", code, param: null },
  });

function networkAllowed(): boolean {
  return process.env.TWOODY_API_ALLOW_NETWORK === "1";
}

/// Whether the request comes from a program of this machine (see above).
export function apiCallerHere(req: FastifyRequest): boolean {
  if (fromOtherPage(req) || viaTunnel(req)) return false;
  if (networkAllowed()) return true;
  return isLoopbackAddress(req.ip) && addressedToLoopback(req) && !forwardedByProxy(req);
}

function bearerOf(req: FastifyRequest): string | null {
  const value = req.headers.authorization;
  const header = Array.isArray(value) ? value[0] : value;
  if (!header || !/^Bearer\s+/i.test(header)) return null;
  return header.replace(/^Bearer\s+/i, "").trim();
}

/// Who calls /v1/*, or the refusal sent.
function caller(req: FastifyRequest, reply: FastifyReply): { userId: string; keyName: string } | null {
  if (!apiCallerHere(req)) {
    fail(reply, 403, "local_only", "The Twoody API answers the programs of this computer only.");
    return null;
  }
  const token = bearerOf(req);
  const key = token ? verifyApiKey(token) : null;
  if (!key) {
    fail(reply, 401, "invalid_api_key", "A valid Twoody API key is required (Authorization: Bearer twk_…). Make one with `twoody api-key create` or in Twoody › Réglages › Développeurs.");
    return null;
  }
  return { userId: key.userId, keyName: key.name };
}

async function waitForRoom(): Promise<boolean> {
  const until = Date.now() + WAIT_MS;
  while (atCapacity("chat")) {
    if (Date.now() > until) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return true;
}

/// The owner, for the keys: this machine's console (or the admin token),
/// or the owner's session from here. Their user id, or the refusal sent.
async function keyOwner(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  if (ownerRequest(req)) {
    const userId = (await authenticate(req))?.userId ?? soleUserId();
    if (!userId) {
      reply.code(409).send({ error: "setup_required", message: "This Twoody server has no owner yet: run `twoody setup` first." });
      return null;
    }
    return userId;
  }
  const auth = await requireAuth(req, reply);
  if (!auth) return null;
  if (!ownerHere(req, auth)) {
    reply.code(403).send({ error: "owner_required", message: "Only this computer's owner, on this computer, manages its API keys." });
    return null;
  }
  return auth.userId;
}

export async function developerApiRoutes(app: FastifyInstance) {
  app.get("/v1/models", {
    schema: { tags: ["developer"], summary: "OpenAI-compatible list of this computer's chat models (local API key)" },
    handler: async (req, reply) => {
      const who = caller(req, reply);
      if (!who) return;
      const models = await localModels(who.userId);
      const data = models.map((m) => ({ id: m.id, object: "model", created: 0, owned_by: "twoody", loaded: m.loaded }));
      if (embeddingFilesPresent()) data.push({ id: EMBED_MODEL, object: "model", created: 0, owned_by: "twoody", loaded: false });
      return reply.send({ object: "list", data });
    },
  });

  app.post<{ Body: Body }>("/v1/chat/completions", {
    schema: { tags: ["developer"], summary: "OpenAI-compatible chat completion on this computer's model (local API key)" },
    handler: async (req, reply) => {
      const who = caller(req, reply);
      if (!who) return;
      const body = (req.body ?? {}) as Body;
      const model = typeof body.model === "string" ? body.model : "";
      const messages = body.messages;
      if (!model) return fail(reply, 400, "invalid_request", "model is required");
      if (
        !Array.isArray(messages) ||
        messages.length === 0 ||
        messages.length > MAX_MESSAGES ||
        !messages.every((m) => m && typeof m === "object" && typeof (m as { role?: unknown }).role === "string")
      ) {
        return fail(reply, 400, "invalid_request", `messages: 1 to ${MAX_MESSAGES} messages with a role are required`);
      }
      if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 128)) {
        return fail(reply, 400, "invalid_request", "tools must be a list of at most 128");
      }
      const holder = (await localModels(who.userId)).find((m) => m.id === model);
      if (!holder) return fail(reply, 404, "model_not_found", `The model ${model} is not on this computer. See GET /v1/models, or \`twoody pull\`.`);
      if (!(await waitForRoom())) return fail(reply, 503, "busy", "This computer is answering already; try again in a moment.");
      if (!(await startHolder(holder.baseUrl, model, reply, fail))) return;
      return relayCompletion({
        req,
        reply,
        userId: who.userId,
        baseUrl: holder.baseUrl,
        model,
        body,
        purpose: "chat",
        maxTokens: MAX_TOKENS,
        source: "api",
        client: `api:${who.keyName}`,
        fail,
      });
    },
  });

  app.post<{ Body: Body }>("/v1/embeddings", {
    schema: { tags: ["developer"], summary: "OpenAI-compatible embeddings with the semantic search model (local API key)" },
    handler: async (req, reply) => {
      const who = caller(req, reply);
      if (!who) return;
      const body = (req.body ?? {}) as Body;
      const input = body.input;
      const inputs = typeof input === "string" ? [input] : Array.isArray(input) && input.every((i) => typeof i === "string") ? (input as string[]) : null;
      if (!inputs || inputs.length === 0 || inputs.length > MAX_EMBED_INPUTS) {
        return fail(reply, 400, "invalid_request", `input: a text, or a list of 1 to ${MAX_EMBED_INPUTS} texts`);
      }
      if (typeof body.model === "string" && body.model && body.model !== EMBED_MODEL) {
        return fail(reply, 404, "model_not_found", `Embeddings are made by ${EMBED_MODEL}.`);
      }
      if (!embeddingFilesPresent()) {
        return fail(reply, 404, "model_not_found", "The semantic search model is not installed (Twoody › Documents › « Rechercher par le sens »).");
      }
      try {
        const data: Array<{ object: "embedding"; index: number; embedding: number[] }> = [];
        let chars = 0;
        for (const [index, text] of inputs.entries()) {
          chars += text.length;
          data.push({ object: "embedding", index, embedding: Array.from(await embed(text)) });
        }
        const tokens = Math.ceil(chars / 3.5);
        return reply.send({ object: "list", model: EMBED_MODEL, data, usage: { prompt_tokens: tokens, total_tokens: tokens } });
      } catch {
        return fail(reply, 503, "runtime_unavailable", "The semantic search model does not answer.");
      }
    },
  });

  app.get("/api/v1/api_keys", {
    schema: { tags: ["developer"], summary: "This computer's local API keys (owner only; never a token)" },
    handler: async (req, reply) => {
      const userId = await keyOwner(req, reply);
      if (!userId) return;
      return reply.send({ api_keys: listApiKeys(userId) });
    },
  });

  app.post<{ Body: { name?: string } }>("/api/v1/api_keys", {
    schema: { tags: ["developer"], summary: "Make a local API key (owner only); its token is shown once" },
    handler: async (req, reply) => {
      const userId = await keyOwner(req, reply);
      if (!userId) return;
      try {
        const { token, key } = createApiKey(userId, req.body?.name);
        return reply.code(201).send({ token, api_key: key });
      } catch (err) {
        if (err instanceof KeyLimitError) return reply.code(422).send({ error: "too_many_keys", message: err.message });
        throw err;
      }
    },
  });

  app.delete<{ Params: { id: string } }>("/api/v1/api_keys/:id", {
    schema: { tags: ["developer"], summary: "Revoke a local API key (owner only)" },
    handler: async (req, reply) => {
      const userId = await keyOwner(req, reply);
      if (!userId) return;
      if (!revokeApiKey(userId, req.params.id)) return reply.code(404).send({ error: "not_found" });
      return reply.code(204).send();
    },
  });
}
