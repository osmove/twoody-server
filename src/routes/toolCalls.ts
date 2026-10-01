import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.js";
import { ownerRequest } from "../localAccess.js";
import { isPersonOrOwner } from "../sessionTrust.js";
import { meshRoster } from "../vault/roster.js";
import { SearchError } from "../memory/search.js";
import { executeLocalTool } from "../tools.js";

// The memories' and the conversations' searches are for the owner or one
// of the person's own devices only (sessionTrust.ts).
const PERSON_TOOLS = new Set(["memory_search", "search_memory", "search_conversations"]);

export async function toolCallRoutes(app: FastifyInstance) {
  app.post<{ Body: { name: string; arguments?: Record<string, unknown> | string } }>("/tool_calls", {
    schema: {
      tags: ["queries"],
      summary: "Execute a local tool call",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;

      const name = req.body?.name;
      if (!name) return reply.code(422).send({ error: "name is required" });

      const args =
        typeof req.body.arguments === "string"
          ? (JSON.parse(req.body.arguments) as Record<string, unknown>)
          : req.body.arguments ?? {};

      const person = PERSON_TOOLS.has(name) && (ownerRequest(req) || (await isPersonOrOwner(req, auth, () => meshRoster().get())));
      if (PERSON_TOOLS.has(name) && !person) return reply.code(403).send({ error: "person_device_required" });
      try {
        const result = await executeLocalTool(name, args, { userId: auth.userId, person });
        reply.send({ status: "ok", result });
      } catch (err) {
        if (err instanceof SearchError) return reply.code(err.status).send({ error: err.code });
        throw err;
      }
    },
  });
}
