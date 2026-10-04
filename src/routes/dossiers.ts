import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth } from "../auth.js";
import { FolderRejected } from "../documents/library.js";
import {
  addNote, createDossier, DossierError, exportDossier, getDossier, linkFolder, listDossiers, listNotes, readDossierInput, readNoteContent,
  removeNote, unlinkFolder, updateDossier, updateNote,
} from "../dossiers/dossiers.js";
import { sqlite } from "../db.js";
import { isThisComputersApp } from "./usage.js";

// Client files (src/dossiers/dossiers.ts):
//   GET    /dossiers                          ?status=open|archived|all → { dossiers }
//   POST   /dossiers                          { title, reference?, brief?, folder_path? } → { dossier, folder_error? }
//   GET    /dossiers/:id                      → { dossier, notes, conversations }
//   PATCH  /dossiers/:id                      { title?, reference?, brief?, status? } → { dossier }
//   POST   /dossiers/:id/folders              { path } → { dossier }: the folder of its documents
//   DELETE /dossiers/:id/folders/:folder_id   → { dossier }: no longer its (the files stay)
//   POST   /dossiers/:id/notes                { content } → { note } (200 with note: null when it holds it already)
//   PATCH  /dossiers/:id/notes/:note_id       { content?, pinned? } → { note }
//   DELETE /dossiers/:id/notes/:note_id       → 204
//   GET    /dossiers/:id/export               → everything of it, for the app to write where the person says
// This computer's app only, reading as writing: nothing about a client file
// leaves this computer (the phone: later).

const security: Array<Record<string, string[]>> = [{ bearerAuth: [] }, { userTokenAuth: [] }];

function failed(reply: FastifyReply, err: unknown) {
  if (err instanceof DossierError) return reply.code(err.status).send({ error: err.code });
  if (err instanceof FolderRejected) return reply.code(err.reason === "not_permitted" ? 403 : 422).send({ error: err.reason });
  throw err;
}

export async function dossierRoutes(app: FastifyInstance) {
  const allowed = async (req: Parameters<typeof requireAuth>[0], reply: FastifyReply) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return null;
    if (!isThisComputersApp(auth)) {
      reply.code(403).send({ error: "desktop_app_only" });
      return null;
    }
    return auth;
  };

  app.get<{ Querystring: { status?: string } }>("/dossiers", {
    schema: { tags: ["dossiers"], summary: "The person's client files", security, querystring: { type: "object", properties: { status: { type: "string", enum: ["open", "archived", "all"] } } } },
    handler: async (req, reply) => {
      const auth = await allowed(req, reply);
      if (!auth) return;
      reply.send({ dossiers: listDossiers(auth.userId, (req.query.status as "open" | "archived" | "all" | undefined) ?? "open") });
    },
  });

  app.post<{ Body: Record<string, unknown> }>("/dossiers", {
    schema: { tags: ["dossiers"], summary: "A new client file, with the folder of its documents", security, body: { type: "object" } },
    handler: async (req, reply) => {
      const auth = await allowed(req, reply);
      if (!auth) return;
      try {
        const dossier = createDossier(auth.userId, readDossierInput(req.body, true));
        const path = typeof req.body?.folder_path === "string" ? req.body.folder_path.trim() : "";
        if (!path) return reply.code(201).send({ dossier });
        // The file is made even when its folder cannot be: said, to choose another.
        try {
          return reply.code(201).send({ dossier: await linkFolder(auth.userId, dossier.id, path) });
        } catch (err) {
          const code = err instanceof DossierError ? err.code : err instanceof FolderRejected ? err.reason : null;
          if (!code) throw err;
          return reply.code(201).send({ dossier, folder_error: code });
        }
      } catch (err) {
        return failed(reply, err);
      }
    },
  });

  app.get<{ Params: { id: string } }>("/dossiers/:id", {
    schema: { tags: ["dossiers"], summary: "A client file: its documents' folder, notes and conversations", security },
    handler: async (req, reply) => {
      const auth = await allowed(req, reply);
      if (!auth) return;
      const dossier = getDossier(auth.userId, req.params.id);
      if (!dossier) return reply.code(404).send({ error: "dossier_not_found" });
      const conversations = (sqlite.prepare(`SELECT id, title, created_at, last_activity_at FROM discussions WHERE user_id = ? AND dossier_id = ?
        ORDER BY last_activity_at DESC, rowid DESC`).all(auth.userId, dossier.id) as Array<{ id: string; title: string | null; created_at: number; last_activity_at: number }>)
        .map((row) => ({ id: row.id, title: row.title, created_at: new Date(row.created_at).toISOString(), last_activity_at: new Date(row.last_activity_at).toISOString() }));
      reply.send({ dossier, notes: listNotes(auth.userId, dossier.id), conversations });
    },
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>("/dossiers/:id", {
    schema: { tags: ["dossiers"], summary: "Rename, describe, archive or reopen a client file", security, body: { type: "object", minProperties: 1 } },
    handler: async (req, reply) => {
      const auth = await allowed(req, reply);
      if (!auth) return;
      try {
        reply.send({ dossier: updateDossier(auth.userId, req.params.id, readDossierInput(req.body, false)) });
      } catch (err) {
        return failed(reply, err);
      }
    },
  });

  app.post<{ Params: { id: string }; Body: { path?: unknown } }>("/dossiers/:id/folders", {
    schema: { tags: ["dossiers"], summary: "The folder of a client file's documents", security, body: { type: "object", required: ["path"], properties: { path: { type: "string", minLength: 1, maxLength: 4096 } } } },
    handler: async (req, reply) => {
      const auth = await allowed(req, reply);
      if (!auth) return;
      try {
        reply.send({ dossier: await linkFolder(auth.userId, req.params.id, String(req.body.path)) });
      } catch (err) {
        return failed(reply, err);
      }
    },
  });

  app.delete<{ Params: { id: string; folder_id: string } }>("/dossiers/:id/folders/:folder_id", {
    schema: { tags: ["dossiers"], summary: "A folder no longer a client file's (its files are not touched)", security },
    handler: async (req, reply) => {
      const auth = await allowed(req, reply);
      if (!auth) return;
      try {
        reply.send({ dossier: unlinkFolder(auth.userId, req.params.id, req.params.folder_id) });
      } catch (err) {
        return failed(reply, err);
      }
    },
  });

  app.post<{ Params: { id: string }; Body: { content?: unknown } }>("/dossiers/:id/notes", {
    schema: { tags: ["dossiers"], summary: "A note kept in a client file", security, body: { type: "object", required: ["content"], properties: { content: { type: "string" } } } },
    handler: async (req, reply) => {
      const auth = await allowed(req, reply);
      if (!auth) return;
      try {
        const note = addNote(auth.userId, req.params.id, readNoteContent(req.body.content));
        reply.code(note ? 201 : 200).send({ note });
      } catch (err) {
        return failed(reply, err);
      }
    },
  });

  app.patch<{ Params: { id: string; note_id: string }; Body: { content?: unknown; pinned?: unknown } }>("/dossiers/:id/notes/:note_id", {
    schema: { tags: ["dossiers"], summary: "Change or pin a note of a client file", security, body: { type: "object", minProperties: 1, properties: { content: { type: "string" }, pinned: { type: "boolean" } } } },
    handler: async (req, reply) => {
      const auth = await allowed(req, reply);
      if (!auth) return;
      try {
        reply.send({ note: updateNote(auth.userId, req.params.id, req.params.note_id, {
          ...(req.body.content !== undefined ? { content: readNoteContent(req.body.content) } : {}),
          ...(typeof req.body.pinned === "boolean" ? { pinned: req.body.pinned } : {}),
        }) });
      } catch (err) {
        return failed(reply, err);
      }
    },
  });

  app.delete<{ Params: { id: string; note_id: string } }>("/dossiers/:id/notes/:note_id", {
    schema: { tags: ["dossiers"], summary: "Remove a note of a client file", security },
    handler: async (req, reply) => {
      const auth = await allowed(req, reply);
      if (!auth) return;
      try {
        return removeNote(auth.userId, req.params.id, req.params.note_id) ? reply.code(204).send() : reply.code(404).send({ error: "note_not_found" });
      } catch (err) {
        return failed(reply, err);
      }
    },
  });

  app.get<{ Params: { id: string } }>("/dossiers/:id/export", {
    schema: { tags: ["dossiers"], summary: "Everything of a client file, for the app to write where the person chooses", security },
    handler: async (req, reply) => {
      const auth = await allowed(req, reply);
      if (!auth) return;
      try {
        reply.send(exportDossier(auth.userId, req.params.id));
      } catch (err) {
        return failed(reply, err);
      }
    },
  });
}
