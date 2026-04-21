import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.js";
import { executeLocalTool } from "../tools.js";

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

      const result = await executeLocalTool(name, args, { userId: auth.userId });
      reply.send({ status: "ok", result });
    },
  });
}
