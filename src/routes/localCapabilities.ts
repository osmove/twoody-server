import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.js";
import { reindex } from "../documents/library.js";
import { capabilityOrder, capabilityPlaces, isLocalCapability, LOCAL_CAPABILITIES, localCapabilities, setCapabilityOrder, setCapabilityPlace, setLocalCapability, setUsageProfile, usageProfile } from "../localCapabilities.js";
import { isThisComputersApp } from "./usage.js";
import { homeOn } from "../home/homeAssistant.js";

//   GET   /local_capabilities        → { capabilities: { documents: false, … }, places: { documents: { menu, chat }, … } }
//   PATCH /local_capabilities/:id    { enabled?, menu?, chat? } → the same
//   PUT   /local_capabilities_order  { order: [...] } → the same (null: alphabetical)
//   PUT   /local_usage               { kind?, team?, profession? } → the same (`usage`)
// Read by any of the person's devices (a phone hides what is off); changed
// only from the app of this computer.
export async function localCapabilityRoutes(app: FastifyInstance) {
  app.get("/local_capabilities", {
    schema: { tags: ["capabilities"], summary: "What the person switched on on this computer", security: [{ bearerAuth: [] }, { userTokenAuth: [] }] },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      // Maison may be on by the environment of a computer without a screen.
      reply.send({ capabilities: { ...localCapabilities(auth.userId), home: homeOn(auth.userId) }, places: capabilityPlaces(auth.userId), order: capabilityOrder(auth.userId), usage: usageProfile(auth.userId), known: LOCAL_CAPABILITIES });
    },
  });

  app.patch<{ Params: { id: string }; Body: { enabled?: unknown; menu?: unknown; chat?: unknown } }>("/local_capabilities/:id", {
    schema: {
      tags: ["capabilities"],
      summary: "Switch a capability on or off",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      body: { type: "object", minProperties: 1, properties: { enabled: { type: "boolean" }, menu: { type: "boolean" }, chat: { type: "boolean" } } },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!isThisComputersApp(auth)) return reply.code(403).send({ error: "desktop_app_only" });
      if (!isLocalCapability(req.params.id)) return reply.code(404).send({ error: "unknown_capability" });
      const id = req.params.id;
      const body = req.body ?? {};
      let capabilities = localCapabilities(auth.userId);
      if (typeof body.enabled === "boolean") {
        capabilities = setLocalCapability(auth.userId, id, body.enabled);
        // Documents back on: the folders are read again for what changed.
        if (id === "documents" && body.enabled) void reindex(auth.userId).catch(() => undefined);
      }
      const place = { ...(typeof body.menu === "boolean" ? { menu: body.menu } : {}), ...(typeof body.chat === "boolean" ? { chat: body.chat } : {}) };
      const places = Object.keys(place).length ? setCapabilityPlace(auth.userId, id, place) : capabilityPlaces(auth.userId);
      reply.send({ capabilities: { ...capabilities, home: homeOn(auth.userId) }, places, order: capabilityOrder(auth.userId), usage: usageProfile(auth.userId), known: LOCAL_CAPABILITIES });
    },
  });

  app.put<{ Body: { kind?: unknown; team?: unknown; profession?: unknown } }>("/local_usage", {
    schema: {
      tags: ["capabilities"],
      summary: "How the person uses Twoody: personal or pro, alone or as a team",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      body: { type: "object", minProperties: 1, properties: { kind: { type: "string", enum: ["personal", "pro"] }, team: { type: "boolean" }, profession: { type: ["string", "null"] } } },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!isThisComputersApp(auth)) return reply.code(403).send({ error: "desktop_app_only" });
      const usage = setUsageProfile(auth.userId, req.body ?? {});
      reply.send({ capabilities: { ...localCapabilities(auth.userId), home: homeOn(auth.userId) }, places: capabilityPlaces(auth.userId), order: capabilityOrder(auth.userId), usage, known: LOCAL_CAPABILITIES });
    },
  });

  app.put<{ Body: { order?: unknown } }>("/local_capabilities_order", {
    schema: {
      tags: ["capabilities"],
      summary: "Arrange the capabilities' pages in the menu",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      body: { type: "object", required: ["order"], properties: { order: { type: ["array", "null"], items: { type: "string" }, maxItems: 40 } } },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!isThisComputersApp(auth)) return reply.code(403).send({ error: "desktop_app_only" });
      const order = setCapabilityOrder(auth.userId, req.body?.order);
      reply.send({ capabilities: { ...localCapabilities(auth.userId), home: homeOn(auth.userId) }, places: capabilityPlaces(auth.userId), order, usage: usageProfile(auth.userId), known: LOCAL_CAPABILITIES });
    },
  });
}
