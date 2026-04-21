import type { FastifyInstance } from "fastify";
import { createRequire } from "module";

const { version } = createRequire(import.meta.url)("../../package.json") as {
  version: string;
};

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", {
    schema: {
      tags: ["health"],
      summary: "Server health",
      response: {
        200: {
          type: "object",
          properties: {
            status: { type: "string" },
            version: { type: "string" },
            uptime: { type: "number" },
          },
          required: ["status", "version", "uptime"],
        },
      },
    },
    handler: async (_req, reply) => {
      reply.send({ status: "ok", version, uptime: process.uptime() });
    },
  });
}
