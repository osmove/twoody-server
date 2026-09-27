import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.js";
import {
  addFolder,
  FolderRejected,
  indexStatus,
  isIndexedPath,
  listFolders,
  listDocuments,
  reindex,
  removeFolder,
  searchPassages,
} from "../documents/library.js";

// Document library: the folders the user granted, the state of their
// index, and a search endpoint (the same one /queries uses, exposed so a
// client can show what would be retrieved).
//
// Lives under /local_documents rather than /documents: on the managed
// backend that path is the Google Drive browser, and one client code
// base talks to both.
export async function localDocumentRoutes(app: FastifyInstance) {
  const security: Array<Record<string, string[]>> = [{ bearerAuth: [] }, { userTokenAuth: [] }];

  app.get("/local_documents/folders", {
    schema: { tags: ["documents"], summary: "Granted folders and index counts", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      reply.send({ folders: listFolders(auth.userId), index: indexStatus(auth.userId) });
    },
  });

  app.post<{ Body: { path?: string } }>("/local_documents/folders", {
    schema: {
      tags: ["documents"],
      summary: "Grant a folder and start indexing it",
      security,
      body: { type: "object", properties: { path: { type: "string" } } },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const path = req.body?.path?.trim();
      if (!path) return reply.code(422).send({ error: "path_required" });

      try {
        const folder = addFolder(auth.userId, path);
        void reindex(auth.userId).catch((err) => app.log.error(err, "document indexing failed"));
        reply.code(201).send({ folder });
      } catch (err) {
        if (err instanceof FolderRejected) {
          return reply.code(err.reason === "already_added" ? 409 : 422).send({ error: err.reason });
        }
        throw err;
      }
    },
  });

  app.delete<{ Params: { id: string } }>("/local_documents/folders/:id", {
    schema: { tags: ["documents"], summary: "Revoke a folder and drop its index", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!removeFolder(auth.userId, req.params.id)) return reply.code(404).send({ error: "not_found" });
      reply.code(204).send();
    },
  });

  app.post("/local_documents/reindex", {
    schema: { tags: ["documents"], summary: "Re-scan the granted folders", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      void reindex(auth.userId).catch((err) => app.log.error(err, "document indexing failed"));
      reply.code(202).send({ index: indexStatus(auth.userId) });
    },
  });

  app.get<{ Querystring: { q?: string } }>("/local_documents/search", {
    schema: { tags: ["documents"], summary: "Passages the index returns for a question", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const passages = searchPassages(auth.userId, req.query.q ?? "", 8);
      reply.send({
        passages: passages.map(({ text: _text, ...passage }) => passage),
      });
    },
  });

  app.get<{ Querystring: { folder_id: string; offset?: number } }>("/local_documents/files", {
    schema: { tags: ["documents"], summary: "Files indexed in a granted folder, 100 per page", security,
      querystring: { type: "object", required: ["folder_id"], properties: { folder_id: { type: "string", minLength: 1, maxLength: 200 }, offset: { type: "integer", minimum: 0, maximum: 1000000 } } } },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      reply.send(listDocuments(auth.userId, req.query.folder_id, req.query.offset ?? 0));
    },
  });

  // The desktop opens a cited file itself; it asks first whether the
  // path really belongs to this user's index.
  app.get<{ Querystring: { path?: string } }>("/local_documents/known", {
    schema: { tags: ["documents"], summary: "Whether a path is an indexed document of this user", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      reply.send({ known: isIndexedPath(auth.userId, req.query.path ?? "") });
    },
  });
}
