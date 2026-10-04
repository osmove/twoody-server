import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.js";
import { isThisComputersApp } from "./usage.js";
import { COPY_KINDS, linkMicrosoftGraph, microsoftGraphStatus, syncMicrosoftGraph, unlinkMicrosoftGraph } from "../microsoft/sync.js";
import { capabilityOn } from "../localCapabilities.js";

// The link to Microsoft Graph, and the copies of Outlook's or Microsoft 365's
// calendar and contacts made with it (src/microsoft/), from the Agenda and
// Contacts pages of this computer's app:
//   GET    /microsoft_graph/status    the link (never its token): the account's address, the permissions granted
//                                     (the union of what each capability asked), each copy (capability on,
//                                     granted, rows, last sync, last error)
//   POST   /microsoft_graph/account   { address, refresh_token, scopes } → tried, kept, read at once; sent by the
//                                     app's main process after Microsoft's sign-in (the page never holds a token)
//   POST   /microsoft_graph/sync      read now
//   DELETE /microsoft_graph/account   the sign-in forgotten, both copies removed
// All for this computer's app only. No answer carries a token.

const security: Array<Record<string, string[]>> = [{ bearerAuth: [] }, { userTokenAuth: [] }];

/// How a refusal is answered.
function statusFor(error: string): number {
  if (["capability_off", "desktop_app_only"].includes(error)) return 403;
  if (["not_linked", "signin_required"].includes(error)) return 409;
  if (["address_required", "invalid_address", "scope_missing"].includes(error)) return 422;
  return 502;
}

const linkBody = {
  type: "object",
  properties: {
    address: { type: "string", maxLength: 320 },
    refresh_token: { type: "string", maxLength: 16384 },
    scopes: { type: "string", maxLength: 4096 },
  },
};

export async function microsoftGraphRoutes(app: FastifyInstance) {
  const guard = async (req: Parameters<typeof requireAuth>[0], reply: Parameters<typeof requireAuth>[1]) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return null;
    if (!isThisComputersApp(auth)) {
      reply.code(403).send({ error: "desktop_app_only" });
      return null;
    }
    return auth;
  };

  app.get("/microsoft_graph/status", {
    schema: { tags: ["microsoft"], summary: "The link to Outlook's calendar and contacts (never its token), and each copy (this computer's app only)", security },
    handler: async (req, reply) => {
      const auth = await guard(req, reply);
      if (!auth) return;
      reply.send(microsoftGraphStatus(auth.userId));
    },
  });

  app.post<{ Body: unknown }>("/microsoft_graph/account", {
    schema: { tags: ["microsoft"], summary: "Link Outlook's calendar and contacts after Microsoft's sign-in: tried, kept, then read (this computer's app only)", security, body: linkBody },
    handler: async (req, reply) => {
      const auth = await guard(req, reply);
      if (!auth) return;
      const done = await linkMicrosoftGraph(auth.userId, req.body);
      if (!done.ok) return reply.code(statusFor(done.error)).send({ error: done.error });
      reply.send({ ok: true, status: microsoftGraphStatus(auth.userId) });
    },
  });

  app.post("/microsoft_graph/sync", {
    schema: { tags: ["microsoft"], summary: "Read Outlook's calendar and contacts now (this computer's app only)", security },
    handler: async (req, reply) => {
      const auth = await guard(req, reply);
      if (!auth) return;
      if (!COPY_KINDS.some((kind) => capabilityOn(auth.userId, kind))) return reply.code(403).send({ error: "capability_off" });
      const status = microsoftGraphStatus(auth.userId);
      if (!status.linked) return reply.code(409).send({ error: "not_linked" });
      // Answered at once: the page follows it in /microsoft_graph/status.
      void syncMicrosoftGraph(auth.userId).catch(() => undefined);
      reply.code(202).send(microsoftGraphStatus(auth.userId));
    },
  });

  app.delete("/microsoft_graph/account", {
    schema: { tags: ["microsoft"], summary: "Unlink Outlook's calendar and contacts: the sign-in forgotten, both copies removed (this computer's app only)", security },
    handler: async (req, reply) => {
      const auth = await guard(req, reply);
      if (!auth) return;
      if (!unlinkMicrosoftGraph(auth.userId)) return reply.code(404).send({ error: "not_linked" });
      reply.send(microsoftGraphStatus(auth.userId));
    },
  });
}
