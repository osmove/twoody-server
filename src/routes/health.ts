import type { FastifyInstance } from "fastify";
import { createRequire } from "module";

const { version } = createRequire(import.meta.url)("../../package.json") as {
  version: string;
};

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async (_req, reply) => {
    reply.send({ status: "ok", version, uptime: process.uptime() });
  });
}
