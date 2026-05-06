import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.js";

// `/agents` is the iPhone/watch app's catalog of personas (default,
// secrétaire, custom rows). The single-user Self-hosted edition
// doesn't ship a curated catalog — the user is the only operator
// and `system_prompt` on `/me` is the canonical override surface
// here. We answer with an empty list so the app's catalog UI
// gracefully shows the "no custom agents" empty-state instead of
// throwing on a 404.
//
// When the local server gains a real Agent persona model, the wire
// shape to match is `app/views/agents/_agent.json.jbuilder` from the
// cloud backend.
export async function agentRoutes(app: FastifyInstance) {
  app.get("/agents", {
    schema: {
      tags: ["session"],
      summary: "Agent catalog (empty in self-hosted mode)",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      reply.send({ agents: [] });
    },
  });

  app.get("/agents.json", {
    schema: {
      tags: ["session"],
      summary: "Cloud-compat alias for /agents",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      reply.send({ agents: [] });
    },
  });
}
