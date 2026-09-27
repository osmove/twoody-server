import { sqlite } from "../db.js";
import { buildChatMessages } from "../chatContext.js";
import { documentAccess } from "../documents/access.js";
import { retrieveDocuments } from "../documents/retrieval.js";
import { relative, isAbsolute } from "node:path";
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
  browseDocuments,
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

  app.get<{Querystring: {folder_id: string; directory?: string; offset?: number}}>("/local_documents/browse", {
    schema: {tags: ["documents"], security, querystring: {type: "object", required: ["folder_id"], properties: {
      folder_id: {type: "string"}, directory: {type: "string", maxLength: 4096}, offset: {type: "integer", minimum: 0, maximum: 1000000},
    }}},
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply); if (!auth) return;
      try {
        const result = browseDocuments(auth.userId, req.query.folder_id, req.query.directory || "", req.query.offset || 0);
        return result ? reply.send(result) : reply.code(404).send({error: "folder_unavailable"});
      } catch (error) {
        if (error instanceof Error && error.message === "invalid_directory") return reply.code(400).send({error: "invalid_directory"});
        throw error;
      }
    },
  });

  app.get("/local_documents/folders", {
    schema: { tags: ["documents"], summary: "Granted folders and index counts", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      reply.send({ folders: listFolders(auth.userId), index: indexStatus(auth.userId) });
    },
  });

  // A bounded context envelope for clients whose conversation is stored elsewhere.
  // Nothing is sent upstream here. Clients must obtain consent before forwarding it.
  app.post<{Body: {question: string; document_access: unknown; history?: Array<{role: string; content: string; sourcesJson?: string}>}}>("/local_documents/context", {
    schema: {tags: ["documents"], summary: "Retrieve scoped context for an external conversation", security,
      body: {type: "object", required: ["question", "document_access"], properties: {
        question: {type: "string", maxLength: 24000}, document_access: {type: "object"},
        history: {type: "array", maxItems: 20, items: {type: "object", required: ["role", "content"], properties: {
          role: {type: "string", enum: ["user", "assistant"]}, content: {type: "string", maxLength: 16000}, sourcesJson: {type: "string", maxLength: 16000},
        }}},
      }}},
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply); if (!auth) return;
      let access;
      try { access = documentAccess(req.body.document_access); }
      catch { return reply.code(422).send({error: "invalid_document_access"}); }
      const granted = listFolders(auth.userId);
      const selected = granted.filter(folder => access.folderIds?.includes(folder.id));
      const folders = granted.filter(folder => access.mode !== "off" && (!access.folderIds || selected.some(parent => {
        const path = relative(parent.path, folder.path);
        return path === "" || (!path.startsWith("..") && !isAbsolute(path));
      })));
      const found = await retrieveDocuments(auth.userId, req.body.question, req.body.history ?? [], folders.map(f => f.id));
      const messages = buildChatMessages({userName: null, content: "", history: [], memories: [], prefs: {}, local: true,
        documentScan: indexStatus(auth.userId), documentMode: access.mode, documentFolders: folders, documentFiles: found.files, documentFileTotal: found.total,
        excerpts: found.passages.map(p => ({name:p.name,page:p.page,text:p.text})), contextWindow: 16384});
      // Only document data and grounding policy, never the user's profile/memories or paths.
      reply.send({context: messages.at(-1)?.content ?? "", sources: found.passages.map((p,i) => ({
        n:i+1, document_id:p.document_id, name:p.name, page:p.page, snippet:p.snippet,
      }))});
    },
  });

  app.get<{Params:{id:string}; Querystring:{offset?:number}}>("/local_documents/files/:id", {
    schema: {tags:["documents"],summary:"Read indexed text by opaque ID, 20 passages per page",security,
      params:{type:"object",required:["id"],properties:{id:{type:"string",maxLength:200}}},
      querystring:{type:"object",properties:{offset:{type:"integer",minimum:0,maximum:1000000}}}},
    handler:async(req,reply)=>{
      const auth=await requireAuth(req,reply);if(!auth)return;
      const file=sqlite.prepare(`SELECT d.id,d.name,d.mtime_ms,d.status FROM documents d
        JOIN document_folders f ON f.id=d.folder_id AND f.user_id=d.user_id
        WHERE d.id=? AND d.user_id=?`).get(req.params.id,auth.userId);
      if(!file)return reply.code(404).send({error:"not_found"});
      const offset=req.query.offset ?? 0;
      const rows=sqlite.prepare(`SELECT page,text FROM document_chunks WHERE document_id=? AND user_id=?
        ORDER BY position,rowid LIMIT 21 OFFSET ?`).all(req.params.id,auth.userId,offset);
      reply.send({file,passages:rows.slice(0,20),next_offset:rows.length>20?offset+20:null});
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
