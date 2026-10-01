import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.js";
import { requirePerson } from "./memories.js";
import { listTraces, telemetrySince, traceOfMessage } from "../diagnostics/traces.js";

// The Diagnostic screen (src/diagnostics/traces.ts): what happened in each
// answer, learning and read-ahead on this computer. The person's own: the
// traces hold the tools' arguments, in their words.
export async function diagnosticsRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { limit?: string; before?: string; kind?: string; discussion_id?: string; message_id?: string } }>("/diagnostics/turns", {
    schema: { tags: ["diagnostics"], summary: "What happened in each answer on this computer", security: [{ bearerAuth: [] }, { userTokenAuth: [] }] },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!(await requirePerson(req, reply, auth))) return;
      if (req.query.message_id) {
        const trace = traceOfMessage(auth.userId, req.query.message_id);
        return trace ? reply.send({ traces: [trace] }) : reply.code(404).send({ error: "not_found" });
      }
      const before = req.query.before ? Date.parse(req.query.before) : NaN;
      reply.send({
        traces: listTraces(auth.userId, {
          limit: Number(req.query.limit) || 50,
          before: Number.isNaN(before) ? null : before,
          kind: req.query.kind === "chat" || req.query.kind === "learn" || req.query.kind === "warm" ? req.query.kind : null,
          discussionId: req.query.discussion_id || null,
        }),
      });
    },
  });

  // What « Partager des diagnostics » sends to the account, when the person
  // ticked it (Twoody Desktop does the sending): the traces after `after`
  // (ms), without anything the person wrote.
  app.get<{ Querystring: { after?: string; limit?: string } }>("/diagnostics/telemetry", {
    schema: { tags: ["diagnostics"], summary: "The traces without their content, for the account's app analytics", security: [{ bearerAuth: [] }, { userTokenAuth: [] }] },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!(await requirePerson(req, reply, auth))) return;
      reply.send(telemetrySince(auth.userId, Number(req.query.after) || 0, Number(req.query.limit) || 50));
    },
  });
}
