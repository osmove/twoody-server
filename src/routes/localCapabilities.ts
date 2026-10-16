import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.js";
import { reindex } from "../documents/library.js";
import { capabilityNotOffered, capabilityOrder, capabilityPlaces, isLocalCapability, LOCAL_CAPABILITIES, localCapabilities, setCapabilityOrder, setCapabilityPlace, setLocalCapability, setUsageProfile, setWithdrawnReserved, usageProfile, withdrawnReserved } from "../localCapabilities.js";
import { reservedFeatures } from "../reservedFeatures.js";
import { isThisComputersApp } from "./usage.js";
import { homeOn } from "../home/homeAssistant.js";
import { graphCapabilityChanged } from "../microsoft/sync.js";
import { personStanding } from "../sessionTrust.js";
import { emailToolsAvailable } from "../email/chat.js";
import { meshRoster } from "../vault/roster.js";
import { webForDevicesAvailable } from "../webResearch.js";

//   GET   /local_capabilities        → { capabilities: { documents: false, … }, places: { documents: { menu, chat }, … } }
//   PATCH /local_capabilities/:id    { enabled?, menu?, chat? } → the same
//   PUT   /local_capabilities_order  { order: [...] } → the same (null: alphabetical)
//   PUT   /local_usage               { kind?, team?, profession? } → the same (`usage`)
// Read by any of the person's devices (a phone hides what is off); changed
// only from the app of this computer.
//
// `devices` (08/10/2026): what this computer does for the device asking —
// `web`, it searches the web for its messages (src/webResearch.ts): only
// when the Desktop that started it handed over its web search, and only
// for this computer's app or one of the person's own devices, never a
// household member's phone nor a device paired by code. The phone shows
// its « Recherche Internet » switch when this and `capabilities.web` say so.
// `email` (11/10/2026): it searches and reads the person's mailbox copy for
// that device's messages, a draft asked on that device (routes/queries.ts
// offersEmail) — E-mails on, a mailbox linked, the same devices as `web`.
// `person`, `reason`, `until`: whether the device asking is one of the
// person's here, and if not why (sessionTrust.ts personStanding) — what
// its « Outils » says, and what makes a phone sign a fresh device-access.
// `reserved` (16/10/2026, reservedFeatures.ts): whether E-mails
// (`email`) and Google Analytics / Search Console (`google_data`) are
// offered to this person — the apps show neither otherwise; `withdrawn`:
// those switched off here because they no longer are, for the app to say
// once (DELETE /local_capabilities/withdrawn).
export async function localCapabilityRoutes(app: FastifyInstance) {
  app.get("/local_capabilities", {
    schema: { tags: ["capabilities"], summary: "What the person switched on on this computer", security: [{ bearerAuth: [] }, { userTokenAuth: [] }] },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      // Maison may be on by the environment of a computer without a screen.
      const standing = isThisComputersApp(auth) ? { person: true, reason: null, until: null } : await personStanding(req, auth, () => meshRoster().get());
      const person = standing.person;
      reply.send({
        capabilities: { ...localCapabilities(auth.userId), home: homeOn(auth.userId) },
        places: capabilityPlaces(auth.userId),
        order: capabilityOrder(auth.userId),
        usage: usageProfile(auth.userId),
        known: LOCAL_CAPABILITIES,
        devices: { web: person && webForDevicesAvailable(), email: person && emailToolsAvailable(auth.userId), person, reason: standing.reason, until: standing.until },
        reserved: reservedFeatures(),
        withdrawn: withdrawnReserved(auth.userId),
      });
    },
  });

  app.delete("/local_capabilities/withdrawn", {
    schema: { tags: ["capabilities"], summary: "The notice that a reserved capability was switched off has been shown (this computer's app only)", security: [{ bearerAuth: [] }, { userTokenAuth: [] }] },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!isThisComputersApp(auth)) return reply.code(403).send({ error: "desktop_app_only" });
      reply.send({ withdrawn: setWithdrawnReserved(auth.userId, []) });
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
      // E-mails while it is not offered to this person (reservedFeatures.ts).
      if (body.enabled === true && capabilityNotOffered(id)) return reply.code(403).send({ error: "reserved_feature" });
      if (typeof body.enabled === "boolean") {
        const was = capabilities[id];
        capabilities = setLocalCapability(auth.userId, id, body.enabled);
        // Documents back on: the folders are read again for what changed.
        if (id === "documents" && body.enabled) void reindex(auth.userId).catch(() => undefined);
        // Agenda or Contacts off: its copy of Outlook's goes; back on, it is
        // read at once (src/microsoft/sync.ts).
        if ((id === "calendar" || id === "contacts") && was !== body.enabled) graphCapabilityChanged(auth.userId, id, body.enabled);
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
