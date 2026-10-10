import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { forwardedByProxy, isLoopbackAddress, viaTunnel } from "../adminAccess.js";
import { requireAuth } from "../auth.js";
import { isThisComputersApp } from "./usage.js";
import { takeSignIn } from "../connectors/oauth.js";
import { addConnector, answerApproval, beginSignIn, changeConnector, completeSignIn, ConnectorError, connectorView, listConnectors, removeConnector, signOut, startConnector, stopAllConnectors, stopConnector } from "../connectors/connectors.js";
import { forgetGoogleDataLink, setGoogleDataEnabled } from "../google/dataLink.js";
import { GOOGLE_DATA_CONNECTOR_ID, googleDataConnectorView } from "../google/dataTools.js";
import { meshRequester } from "../sessionTrust.js";
import { meshRoster } from "../vault/roster.js";

// « Connecteurs » (Capacités, Jimmy, 03/10/2026), src/connectors/connectors.ts:
//   GET    /connectors                 the person's, with their tools
//   POST   /connectors                 { connector: { name, command, args, env } | { name, url, headers } }
//   PATCH  /connectors/:id             the same fields, enabled, disabled_tools
//   DELETE /connectors/:id
//   POST   /connectors/:id/start       started, its tools read
//   POST   /connectors/:id/oauth/start → { authorization_url }: the service's sign-in page
//   GET    /connectors/oauth/callback  where that page sends the browser back
//   POST   /connectors/:id/oauth/sign_out
//   POST   /queries/approval           { id, allow, always? } — a tool call asked in the chat
// Read by any of the person's devices; added, changed, started and removed
// only from this computer's app — a connector is a command this computer
// runs, or an address it calls with the person's token.
//
// Used in the chat from this computer's app and, since 08/10/2026, from
// the person's own devices — their iPhone — each call asked on the device
// that sent the message (`from_devices` in the list says whether the
// device asking may; never a household member's nor a device paired by
// code: sessionTrust.ts meshRequester). The question is answered only by
// the session that asked it, still the person's device, or by this
// computer's app (connectors.ts answerApproval).
//
// Google Analytics and Search Console, once linked (/google_data,
// 08/10/2026), are listed here too, as the connector « google » of kind
// « builtin », so that « Outils » shows them and `connectors_off` can leave
// them out of a message: PATCH switches the link on or off, DELETE removes
// it; nothing else applies to it.

const security: Array<Record<string, string[]>> = [{ bearerAuth: [] }, { userTokenAuth: [] }];

/// This computer's app, on this computer: its session (usage.ts
/// isThisComputersApp), in a request from this very machine — not one the
/// tunnel served (a phone, another computer, the relay), not one a proxy
/// forwarded, not one from the local network (an owner's password typed
/// on another device). A connector is a program this computer runs: what
/// it runs is decided here only (docs/connectors-security-review.md).
function fromThisComputersApp(req: FastifyRequest, auth: { sessionId?: string; deviceId?: string }): boolean {
  return isThisComputersApp(auth) && isLoopbackAddress(req.ip) && !viaTunnel(req) && !forwardedByProxy(req);
}

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof ConnectorError) return reply.code(err.status).send({ error: err.code });
  throw err;
}

export async function connectorRoutes(app: FastifyInstance) {
  // Their programs end with this server.
  app.addHook("onClose", async () => stopAllConnectors());

  app.get("/connectors", {
    schema: { tags: ["connectors"], summary: "The person's connectors (MCP servers) and their tools", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      // Whether this device's messages get them: what its « Outils » may switch on.
      const fromDevices = isThisComputersApp(auth) || (await meshRequester(req, auth, () => meshRoster().get())) !== null;
      // What each one runs: for this computer's app only.
      const detail = fromThisComputersApp(req, auth);
      const google = googleDataConnectorView(auth.userId);
      reply.send({ connectors: [...listConnectors(auth.userId).map((connector) => connectorView(auth.userId, connector, fromDevices, detail)), ...(google ? [{ ...google, from_devices: fromDevices }] : [])] });
    },
  });

  app.post<{ Body: unknown }>("/connectors", {
    schema: { tags: ["connectors"], summary: "Add a connector (this computer's app only)", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!fromThisComputersApp(req, auth)) return reply.code(403).send({ error: "desktop_app_only" });
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
      if (!fromThisComputersApp(req, auth)) return reply.code(403).send({ error: "desktop_app_only" });
      if (req.params.id === GOOGLE_DATA_CONNECTOR_ID) {
        const input = (req.body && typeof req.body === "object" ? (req.body as { connector?: unknown }).connector ?? req.body : {}) as Record<string, unknown>;
        if (typeof input.enabled === "boolean" && !setGoogleDataEnabled(auth.userId, input.enabled)) return reply.code(404).send({ error: "not_found" });
        const google = googleDataConnectorView(auth.userId);
        return google ? reply.send({ connector: google }) : reply.code(404).send({ error: "not_found" });
      }
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
      if (!fromThisComputersApp(req, auth)) return reply.code(403).send({ error: "desktop_app_only" });
      if (req.params.id === GOOGLE_DATA_CONNECTOR_ID) return forgetGoogleDataLink(auth.userId) ? reply.code(204).send() : reply.code(404).send({ error: "not_found" });
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
      if (!fromThisComputersApp(req, auth)) return reply.code(403).send({ error: "desktop_app_only" });
      stopConnector(auth.userId, req.params.id);
      try {
        const { connector } = await startConnector(auth.userId, req.params.id);
        reply.send({ connector: connectorView(auth.userId, connector) });
      } catch (err) {
        if (err instanceof ConnectorError && (err.code.startsWith("start_failed") || err.code === "sign_in_required")) {
          const stored = listConnectors(auth.userId).find((one) => one.id === req.params.id);
          return reply.code(err.status).send({ error: err.code === "sign_in_required" ? "sign_in_required" : "start_failed", connector: stored ? connectorView(auth.userId, stored) : null });
        }
        fail(reply, err);
      }
    },
  });

  // Signing in to a connector's service (connectors/oauth.ts). The browser
  // comes back to this server, on this computer: a loopback address only.
  app.post<{ Params: { id: string } }>("/connectors/:id/oauth/start", {
    schema: { tags: ["connectors"], summary: "The sign-in page of a connector's service (this computer's app only)", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!fromThisComputersApp(req, auth)) return reply.code(403).send({ error: "desktop_app_only" });
      const host = String(req.headers.host ?? "");
      const hostname = host.replace(/:\d+$/, "");
      if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname)) return reply.code(422).send({ error: "loopback_only" });
      try {
        reply.send({ authorization_url: await beginSignIn(auth.userId, req.params.id, `http://${host}/connectors/oauth/callback`) });
      } catch (err) { fail(reply, err); }
    },
  });

  // Opened by the person's browser, without this app's session: the
  // sign-in is named by its one-time `state`.
  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>("/connectors/oauth/callback", {
    schema: { tags: ["connectors"], summary: "Where a connector's sign-in page sends the browser back", hide: true },
    handler: async (req, reply) => {
      const page = (title: string, text: string) => reply.type("text/html; charset=utf-8").send(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Twoody</title><meta name="viewport" content="width=device-width"><style>body{font:16px -apple-system,system-ui,sans-serif;margin:15vh auto;max-width:34em;padding:0 1em;color:#222}h1{font-size:1.3em}</style></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></body></html>`);
      const { code, state, error } = req.query ?? {};
      if (error || !code || !state) {
        // The sign-in under way is let go.
        if (state) takeSignIn(state);
        return page("Connexion annulée", `Le service n'a pas donné son accord${error ? ` (${String(error).slice(0, 80)})` : ""}. Vous pouvez fermer cet onglet et réessayer depuis Twoody.`);
      }
      try {
        const { userId, connector } = await completeSignIn(state, code);
        void startConnector(userId, connector.id).catch(() => undefined);
        return page(`Twoody est connecté à ${connector.name}`, "Vous pouvez fermer cet onglet et revenir à Twoody.");
      } catch (err) {
        const expired = err instanceof ConnectorError && err.code === "sign_in_expired";
        return page("La connexion n'a pas abouti", expired ? "Cette page de connexion a expiré : recommencez depuis Twoody." : `Le service a refusé : ${err instanceof Error ? err.message.slice(0, 200) : ""}. Recommencez depuis Twoody.`);
      }
    },
  });

  app.post<{ Params: { id: string } }>("/connectors/:id/oauth/sign_out", {
    schema: { tags: ["connectors"], summary: "Sign out of a connector's service (this computer's app only)", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!fromThisComputersApp(req, auth)) return reply.code(403).send({ error: "desktop_app_only" });
      try {
        reply.send({ connector: connectorView(auth.userId, signOut(auth.userId, req.params.id)) });
      } catch (err) { fail(reply, err); }
    },
  });

  app.post<{ Body: { id?: unknown; allow?: unknown; always?: unknown } }>("/queries/approval", {
    schema: { tags: ["queries"], summary: "Allow or refuse a connector's tool call asked in the chat", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const id = typeof req.body?.id === "string" ? req.body.id : "";
      // Who answers: this computer's app, or the very session that asked —
      // still one of the person's own devices, through its own tunnel key.
      // Anyone else is told nothing waits, whatever the id.
      const thisComputersApp = fromThisComputersApp(req, auth);
      const person = thisComputersApp || (await meshRequester(req, auth, () => meshRoster().get())) !== null;
      if (!person || !answerApproval(auth.userId, id, req.body?.allow === true, req.body?.always === true, { sessionId: auth.sessionId ?? null, thisComputersApp })) return reply.code(404).send({ error: "nothing_waiting" });
      reply.send({ ok: true });
    },
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
