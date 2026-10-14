import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.js";
import { requirePerson } from "./memories.js";
import { fullTracesSince, listTraces, promptOfTrace, telemetrySince, traceOfMessage } from "../diagnostics/traces.js";
import { installationFacts } from "../diagnostics/installation.js";
import { reachesWalledProjects } from "../projects/walledAccess.js";

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
      // A walled-off project's traces: this computer's app only.
      const hideWalled = !(await reachesWalledProjects(req, auth));
      if (req.query.message_id) {
        const trace = traceOfMessage(auth.userId, req.query.message_id, hideWalled);
        return trace ? reply.send({ traces: [trace] }) : reply.code(404).send({ error: "not_found" });
      }
      const before = req.query.before ? Date.parse(req.query.before) : NaN;
      reply.send({
        traces: listTraces(auth.userId, {
          limit: Number(req.query.limit) || 50,
          before: Number.isNaN(before) ? null : before,
          kind: req.query.kind === "chat" || req.query.kind === "learn" || req.query.kind === "warm" ? req.query.kind : null,
          discussionId: req.query.discussion_id || null,
          hideWalled,
        }),
      });
    },
  });

  // « Détails » under an answer (Jimmy, 03/10/2026): its trace, and what
  // the model was given — instructions, profile, history, the message,
  // the tools offered.
  app.get<{ Params: { id: string } }>("/diagnostics/messages/:id", {
    schema: { tags: ["diagnostics"], summary: "An answer's trace and the prompt its model was given", security: [{ bearerAuth: [] }, { userTokenAuth: [] }] },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!(await requirePerson(req, reply, auth))) return;
      const trace = traceOfMessage(auth.userId, req.params.id, !(await reachesWalledProjects(req, auth)));
      if (!trace) return reply.code(404).send({ error: "not_found" });
      reply.send({ trace, prompt: promptOfTrace(auth.userId, trace.id) });
    },
  });

  // « Partager aussi le détail des réponses » (off unless ticked): the
  // traces whole, with their prompts, for the account's audits — never a
  // walled-off project's (traces.ts WALLED), nor in the telemetry below.
  app.get<{ Querystring: { after?: string; limit?: string } }>("/diagnostics/full", {
    schema: { tags: ["diagnostics"], summary: "The traces whole, with their prompts, for audits on the account (when the person ticked it)", security: [{ bearerAuth: [] }, { userTokenAuth: [] }] },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!(await requirePerson(req, reply, auth))) return;
      reply.send(fullTracesSince(auth.userId, Number(req.query.after) || 0, Number(req.query.limit) || 20));
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

  // What this installation is, without anything that names the person
  // (src/diagnostics/installation.ts): Twoody Desktop's daily
  // `installation_active`, sent only while « Partager des diagnostics » is on.
  app.get("/diagnostics/installation", {
    schema: { tags: ["diagnostics"], summary: "This installation's capabilities, setup, providers and paired phones, without content, for the account's app analytics", security: [{ bearerAuth: [] }, { userTokenAuth: [] }] },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!(await requirePerson(req, reply, auth))) return;
      reply.send(installationFacts(auth.userId));
    },
  });
}
