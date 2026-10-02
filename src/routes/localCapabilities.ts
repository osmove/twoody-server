import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.js";
import { reindex } from "../documents/library.js";
import { isLocalCapability, LOCAL_CAPABILITIES, localCapabilities, setLocalCapability } from "../localCapabilities.js";
import { isThisComputersApp } from "./usage.js";

//   GET   /local_capabilities        → { capabilities: { documents: false, … } }
//   PATCH /local_capabilities/:id    { enabled } → the same
// Read by any of the person's devices (a phone hides what is off); changed
// only from the app of this computer.
export async function localCapabilityRoutes(app: FastifyInstance) {
  app.get("/local_capabilities", {
    schema: { tags: ["capabilities"], summary: "What the person switched on on this computer", security: [{ bearerAuth: [] }, { userTokenAuth: [] }] },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      reply.send({ capabilities: localCapabilities(auth.userId), known: LOCAL_CAPABILITIES });
    },
  });

  app.patch<{ Params: { id: string }; Body: { enabled?: unknown } }>("/local_capabilities/:id", {
    schema: {
      tags: ["capabilities"],
      summary: "Switch a capability on or off",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      body: { type: "object", required: ["enabled"], properties: { enabled: { type: "boolean" } } },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!isThisComputersApp(auth)) return reply.code(403).send({ error: "desktop_app_only" });
      if (!isLocalCapability(req.params.id)) return reply.code(404).send({ error: "unknown_capability" });
      const enabled = req.body?.enabled === true;
      const capabilities = setLocalCapability(auth.userId, req.params.id, enabled);
      // Documents back on: the folders are read again for what changed.
      if (req.params.id === "documents" && enabled) void reindex(auth.userId).catch(() => undefined);
      reply.send({ capabilities, known: LOCAL_CAPABILITIES });
    },
  });
}
