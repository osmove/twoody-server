import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth } from "../auth.js";
import { requirePerson } from "./memories.js";
import { readDate, readLimit, searchConversations, searchMemories, SearchError } from "../memory/search.js";

// Searching the memories and the conversations (docs/memory-v2-design.md §2,
// lot L5a). Like the memories themselves, for this server's owner or one
// of the person's own devices only (requirePerson): 403
// person_device_required otherwise.
//
//   GET  /memories/search?q&entity&limit   hybrid top-k with every score
//   POST /memories/retrieve                retrieval's dry run (tier b)
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
      // Retrieval v2 (src/memory/retrieve.ts, lot L3) is not there yet.
      reply.code(501).send({ error: "not_implemented" });
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
