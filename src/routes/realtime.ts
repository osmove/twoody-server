import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.js";

// Proxy ephemeral OpenAI Realtime tokens for devices / watch app
export async function realtimeRoutes(app: FastifyInstance) {
  app.post("/realtime_sessions", {
    schema: {
      tags: ["realtime"],
      summary: "Create an ephemeral OpenAI Realtime session",
      security: [{ bearerAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;

      const key = process.env.OPENAI_API_KEY;
      if (!key) {
        return reply.code(503).send({ error: "OPENAI_API_KEY not configured" });
      }

      const model = process.env.OPENAI_MODEL ?? "gpt-4o-realtime-preview";
      const voice = process.env.OPENAI_VOICE ?? "cedar";

      const res = await fetch("https://api.openai.com/v1/realtime/sessions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, voice }),
      });

      if (!res.ok) {
        const err = await res.text();
        app.log.error({ status: res.status, err }, "OpenAI realtime session failed");
        return reply.code(502).send({ error: "Failed to create realtime session" });
      }

      const data = await res.json();
      reply.send(data);
    },
  });
}
