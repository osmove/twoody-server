import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { fromThisMachine, requireAuth } from "../auth.js";
import { isThisComputersApp } from "./usage.js";
import { meshRequester } from "../sessionTrust.js";
import { meshRoster } from "../vault/roster.js";
import { agree, appendAnswer, refuse, resultText } from "../fileActions/chat.js";
import { checkedFolder, undoFileAction } from "../fileActions/run.js";
import { fileAction, type FileActionRow } from "../fileActions/store.js";
import { actionView, mayDecide, type Viewer } from "../fileActions/view.js";
import { say } from "../fileActions/words.js";

// « Agir dans vos dossiers » (twoody-desktop docs/agent-in-chat.md): the
// card under a proposal of the chat.
//
//   GET  /file_actions/:id             the action as the card shows it
//   POST /file_actions/:id/approve     « Faire »: starts it; its result is said in the conversation
//   POST /file_actions/:id/decline     « Ne pas faire »
//   POST /file_actions/:id/undo        « Annuler » (a sort or a rename done)
//   GET  /file_actions/:id/path?item=n the real path of what it made or moved, for « Ouvrir » /
//                                      « Afficher dans le Finder » — this computer's app only
//
// Read by the person only: this computer's app or one of their own devices
// (sessionTrust.ts meshRequester). Answered by the session that asked, or
// this computer's app — as a connector's call (connectors.ts answerApproval):
// anyone else is told there is no such action.

async function viewer(req: FastifyRequest, reply: FastifyReply): Promise<{ userId: string; viewer: Viewer } | null> {
  const auth = await requireAuth(req, reply);
  if (!auth) return null;
  const thisComputersApp = isThisComputersApp(auth) && fromThisMachine(req);
  const person = thisComputersApp || (await meshRequester(req, auth, () => meshRoster().get())) !== null;
  if (!person) {
    reply.code(404).send({ error: "not_found" });
    return null;
  }
  return { userId: auth.userId, viewer: { sessionId: auth.sessionId ?? null, thisComputersApp } };
}

function found(userId: string, id: string, reply: FastifyReply): FileActionRow | null {
  const row = fileAction(userId, id);
  if (!row) reply.code(404).send({ error: "not_found" });
  return row;
}

const params = { type: "object", required: ["id"], properties: { id: { type: "string", maxLength: 64 } } } as const;
const security: Array<Record<string, string[]>> = [{ bearerAuth: [] }, { userTokenAuth: [] }];

export async function fileActionRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/file_actions/:id", {
    schema: { tags: ["queries"], summary: "An action on a folder proposed in the chat (« Agir dans vos dossiers »)", security, params },
    handler: async (req, reply) => {
      const who = await viewer(req, reply);
      if (!who) return;
      const row = found(who.userId, req.params.id, reply);
      if (!row) return;
      reply.send({ action: actionView(row, who.viewer) });
    },
  });

  app.post<{ Params: { id: string } }>("/file_actions/:id/approve", {
    schema: { tags: ["queries"], summary: "Agree to an action on a folder: it starts, its result is said in the conversation", security, params },
    handler: async (req, reply) => {
      const who = await viewer(req, reply);
      if (!who) return;
      const row = found(who.userId, req.params.id, reply);
      if (!row) return;
      if (!mayDecide(row, who.viewer)) return reply.code(404).send({ error: "not_found" });
      if (row.status !== "proposed") return reply.code(409).send({ error: "not_waiting", action: actionView(row, who.viewer) });
      // Started now, said when done: a Word document takes a while, longer
      // than a phone's request through the relay waits.
      const running = agree(row, who.viewer).then((done) => {
        if (done) appendAnswer(row.userId, row.discussionId, resultText(done.row, done.result));
      }).catch(() => undefined);
      void running;
      const now = fileAction(who.userId, row.id) ?? row;
      reply.send({ action: actionView(now.status === "proposed" ? { ...now, status: "running" } : now, who.viewer) });
    },
  });

  app.post<{ Params: { id: string } }>("/file_actions/:id/decline", {
    schema: { tags: ["queries"], summary: "Refuse an action on a folder: nothing is done", security, params },
    handler: async (req, reply) => {
      const who = await viewer(req, reply);
      if (!who) return;
      const row = found(who.userId, req.params.id, reply);
      if (!row) return;
      if (!mayDecide(row, who.viewer)) return reply.code(404).send({ error: "not_found" });
      const declined = refuse(row, who.viewer);
      if (!declined) return reply.code(409).send({ error: "not_waiting", action: actionView(row, who.viewer) });
      appendAnswer(row.userId, row.discussionId, say(row.language, "declined"));
      reply.send({ action: actionView(declined, who.viewer) });
    },
  });

  app.post<{ Params: { id: string } }>("/file_actions/:id/undo", {
    schema: { tags: ["queries"], summary: "Put back what a sort or a rename moved", security, params },
    handler: async (req, reply) => {
      const who = await viewer(req, reply);
      if (!who) return;
      const row = found(who.userId, req.params.id, reply);
      if (!row) return;
      if (!mayDecide(row, who.viewer)) return reply.code(404).send({ error: "not_found" });
      if ((row.kind !== "sort" && row.kind !== "rename") || (row.status !== "done" && row.status !== "failed") || !row.result?.done) {
        return reply.code(409).send({ error: "not_undoable", action: actionView(row, who.viewer) });
      }
      try {
        const result = await undoFileAction(row);
        const said = say(row.language, "undone", { n: result.undo?.restored ?? 0 }) + (result.undo?.left ? ` ${say(row.language, "undoLeft", { m: result.undo.left })}` : "");
        appendAnswer(row.userId, row.discussionId, said);
      } catch (err) {
        return reply.code(409).send({ error: (err as { reason?: string }).reason ?? "failed", action: actionView(row, who.viewer) });
      }
      reply.send({ action: actionView(fileAction(who.userId, row.id) ?? row, who.viewer) });
    },
  });

  app.get<{ Params: { id: string }; Querystring: { item?: string } }>("/file_actions/:id/path", {
    schema: {
      tags: ["queries"],
      summary: "The real path of a file an action made or moved, for this computer's app to open or show it",
      security,
      params,
      querystring: { type: "object", properties: { item: { type: "string", pattern: "^(-1|\\d{1,4})$" } } },
    },
    handler: async (req, reply) => {
      const who = await viewer(req, reply);
      if (!who) return;
      if (!who.viewer.thisComputersApp) return reply.code(403).send({ error: "desktop_app_only" });
      const row = found(who.userId, req.params.id, reply);
      if (!row) return;
      let folder: string;
      try {
        folder = await checkedFolder(row.userId, row.plan);
      } catch {
        return reply.code(404).send({ error: "not_found" });
      }
      const index = Number(req.query.item ?? "-1");
      if (index === -1) return reply.send({ path: folder, folder: true });
      const item = row.result?.items[index];
      if (!item || (item.kind !== "moved" && item.kind !== "created" && item.kind !== "read")) return reply.code(404).send({ error: "not_found" });
      const wanted = join(folder, ...item.to.split("/"));
      const real = await realpath(wanted).catch(() => null);
      const rel = real ? relative(folder, real) : "..";
      const info = real ? await lstat(real).catch(() => null) : null;
      if (!real || rel.startsWith("..") || isAbsolute(rel) || !info?.isFile()) return reply.code(404).send({ error: "not_found" });
      reply.send({ path: real, folder: false });
    },
  });
}
