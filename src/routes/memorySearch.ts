import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth } from "../auth.js";
import { requirePerson } from "./memories.js";
import { readDate, readLimit, searchConversations, searchMemories, SearchError } from "../memory/search.js";
import { buildChatTurn, memoryModeFor, readMemoryMode } from "../chatContext.js";
import { profileHints, retrieveMemories, settleMemoryVectors } from "../memory/retrieve.js";
import { loadUserContext } from "./queries.js";

// Searching the memories and the conversations (docs/memory-v2-design.md §2,
// lot L5a). Like the memories themselves, for this server's owner or one
// of the person's own devices only (requirePerson): 403
// person_device_required otherwise.
//
//   GET  /memories/search?q&entity&limit   hybrid top-k with every score
//   POST /memories/retrieve                retrieval's dry run: profile and tier b
//   GET  /conversations/search?q&after&before&limit   FTS5 snippets

const security: Array<Record<string, string[]>> = [{ bearerAuth: [] }, { userTokenAuth: [] }];

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof SearchError) return reply.code(err.status).send({ error: err.code });
  throw err;
}

export async function memorySearchRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { q?: string; entity?: string; limit?: string } }>("/memories/search", {
    schema: {
      tags: ["memories"],
      summary: "Search the user's memories: hybrid lexical + embeddings, top-k with scores, no threshold",
      security,
      querystring: { type: "object", properties: { q: { type: "string", maxLength: 2000 }, entity: { type: "string", maxLength: 200 }, limit: { type: "string" } } },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!(await requirePerson(req, reply, auth))) return;
      try {
        reply.send(await searchMemories(auth.userId, { q: req.query.q, entity: req.query.entity, limit: readLimit(req.query.limit, 10) }));
      } catch (err) {
        return fail(reply, err);
      }
    },
  });

  app.post<{ Body: unknown }>("/memories/retrieve", {
    schema: { tags: ["memories"], summary: "Dry run of retrieval (tier b): what a message would be given, with scores and budget", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!(await requirePerson(req, reply, auth))) return;
      // {query (or message), context_window?, tau?, mode?, local?, explain?}: the first
      // turn of a new conversation, as /queries would build it — its profile
      // and the memories its message would carry — without asking a model or
      // counting anything. Retrieval is measured with every memory embedded
      // (those missing are embedded first, 20 s at most) and a warm engine.
      const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
      const query = typeof body.query === "string" ? body.query : typeof body.message === "string" ? body.message : "";
      if (!query.trim() || query.length > 4000) return reply.code(422).send({ error: "query_required" });
      const window = typeof body.context_window === "number" && Number.isInteger(body.context_window) && body.context_window >= 1024 && body.context_window <= 1_048_576 ? body.context_window : null;
      const tau = typeof body.tau === "number" && Number.isFinite(body.tau) && body.tau > 0 && body.tau < 2 ? body.tau : null;
      const context = loadUserContext(auth.userId);
      const mode = memoryModeFor(context.prefs, null, readMemoryMode(body.mode));
      const indexed = await settleMemoryVectors(auth.userId);
      const started = performance.now();
      const relevant = await retrieveMemories({ userId: auth.userId, query, memories: context.memories, mode, tau, waitMs: 10_000, explain: body.explain === true });
      const turn = buildChatTurn({
        ...context,
        history: [],
        content: query,
        local: body.local !== false,
        contextWindow: window,
        memoryMode: mode,
        relevant,
        profileHints: mode === "none" ? null : profileHints(auth.userId, context.memories),
      });
      const ms = Math.round((performance.now() - started) * 10) / 10;
      const entityOf = new Map(relevant.items.map((item) => [item.id, item.entity]));
      reply.send({
        mode,
        retrieval: relevant.retrieval,
        indexed,
        ms,
        items: turn.memory.items.map((item) => ({ ...item, entity: item.id ? entityOf.get(item.id) ?? null : null })),
        // Every memory admitted, before the budget and what the profile holds.
        admitted: relevant.items,
        ...(relevant.explained ? { explained: relevant.explained } : {}),
        relevant_tokens: turn.memory.relevant_tokens,
        profile: { tokens: turn.memory.profile_tokens, items: turn.profileIds.map((id) => ({ id })), text: turn.state.profile },
      });
    },
  });

  app.get<{ Querystring: { q?: string; after?: string; before?: string; limit?: string } }>("/conversations/search", {
    schema: {
      tags: ["discussions"],
      summary: "Search the user's conversations (FTS5): snippet, date and conversation title per message; « Aucune » conversations are never indexed",
      security,
      querystring: {
        type: "object",
        properties: { q: { type: "string", maxLength: 2000 }, after: { type: "string", maxLength: 40 }, before: { type: "string", maxLength: 40 }, limit: { type: "string" } },
      },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!(await requirePerson(req, reply, auth))) return;
      try {
        const items = searchConversations(auth.userId, {
          q: req.query.q,
          after: readDate(req.query.after, "after"),
          before: readDate(req.query.before, "before"),
          limit: readLimit(req.query.limit, 10),
        });
        reply.send({ items });
      } catch (err) {
        return fail(reply, err);
      }
    },
  });
}
