import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth } from "../auth.js";
import { isThisComputersApp } from "./usage.js";
import { addConnector, answerApproval, changeConnector, ConnectorError, connectorView, listConnectors, removeConnector, startConnector, stopConnector } from "../connectors/connectors.js";

// « Connecteurs » (Capacités, Jimmy, 03/10/2026), src/connectors/connectors.ts:
//   GET    /connectors                 the person's, with their tools
//   POST   /connectors                 { connector: { name, command, args, env } | { name, url, headers } }
//   PATCH  /connectors/:id             the same fields, enabled, disabled_tools
//   DELETE /connectors/:id
//   POST   /connectors/:id/start       started, its tools read
//   POST   /queries/approval           { id, allow } — a tool call asked in the chat
// Read by any of the person's devices; added, changed, started and removed
// only from this computer's app — a connector is a command this computer
// runs, or an address it calls with the person's token.

const security: Array<Record<string, string[]>> = [{ bearerAuth: [] }, { userTokenAuth: [] }];

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof ConnectorError) return reply.code(err.status).send({ error: err.code });
  throw err;
}

export async function connectorRoutes(app: FastifyInstance) {
  app.get("/connectors", {
    schema: { tags: ["connectors"], summary: "The person's connectors (MCP servers) and their tools", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      reply.send({ connectors: listConnectors(auth.userId).map((connector) => connectorView(auth.userId, connector)) });
    },
  });

  app.post<{ Body: unknown }>("/connectors", {
    schema: { tags: ["connectors"], summary: "Add a connector (this computer's app only)", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!isThisComputersApp(auth)) return reply.code(403).send({ error: "desktop_app_only" });
      try {
        const connector = addConnector(auth.userId, req.body);
        // Started at once, so that its tools are known; a failure is said, the connector stays.
        await startConnector(auth.userId, connector.id).catch(() => undefined);
        const stored = listConnectors(auth.userId).find((one) => one.id === connector.id)!;
        reply.code(201).send({ connector: connectorView(auth.userId, stored) });
      } catch (err) { fail(reply, err); }
    },
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/connectors/:id", {
    schema: { tags: ["connectors"], summary: "Change a connector (this computer's app only)", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!isThisComputersApp(auth)) return reply.code(403).send({ error: "desktop_app_only" });
      try {
        const changed = changeConnector(auth.userId, req.params.id, req.body);
        reply.send({ connector: connectorView(auth.userId, changed) });
      } catch (err) { fail(reply, err); }
    },
  });

  app.delete<{ Params: { id: string } }>("/connectors/:id", {
    schema: { tags: ["connectors"], summary: "Remove a connector (this computer's app only)", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!isThisComputersApp(auth)) return reply.code(403).send({ error: "desktop_app_only" });
      try {
        removeConnector(auth.userId, req.params.id);
        reply.code(204).send();
      } catch (err) { fail(reply, err); }
    },
  });

  app.post<{ Params: { id: string } }>("/connectors/:id/start", {
    schema: { tags: ["connectors"], summary: "Start a connector and read its tools again (this computer's app only)", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!isThisComputersApp(auth)) return reply.code(403).send({ error: "desktop_app_only" });
      stopConnector(auth.userId, req.params.id);
      try {
        const { connector } = await startConnector(auth.userId, req.params.id);
        reply.send({ connector: connectorView(auth.userId, connector) });
      } catch (err) {
        if (err instanceof ConnectorError && err.code.startsWith("start_failed")) {
          const stored = listConnectors(auth.userId).find((one) => one.id === req.params.id);
          return reply.code(502).send({ error: "start_failed", connector: stored ? connectorView(auth.userId, stored) : null });
        }
        fail(reply, err);
      }
    },
  });

  app.post<{ Body: { id?: unknown; allow?: unknown } }>("/queries/approval", {
    schema: { tags: ["queries"], summary: "Allow or refuse a connector's tool call asked in the chat", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const id = typeof req.body?.id === "string" ? req.body.id : "";
      if (!answerApproval(auth.userId, id, req.body?.allow === true)) return reply.code(404).send({ error: "nothing_waiting" });
      reply.send({ ok: true });
    },
  });
}
