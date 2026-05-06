import type { FastifyInstance } from "fastify";
import { hostname as osHostname } from "node:os";
import { createRequire } from "module";

const { version } = createRequire(import.meta.url)("../../package.json") as {
  version: string;
};

// Public deployment metadata. Lets clients tell apart Cloud
// (api.twoody.com), a customer Self-hosted Rails, and a local
// twoody-server. Mirrors the Rails `/api/v1/deployment` shape so the
// client uses one path regardless of backend.
export async function deploymentRoutes(app: FastifyInstance) {
  app.get("/deployment", {
    schema: {
      tags: ["health"],
      summary: "Deployment metadata",
      response: {
        200: {
          type: "object",
          properties: {
            kind:          { type: "string" },
            version:       { type: "string" },
            instance_name: { type: "string" },
          },
          required: ["kind", "version", "instance_name"],
        },
      },
    },
    handler: async (_req, reply) => {
      reply.send({
        kind:          "local",
        version,
        instance_name: process.env.TWOODY_INSTANCE_NAME?.trim() || osHostname(),
      });
    },
  });
}
