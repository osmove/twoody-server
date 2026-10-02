import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.js";
import { checkHome, cleanHomeUrl, controlHome, homeConfig, homeEntities, HomeError, homeOn, setHomeConfig, type HomeAction } from "../home/homeAssistant.js";
import { isThisComputersApp } from "./usage.js";

// Capacités → Maison (home/homeAssistant.ts):
//   GET    /home             whether it is set up, and the devices
//   PUT    /home/config      { url, token }: checked against Home Assistant, then kept
//   DELETE /home/config
//   POST   /home/control     { entity_id, action, brightness? }
// The token never comes back. Set up from this computer's app only.
export async function homeRoutes(app: FastifyInstance) {
  const security: Array<Record<string, string[]>> = [{ bearerAuth: [] }, { userTokenAuth: [] }];

  app.get<{ Querystring: { fresh?: string } }>("/home", {
    schema: { tags: ["home"], summary: "Home Assistant: set up or not, and the devices", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const config = homeConfig(auth.userId);
      if (!config) return reply.send({ enabled: homeOn(auth.userId), configured: false, url: null, source: null, devices: [] });
      try {
        const devices = await homeEntities(auth.userId, { fresh: req.query.fresh === "1" });
        reply.send({ enabled: homeOn(auth.userId), configured: true, url: config.url, source: config.source, devices });
      } catch (err) {
        reply.send({ enabled: homeOn(auth.userId), configured: true, url: config.url, source: config.source, devices: [], error: err instanceof HomeError ? err.code : "failed" });
      }
    },
  });

  app.put<{ Body: { url?: unknown; token?: unknown } }>("/home/config", {
    schema: { tags: ["home"], summary: "Set the address and token of Home Assistant", security, body: { type: "object", properties: { url: { type: "string" }, token: { type: "string" } } } },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!isThisComputersApp(auth)) return reply.code(403).send({ error: "desktop_app_only" });
      const url = cleanHomeUrl(req.body?.url);
      // An empty token keeps the one already given (the screen never has it).
      const token = typeof req.body?.token === "string" && req.body.token.trim() ? req.body.token.trim() : homeConfig(auth.userId)?.token ?? "";
      if (!url) return reply.code(422).send({ error: "url_required" });
      if (!token) return reply.code(422).send({ error: "token_required" });
      const checked = await checkHome({ url, token });
      if (!checked.ok) return reply.code(422).send({ error: checked.code });
      setHomeConfig(auth.userId, { url, token });
      reply.send({ configured: true, url, devices: checked.devices });
    },
  });

  app.delete("/home/config", {
    schema: { tags: ["home"], summary: "Forget Home Assistant", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!isThisComputersApp(auth)) return reply.code(403).send({ error: "desktop_app_only" });
      setHomeConfig(auth.userId, null);
      reply.code(204).send();
    },
  });

  app.post<{ Body: { entity_id?: unknown; action?: unknown; brightness?: unknown } }>("/home/control", {
    schema: { tags: ["home"], summary: "Switch a device of the home", security, body: { type: "object", required: ["entity_id", "action"], properties: { entity_id: { type: "string" }, action: { type: "string" }, brightness: { type: "number" } } } },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!homeOn(auth.userId)) return reply.code(403).send({ error: "home_off" });
      const action = (["on", "off", "toggle", "open", "close", "stop"] as HomeAction[]).find((value) => value === req.body?.action);
      if (typeof req.body?.entity_id !== "string" || !action) return reply.code(422).send({ error: "invalid_request" });
      try {
        const done = await controlHome(auth.userId, req.body.entity_id, action, { brightness: typeof req.body.brightness === "number" ? req.body.brightness : null });
        reply.send({ ok: true, entity_id: done.entity.entity_id, action });
      } catch (err) {
        const code = err instanceof HomeError ? err.code : "failed";
        reply.code(code === "unknown_entity" ? 404 : code === "not_configured" ? 409 : 502).send({ error: code });
      }
    },
  });
}
