import type { FastifyInstance } from "fastify";
import { createRequire } from "module";
import { DATA_DIR, databaseEncryption } from "../db.js";
import { dataAtRest } from "../dataAtRest.js";

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
            // Whether this server's data folder is on an encrypted volume
            // (dataAtRest.ts): "encrypted", "not_encrypted" or "unknown".
            data_at_rest: { type: "string" },
            // Whether local.db itself is encrypted (dbCipher.ts): "encrypted"
            // inside Twoody Desktop with a keyring, "clear" otherwise.
            database: { type: "string" },
          },
          required: ["status", "version", "uptime"],
        },
      },
    },
    handler: async (_req, reply) => {
      reply.send({ status: "ok", version, uptime: process.uptime(), data_at_rest: dataAtRest(DATA_DIR), database: databaseEncryption });
    },
  });
}
