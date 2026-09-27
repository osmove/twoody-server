import { indexSemantic, semanticPassages, semanticStatus, setSemantic, stopSemantic } from "../documents/semantic.js";
import { fusePassages } from "../documents/vectorMath.js";
import { homedir } from "node:os";
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
  app.addHook("onClose", async () => stopSemantic());
  const security: Array<Record<string, string[]>> = [{ bearerAuth: [] }, { userTokenAuth: [] }];

  app.get("/local_documents/folders", {
    schema: { tags: ["documents"], summary: "Granted folders and index counts", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      reply.send({ folders: listFolders(auth.userId), index: indexStatus(auth.userId) });
    },
  });

  app.get("/local_documents/semantic", {
    schema: {tags: ["documents"], summary: "Local semantic indexing status", security},
    handler: async (req, reply) => {const auth=await requireAuth(req,reply);if(auth)reply.send(semanticStatus(auth.userId));},
  });
  app.post<{Body:{enabled:boolean}}>("/local_documents/semantic", {
    schema:{tags:["documents"],summary:"Enable or pause local semantic indexing",security,
      body:{type:"object",required:["enabled"],properties:{enabled:{type:"boolean"}}}},
    handler:async(req,reply)=>{const auth=await requireAuth(req,reply);if(auth)reply.send(setSemantic(auth.userId,req.body.enabled));},
  });
  app.post("/local_documents/semantic/reindex", {
    schema:{tags:["documents"],summary:"Resume local semantic indexing",security},
    handler:async(req,reply)=>{const auth=await requireAuth(req,reply);if(!auth)return;void indexSemantic(auth.userId);reply.code(202).send(semanticStatus(auth.userId));},
  });

  app.get("/local_documents/personal", {
    schema: {tags: ["documents"], summary: "Preview the personal-files grant", security},
    handler: async (req, reply) => {
      if (!await requireAuth(req, reply)) return;
      reply.send({path: homedir(), excludes: ["hidden files", "system and application data", "caches", "symlinks", "known credential filenames"], file_limit: 20000});
    },
  });
  app.post<{Body: {confirmed?: boolean}}>("/local_documents/personal", {
    schema: {tags: ["documents"], summary: "Explicitly grant personal files under the home directory", security,
      body: {type: "object", required: ["confirmed"], properties: {confirmed: {type: "boolean", const: true}}}},
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply); if (!auth) return;
      try {
        const folder = addFolder(auth.userId, homedir(), true);
        void reindex(auth.userId).catch(err => app.log.error(err, "document indexing failed"));
        reply.code(201).send({folder});
      } catch (err) {
        if (err instanceof FolderRejected) return reply.code(err.reason === "already_added" ? 409 : 422).send({error: err.reason});
        throw err;
      }
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
      const q=req.query.q ?? "";
      const passages = fusePassages(searchPassages(auth.userId, q, 8), q.trim() ? await semanticPassages(auth.userId, q, listFolders(auth.userId).map(f=>f.id)) : [], 8);
      reply.send({
        passages: passages.map(({ text: _text, ...passage }) => passage),
      });
    },
  });

  app.get<{ Querystring: { folder_id: string; offset?: number; sort?: "name" | "modified" | "category" } }>("/local_documents/files", {
    schema: { tags: ["documents"], summary: "Files indexed in a granted folder, 100 per page", security,
      querystring: { type: "object", required: ["folder_id"], properties: { sort: {type: "string", enum: ["name", "modified", "category"]}, folder_id: { type: "string", minLength: 1, maxLength: 200 }, offset: { type: "integer", minimum: 0, maximum: 1000000 } } } },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      reply.send(listDocuments(auth.userId, req.query.folder_id, req.query.offset ?? 0, 100, req.query.sort));
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
